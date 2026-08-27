/**
 * Revenue reconciliation between Xero and the booking system.
 *
 * For each recent month we compare the hut-fee income recognised in Xero (from
 * the stored profit-and-loss snapshot) against the hut-fee revenue the booking
 * system recorded over the same period (summed from per-guest-night prices).
 * The two are expected to be close; a material gap is surfaced so finance can
 * investigate. Membership income is reported from Xero only, because the app
 * does not store a membership fee amount locally (only the paid count).
 *
 * Matching P&L income lines to hut-fee / subscription income is done by GL code
 * when possible: each P&L row carries the account's Xero AccountID, and the
 * stored chart-of-accounts snapshot maps that AccountID to a GL code, which is
 * compared against the configured hutFeesIncome / subscriptionIncome account
 * codes. This is deterministic, unlike matching by account label (e.g. "Annual
 * Subs" matches neither "subscription" nor "membership"). Label keyword matching
 * is kept as a fallback for when the chart-of-accounts snapshot is unavailable or
 * a profit-and-loss snapshot predates account-id capture.
 *
 * Reconciling items to expect: stay-night recognition vs Xero invoice/accrual
 * timing, refunds/discounts (booking nights are gross), and any non-NZD lines.
 */

import { FinanceSnapshotType, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { FINANCE_REALIZED_BOOKING_STATUSES } from "@/lib/finance-booking-metrics";
import { getAccountMapping } from "@/lib/xero-mappings";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import {
  extractPnlLineItems,
  extractPnlSectionTotalCents,
  findPnlSection,
  readPnlPeriodLabel,
  readPnlReportPayload,
  type PnlLineItem,
} from "@/lib/finance-pnl-snapshot";
import {
  calendarDateOfDateOnlyInstant,
  formatClubMonthYear,
  requireStoredCalendarDay,
} from "@/lib/club-time";
import { formatDateOnly, formatMonthOnly } from "@/lib/date-only";

const INCOME_SECTION_KEYWORDS = ["income", "revenue"];
const INCOME_SUMMARY_KEYWORDS = ["total income", "total revenue"];
const HUT_FEE_LABEL_KEYWORDS = ["hut fee", "hut fees", "accommodation"];
const SUBSCRIPTION_LABEL_KEYWORDS = ["subscription", "membership"];

/** How a period's Xero income figures were matched to the booking categories. */
type FinanceIncomeMatchStrategy = "GL_CODE" | "LABEL";

/** Resolved GL codes + AccountID-to-code map used for GL-code matching. */
interface ChartOfAccountsContext {
  /** Xero AccountID -> GL code, from the latest chart-of-accounts snapshot. */
  accountCodeById: Map<string, string>;
  /** Configured GL code for hut-fee income (default 200). */
  hutFeesCode: string | null;
  /** Configured GL code for subscription income (default 203). */
  subscriptionCode: string | null;
}

const DEFAULT_RECONCILIATION_PERIODS = 6;
const MAX_RECONCILIATION_PERIODS = 24;
const DEFAULT_TOLERANCE_PCT = 0.01; // 1%
const DEFAULT_TOLERANCE_CENTS = 5000; // $50
const MILLISECONDS_PER_DAY = 86_400_000;

type FinanceReconciliationStatus =
  | "TIES"
  | "DOES_NOT_TIE"
  | "XERO_UNAVAILABLE";

interface FinanceReconciliationPeriod {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  xeroHutFeesIncomeCents: number | null;
  xeroSubscriptionIncomeCents: number | null;
  xeroTotalIncomeCents: number | null;
  bookingHutFeesCents: number;
  bookingMemberHutFeesCents: number;
  bookingNonMemberHutFeesCents: number;
  paidSubscriptionCount: number;
  varianceCents: number | null;
  variancePct: number | null;
  status: FinanceReconciliationStatus;
  incomeMatchStrategy: FinanceIncomeMatchStrategy;
}

export interface FinanceRevenueReconciliation {
  generatedAt: string;
  overallStatus: FinanceReconciliationStatus;
  toleranceCents: number;
  tolerancePct: number;
  periods: FinanceReconciliationPeriod[];
}

type FinanceSnapshotRecord = Awaited<
  ReturnType<typeof listFinanceSnapshots>
>[number];

function clampPeriods(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECONCILIATION_PERIODS;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RECONCILIATION_PERIODS);
}

function startOfMonthUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)
  );
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MILLISECONDS_PER_DAY);
}

function resolvePeriodBounds(snapshot: FinanceSnapshotRecord): {
  start: Date;
  end: Date;
} {
  const end = snapshot.periodEnd ?? snapshot.asOfDate;
  const start = snapshot.periodStart ?? startOfMonthUtc(end);
  return { start, end };
}

/**
 * The fallback period heading, when the stored payload carries none of its own.
 *
 * A CALENDAR MONTH, SO IT TAKES NO ZONE (#3123; `INV-DATE-019`). The value is
 * {@link resolvePeriodBounds}'s `end`, which is `FinanceSnapshot.periodEnd` or
 * `FinanceSnapshot.asOfDate` — both `@db.Date` columns, round-tripping as UTC
 * midnight. `formatNZMonthYear` projected them through `APP_TIME_ZONE`, so for a
 * club west of Greenwich the first of a month rolled back and the revenue
 * reconciliation table named the PREVIOUS month against that month's figures.
 * The club's persisted zone would be just as wrong here: the question has no
 * zone to answer it with. Composed rather than wrapped, per
 * `docs/CLUB_TIME_KERNEL.md`.
 */
function formatSnapshotPeriodMonth(value: Date): string {
  return formatClubMonthYear(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(value, {
        subject: "A revenue-reconciliation period heading",
        instead:
          "A real timestamp rendered as a bare month is a projection, and both " +
          "FinanceSnapshot.periodEnd and FinanceSnapshot.asOfDate are @db.Date columns.",
      }),
    ),
  );
}

/** Key a snapshot by its calendar month so we keep one row per month. */
function periodKey(snapshot: FinanceSnapshotRecord): string {
  const { start } = resolvePeriodBounds(snapshot);
  return formatMonthOnly(start);
}

function sumMatchingLineItems(
  lineItems: PnlLineItem[],
  keywords: string[]
): number | null {
  const matched = lineItems.filter((item) =>
    keywords.some((keyword) => item.label.toLowerCase().includes(keyword))
  );
  if (matched.length === 0) {
    return null;
  }
  return matched.reduce((total, item) => total + item.amountCents, 0);
}

/** Sum income lines whose AccountID resolves to the target GL code. */
function sumByGlCode(
  lineItems: PnlLineItem[],
  accountCodeById: Map<string, string>,
  targetCode: string | null
): number | null {
  if (!targetCode) {
    return null;
  }

  const matched = lineItems.filter((item) => {
    if (!item.accountId) {
      return false;
    }
    return accountCodeById.get(item.accountId) === targetCode;
  });
  if (matched.length === 0) {
    return null;
  }
  return matched.reduce((total, item) => total + item.amountCents, 0);
}

