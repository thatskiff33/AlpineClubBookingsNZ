import { FinanceSnapshotType } from "@prisma/client";
import {
  dateOnlyInstantOf,
  formatClubDayMonth,
  parseInstant,
  requireCalendarDate,
  type BoundClubTime,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import {
  DEFAULT_CLUB_THEME_VALUES,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";
import {
  getFinanceBookingMetrics,
  type FinanceBookingMetricsResult,
} from "@/lib/finance-booking-metrics";
import { parseCashSnapshot } from "@/lib/finance-cash-snapshot";
import {
  FINANCE_DASHBOARD_COMPARE_LABELS,
  FINANCE_DASHBOARD_FORWARD_LABELS,
  FINANCE_DASHBOARD_RANGE_LABELS,
  FINANCE_DASHBOARD_VIEW_LABELS,
  financeDashboardDateRangeDayCount,
  financeDashboardMonthCount,
  financeDashboardViewUsesLodgeScope,
  resolveFinanceDashboardSelection,
  resolveFinanceDashboardView,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import { financeDashboardWindowDetail } from "@/lib/finance-dashboard-labels";
import {
  formatDollarsDisplay,
  formatFinanceNumber as formatNumber,
  formatFinancePercent as formatPercent,
  formatFinanceSignedNumber as formatSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import { buildFinanceMonthlyBalanceSeries } from "@/lib/finance-monthly-balance";
import {
  buildFinanceMonthlyPnlSummary,
} from "@/lib/finance-monthly-pnl";
import {
  buildFinanceFinancialYearsPanelItems,
  buildFinanceRatioMatrix,
} from "@/lib/finance-ratio-insights";
import {
  financeFinancialYearBuckets,
  type FinanceRatioMatrix,
} from "@/lib/finance-ratio-shared";
import type { FinanceMappedPnlCategorySummary } from "@/lib/finance-report-mappings";
import { buildFinanceRevenueReconciliation } from "@/lib/finance-revenue-reconciliation";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { hasFinanceManagerAccess } from "@/lib/admin-permissions";
import { buildXeroReportsUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import type { FinanceAccessMember } from "@/lib/finance-auth";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import {
  buildFinanceSyncHealth,
  type FinanceSyncHealthTone,
} from "@/lib/finance-sync-health";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

// Compact day+month export label ("14 Jun"), deliberately year-less: it labels
// rows already scoped to one range, and widening it to the shared medium form
// would change an exported report column. That bag is the kernel's `dayMonth`
// shape (F3, #3079), so the local formatter this file kept is gone.
//
// CT-4 (#2870): THIS ALSO CORRECTS THE DAY. Every value reaching it is a
// `yyyy-MM-dd` metric key minted by `buildIsoDateRange`, i.e. a CALENDAR DATE,
// which takes no zone — and the local formatter was still pinned to
// `APP_TIME_ZONE`. That projection cancelled only because New Zealand is east of
// Greenwich; for a club west of it every trend point on the finance dashboard,
// and every exported row label, named the PREVIOUS day (INV-DATE-019).

type SearchParams = Record<string, string | string[] | undefined>;
type FinanceDashboardViewModel = Pick<
  FinanceDashboardPageModel,
  | "cards"
  | "trends"
  | "mix"
  | "statusPanels"
  | "costFilters"
  | "sourceNotes"
  | "exportSections"
> & { warnings: string[] };

interface FinanceDashboardKpiCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

interface FinanceDashboardTrend {
  title: string;
  description: string;
  variant: "bar" | "area" | "line";
  xKey: string;
  data: Array<Record<string, number | string>>;
  series: Array<{
    key: string;
    name: string;
    color: string;
    valueType: "currency" | "count" | "percent" | "ratio";
    stackId?: string;
  }>;
}

interface FinanceDashboardMix {
  title: string;
  description: string;
  valueType: "currency" | "count" | "percent" | "ratio";
  data: Array<{ name: string; value: number }>;
}

interface FinanceDashboardStatusPanel {
  title: string;
  description: string;
  badgeLabel?: string;
  badgeTone?: "success" | "warning" | "destructive" | "secondary";
  items: Array<{
    label: string;
    value: string;
    detail?: string;
    // Set on subtype sub-heading / sub-total rows so the renderer can emphasise them.
    emphasis?: boolean;
    href?: string;
    linkLabel?: string;
  }>;
}

interface FinanceDashboardExportSection {
  title: string;
  rows: Array<Record<string, string | number>>;
}

interface FinanceDashboardCostFilters {
  categories: Array<{ id: string; label: string }>;
  lines: Array<{ value: string; label: string; categoryId: string }>;
}

interface FinanceDashboardSyncStatus {
  label: string;
  tone: "success" | "warning" | "destructive" | "secondary";
  detail: string;
  lastSyncedAt: string | null;
}

interface FinanceDashboardRatioExplorerModel {
  matrix: FinanceRatioMatrix;
  initialNumeratorId: string | null;
  initialDenominatorId: string | null;
  initialRangeKey: string | null;
}

export interface FinanceDashboardPageModel {
  generatedOn: string;
  isManager: boolean;
  selection: FinanceDashboardSelection;
  /** Present only on the Ratios view; drives the client-side explorer. */
  ratios: FinanceDashboardRatioExplorerModel | null;
  selectionLabels: {
    view: string;
    range: string;
    compare: string;
    forward: string;
    primaryWindow: string;
    comparisonWindow: string;
    forwardWindow: string;
  };
  syncStatus: FinanceDashboardSyncStatus;
  warnings: string[];
  cards: FinanceDashboardKpiCard[];
  trends: FinanceDashboardTrend[];
  mix: FinanceDashboardMix | null;
  statusPanels: FinanceDashboardStatusPanel[];
  costFilters: FinanceDashboardCostFilters | null;
  sourceNotes: Array<{
    label: string;
    description: string;
    href?: string;
    linkLabel?: string;
  }>;
  exportSections: FinanceDashboardExportSection[];
  /**
   * Active lodges for the booking-derived reporting scope (occupancy, guest
   * nights, booked revenue). ADR-002: the selector only appears once a second
   * active lodge exists, so a single-lodge club sees an empty list and no
   * selector. Accounting views (P&L, cash, balances) stay club-wide and ignore
   * this scope — including the seasons behind the "Rest of Season" forward
   * window (#2919), which honour it only on the views that render the selector
   * (FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS), never on a lodgeId the query string
   * happens to have carried over.
   */
  lodges: Array<{ id: string; name: string }>;
  /** Selected reporting lodge, or null for all active lodges (summed capacity). */
  selectedLodgeId: string | null;
}

// #2190 P4 (D15/J7): the trend/bar series colours are DERIVED from the generated
// substrate rather than hand-picked hex (the old set led with a fork's brand gold
// and its support orange). Like FINANCE_MIX_COLORS these feed Recharts
// `fill`/`stroke` presentation attributes where `var()` does not resolve, so a
// resolved hex is required; the scales chosen are club-independent at step 9 and
// distinct from each other and from FINANCE_MIX_COLORS' first slots reused here
// (cat1/cat3/cat4-9 read as the SAME hue across the two charts on purpose). Built
// once from the shipping default reference seeds; pinned by
// finance-dashboard-series-colors.test.ts. The dead `neutral`/`negative` slots
// (zero references) were removed.
function buildFinanceSeriesColors() {
  const light = buildThemeSubstrate(themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES), "light");
  const step9 = (scale: string) => light.scales[scale].hex[8];
  return {
    revenue: step9("cat1"), // headline revenue — categorical chart-1 tone
    costs: step9("cat4"), // orange, reads as outflow; distinct from revenue
    bookings: step9("cat3"), // magenta, distinct from revenue and costs
    cash: step9("info"), // semantic info blue
    positive: step9("success"), // semantic success green
    comparison: light.neutralHex[8], // neutral-9: a muted grey reference line
  } as const;
}

// Exported for finance-dashboard-series-colors.test.ts (pin to the default seeds).
export const SERIES_COLORS = buildFinanceSeriesColors();

// Exact cents (reconciliation and export rows only; displays use whole dollars).
function formatSignedCents(value: number) {
  if (value === 0) {
    return formatCents(0);
  }
  return `${value > 0 ? "+" : "-"}${formatCents(Math.abs(value))}`;
}

/**
 * A real INSTANT — a sync run's completion stamp, or the moment this page model
 * was built — in the club's PERSISTED zone (#3123, `INV-CONFIG-002`).
 *
 * It used to go through `formatNZDateTime`, i.e. through `APP_TIME_ZONE`, so for
 * a club west of Greenwich the finance page could say its figures were last
 * synced on the wrong day. Unlike `formatShortDate` below — which renders a
 * `yyyy-MM-dd` CALENDAR key and rightly takes no zone — this one holds a moment,
 * which has no civil date until a zone is chosen.
 *
 * The binding is threaded from `buildFinanceDashboardPageModel`, which resolves
 * it once per render pass; see the note there.
 */
function formatDateTime(club: BoundClubTime, value: string | Date) {
  const instant = parseInstant(value);
  return instant === null ? "Unavailable" : club.instantDateTime(instant);
}

function formatShortDate(dateOnly: string) {
  return formatClubDayMonth(requireCalendarDate(dateOnly));
}

function cardRows(cards: FinanceDashboardKpiCard[]) {
  return cards.map((card) => ({
    Metric: card.title,
    Value: card.value,
    Description: card.description,
    Footnote: card.footnote ?? "",
  }));
}

/**
 * Active seasons for the page's reporting scope (#2919). They drive the "Rest
 * of Season" forward window, so reading them unscoped let one lodge's season
 * define another lodge's forward range with nothing on screen saying so. A
 * selected lodge reads only its own; All Lodges reads every ACTIVE lodge's and
 * carries the lodge name so the window can say whose season it picked.
 *
 * `lodge: { active: true }` is deliberate and is not the Season's own `active`
 * flag: a deactivated lodge disappears from the selector and from the
 * summed-capacity denominator, so a still-active season row of its own must not
 * set the club-wide forward window or put a name on screen that appears nowhere
 * else (review finding, #2919). Season.lodgeId is NOT NULL, so this excludes no
 * lodgeless rows — there are none.
 */
async function loadSeasons(lodgeId: string | null, labelWithLodge: boolean) {
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      lodge: { active: true },
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
    },
    select: {
      name: true,
      startDate: true,
      endDate: true,
      active: true,
      lodge: { select: { name: true } },
    },
    orderBy: [{ startDate: "asc" }],
  });
  return seasons.map(({ lodge, ...season }) => ({
    ...season,
    // Only in All-Lodges mode, and only for a club that has more than one:
    // labelling a single-lodge club's own season with its own name is noise.
    lodgeName: labelWithLodge ? lodge.name : null,
  }));
}

async function buildSyncStatus(club: BoundClubTime): Promise<{
  status: FinanceDashboardSyncStatus;
  warnings: string[];
}> {
  try {
    const sync = await getFinanceSyncDiagnosticsStatus();
    const latest = sync.latestRun;
    if (!latest) {
      return {
        status: {
          label: "Not yet synced",
          tone: "warning",
          detail: `Scheduled ${sync.cron.schedule} (${sync.cron.timezone}).`,
          lastSyncedAt: null,
        },
        warnings: ["No finance sync run has completed in this environment yet."],
      };
    }

    const completedOrStarted = latest.completedAt ?? latest.startedAt;
    const tone =
      latest.status === "SUCCEEDED"
        ? "success"
        : latest.status === "PARTIAL"
          ? "warning"
          : latest.status === "RUNNING"
            ? "secondary"
            : "destructive";

    return {
      status: {
        label:
          latest.status === "SUCCEEDED"
            ? "Synced"
            : latest.status === "PARTIAL"
              ? "Partial sync"
              : latest.status === "RUNNING"
                ? "Running"
                : "Sync failed",
        tone,
        detail: `${latest.snapshotCount} snapshots, ${latest.totalRowCount} rows. ${formatDateTime(club, completedOrStarted)}.`,
        lastSyncedAt: completedOrStarted,
      },
      warnings:
        latest.status === "FAILED" || latest.status === "PARTIAL"
          ? [latest.errorSummary ?? "The latest finance sync needs manager review."]
          : [],
    };
  } catch {
    return {
      status: {
        label: "Sync unavailable",
        tone: "warning",
        detail: "Finance sync status could not be loaded.",
        lastSyncedAt: null,
      },
      warnings: ["Finance sync status could not be loaded."],
    };
  }
}

function buildSelectionLabels(selection: FinanceDashboardSelection) {
  return {
    view: FINANCE_DASHBOARD_VIEW_LABELS[selection.view],
    range: FINANCE_DASHBOARD_RANGE_LABELS[selection.range],
    compare: FINANCE_DASHBOARD_COMPARE_LABELS[selection.compare],
    forward: FINANCE_DASHBOARD_FORWARD_LABELS[selection.forward],
    primaryWindow: financeDashboardWindowDetail(selection.primary),
    comparisonWindow: financeDashboardWindowDetail(selection.comparison),
    // #2919: in All-Lodges mode at a multi-lodge club, say WHOSE season set the
    // forward window — dates alone never did. That string is the one the range
    // resolver already built (`label`), reused rather than rebuilt so there is
    // no second construction to keep in step. Every other case (one lodge
    // selected, or a single-lodge club) keeps the dates-only wording it had.
    forwardWindow: selection.forwardWindow.seasonLodgeName
      ? selection.forwardWindow.label
      : financeDashboardWindowDetail(selection.forwardWindow),
  };
}

async function buildBookingsDashboard(
  selection: FinanceDashboardSelection,
  lodgeId: string | null
): Promise<FinanceDashboardViewModel> {
  const warnings: string[] = [];
  const query = {
    realized: {
      from: selection.primary.from,
      to: selection.primary.to,
      cutoffDate: selection.primary.to,
    },
    ...(selection.forwardWindow.from && selection.forwardWindow.to
      ? {
          forward: {
            from: selection.forwardWindow.from,
            to: selection.forwardWindow.to,
            asOfDate: selection.primary.to,
          },
        }
      : {}),
    lodgeId,
  };
  const [metrics, comparison] = await Promise.all([
    getFinanceBookingMetrics(query),
    selection.comparison
      ? getFinanceBookingMetrics({
          realized: {
            from: selection.comparison.from,
            to: selection.comparison.to,
            cutoffDate: selection.comparison.to,
          },
          lodgeId,
        })
      : Promise.resolve(null),
  ]);
  const realized = metrics.realized;
  const compareRealized = comparison?.realized ?? null;

  if (!realized) {
    warnings.push("Realized booking metrics were unavailable for the selected range.");
  }

  // #2408. Net collected cash is the gross captured figure from the payment
  // rows, which contains a collected price increase because the payment ledger
  // put it there. A payment that says its increase was collected without a
  // ledger row to prove it is the one shape where that is not true, so the card
  // below would understate the cash. Say so where the treasurer reads the
  // number, and say by how much, rather than publishing a figure that is
  // quietly short.
  const ledgerGapBookings =
    metrics.paymentSummary.additionalLedgerGapBookings;
  if (ledgerGapBookings > 0) {
    warnings.push(
      `Net collected cash may understate by ${formatDollarsDisplay(metrics.paymentSummary.additionalLedgerGapCents)}: ${formatNumber(ledgerGapBookings)} booking${ledgerGapBookings === 1 ? "" : "s"} in this range record an extra payment as collected without a matching payment record behind it. Ask a developer to re-check those payments before reconciling this figure.`
    );
  }

  const realizedTotals = realized?.totals;
  const compareTotals = compareRealized?.totals;
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Realized guest nights",
      value: formatNumber(realizedTotals?.guestNights ?? 0),
      description: "Guest nights stayed in the selected period.",
      footnote: compareTotals
        ? `${formatSignedNumber((realizedTotals?.guestNights ?? 0) - compareTotals.guestNights)} vs comparison.`
        : undefined,
    },
    {
      title: "Occupancy",
      value: formatPercent(realizedTotals?.occupancy.occupancyRate ?? 0),
      description: "Occupied bed nights divided by available bed nights.",
      footnote: compareTotals
        ? `${formatPercent(compareTotals.occupancy.occupancyRate)} in comparison.`
        : undefined,
    },
    {
      title: "Booked revenue",
      value: formatDollarsDisplay(realizedTotals?.bookedRevenueCents ?? 0),
      description: "Booking-system revenue allocated across realized stay nights.",
      footnote: compareTotals
        ? `${formatSignedDollarsDisplay((realizedTotals?.bookedRevenueCents ?? 0) - compareTotals.bookedRevenueCents)} vs comparison.`
        : undefined,
    },
    {
      title: "Net collected cash",
      value: formatDollarsDisplay(metrics.paymentSummary.netCollectedCents),
      // #2408: one figure, counted once. The captured amount on a payment row
      // already includes any later price increase that was collected, so this
      // is the whole of the cash and not a part of it.
      description:
        "Captured payments less refunds from local payment rows, including any collected price increase.",
      footnote:
        ledgerGapBookings > 0
          ? `May understate by ${formatDollarsDisplay(metrics.paymentSummary.additionalLedgerGapCents)} - see the warning above. Cash is local payment-derived and separate from Xero revenue.`
          : "Cash is local payment-derived and separate from Xero revenue.",
    },
    {
      title: "Forward demand",
      value: formatNumber(metrics.forward?.totals.totalPipeline.guestNights ?? 0),
      description: "Committed plus at-risk future guest nights in the forward window.",
      footnote: selection.forwardWindow.from
        ? selection.forwardWindow.label
        : "Forward window unavailable.",
    },
    {
      // #2350: the payment summary has always counted these; nothing rendered
      // them, so an upward booking change whose extra was never collected was
      // invisible on every finance surface.
      title: "Outstanding additional payments",
      value: formatDollarsDisplay(
        metrics.paymentSummary.outstandingAdditionalCents,
      ),
      description:
        "Extra owed after an upward booking change and not yet collected, for bookings in the selected range.",
      // Window-scoped, unlike the admin dashboard card and sidebar badge (which
      // count every owing booking, whenever it stays) and the reports summary
      // (which counts the report's own date range). Say so, or the three
      // numbers look like a contradiction rather than three questions.
      footnote: `${formatNumber(metrics.paymentSummary.outstandingAdditionalBookings)} booking${metrics.paymentSummary.outstandingAdditionalBookings === 1 ? "" : "s"} awaiting or failed payment in this range.`,
    },
  ];

  const trends: FinanceDashboardTrend[] = [];
  if (realized) {
    trends.push({
      title: "Occupancy and guest-night trend",
      description: "Daily realized occupancy and guest nights for the selected range.",
      variant: "line",
      xKey: "label",
      data: realized.byDate.map((entry) => ({
        label: formatShortDate(entry.date),
        occupancy: entry.occupancyRate,
        guestNights: entry.guestNights,
      })),
      series: [
        {
          key: "occupancy",
          name: "Occupancy",
          color: SERIES_COLORS.revenue,
          valueType: "percent",
        },
        {
          key: "guestNights",
          name: "Guest nights",
          color: SERIES_COLORS.bookings,
          valueType: "count",
        },
      ],
    });
  }
  if (metrics.forward) {
    trends.push({
      title: "Forward committed and at-risk demand",
      description: "Future pipeline split between paid committed stays and at-risk bookings.",
      variant: "area",
      xKey: "label",
      data: metrics.forward.byDate.map((entry) => ({
        label: formatShortDate(entry.date),
        committed: entry.committed.guestNights,
        atRisk: entry.atRisk.guestNights,
      })),
      series: [
        {
          key: "committed",
          name: "Committed",
          color: SERIES_COLORS.positive,
          valueType: "count",
          stackId: "pipeline",
        },
        {
          key: "atRisk",
          name: "At risk",
          color: SERIES_COLORS.costs,
          valueType: "count",
          stackId: "pipeline",
        },
      ],
    });
  }

  const statusPanels = buildBookingStatusPanels(metrics);
  return {
    cards,
    trends,
    mix: null,
    statusPanels,
    costFilters: null,
    sourceNotes: [
      {
        label: "Booking metrics",
        description:
          "Guest nights, occupancy, and booked revenue come from local booking and guest-night rows.",
      },
      {
        label: "Payment cash",
        description:
          "Net collected cash comes from local payment rows and remains separate from Xero revenue recognition.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Forward status",
        rows: statusPanels.flatMap((panel) =>
          panel.items.map((item) => ({
            Panel: panel.title,
            Label: item.label,
            Value: item.value,
            Detail: item.detail ?? "",
          }))
        ),
      },
    ],
    warnings,
  };
}

