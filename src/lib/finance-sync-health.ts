import { FinanceMonthlyStatementKind } from "@prisma/client";
import { financeDashboardTrendMonthLabel } from "@/lib/finance-dashboard-labels";
import { DEFAULT_FINANCE_MONTHLY_FACT_SCOPE } from "@/lib/finance-monthly-fact-store";
import {
  getFinanceSyncDiagnosticsStatus,
  type FinanceSyncDiagnosticsStatus,
} from "@/lib/finance-sync-diagnostics";
import {
  buildFinanceRevenueReconciliation,
  type FinanceRevenueReconciliation,
} from "@/lib/finance-revenue-reconciliation";
import {
  getXeroAdminHealthSnapshot,
  type XeroAdminHealthSnapshot,
} from "@/lib/xero-admin-health";
import { prisma } from "@/lib/prisma";
import { formatMonthOnly } from "@/lib/date-only";

/**
 * Treasurer sync-confidence view: aggregates the health signals the platform
 * already tracks (sync diagnostics, revenue reconciliation, Xero operation
 * outbox, monthly fact freshness) into one traffic light. Aggregation only —
 * no new sync logic, no live Xero calls.
 *
 * Traffic light policy:
 * - red   = sync run failed within the last 24h, failed outbox operations,
 *           or revenue reconciliation does not tie.
 * - amber = pending outbox operations, sync stale >36h, a finished month
 *           still provisional-only, reconciliation unavailable, missing
 *           invoices / refunds without credit notes, or a signal that could
 *           not be loaded.
 * - green = everything else.
 */

const FAILED_SYNC_RED_WINDOW_HOURS = 24;
const STALE_SYNC_AMBER_HOURS = 36;

export type FinanceSyncHealthTone = "green" | "amber" | "red";

interface FinanceSyncHealthSignal {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone: FinanceSyncHealthTone;
  href?: string;
  linkLabel?: string;
}

interface FinanceSyncHealthSection {
  id: "daily-sync" | "reconciliation" | "xero-operations" | "monthly-facts";
  title: string;
  description: string;
  tone: FinanceSyncHealthTone;
  signals: FinanceSyncHealthSignal[];
}

export interface FinanceSyncHealth {
  overallTone: FinanceSyncHealthTone;
  overallLabel: string;
  sections: FinanceSyncHealthSection[];
  warnings: string[];
}

export interface FinanceSyncHealthFactFreshness {
  kind: FinanceMonthlyStatementKind;
  maxSyncedAt: Date | null;
  latestFinalMonth: string | null;
}

/** Everything the classifier needs; null means the source failed to load. */
export interface FinanceSyncHealthSourceData {
  now: Date;
  /** Current NZ month, "YYYY-MM". */
  currentMonth: string;
  diagnostics: FinanceSyncDiagnosticsStatus | null;
  reconciliation: FinanceRevenueReconciliation | null;
  xeroHealth: XeroAdminHealthSnapshot | null;
  factFreshness: FinanceSyncHealthFactFreshness[];
}

const XERO_ADMIN_HREF = "/admin/xero";
const MAPPINGS_HREF = "/admin/setup/finance";

const STATEMENT_KIND_LABELS: Record<FinanceMonthlyStatementKind, string> = {
  PROFIT_AND_LOSS: "Profit and loss",
  BALANCE_SHEET: "Balance sheet",
};

function worstTone(tones: FinanceSyncHealthTone[]): FinanceSyncHealthTone {
  if (tones.includes("red")) return "red";
  if (tones.includes("amber")) return "amber";
  return "green";
}

function hoursSince(now: Date, value: Date): number {
  return (now.getTime() - value.getTime()) / 3_600_000;
}

function formatHoursAgo(now: Date, value: Date): string {
  const hours = hoursSince(now, value);
  if (hours < 1) return "under an hour ago";
  if (hours < 48) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// The month key one month back. `Date.UTC(year, month - 2, 1)` is the first of
// the PREVIOUS month pinned to UTC midnight — a date-only value by construction,
// built from a `yyyy-MM` key rather than from any clock or `DateTime` column —
// so the canonical date-only encoder reads back exactly the month it encodes
// (INV-DATE-019's first exact boundary, with INV-DATE-026; INV-DATE-010 rules
// that the value is an encoding rather than a moment and is not the citation for
// a decode — #3080). It used to assemble the same string from `getUTCFullYear()`
// and a padded `getUTCMonth()`, which is the truncation written a fourth way and
// invisible to every guard that looks for the ISO spellings (#2684).
function previousMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return formatMonthOnly(new Date(Date.UTC(year, month - 2, 1)));
}