function parseXeroIncome(
  snapshot: FinanceSnapshotRecord,
  chart: ChartOfAccountsContext
): {
  hutFeesCents: number | null;
  subscriptionCents: number | null;
  totalCents: number | null;
  strategy: FinanceIncomeMatchStrategy;
} {
  const payload = readPnlReportPayload(snapshot.payload);
  if (!payload) {
    return {
      hutFeesCents: null,
      subscriptionCents: null,
      totalCents: null,
      strategy: "LABEL",
    };
  }

  const incomeSection = findPnlSection(payload.rows, INCOME_SECTION_KEYWORDS);
  if (!incomeSection) {
    return {
      hutFeesCents: null,
      subscriptionCents: null,
      totalCents: null,
      strategy: "LABEL",
    };
  }

  const lineItems = extractPnlLineItems(incomeSection);
  const totalCents = extractPnlSectionTotalCents(
    incomeSection,
    INCOME_SUMMARY_KEYWORDS
  );

  // Prefer deterministic GL-code matching when the chart-of-accounts snapshot is
  // available and the P&L rows carry account ids. Otherwise fall back to label
  // keyword matching (older snapshots, or no chart snapshot synced yet).
  const canUseGlCodes =
    chart.accountCodeById.size > 0 && lineItems.some((item) => item.accountId);

  if (canUseGlCodes) {
    return {
      hutFeesCents: sumByGlCode(lineItems, chart.accountCodeById, chart.hutFeesCode),
      subscriptionCents: sumByGlCode(
        lineItems,
        chart.accountCodeById,
        chart.subscriptionCode
      ),
      totalCents,
      strategy: "GL_CODE",
    };
  }

  return {
    hutFeesCents: sumMatchingLineItems(lineItems, HUT_FEE_LABEL_KEYWORDS),
    subscriptionCents: sumMatchingLineItems(lineItems, SUBSCRIPTION_LABEL_KEYWORDS),
    totalCents,
    strategy: "LABEL",
  };
}

/** Read the latest chart-of-accounts snapshot into an AccountID -> GL code map. */
function parseChartOfAccountsMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return map;
  }

  const accounts = (payload as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) {
    return map;
  }

  for (const entry of accounts) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const accountId = (entry as { accountId?: unknown }).accountId;
    const code = (entry as { code?: unknown }).code;
    if (typeof accountId === "string" && accountId && typeof code === "string" && code) {
      map.set(accountId, code);
    }
  }

  return map;
}

async function loadChartOfAccountsContext(): Promise<ChartOfAccountsContext> {
  const snapshots = await listFinanceSnapshots({
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 1,
  });

  const accountCodeById = parseChartOfAccountsMap(snapshots[0]?.payload);
  if (accountCodeById.size === 0) {
    return { accountCodeById, hutFeesCode: null, subscriptionCode: null };
  }

  const [hutFeesCode, subscriptionCode] = await Promise.all([
    getAccountMapping("hutFeesIncome"),
    getAccountMapping("subscriptionIncome"),
  ]);

  return { accountCodeById, hutFeesCode, subscriptionCode };
}

async function loadBookingHutFees(
  start: Date,
  end: Date
): Promise<{ total: number; member: number }> {
  const realizedStatuses = [...FINANCE_REALIZED_BOOKING_STATUSES];
  const dateWindow = { gte: start, lte: end };

  const [total, member] = await Promise.all([
    prisma.bookingGuestNight.aggregate({
      _sum: { priceCents: true },
      where: {
        stayDate: dateWindow,
        bookingGuest: { booking: { status: { in: realizedStatuses } } },
      },
    }),
    prisma.bookingGuestNight.aggregate({
      _sum: { priceCents: true },
      where: {
        stayDate: dateWindow,
        bookingGuest: {
          isMember: true,
          booking: { status: { in: realizedStatuses } },
        },
      },
    }),
  ]);

  return {
    total: total._sum.priceCents ?? 0,
    member: member._sum.priceCents ?? 0,
  };
}

function resolveStatus(
  xeroHutFeesCents: number | null,
  varianceCents: number | null,
  toleranceCents: number,
  tolerancePct: number
): FinanceReconciliationStatus {
  if (xeroHutFeesCents === null || varianceCents === null) {
    return "XERO_UNAVAILABLE";
  }

  const allowed = Math.max(
    toleranceCents,
    Math.round(Math.abs(xeroHutFeesCents) * tolerancePct)
  );
  return Math.abs(varianceCents) <= allowed ? "TIES" : "DOES_NOT_TIE";
}