function buildBookingStatusPanels(
  metrics: FinanceBookingMetricsResult
): FinanceDashboardStatusPanel[] {
  const panels: FinanceDashboardStatusPanel[] = [];
  if (metrics.realized) {
    panels.push({
      title: "Realized status mix",
      description: "Booking statuses contributing to realized guest nights.",
      items: Object.entries(metrics.realized.statusBreakdown).map(
        ([status, summary]) => ({
          label: status,
          value: formatNumber(summary.guestNights),
          detail: `${formatNumber(summary.bookingCount)} bookings, ${formatDollarsDisplay(summary.bookedRevenueCents)}`,
        })
      ),
    });
  }
  // #2350: the additional-payment status split, alongside the existing
  // realized/forward panels. Rendered only when something is actually
  // outstanding — an all-clear panel of zeroes is noise on a busy dashboard.
  const additionalBreakdown =
    metrics.paymentSummary.additionalPaymentStatusBreakdown;
  if (metrics.paymentSummary.outstandingAdditionalBookings > 0) {
    panels.push({
      title: "Outstanding additional payments",
      description:
        "Bookings whose price went up after payment, with the extra still uncollected.",
      badgeLabel: "Owing",
      badgeTone: "secondary",
      items: [
        {
          label: "Awaiting payment",
          value: formatNumber(additionalBreakdown.PENDING),
          detail: "Charge not yet completed by the member.",
        },
        {
          label: "Payment failed",
          value: formatNumber(additionalBreakdown.FAILED),
          detail: "The last attempt to charge the card did not succeed.",
        },
        {
          label: "Total outstanding",
          value: formatDollarsDisplay(
            metrics.paymentSummary.outstandingAdditionalCents
          ),
          detail: `Across ${formatNumber(metrics.paymentSummary.outstandingAdditionalBookings)} booking${metrics.paymentSummary.outstandingAdditionalBookings === 1 ? "" : "s"}.`,
        },
      ],
    });
  }
  if (metrics.forward) {
    panels.push({
      title: "Forward pipeline split",
      description: "Committed demand is paid; at-risk demand still needs settlement or review.",
      badgeLabel: "Forward",
      badgeTone: "secondary",
      items: [
        {
          label: "Committed",
          value: formatNumber(metrics.forward.totals.committed.guestNights),
          detail: formatDollarsDisplay(
            metrics.forward.totals.committed.bookedRevenueCents
          ),
        },
        {
          label: "At risk",
          value: formatNumber(metrics.forward.totals.atRisk.guestNights),
          detail: formatDollarsDisplay(
            metrics.forward.totals.atRisk.bookedRevenueCents
          ),
        },
      ],
    });
  }
  return panels;
}

