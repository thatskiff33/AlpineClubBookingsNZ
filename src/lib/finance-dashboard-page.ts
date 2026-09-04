import { FinanceSnapshotType } from "@prisma/client";
import { dateOnlyInstantOf, parseInstant, type BoundClubTime } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
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
import { buildBookingsDashboard } from "@/lib/finance-dashboard-page/bookings-view";
import {
  appendFinancialYearsPanel,
  buildMappedPnlDashboard,
  buildRevenueDashboard,
} from "@/lib/finance-dashboard-page/pnl-view";
import { buildRatiosDashboard } from "@/lib/finance-dashboard-page/ratios-view";
import {
  cardRows,
  type FinanceDashboardKpiCard,
  type FinanceDashboardPageModel,
  type FinanceDashboardRatioExplorerModel,
  type FinanceDashboardStatusPanel,
  type FinanceDashboardSyncStatus,
  type FinanceDashboardTrend,
  type FinanceDashboardViewModel,
} from "@/lib/finance-dashboard-page/model";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";
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

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * A real INSTANT — a sync run's completion stamp, or the moment this page model
 * was built — in the club's PERSISTED zone (#3123, `INV-CONFIG-002`).
 *
 * It used to go through `formatNZDateTime`, i.e. through `APP_TIME_ZONE`, so for
 * a club west of Greenwich the finance page could say its figures were last
 * synced on the wrong day. Unlike `formatShortDate` in `finance-dashboard-page/bookings-view.ts` — which renders a
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