function classifyLatestSyncRun(input: FinanceSyncHealthSourceData): FinanceSyncHealthSignal {
  const base = {
    id: "latest-sync-run",
    label: "Latest sync run",
    href: XERO_ADMIN_HREF,
    linkLabel: "Open Xero admin",
  };

  if (!input.diagnostics) {
    return {
      ...base,
      value: "Unavailable",
      detail: "Finance sync diagnostics could not be loaded.",
      tone: "amber",
    };
  }

  const latest = input.diagnostics.latestRun;
  if (!latest) {
    return {
      ...base,
      value: "Never run",
      detail: `Scheduled ${input.diagnostics.cron.schedule} (${input.diagnostics.cron.timezone}).`,
      tone: "amber",
    };
  }

  const ranAt = new Date(latest.completedAt ?? latest.startedAt);
  const agoLabel = formatHoursAgo(input.now, ranAt);

  if (latest.status === "FAILED") {
    const recentFailure =
      hoursSince(input.now, ranAt) < FAILED_SYNC_RED_WINDOW_HOURS;
    return {
      ...base,
      value: `Failed ${agoLabel}`,
      detail: latest.errorSummary ?? "The latest finance sync run failed.",
      tone: recentFailure ? "red" : "amber",
    };
  }
  if (latest.status === "PARTIAL") {
    return {
      ...base,
      value: `Partial ${agoLabel}`,
      detail:
        latest.errorSummary ??
        `${latest.failedDatasetCount} of ${latest.datasetCount} datasets failed.`,
      tone: "amber",
    };
  }
  if (latest.status === "RUNNING") {
    return {
      ...base,
      value: "Running now",
      detail: `Started ${formatHoursAgo(input.now, new Date(latest.startedAt))}.`,
      tone: "green",
    };
  }
  return {
    ...base,
    value: `Succeeded ${agoLabel}`,
    detail: `${latest.snapshotCount} snapshots, ${latest.totalRowCount} rows.`,
    tone: "green",
  };
}

function classifyReconciliation(
  input: FinanceSyncHealthSourceData
): FinanceSyncHealthSignal {
  const base = {
    id: "revenue-reconciliation",
    label: "Platform vs Xero revenue",
    href: MAPPINGS_HREF,
    linkLabel: "Open setup mappings",
  };

  if (!input.reconciliation) {
    return {
      ...base,
      value: "Unavailable",
      detail: "Revenue reconciliation could not be loaded.",
      tone: "amber",
    };
  }

  const recon = input.reconciliation;
  const periodCount = recon.periods.length;
  if (recon.overallStatus === "DOES_NOT_TIE") {
    const offCount = recon.periods.filter(
      (period) => period.status === "DOES_NOT_TIE"
    ).length;
    return {
      ...base,
      value: "Does not tie",
      detail: `${offCount} of ${periodCount} recent months outside tolerance.`,
      tone: "red",
    };
  }
  if (recon.overallStatus === "XERO_UNAVAILABLE") {
    return {
      ...base,
      value: "Xero data unavailable",
      detail: "Stored Xero snapshots are missing for the reconciliation window.",
      tone: "amber",
    };
  }
  return {
    ...base,
    value: "Ties",
    detail: `${periodCount} recent months within tolerance.`,
    tone: "green",
  };
}

function classifyXeroOperations(
  input: FinanceSyncHealthSourceData
): FinanceSyncHealthSignal[] {
  const link = { href: XERO_ADMIN_HREF, linkLabel: "Open Xero admin" };

  if (!input.xeroHealth) {
    return [
      {
        id: "xero-operations",
        label: "Xero operations",
        value: "Unavailable",
        detail: "Xero operations health could not be loaded.",
        tone: "amber",
        ...link,
      },
    ];
  }

  const health = input.xeroHealth;
  return [
    {
      id: "failed-operations",
      label: "Failed operations",
      value: String(health.failedOperations.count),
      detail:
        health.failedOperations.count > 0
          ? "Invoices or credit notes are not reaching Xero."
          : undefined,
      tone: health.failedOperations.count > 0 ? "red" : "green",
      ...link,
    },
    {
      id: "pending-operations",
      label: "Pending operations",
      value: String(health.pendingOperations.count),
      detail:
        health.pendingOperations.count > 0
          ? "Queued writes waiting for the next outbox run."
          : undefined,
      tone: health.pendingOperations.count > 0 ? "amber" : "green",
      ...link,
    },
    {
      id: "missing-invoices",
      label: "Bookings missing invoices",
      value: String(health.missingInvoices.count),
      tone: health.missingInvoices.count > 0 ? "amber" : "green",
      ...link,
    },
    {
      id: "refunds-missing-credit-notes",
      label: "Refunds missing credit notes",
      value: String(health.refundsMissingCreditNotes.count),
      detail: `After a ${health.refundsMissingCreditNotes.graceHours}h grace window.`,
      tone: health.refundsMissingCreditNotes.count > 0 ? "amber" : "green",
      ...link,
    },
  ];
}