// Group the mapped P&L categories under their subtype sub-headings, inserting an
// emphasised sub-total row before each subtype's member groups. Groups without a
// subtype (including the synthetic "Unmapped" group) render flat, after the
// labelled subtypes.
function buildGroupStatusItems(
  groups: FinanceMappedPnlCategorySummary[],
  hasComparison: boolean
): FinanceDashboardStatusPanel["items"] {
  const withSubtype = groups.filter((group) => group.subtype);
  const withoutSubtype = groups.filter((group) => !group.subtype);

  const subtypeOrder = new Map<string, number>();
  for (const group of withSubtype) {
    const subtype = group.subtype as string;
    const current = subtypeOrder.get(subtype);
    if (current === undefined || group.sortOrder < current) {
      subtypeOrder.set(subtype, group.sortOrder);
    }
  }
  const orderedSubtypes = Array.from(subtypeOrder.keys()).sort((left, right) => {
    const byOrder = subtypeOrder.get(left)! - subtypeOrder.get(right)!;
    return byOrder !== 0 ? byOrder : left.localeCompare(right);
  });

  const groupItem = (group: FinanceMappedPnlCategorySummary) => ({
    label: group.name,
    value: group.formattedAmount,
    detail: hasComparison
      ? `${group.lineCount} lines, ${group.formattedDelta} vs comparison`
      : `${group.lineCount} lines`,
  });

  const items: FinanceDashboardStatusPanel["items"] = [];
  for (const subtype of orderedSubtypes) {
    const members = withSubtype
      .filter((group) => group.subtype === subtype)
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
      );
    const subtotalCents = members.reduce(
      (total, group) => total + group.amountCents,
      0
    );
    items.push({
      label: subtype,
      value: formatDollarsDisplay(subtotalCents),
      detail: `${members.length} group${members.length === 1 ? "" : "s"} subtotal`,
      emphasis: true,
    });
    items.push(...members.map(groupItem));
  }
  items.push(...withoutSubtype.map(groupItem));
  return items;
}

