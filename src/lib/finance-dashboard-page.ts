import { FinanceSnapshotType } from "@prisma/client";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  parseBalanceSheetSnapshot,
  type ParsedBalanceSheetSnapshot,
} from "@/lib/finance-balance-sheet-report-page";
import {
  getFinanceBookingMetrics,
  type FinanceBookingMetricsResult,
} from "@/lib/finance-booking-metrics";
import { parseCashSnapshot } from "@/lib/finance-cash-report-page";
import type { ParsedCashSnapshot } from "@/lib/finance-cash-report-page";
import {
  FINANCE_DASHBOARD_COMPARE_LABELS,
  FINANCE_DASHBOARD_FORWARD_LABELS,
  FINANCE_DASHBOARD_RANGE_LABELS,
  FINANCE_DASHBOARD_VIEW_LABELS,
  financeDashboardDateRangeDayCount,
  financeDashboardWindowDetail,
  resolveFinanceDashboardSelection,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import {
  buildFinanceMappedPnlSummary,
} from "@/lib/finance-report-mappings";
import { buildFinanceRevenueReconciliation } from "@/lib/finance-revenue-reconciliation";
import type { FinanceAccessMember } from "@/lib/finance-auth";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

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

export interface FinanceDashboardKpiCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceDashboardTrend {
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

export interface FinanceDashboardMix {
  title: string;
  description: string;
  valueType: "currency" | "count" | "percent" | "ratio";
  data: Array<{ name: string; value: number }>;
}

export interface FinanceDashboardStatusPanel {
  title: string;
  description: string;
  badgeLabel?: string;
  badgeTone?: "success" | "warning" | "destructive" | "secondary";
  items: Array<{
    label: string;
    value: string;
    detail?: string;
  }>;
}

export interface FinanceDashboardExportSection {
  title: string;
  rows: Array<Record<string, string | number>>;
}

export interface FinanceDashboardCostFilters {
  categories: Array<{ id: string; label: string }>;
  lines: Array<{ value: string; label: string; categoryId: string }>;
}

export interface FinanceDashboardSyncStatus {
  label: string;
  tone: "success" | "warning" | "destructive" | "secondary";
  detail: string;
  lastSyncedAt: string | null;
}

export interface FinanceDashboardPageModel {
  generatedOn: string;
  isManager: boolean;
  selection: FinanceDashboardSelection;
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
  sourceNotes: Array<{ label: string; description: string }>;
  exportSections: FinanceDashboardExportSection[];
}

const SERIES_COLORS = {
  revenue: "#ffcb05",
  costs: "#ff7c12",
  bookings: "#6a6a63",
  cash: "#2563eb",
  positive: "#16a34a",
  negative: "#dc2626",
  neutral: "#4d4d46",
} as const;

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(APP_LOCALE, {
    maximumFractionDigits,
  }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSignedCents(value: number) {
  if (value === 0) {
    return formatCents(0);
  }
  return `${value > 0 ? "+" : "-"}${formatCents(Math.abs(value))}`;
}

function formatDateTime(value: string | Date) {
  return new Date(value).toLocaleString(APP_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: APP_TIME_ZONE,
  });
}

function formatShortDate(dateOnly: string) {
  return new Date(`${dateOnly}T00:00:00.000Z`).toLocaleDateString(APP_LOCALE, {
    day: "numeric",
    month: "short",
    timeZone: APP_TIME_ZONE,
  });
}

function cardRows(cards: FinanceDashboardKpiCard[]) {
  return cards.map((card) => ({
    Metric: card.title,
    Value: card.value,
    Description: card.description,
    Footnote: card.footnote ?? "",
  }));
}

async function loadSeasons() {
  return prisma.season.findMany({
    where: { active: true },
    select: {
      name: true,
      startDate: true,
      endDate: true,
      active: true,
    },
    orderBy: [{ startDate: "asc" }],
  });
}

async function buildSyncStatus(): Promise<{
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
        detail: `${latest.snapshotCount} snapshots, ${latest.totalRowCount} rows. ${formatDateTime(completedOrStarted)}.`,
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
    forwardWindow: financeDashboardWindowDetail(selection.forwardWindow),
  };
}

async function buildBookingsDashboard(
  selection: FinanceDashboardSelection
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
  };
  const comparisonQuery = {
    realized: {
      from: selection.comparison.from,
      to: selection.comparison.to,
      cutoffDate: selection.comparison.to,
    },
  };
  const [metrics, comparison] = await Promise.all([
    getFinanceBookingMetrics(query),
    getFinanceBookingMetrics(comparisonQuery),
  ]);
  const realized = metrics.realized;
  const compareRealized = comparison.realized;

  if (!realized) {
    warnings.push("Realized booking metrics were unavailable for the selected range.");
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
      value: formatCents(realizedTotals?.bookedRevenueCents ?? 0),
      description: "Booking-system revenue allocated across realized stay nights.",
      footnote: compareTotals
        ? `${formatSignedCents((realizedTotals?.bookedRevenueCents ?? 0) - compareTotals.bookedRevenueCents)} vs comparison.`
        : undefined,
    },
    {
      title: "Net collected cash",
      value: formatCents(metrics.paymentSummary.netCollectedCents),
      description: "Captured payments less refunds from local payment rows.",
      footnote: "Cash is local payment-derived and separate from Xero revenue.",
    },
    {
      title: "Forward demand",
      value: formatNumber(metrics.forward?.totals.totalPipeline.guestNights ?? 0),
      description: "Committed plus at-risk future guest nights in the forward window.",
      footnote: selection.forwardWindow.from
        ? selection.forwardWindow.label
        : "Forward window unavailable.",
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
          detail: `${formatNumber(summary.bookingCount)} bookings, ${formatCents(summary.bookedRevenueCents)}`,
        })
      ),
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
          detail: formatCents(metrics.forward.totals.committed.bookedRevenueCents),
        },
        {
          label: "At risk",
          value: formatNumber(metrics.forward.totals.atRisk.guestNights),
          detail: formatCents(metrics.forward.totals.atRisk.bookedRevenueCents),
        },
      ],
    });
  }
  return panels;
}

