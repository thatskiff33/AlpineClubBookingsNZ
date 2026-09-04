import type { FinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import { buildFinanceRatioMatrix } from "@/lib/finance-ratio-insights";
import { financeFinancialYearBuckets } from "@/lib/finance-ratio-shared";
import { formatCents } from "@/lib/utils";
import type {
  FinanceDashboardRatioExplorerModel,
  FinanceDashboardViewModel,
} from "@/lib/finance-dashboard-page/model";

export async function buildRatiosDashboard(
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