async function buildMappedPnlDashboard(input: {
  selection: FinanceDashboardSelection;
  kind: "REVENUE" | "EXPENSE";
}) {
  const summary = await buildFinanceMonthlyPnlSummary({
    kind: input.kind,
    primary: input.selection.primary,
    comparison: input.selection.comparison,
    currentMonth: input.selection.currentMonth,
    expenseCategoryId: input.selection.expenseCategoryId,
    expenseLine: input.selection.expenseLine,
  });

  const noun = input.kind === "REVENUE" ? "revenue" : "costs";
  const hasComparison = input.selection.comparison !== null;
  const rankedGroups = [...summary.groups].sort(
    (left, right) => right.amountCents - left.amountCents
  );
  const largest = rankedGroups[0];
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: input.kind === "REVENUE" ? "Revenue" : "Costs",
      value: summary.formattedAmount,
      description: `Selected-period ${noun} from stored monthly Xero account balances.`,
      footnote:
        summary.formattedDelta && summary.formattedComparisonAmount
          ? `${summary.formattedDelta} vs ${summary.formattedComparisonAmount} comparison.`
          : undefined,
    },
    hasComparison
      ? {
          title: "Comparison period",
          value: summary.formattedComparisonAmount ?? formatDollarsDisplay(0),
          description: `${input.selection.comparison?.label ?? ""} total.`,
        }
      : {
          title: "Months covered",
          value: `${summary.monthsWithData} of ${financeDashboardMonthCount(input.selection.primary)}`,
          description: "Selected months with stored monthly Xero data.",
        },
    {
      title: largest ? "Largest group" : "Groups",
      value: largest ? largest.formattedAmount : "No groups",
      description: largest
        ? largest.name
        : "No mapped or unmapped lines were found for the selected period.",
    },
    {
      title: "Unmapped included",
      value:
        summary.groups.find((group) => group.id === "unmapped")?.formattedAmount ??
        formatDollarsDisplay(0),
      description:
        "Unmapped account lines remain in totals so missing mappings cannot hide data.",
    },
  ];
  const seriesName = input.kind === "REVENUE" ? "Revenue" : "Costs";
  const trends: FinanceDashboardTrend[] = [
    {
      title: input.kind === "REVENUE" ? "Revenue trend" : "Cost trend",
      description: hasComparison
        ? `Monthly ${noun} for the selected period, with the comparison period aligned month by month.`
        : `Monthly ${noun} for the selected period.`,
      variant: "bar",
      xKey: "label",
      data: summary.trend.map((point) => ({
        label: point.isProvisional ? `${point.label} (MTD)` : point.label,
        amount: point.amountCents,
        // A custom comparison window shorter than the primary leaves trailing
        // months unaligned (comparisonAmountCents null). Omit the key so the
        // chart renders a gap rather than a fake $0 bar, matching the CSV/PDF
        // export which prints "" for the same case.
        ...(hasComparison && point.comparisonAmountCents !== null
          ? { comparison: point.comparisonAmountCents }
          : {}),
      })),
      series: [
        {
          key: "amount",
          name: seriesName,
          color:
            input.kind === "REVENUE"
              ? SERIES_COLORS.revenue
              : SERIES_COLORS.costs,
          valueType: "currency",
        },
        ...(hasComparison
          ? [
              {
                key: "comparison",
                name: "Comparison",
                color: SERIES_COLORS.comparison,
                valueType: "currency" as const,
              },
            ]
          : []),
      ],
    },
  ];
  const statusPanels: FinanceDashboardStatusPanel[] = [
    {
      title: input.kind === "REVENUE" ? "Revenue groups" : "Expense groups",
      description:
        "Mapped Treasurer-controlled groups under their subtype sub-headings, with Unmapped kept visible.",
      items: buildGroupStatusItems(summary.groups, hasComparison),
    },
  ];
  // Export rows keep exact cents so they tie out against Xero.
  const exportSections = [
    { title: "KPI cards", rows: cardRows(cards) },
    {
      title: input.kind === "REVENUE" ? "Revenue groups" : "Expense groups",
      rows: summary.groups.map((group) => ({
        Subtype: group.subtype ?? "",
        Group: group.name,
        Amount: formatCents(group.amountCents),
        Comparison: hasComparison ? formatCents(group.comparisonAmountCents) : "",
        Delta: hasComparison ? formatSignedCents(group.deltaCents) : "",
        Lines: group.lineCount,
      })),
    },
    {
      title: "Monthly totals",
      rows: summary.trend.map((point) => ({
        Month: point.label,
        Amount: formatCents(point.amountCents),
        Comparison:
          point.comparisonAmountCents === null
            ? ""
            : formatCents(point.comparisonAmountCents),
        MonthToDate: point.isProvisional ? "yes" : "",
      })),
    },
    {
      title: "Lines",
      rows: summary.groups.flatMap((group) =>
        group.lines.map((line) => ({
          Group: group.name,
          Line: line.lineLabel,
          AccountCode: line.accountCode ?? "",
          Amount: formatCents(line.amountCents),
          Comparison: hasComparison ? formatCents(line.comparisonAmountCents) : "",
          MonthsPresent: line.periodsPresent,
        }))
      ),
    },
  ];

  return {
    summary,
    cards,
    trends,
    mix: {
      title: input.kind === "REVENUE" ? "Revenue mix" : "Expense mix",
      description:
        "Share of the selected period by finance report group. Zero and negative lines stay in export detail.",
      valueType: "currency" as const,
      data: summary.mix.map((item) => ({
        name: item.name,
        value: item.valueCents,
      })),
    },
    statusPanels,
    costFilters:
      input.kind === "EXPENSE"
        ? {
            categories: summary.groups.map((group) => ({
              id: group.id,
              label: group.name,
            })),
            lines: summary.availableExpenseLines,
          }
        : null,
    sourceNotes: [
      {
        label: "Xero monthly facts",
        description:
          "Revenue and costs come from stored monthly Xero account balances (one amount per account and month). Opening the dashboard does not call Xero live; drill into Xero for day-level detail.",
        // #2314 review: the report centre is the highest-value Xero link in the
        // product and its audience is exactly the multi-organisation treasurer
        // #2314 exists for, so it resolves the short code like every other
        // server-side producer. The cached read is what made that affordable
        // (see getXeroOrgShortCode); a null one degrades to the generic link.
        href: buildXeroReportsUrl({ shortCode: await getXeroOrgShortCode() }),
        linkLabel: "Open Xero reports",
      },
      {
        label: "Mappings",
        description:
          "Treasurer-controlled setup mappings group accounts by Xero account code under named subtypes. Unmapped accounts are included in totals.",
      },
    ],
    exportSections,
    warnings: summary.warnings,
  };
}