async function buildMappedPnlDashboard(input: {
  selection: FinanceDashboardSelection;
  kind: "REVENUE" | "EXPENSE";
}) {
  const summary = await buildFinanceMappedPnlSummary({
    kind: input.kind,
    from: input.selection.primary.from,
    to: input.selection.primary.to,
    compareFrom: input.selection.comparison.from,
    compareTo: input.selection.comparison.to,
    expenseCategoryId: input.selection.expenseCategoryId,
    expenseLine: input.selection.expenseLine,
  });

  const noun = input.kind === "REVENUE" ? "revenue" : "costs";
  const largest = summary.groups[0];
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: input.kind === "REVENUE" ? "Mapped revenue" : "Mapped costs",
      value: summary.formattedAmount,
      description: `Selected-period ${noun} from stored monthly profit-and-loss snapshots.`,
      footnote: `${summary.formattedDelta} vs ${summary.formattedComparisonAmount} comparison.`,
    },
    {
      title: "Comparison period",
      value: summary.formattedComparisonAmount,
      description: `${input.selection.comparison.label} snapshot total.`,
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
        formatCents(0),
      description:
        "Unmapped P&L lines remain in totals so missing mappings cannot hide data.",
    },
  ];
  const trends: FinanceDashboardTrend[] = [
    {
      title:
        input.kind === "REVENUE"
          ? "Revenue trend"
          : "Cost trend",
      description: `Stored Xero P&L ${noun} across snapshots covering the selected period.`,
      variant: "bar",
      xKey: "label",
      data: summary.trend.map((point) => ({
        label: point.label,
        amount: point.amountCents,
      })),
      series: [
        {
          key: "amount",
          name: input.kind === "REVENUE" ? "Revenue" : "Costs",
          color:
            input.kind === "REVENUE"
              ? SERIES_COLORS.revenue
              : SERIES_COLORS.costs,
          valueType: "currency",
        },
      ],
    },
  ];
  const statusPanels: FinanceDashboardStatusPanel[] = [
    {
      title: input.kind === "REVENUE" ? "Revenue groups" : "Expense groups",
      description:
        "Mapped Treasurer-controlled groups, with Unmapped kept visible.",
      items: summary.groups.slice(0, 8).map((group) => ({
        label: group.name,
        value: group.formattedAmount,
        detail: `${group.lineCount} lines, ${group.formattedDelta} vs comparison`,
      })),
    },
  ];
  const exportSections = [
    { title: "KPI cards", rows: cardRows(cards) },
    {
      title: input.kind === "REVENUE" ? "Revenue groups" : "Expense groups",
      rows: summary.groups.map((group) => ({
        Group: group.name,
        Amount: group.formattedAmount,
        Comparison: group.formattedComparisonAmount,
        Delta: group.formattedDelta,
        Lines: group.lineCount,
      })),
    },
    {
      title: "Lines",
      rows: summary.groups.flatMap((group) =>
        group.lines.map((line) => ({
          Group: group.name,
          Section: line.sectionLabel,
          Line: line.lineLabel,
          AccountCode: line.accountCode ?? "",
          Amount: line.formattedAmount,
          Comparison: line.formattedComparisonAmount,
          Delta: line.formattedDelta,
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
        label: "Xero snapshots",
        description:
          "Revenue and costs come from stored Xero profit-and-loss snapshots. Opening the dashboard does not call Xero live.",
      },
      {
        label: "Mappings",
        description:
          "Treasurer-controlled setup mappings group P&L account codes or fallback section/line labels. Unmapped lines are included in totals.",
      },
    ],
    exportSections,
    warnings: summary.warnings,
  };
}

async function buildRevenueDashboard(selection: FinanceDashboardSelection) {
  const mapped = await buildMappedPnlDashboard({ selection, kind: "REVENUE" });
  try {
    const periods = Math.max(
      1,
      Math.min(12, Math.ceil(financeDashboardDateRangeDayCount(selection.primary) / 31))
    );
    const reconciliation = await buildFinanceRevenueReconciliation({ periods });
    mapped.statusPanels.push({
      title: "Xero vs booking reconciliation",
      description:
        "Hut-fee income from Xero compared with booking-system hut fee revenue.",
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

async function buildPricingSensitivityDashboard(selection: FinanceDashboardSelection) {
  const [costs, metrics] = await Promise.all([
    buildFinanceMappedPnlSummary({
      kind: "EXPENSE",
      from: selection.primary.from,
      to: selection.primary.to,
      compareFrom: selection.comparison.from,
      compareTo: selection.comparison.to,
    }),
    getFinanceBookingMetrics({
      realized: {
        from: selection.primary.from,
        to: selection.primary.to,
        cutoffDate: selection.primary.to,
      },
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
      value: formatSignedCents(bookedRevenueLessCostsCents),
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
          detail: `Revenue at realized rate ${formatCents(scenario.realizedRevenue)}`,
        })),
      },
    ],
    costFilters: null,
    sourceNotes: [
      {
        label: "Cost source",
        description: "Costs come from stored Xero P&L snapshots and setup mappings.",
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

async function loadSnapshotsForRange(
  snapshotType: FinanceSnapshotType,
  selection: FinanceDashboardSelection
) {
  const snapshots = await listFinanceSnapshots({
    snapshotType,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 100,
  });
  const from = new Date(`${selection.primary.from}T00:00:00.000Z`);
  const to = new Date(`${selection.primary.to}T00:00:00.000Z`);
  return snapshots.filter((snapshot) => {
    const end = snapshot.periodEnd ?? snapshot.asOfDate;
    const start = snapshot.periodStart ?? snapshot.asOfDate;
    return end >= from && start <= to;
  });
}

async function buildCashDashboard(selection: FinanceDashboardSelection) {
  const snapshots = await loadSnapshotsForRange(
    FinanceSnapshotType.BANK_BALANCES,
    selection
  );
  const parsed = snapshots
    .map(parseCashSnapshot)
    .filter((snapshot): snapshot is ParsedCashSnapshot => snapshot !== null);
  const latest = parsed[0] ?? null;
  const average =
    parsed.length > 0
      ? Math.round(
          parsed.reduce((total, snapshot) => total + snapshot.totalBalanceCents, 0) /
            parsed.length
        )
      : 0;
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Latest bank balance",
      value: latest ? latest.totalBalance : "Unavailable",
      description: "Latest stored bank summary balance from Xero snapshots.",
      footnote: latest?.sourceUpdatedAtLabel,
    },
    {
      title: "Average stored balance",
      value: formatCents(average),
      description: "Average across stored bank-balance snapshots in the selected range.",
    },
    {
      title: "Accounts tracked",
      value: formatNumber(latest?.accountCount ?? 0),
      description: "Bank accounts present in the latest stored snapshot.",
    },
  ];
  return {
    cards,
    trends: [
      {
        title: "Bank balance trend",
        description: "Stored bank balance snapshots across the selected period.",
        variant: "line" as const,
        xKey: "label",
        data: [...parsed].reverse().map((snapshot) => ({
          label: snapshot.snapshotLabel,
          balance: snapshot.totalBalanceCents,
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
    mix: latest
      ? {
          title: "Account mix",
          description: "Latest stored bank balance by account.",
          valueType: "currency" as const,
          data: latest.accounts.map((account) => ({
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
          "Cash comes from stored Xero bank-balance snapshots, not live bank feeds or local payment totals.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Accounts",
        rows: latest
          ? latest.accounts.map((account) => ({
              Account: account.label,
              Balance: formatCents(account.balanceCents),
            }))
          : [],
      },
    ],
    warnings:
      snapshots.length === 0
        ? ["No stored bank-balance snapshots cover the selected range."]
        : [],
  };
}

async function buildBalanceOrWorkingCapitalDashboard(input: {
  selection: FinanceDashboardSelection;
  workingCapitalOnly: boolean;
}) {
  const snapshots = await loadSnapshotsForRange(
    FinanceSnapshotType.BALANCE_SHEET,
    input.selection
  );
  const parsed = snapshots
    .map(parseBalanceSheetSnapshot)
    .filter(
      (snapshot): snapshot is ParsedBalanceSheetSnapshot => snapshot !== null
    );
  const latest = parsed[0] ?? null;
  const cards: FinanceDashboardKpiCard[] = input.workingCapitalOnly
    ? [
        {
          title: "Current assets",
          value: latest?.currentAssets ?? "Unavailable",
          description: "Current assets from the latest stored balance sheet.",
        },
        {
          title: "Current liabilities",
          value: latest?.currentLiabilities ?? "Unavailable",
          description: "Current liabilities from the latest stored balance sheet.",
        },
        {
          title: "Working capital",
          value: latest?.workingCapital ?? "Unavailable",
          description: "Current assets less current liabilities.",
        },
        {
          title: "Current ratio",
          value: latest?.currentRatio === null || !latest ? "Unavailable" : `${latest.currentRatio.toFixed(2)}x`,
          description: "Current assets divided by current liabilities.",
        },
      ]
    : [
        {
          title: "Total assets",
          value: latest?.totalAssets ?? "Unavailable",
          description: "Assets from the latest stored balance sheet.",
        },
        {
          title: "Total liabilities",
          value: latest?.totalLiabilities ?? "Unavailable",
          description: "Liabilities from the latest stored balance sheet.",
        },
        {
          title: "Net assets",
          value: latest?.netAssets ?? "Unavailable",
          description: "Assets less liabilities from stored balance-sheet data.",
        },
        {
          title: "Lines tracked",
          value: formatNumber(latest?.lineItemCount ?? 0),
          description: "Balance-sheet lines present in the latest stored snapshot.",
        },
      ];
  const trend = input.workingCapitalOnly
    ? {
        title: "Working capital trend",
        description: "Current assets, liabilities, and working capital across stored snapshots.",
        variant: "line" as const,
        xKey: "label",
        data: [...parsed].reverse().map((snapshot) => ({
          label: snapshot.snapshotLabel,
          currentAssets: snapshot.currentAssetsCents ?? 0,
          currentLiabilities: snapshot.currentLiabilitiesCents ?? 0,
          workingCapital: snapshot.workingCapitalCents ?? 0,
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
        description: "Assets, liabilities, and net assets across stored snapshots.",
        variant: "line" as const,
        xKey: "label",
        data: [...parsed].reverse().map((snapshot) => ({
          label: snapshot.snapshotLabel,
          assets: snapshot.totalAssetsCents,
          liabilities: snapshot.totalLiabilitiesCents,
          netAssets: snapshot.netAssetsCents,
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
            description: "Latest stored balance sheet composition.",
            valueType: "currency" as const,
            data: [
              { name: "Assets", value: latest.totalAssetsCents },
              { name: "Liabilities", value: latest.totalLiabilitiesCents },
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
          "Balance sheet and working-capital figures come from stored Xero balance-sheet snapshots.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Snapshots",
        rows: parsed.map((snapshot) => ({
          Period: snapshot.snapshotLabel,
          Assets: snapshot.totalAssets,
          Liabilities: snapshot.totalLiabilities,
          NetAssets: snapshot.netAssets,
          CurrentAssets: snapshot.currentAssets ?? "",
          CurrentLiabilities: snapshot.currentLiabilities ?? "",
          WorkingCapital: snapshot.workingCapital ?? "",
        })),
      },
    ],
    warnings:
      snapshots.length === 0
        ? ["No stored balance-sheet snapshots cover the selected range."]
        : [],
  };
}

function formatSignedNumber(value: number) {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "-"}${formatNumber(Math.abs(value))}`;
}

export async function buildFinanceDashboardPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: SearchParams;
}): Promise<FinanceDashboardPageModel> {
  const [seasons, sync] = await Promise.all([loadSeasons(), buildSyncStatus()]);
  const selection = resolveFinanceDashboardSelection({
    searchParams: input.searchParams,
    seasons,
  });
  const labels = buildSelectionLabels(selection);

  let viewModel: FinanceDashboardViewModel;

  if (selection.view === "bookings") {
    viewModel = await buildBookingsDashboard(selection);
  } else if (selection.view === "revenue") {
    viewModel = await buildRevenueDashboard(selection);
  } else if (selection.view === "costs") {
    viewModel = await buildMappedPnlDashboard({ selection, kind: "EXPENSE" });
  } else if (selection.view === "pricing-sensitivity") {
    viewModel = await buildPricingSensitivityDashboard(selection);
  } else if (selection.view === "cash") {
    viewModel = await buildCashDashboard(selection);
  } else if (selection.view === "working-capital") {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: true,
    });
  } else {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: false,
    });
  }

  return {
    generatedOn: formatDateTime(new Date()),
    isManager: input.member.financeAccessLevel === "MANAGER",
    selection,
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
