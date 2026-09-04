import { FinanceSnapshotType } from "@prisma/client";
import type { BoundClubTime } from "@/lib/club-time";
import { parseCashSnapshot } from "@/lib/finance-cash-snapshot";
import {
  financeDashboardMonthCount,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import {
  formatDollarsDisplay,
  formatFinanceNumber as formatNumber,
} from "@/lib/finance-format";
import { buildFinanceMonthlyBalanceSeries } from "@/lib/finance-monthly-balance";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { formatCents } from "@/lib/utils";
import { xeroReportsSourceLink } from "@/lib/finance-dashboard-page/xero-reports-source-note";
import {
  cardRows,
  monthPointLabel,
  monthToDateCell,
  type FinanceDashboardKpiCard,
} from "@/lib/finance-dashboard-page/model";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";

async function loadLatestBankBalancesSnapshot(club: BoundClubTime) {
  const snapshots = await listFinanceSnapshots({
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 1,
  });
  return snapshots[0] ? parseCashSnapshot(club, snapshots[0]) : null;
}

export async function buildCashDashboard(
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
          label: monthPointLabel(point),
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
          MonthToDate: monthToDateCell(point),
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

export async function buildBalanceOrWorkingCapitalDashboard(input: {
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
          label: monthPointLabel(point),
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
          label: monthPointLabel(point),
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
        ...(await xeroReportsSourceLink()),
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
          MonthToDate: monthToDateCell(point),
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