/**
 * "Financial years" committee panel: per-category totals for this FY (YTD),
 * last FY, and the FY before, appended to the revenue and costs views.
 */
async function appendFinancialYearsPanel(
  viewModel: { statusPanels: FinanceDashboardStatusPanel[]; warnings: string[] },
  selection: FinanceDashboardSelection,
  kind: "REVENUE" | "EXPENSE"
) {
  try {
    const matrix = await buildFinanceRatioMatrix({
      financialYearEndMonth: selection.financialYearEndMonth,
      currentMonth: selection.currentMonth,
    });
    if (matrix.months.length === 0) {
      return;
    }
    const buckets = financeFinancialYearBuckets(matrix);
    viewModel.statusPanels.push({
      title: "Financial years",
      description: `${buckets[0].label} vs ${buckets[1].label} and ${buckets[2].label} by group. Explore any pairing in the Ratios view.`,
      items: buildFinanceFinancialYearsPanelItems({
        matrix,
        kind,
        formatCents: formatDollarsDisplay,
      }),
    });
  } catch {
    viewModel.warnings.push("Financial-year comparison could not be loaded.");
  }
}

async function buildRatiosDashboard(
  selection: FinanceDashboardSelection
): Promise<FinanceDashboardViewModel & { ratios: FinanceDashboardRatioExplorerModel }> {
  const matrix = await buildFinanceRatioMatrix({
    financialYearEndMonth: selection.financialYearEndMonth,
    currentMonth: selection.currentMonth,
  });
  const buckets = financeFinancialYearBuckets(matrix);

  return {
    ratios: {
      matrix,
      initialNumeratorId: selection.ratioNumeratorId,
      initialDenominatorId: selection.ratioDenominatorId,
      initialRangeKey: selection.ratioRangeKey,
    },
    cards: [],
    trends: [],
    mix: null,
    statusPanels: [],
    costFilters: null,
    sourceNotes: [
      {
        label: "Ratio source",
        description:
          "Ratios divide stored monthly Xero account balances grouped by the treasurer's category mappings. Unmapped accounts are included in the totals series.",
      },
    ],
    exportSections: [
      {
        title: "Category totals by financial year",
        rows: matrix.series.map((series) => ({
          Category: series.name,
          Kind: series.kind,
          [buckets[0].label]: formatCents(
            buckets[0]
              ? matrix.months.reduce(
                  (total, month, index) =>
                    month >= buckets[0].fromMonth && month <= buckets[0].toMonth
                      ? total + (series.valuesCents[index] ?? 0)
                      : total,
                  0
                )
              : 0
          ),
          [buckets[1].label]: formatCents(
            matrix.months.reduce(
              (total, month, index) =>
                month >= buckets[1].fromMonth && month <= buckets[1].toMonth
                  ? total + (series.valuesCents[index] ?? 0)
                  : total,
              0
            )
          ),
          [buckets[2].label]: formatCents(
            matrix.months.reduce(
              (total, month, index) =>
                month >= buckets[2].fromMonth && month <= buckets[2].toMonth
                  ? total + (series.valuesCents[index] ?? 0)
                  : total,
              0
            )
          ),
        })),
      },
    ],
    warnings:
      matrix.months.length === 0
        ? [
            "No monthly Xero data is stored yet. Run the finance sync, or the monthly-facts backfill for older history.",
          ]
        : [],
  };
}