async function buildPeriod(
  snapshot: FinanceSnapshotRecord,
  chart: ChartOfAccountsContext,
  toleranceCents: number,
  tolerancePct: number
): Promise<FinanceReconciliationPeriod> {
  const { start, end } = resolvePeriodBounds(snapshot);
  const payload = readPnlReportPayload(snapshot.payload);
  const periodLabel =
    (payload ? readPnlPeriodLabel(payload) : null) ??
    formatSnapshotPeriodMonth(end);

  const xero = parseXeroIncome(snapshot, chart);
  const bookingHutFees = await loadBookingHutFees(start, end);
  const paidSubscriptionCount = await prisma.memberSubscription.count({
    where: {
      status: SubscriptionStatus.PAID,
      paidAt: { gte: start, lt: addUtcDays(end, 1) },
    },
  });

  const varianceCents =
    xero.hutFeesCents === null
      ? null
      : xero.hutFeesCents - bookingHutFees.total;
  const variancePct =
    xero.hutFeesCents === null || xero.hutFeesCents === 0
      ? null
      : Number(((varianceCents ?? 0) / xero.hutFeesCents).toFixed(4));

  return {
    periodLabel,
    periodStart: formatDateOnly(start),
    periodEnd: formatDateOnly(end),
    xeroHutFeesIncomeCents: xero.hutFeesCents,
    xeroSubscriptionIncomeCents: xero.subscriptionCents,
    xeroTotalIncomeCents: xero.totalCents,
    bookingHutFeesCents: bookingHutFees.total,
    bookingMemberHutFeesCents: bookingHutFees.member,
    bookingNonMemberHutFeesCents: bookingHutFees.total - bookingHutFees.member,
    paidSubscriptionCount,
    varianceCents,
    variancePct,
    status: resolveStatus(
      xero.hutFeesCents,
      varianceCents,
      toleranceCents,
      tolerancePct
    ),
    incomeMatchStrategy: xero.strategy,
  };
}

function resolveOverallStatus(
  periods: FinanceReconciliationPeriod[]
): FinanceReconciliationStatus {
  if (periods.length === 0) {
    return "XERO_UNAVAILABLE";
  }
  if (periods.some((period) => period.status === "DOES_NOT_TIE")) {
    return "DOES_NOT_TIE";
  }
  if (periods.every((period) => period.status === "XERO_UNAVAILABLE")) {
    return "XERO_UNAVAILABLE";
  }
  return "TIES";
}

export async function buildFinanceRevenueReconciliation(input?: {
  periods?: number;
  toleranceCents?: number;
  tolerancePct?: number;
  now?: Date;
}): Promise<FinanceRevenueReconciliation> {
  const periodsRequested = clampPeriods(input?.periods);
  const toleranceCents = input?.toleranceCents ?? DEFAULT_TOLERANCE_CENTS;
  const tolerancePct = input?.tolerancePct ?? DEFAULT_TOLERANCE_PCT;

  const [snapshots, chart] = await Promise.all([
    listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: 100,
    }),
    loadChartOfAccountsContext(),
  ]);

  // Snapshots are newest-first; keep the latest one per calendar month so a
  // daily sync of the current month does not crowd out earlier months.
  const latestByMonth = new Map<string, FinanceSnapshotRecord>();
  for (const snapshot of snapshots) {
    const key = periodKey(snapshot);
    if (!latestByMonth.has(key)) {
      latestByMonth.set(key, snapshot);
    }
  }

  const selected = Array.from(latestByMonth.values()).slice(0, periodsRequested);
  const periods = await Promise.all(
    selected.map((snapshot) =>
      buildPeriod(snapshot, chart, toleranceCents, tolerancePct)
    )
  );

  return {
    generatedAt: (input?.now ?? new Date()).toISOString(),
    overallStatus: resolveOverallStatus(periods),
    toleranceCents,
    tolerancePct,
    periods,
  };
}