function classifyFactFreshness(
  input: FinanceSyncHealthSourceData
): FinanceSyncHealthSignal[] {
  const lastFinishedMonth = previousMonthKey(input.currentMonth);

  return input.factFreshness.flatMap((freshness) => {
    const kindLabel = STATEMENT_KIND_LABELS[freshness.kind];

    const syncedSignal: FinanceSyncHealthSignal = freshness.maxSyncedAt
      ? {
          id: `facts-synced-${freshness.kind}`,
          label: `${kindLabel} facts synced`,
          value: formatHoursAgo(input.now, freshness.maxSyncedAt),
          tone:
            hoursSince(input.now, freshness.maxSyncedAt) > STALE_SYNC_AMBER_HOURS
              ? "amber"
              : "green",
          detail:
            hoursSince(input.now, freshness.maxSyncedAt) > STALE_SYNC_AMBER_HOURS
              ? `Older than ${STALE_SYNC_AMBER_HOURS}h — check the daily sync cron.`
              : undefined,
        }
      : {
          id: `facts-synced-${freshness.kind}`,
          label: `${kindLabel} facts synced`,
          value: "No data stored",
          detail: "Run the finance sync or the monthly-facts backfill.",
          tone: "amber",
        };

    const completedSignal: FinanceSyncHealthSignal = {
      id: `facts-final-month-${freshness.kind}`,
      label: `${kindLabel} final through`,
      value: freshness.latestFinalMonth
        ? financeDashboardTrendMonthLabel(freshness.latestFinalMonth)
        : "No final months",
      detail:
        !freshness.latestFinalMonth ||
        freshness.latestFinalMonth < lastFinishedMonth
          ? `${financeDashboardTrendMonthLabel(lastFinishedMonth)} has ended but is still provisional or missing.`
          : undefined,
      tone:
        freshness.latestFinalMonth &&
        freshness.latestFinalMonth >= lastFinishedMonth
          ? "green"
          : "amber",
    };

    return [syncedSignal, completedSignal];
  });
}

const OVERALL_LABELS: Record<FinanceSyncHealthTone, string> = {
  green: "All clear",
  amber: "Needs attention",
  red: "Action required",
};

export function classifyFinanceSyncHealth(
  input: FinanceSyncHealthSourceData
): FinanceSyncHealth {
  const sectionDefs: Array<Omit<FinanceSyncHealthSection, "tone">> = [
    {
      id: "daily-sync",
      title: "Daily Xero sync",
      description: "The scheduled pull that stores Xero data for the dashboard.",
      signals: [classifyLatestSyncRun(input)],
    },
    {
      id: "reconciliation",
      title: "Revenue reconciliation",
      description:
        "Whether platform booking revenue ties to Xero's recorded income.",
      signals: [classifyReconciliation(input)],
    },
    {
      id: "xero-operations",
      title: "Xero operations",
      description: "Outbound invoices, credit notes, and contact updates.",
      signals: classifyXeroOperations(input),
    },
    {
      id: "monthly-facts",
      title: "Monthly fact freshness",
      description: "The stored per-account monthly balances the dashboard reads.",
      signals: classifyFactFreshness(input),
    },
  ];
  const sections: FinanceSyncHealthSection[] = sectionDefs.map((section) => ({
    ...section,
    tone: worstTone(section.signals.map((signal) => signal.tone)),
  }));

  const overallTone = worstTone(sections.map((section) => section.tone));
  const warnings = sections.flatMap((section) =>
    section.signals
      .filter((signal) => signal.tone !== "green")
      .map((signal) => `${signal.label}: ${signal.value}.`)
  );

  return {
    overallTone,
    overallLabel: OVERALL_LABELS[overallTone],
    sections,
    warnings,
  };
}

async function loadFactFreshness(
  kind: FinanceMonthlyStatementKind
): Promise<FinanceSyncHealthFactFreshness> {
  const [aggregate, latestFinal] = await Promise.all([
    prisma.financeAccountMonthlyBalance.aggregate({
      where: { statementKind: kind, scope: DEFAULT_FINANCE_MONTHLY_FACT_SCOPE },
      _max: { syncedAt: true },
    }),
    prisma.financeAccountMonthlyBalance.findFirst({
      where: {
        statementKind: kind,
        scope: DEFAULT_FINANCE_MONTHLY_FACT_SCOPE,
        isProvisional: false,
      },
      orderBy: { month: "desc" },
      select: { month: true },
    }),
  ]);

  return {
    kind,
    maxSyncedAt: aggregate._max.syncedAt,
    latestFinalMonth: latestFinal
      ? formatMonthOnly(latestFinal.month)
      : null,
  };
}

export async function buildFinanceSyncHealth(input: {
  currentMonth: string;
  now?: Date;
}): Promise<FinanceSyncHealth> {
  const now = input.now ?? new Date();

  const [diagnostics, reconciliation, xeroHealth, factFreshness] =
    await Promise.all([
      getFinanceSyncDiagnosticsStatus().catch(() => null),
      buildFinanceRevenueReconciliation().catch(() => null),
      getXeroAdminHealthSnapshot().catch(() => null),
      Promise.all(
        Object.values(FinanceMonthlyStatementKind).map((kind) =>
          loadFactFreshness(kind).catch(
            (): FinanceSyncHealthFactFreshness => ({
              kind,
              maxSyncedAt: null,
              latestFinalMonth: null,
            })
          )
        )
      ),
    ]);

  return classifyFinanceSyncHealth({
    now,
    currentMonth: input.currentMonth,
    diagnostics,
    reconciliation,
    xeroHealth,
    factFreshness,
  });
}