async function buildRevenueDashboard(selection: FinanceDashboardSelection) {
  const mapped = await buildMappedPnlDashboard({ selection, kind: "REVENUE" });
  await appendFinancialYearsPanel(mapped, selection, "REVENUE");
  try {
    const periods = Math.max(
      1,
      Math.min(12, financeDashboardMonthCount(selection.primary))
    );
    const reconciliation = await buildFinanceRevenueReconciliation({ periods });
    mapped.statusPanels.push({
      title: "Xero vs booking reconciliation",
      description:
        "Hut-fee income from Xero compared with booking-system hut fee revenue. Exact cents, for tie-out.",
      badgeLabel:
        reconciliation.overallStatus === "TIES"
          ? "Ties"
          : reconciliation.overallStatus === "DOES_NOT_TIE"
            ? "Variance"
            : "Unavailable",
      badgeTone:
        reconciliation.overallStatus === "TIES"
          ? "success"
          : reconciliation.overallStatus === "DOES_NOT_TIE"
            ? "warning"
            : "secondary",
      items: reconciliation.periods.slice(0, 6).map((period) => ({
        label: period.periodLabel,
        value:
          period.varianceCents === null
            ? "Unavailable"
            : formatSignedCents(period.varianceCents),
        detail: `Xero ${period.xeroHutFeesIncomeCents === null ? "—" : formatCents(period.xeroHutFeesIncomeCents)} · Booking ${formatCents(period.bookingHutFeesCents)}`,
      })),
    });
  } catch {
    mapped.warnings.push("Revenue reconciliation could not be loaded.");
  }
  return mapped;
}

async function buildPricingSensitivityDashboard(
  selection: FinanceDashboardSelection,
  lodgeId: string | null
) {
  const [costs, metrics] = await Promise.all([
    buildFinanceMonthlyPnlSummary({
      kind: "EXPENSE",
      primary: selection.primary,
      comparison: null,
      currentMonth: selection.currentMonth,
    }),
    getFinanceBookingMetrics({
      realized: {
        from: selection.primary.from,
        to: selection.primary.to,
        cutoffDate: selection.primary.to,
      },
      lodgeId,
    }),
  ]);
  const realized = metrics.realized;
  const guestNights = realized?.totals.guestNights ?? 0;
  const bookedRevenueCents = realized?.totals.bookedRevenueCents ?? 0;
  const realizedRateCents =
    guestNights > 0 ? Math.round(bookedRevenueCents / guestNights) : null;
  const breakEvenRateCents =
    guestNights > 0 ? Math.round(costs.amountCents / guestNights) : null;
  const bookedRevenueLessCostsCents = bookedRevenueCents - costs.amountCents;
  const capacityBedNights =
    realized?.totals.occupancy.capacityBedNights ??
    financeDashboardDateRangeDayCount(selection.primary);
  const assumptions = [0.2, 0.35, 0.5, 0.65, 0.8];
  const scenarioData = assumptions.map((occupancy) => {
    const impliedGuestNights = Math.round(capacityBedNights * occupancy);
    return {
      label: formatPercent(occupancy),
      requiredRate:
        impliedGuestNights > 0
          ? Math.round(costs.amountCents / impliedGuestNights)
          : 0,
      realizedRevenue:
        realizedRateCents === null ? 0 : impliedGuestNights * realizedRateCents,
    };
  });
  // Per-night rates keep cents: they are unit prices where cents are signal.
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Break-even revenue / guest night",
      value: breakEvenRateCents === null ? "Unavailable" : formatCents(breakEvenRateCents),
      description: "Selected-period costs divided by realized guest nights.",
    },
    {
      title: "Realized rate",
      value: realizedRateCents === null ? "Unavailable" : formatCents(realizedRateCents),
      description: "Booked revenue divided by realized guest nights.",
    },
    {
      title: "Booked revenue less costs",
      value: formatSignedDollarsDisplay(bookedRevenueLessCostsCents),
      description: "Booking-system revenue less mapped Xero costs.",
    },
    {
      title: "Realized guest nights",
      value: formatNumber(guestNights),
      description: "Demand base used by the break-even calculation.",
    },
  ];

  return {
    cards,
    trends: [
      {
        title: "Occupancy scenario chart",
        description:
          "Required guest-night rate by occupancy assumption, compared with revenue at the realized rate.",
        variant: "bar" as const,
        xKey: "label",
        data: scenarioData,
        series: [
          {
            key: "requiredRate",
            name: "Required rate",
            color: SERIES_COLORS.costs,
            valueType: "currency" as const,
          },
          {
            key: "realizedRevenue",
            name: "Revenue at realized rate",
            color: SERIES_COLORS.revenue,
            valueType: "currency" as const,
          },
        ],
      },
    ],
    mix: null,
    statusPanels: [
      {
        title: "Scenario assumptions",
        description: "Break-even rates are based on mapped selected-period costs.",
        items: scenarioData.map((scenario) => ({
          label: scenario.label,
          value: formatCents(scenario.requiredRate),
          detail: `Revenue at realized rate ${formatDollarsDisplay(scenario.realizedRevenue)}`,
        })),
      },
    ],
    costFilters: null,
    sourceNotes: [
      {
        label: "Cost source",
        description:
          "Costs come from stored monthly Xero account balances and setup mappings.",
      },
      {
        label: "Booking source",
        description: "Guest nights and booked revenue come from local booking metrics.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      { title: "Scenarios", rows: scenarioData },
    ],
    warnings: costs.warnings,
  };
}

async function loadLatestBankBalancesSnapshot(club: BoundClubTime) {
  const snapshots = await listFinanceSnapshots({
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 1,
  });
  return snapshots[0] ? parseCashSnapshot(club, snapshots[0]) : null;
}

async function buildCashDashboard(
  club: BoundClubTime,
  selection: FinanceDashboardSelection
) {
  const [series, latestSnapshot] = await Promise.all([
    buildFinanceMonthlyBalanceSeries(selection.primary, {
      currentMonth: selection.currentMonth,
    }),
    loadLatestBankBalancesSnapshot(club),
  ]);
  const monthPoints = series.points.filter((point) => point.hasData);
  const averageMonthEndCents =
    monthPoints.length > 0
      ? Math.round(
          monthPoints.reduce((total, point) => total + point.bankCents, 0) /
            monthPoints.length
        )
      : 0;
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Latest bank balance",
      value: latestSnapshot ? latestSnapshot.totalBalance : "Unavailable",
      description: "Latest stored bank summary balance from Xero snapshots.",
      footnote: latestSnapshot?.sourceUpdatedAtLabel,
    },
    {
      title: "Average month-end balance",
      value: formatDollarsDisplay(averageMonthEndCents),
      description: "Average of stored month-end bank balances in the selected range.",
    },
    {
      title: "Accounts tracked",
      value: formatNumber(series.latestBankAccounts.length),
      description: "Bank accounts present in the latest stored month.",
    },
  ];
  return {
    cards,
    trends: [
      {
        title: "Bank balance trend",
        description: "Month-end bank balances across the selected period.",
        variant: "line" as const,
        xKey: "label",
        data: monthPoints.map((point) => ({
          label: point.isProvisional ? `${point.label} (MTD)` : point.label,
          balance: point.bankCents,
        })),
        series: [
          {
            key: "balance",
            name: "Bank balance",
            color: SERIES_COLORS.cash,
            valueType: "currency" as const,
          },
        ],
      },
    ],
    mix:
      series.latestBankAccounts.length > 0
        ? {
            title: "Account mix",
            description: "Latest month-end bank balance by account.",
            valueType: "currency" as const,
            data: series.latestBankAccounts.map((account) => ({
              name: account.label,
              value: account.balanceCents,
            })),
          }
        : null,
    statusPanels: [],
    costFilters: null,
    sourceNotes: [
      {
        label: "Cash source",
        description:
          "Cash comes from stored monthly Xero balance-sheet bank balances, not live bank feeds or local payment totals.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Month-end balances",
        rows: monthPoints.map((point) => ({
          Month: point.label,
          Balance: formatCents(point.bankCents),
          MonthToDate: point.isProvisional ? "yes" : "",
        })),
      },
      {
        title: "Accounts",
        rows: series.latestBankAccounts.map((account) => ({
          Account: account.label,
          Balance: formatCents(account.balanceCents),
        })),
      },
    ],
    warnings:
      series.monthsWithData === 0
        ? [
            `No monthly Xero balance data is stored for ${selection.primary.label}. Run the finance sync, or the monthly-facts backfill for older history.`,
          ]
        : [],
  };
}

