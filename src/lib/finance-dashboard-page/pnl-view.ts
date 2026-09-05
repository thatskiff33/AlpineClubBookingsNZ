import {
  financeDashboardMonthCount,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import { formatDollarsDisplay } from "@/lib/finance-format";
import {
  buildFinanceMonthlyPnlSummary,
} from "@/lib/finance-monthly-pnl";
import {
  buildFinanceFinancialYearsPanelItems,
  buildFinanceRatioMatrix,
} from "@/lib/finance-ratio-insights";
import { financeFinancialYearBuckets } from "@/lib/finance-ratio-shared";
import type { FinanceMappedPnlCategorySummary } from "@/lib/finance-report-mappings";
import { buildFinanceRevenueReconciliation } from "@/lib/finance-revenue-reconciliation";
import { xeroReportsSourceLink } from "@/lib/finance-dashboard-page/xero-reports-source-note";
import { formatCents } from "@/lib/utils";
import {
  cardRows,
  monthPointLabel,
  monthToDateCell,
  type FinanceDashboardKpiCard,
  type FinanceDashboardStatusPanel,
  type FinanceDashboardTrend,
} from "@/lib/finance-dashboard-page/model";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";

// Exact cents (reconciliation and export rows only; displays use whole dollars).
function formatSignedCents(value: number) {
  if (value === 0) {
    return formatCents(0);
  }
  return `${value > 0 ? "+" : "-"}${formatCents(Math.abs(value))}`;
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

export async function buildMappedPnlDashboard(input: {
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
        label: monthPointLabel(point),
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
        MonthToDate: monthToDateCell(point),
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
        ...(await xeroReportsSourceLink()),
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
export async function appendFinancialYearsPanel(
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

export async function buildRevenueDashboard(selection: FinanceDashboardSelection) {
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