async function buildBalanceOrWorkingCapitalDashboard(input: {
  selection: FinanceDashboardSelection;
  workingCapitalOnly: boolean;
}) {
  const series = await buildFinanceMonthlyBalanceSeries(input.selection.primary, {
    currentMonth: input.selection.currentMonth,
  });
  const monthPoints = series.points.filter((point) => point.hasData);
  const latest = series.latest;
  const currentRatio =
    latest && latest.currentLiabilitiesCents !== 0
      ? latest.currentAssetsCents / latest.currentLiabilitiesCents
      : null;
  const cards: FinanceDashboardKpiCard[] = input.workingCapitalOnly
    ? [
        {
          title: "Current assets",
          value: latest ? formatDollarsDisplay(latest.currentAssetsCents) : "Unavailable",
          description: "Current assets at the latest stored month end.",
        },
        {
          title: "Current liabilities",
          value: latest
            ? formatDollarsDisplay(latest.currentLiabilitiesCents)
            : "Unavailable",
          description: "Current liabilities at the latest stored month end.",
        },
        {
          title: "Working capital",
          value: latest ? formatDollarsDisplay(latest.workingCapitalCents) : "Unavailable",
          description: "Current assets less current liabilities.",
        },
        {
          title: "Current ratio",
          value: currentRatio === null ? "Unavailable" : `${currentRatio.toFixed(2)}x`,
          description: "Current assets divided by current liabilities.",
        },
      ]
    : [
        {
          title: "Total assets",
          value: latest ? formatDollarsDisplay(latest.assetsCents) : "Unavailable",
          description: "Assets at the latest stored month end.",
        },
        {
          title: "Total liabilities",
          value: latest ? formatDollarsDisplay(latest.liabilitiesCents) : "Unavailable",
          description: "Liabilities at the latest stored month end.",
        },
        {
          title: "Net assets",
          value: latest ? formatDollarsDisplay(latest.netAssetsCents) : "Unavailable",
          description: "Assets less liabilities at the latest stored month end.",
        },
        {
          title: "Months covered",
          value: `${series.monthsWithData} of ${financeDashboardMonthCount(input.selection.primary)}`,
          description: "Selected months with stored balance-sheet data.",
        },
      ];
  const trend = input.workingCapitalOnly
    ? {
        title: "Working capital trend",
        description:
          "Month-end current assets, current liabilities, and working capital.",
        variant: "line" as const,
        xKey: "label",
        data: monthPoints.map((point) => ({
          label: point.isProvisional ? `${point.label} (MTD)` : point.label,
          currentAssets: point.currentAssetsCents,
          currentLiabilities: point.currentLiabilitiesCents,
          workingCapital: point.workingCapitalCents,
        })),
        series: [
          {
            key: "currentAssets",
            name: "Current assets",
            color: SERIES_COLORS.positive,
            valueType: "currency" as const,
          },
          {
            key: "currentLiabilities",
            name: "Current liabilities",
            color: SERIES_COLORS.costs,
            valueType: "currency" as const,
          },
          {
            key: "workingCapital",
            name: "Working capital",
            color: SERIES_COLORS.cash,
            valueType: "currency" as const,
          },
        ],
      }
    : {
        title: "Balance sheet trend",
        description: "Month-end assets, liabilities, and net assets.",
        variant: "line" as const,
        xKey: "label",
        data: monthPoints.map((point) => ({
          label: point.isProvisional ? `${point.label} (MTD)` : point.label,
          assets: point.assetsCents,
          liabilities: point.liabilitiesCents,
          netAssets: point.netAssetsCents,
        })),
        series: [
          {
            key: "assets",
            name: "Assets",
            color: SERIES_COLORS.positive,
            valueType: "currency" as const,
          },
          {
            key: "liabilities",
            name: "Liabilities",
            color: SERIES_COLORS.costs,
            valueType: "currency" as const,
          },
          {
            key: "netAssets",
            name: "Net assets",
            color: SERIES_COLORS.cash,
            valueType: "currency" as const,
          },
        ],
      };

  return {
    cards,
    trends: [trend],
    mix:
      !input.workingCapitalOnly && latest
        ? {
            title: "Latest composition",
            description: "Latest month-end balance sheet composition.",
            valueType: "currency" as const,
            data: [
              { name: "Assets", value: latest.assetsCents },
              { name: "Liabilities", value: latest.liabilitiesCents },
              { name: "Net assets", value: latest.netAssetsCents },
            ],
          }
        : null,
    statusPanels: [],
    costFilters: null,
    sourceNotes: [
      {
        label: "Balance-sheet source",
        description:
          "Balance sheet and working-capital figures come from stored monthly Xero account balances (month-end positions per account). Drill into Xero for day-level detail.",
        // Same rule as the P&L views' source note above (#2314 review).
        href: buildXeroReportsUrl({ shortCode: await getXeroOrgShortCode() }),
        linkLabel: "Open Xero reports",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Month-end positions",
        rows: monthPoints.map((point) => ({
          Month: point.label,
          Assets: formatCents(point.assetsCents),
          Liabilities: formatCents(point.liabilitiesCents),
          NetAssets: formatCents(point.netAssetsCents),
          CurrentAssets: formatCents(point.currentAssetsCents),
          CurrentLiabilities: formatCents(point.currentLiabilitiesCents),
          WorkingCapital: formatCents(point.workingCapitalCents),
          MonthToDate: point.isProvisional ? "yes" : "",
        })),
      },
    ],
    warnings:
      series.monthsWithData === 0
        ? [
            `No monthly Xero balance-sheet data is stored for ${input.selection.primary.label}. Run the finance sync, or the monthly-facts backfill for older history.`,
          ]
        : [],
  };
}

const SYNC_HEALTH_BADGE_TONES: Record<
  FinanceSyncHealthTone,
  "success" | "warning" | "destructive"
> = {
  green: "success",
  amber: "warning",
  red: "destructive",
};

const SYNC_HEALTH_BADGE_LABELS: Record<FinanceSyncHealthTone, string> = {
  green: "OK",
  amber: "Attention",
  red: "Action",
};

async function buildSyncHealthDashboard(
  selection: FinanceDashboardSelection
): Promise<FinanceDashboardViewModel> {
  const health = await buildFinanceSyncHealth({
    currentMonth: selection.currentMonth,
  });

  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Sync confidence",
      value: health.overallLabel,
      description:
        "Worst signal across the daily sync, reconciliation, Xero operations, and stored monthly facts.",
    },
    ...health.sections.map((section) => {
      const worst =
        section.signals.find((signal) => signal.tone === section.tone) ??
        section.signals[0];
      return {
        title: section.title,
        value: worst?.value ?? "No signals",
        description: worst?.detail ?? section.description,
        footnote: worst && worst.label !== section.title ? worst.label : undefined,
      };
    }),
  ];

  const statusPanels: FinanceDashboardStatusPanel[] = health.sections.map(
    (section) => ({
      title: section.title,
      description: section.description,
      badgeLabel: SYNC_HEALTH_BADGE_LABELS[section.tone],
      badgeTone: SYNC_HEALTH_BADGE_TONES[section.tone],
      items: section.signals.map((signal) => ({
        label: signal.label,
        value: signal.value,
        detail: signal.detail,
        emphasis: signal.tone !== "green",
        href: signal.href,
        linkLabel: signal.linkLabel,
      })),
    })
  );

  return {
    cards,
    trends: [],
    mix: null,
    statusPanels,
    costFilters: null,
    sourceNotes: [
      {
        label: "Health signals",
        description:
          "Aggregates the sync diagnostics, revenue reconciliation, Xero operation outbox, and monthly fact freshness the platform already tracks. Opening this view does not call Xero live.",
      },
      {
        label: "Fixing issues",
        description:
          "Failed or pending operations are retried from the Xero admin console; category mapping gaps are fixed in the setup mappings panel.",
        href: "/admin/xero",
        linkLabel: "Open Xero admin",
      },
    ],
    exportSections: [
      {
        title: "Sync health signals",
        rows: health.sections.flatMap((section) =>
          section.signals.map((signal) => ({
            Section: section.title,
            Signal: signal.label,
            Value: signal.value,
            Status: signal.tone,
            Detail: signal.detail ?? "",
          }))
        ),
      },
    ],
    warnings: health.warnings,
  };
}

export async function buildFinanceDashboardPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: SearchParams;
}): Promise<FinanceDashboardPageModel> {
  /*
    THE CLUB'S ZONE, RESOLVED ONCE FOR THE WHOLE PAGE (#3123; INV-CONFIG-002).

    This is the finance dashboard's single zone boundary, and everything below
    is handed the binding rather than reaching for one of its own.
    `clubTime()` is `cache()`-wrapped, so the persisted row is read once per
    render pass no matter how many builders ask.

    IT ALSO SUPPLIES `today`. `finance-dashboard-ranges.ts` is on the browser
    graph and may not read a zone at all, so the day that picks the reporting
    month and the financial-year bucket is resolved here and threaded in — one
    value, from one authority, instead of three `getTodayDateOnly()` reads of
    the container's clock.

    THE READER IS THE `server-only` ONE, and that was checked rather than
    assumed: `cli-server-only-reach-census.test.ts` walks the real static import
    graph from every `tsx` entrypoint and reports no operator script reaching
    this module. `server-only` throws at import outside the react-server
    condition, so a CLI edge here would break `npm run` scripts that no route
    test covers.
  */
  const club = await clubTime();
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  // Booking-derived reporting scope (occupancy, guest nights, booked revenue).
  // ADR-002: only expose the selector once a second active lodge exists — a
  // single-lodge club gets an empty list and no selector. An unknown/omitted
  // lodgeId param falls back to all active lodges (summed-capacity denominator).
  const requestedLodgeId =
    typeof input.searchParams?.lodgeId === "string"
      ? input.searchParams.lodgeId
      : undefined;
  const selectableLodges = activeLodges.length > 1 ? activeLodges : [];
  const selectedLodgeId =
    requestedLodgeId &&
    selectableLodges.some((lodge) => lodge.id === requestedLodgeId)
      ? requestedLodgeId
      : null;

  // Which lodge (if any) the seasons are read for. The view select and the lodge
  // select share one GET form, so switching from Bookings to an accounting view
  // resubmits the lodgeId the previous view had — on a page that then renders no
  // lodge selector at all. Honouring it there would let an invisible lodge set
  // the forward window, or raise a "configure seasons" warning with no control
  // to explain or clear it (review finding, #2919). The view is resolved from the
  // query string alone, which needs no seasons, so there is no cycle; and the
  // "which views are lodge-scoped" rule lives once, in
  // FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS, shared with the client's render gate.
  const seasonLodgeId = financeDashboardViewUsesLodgeScope(
    resolveFinanceDashboardView(input.searchParams)
  )
    ? selectedLodgeId
    : null;
  // Seed the financial-year cache (override → Xero org → March default) so
  // FY-aligned ranges resolve correctly before the selection is built. The
  // seasons read is resolved AFTER the lodge scope (#2919) because it honours
  // it, exactly as the occupancy and pricing reads below do.
  const [seasons, sync, financialYearEndMonth] = await Promise.all([
    loadSeasons(seasonLodgeId, seasonLodgeId === null && selectableLodges.length > 1),
    buildSyncStatus(club),
    refreshFinancialYearConfig(),
  ]);
  const selection = resolveFinanceDashboardSelection({
    searchParams: input.searchParams,
    today: dateOnlyInstantOf(club.today()),
    seasons,
    financialYearEndMonth,
  });
  const labels = buildSelectionLabels(selection);

  let viewModel: FinanceDashboardViewModel;
  let ratios: FinanceDashboardRatioExplorerModel | null = null;

  if (selection.view === "bookings") {
    viewModel = await buildBookingsDashboard(selection, selectedLodgeId);
  } else if (selection.view === "revenue") {
    viewModel = await buildRevenueDashboard(selection);
  } else if (selection.view === "costs") {
    const costsModel = await buildMappedPnlDashboard({
      selection,
      kind: "EXPENSE",
    });
    await appendFinancialYearsPanel(costsModel, selection, "EXPENSE");
    viewModel = costsModel;
  } else if (selection.view === "ratios") {
    const ratiosModel = await buildRatiosDashboard(selection);
    ratios = ratiosModel.ratios;
    viewModel = ratiosModel;
  } else if (selection.view === "pricing-sensitivity") {
    viewModel = await buildPricingSensitivityDashboard(selection, selectedLodgeId);
  } else if (selection.view === "cash") {
    viewModel = await buildCashDashboard(club, selection);
  } else if (selection.view === "working-capital") {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: true,
    });
  } else if (selection.view === "sync-health") {
    viewModel = await buildSyncHealthDashboard(selection);
  } else {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: false,
    });
  }

  return {
    generatedOn: formatDateTime(club, new Date()),
    isManager: hasFinanceManagerAccess(input.member),
    selection,
    ratios,
    selectionLabels: labels,
    syncStatus: sync.status,
    warnings: [
      ...selection.warnings,
      ...sync.warnings,
      ...viewModel.warnings,
    ],
    cards: viewModel.cards,
    trends: viewModel.trends,
    mix: viewModel.mix,
    statusPanels: viewModel.statusPanels,
    costFilters: viewModel.costFilters,
    sourceNotes: viewModel.sourceNotes,
    lodges: selectableLodges,
    selectedLodgeId,
    exportSections: [
      {
        title: "Dashboard selection",
        rows: [
          {
            View: labels.view,
            Range: labels.range,
            PrimaryWindow: labels.primaryWindow,
            Compare: labels.compare,
            ComparisonWindow: labels.comparisonWindow,
            Forward: labels.forward,
            ForwardWindow: labels.forwardWindow,
          },
        ],
      },
      ...viewModel.exportSections,
    ],
  };
}
