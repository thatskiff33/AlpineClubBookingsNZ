/**
 * Ratio-explorer data for the finance dashboard's committee view.
 *
 * The committee's core question is "expense X as a share of income Y across
 * financial years" (e.g. catering cost ÷ hut-fee income for this FY, last FY,
 * and the FY before). This module builds a category-by-month matrix over the
 * full stored fact-table history — small enough to ship to the client whole
 * (~a dozen categories × the org's months), so the explorer's dropdowns and
 * range chips recompute instantly without a round trip. Pure helpers shared
 * with the client live in finance-ratio-shared.ts.
 */

import { FinanceMonthlyStatementKind } from "@prisma/client";
import { listMonthlyFacts } from "@/lib/finance-monthly-fact-store";
import {
  FINANCE_RATIO_TOTAL_EXPENSES_ID,
  FINANCE_RATIO_TOTAL_INCOME_ID,
  financeFinancialYearBuckets,
  sumRatioSeries,
  type FinanceRatioMatrix,
  type FinanceRatioSeries,
} from "@/lib/finance-ratio-shared";
import {
  listFinanceReportCategories,
  UNMAPPED_FINANCE_CATEGORY_ID,
} from "@/lib/finance-report-mappings";
import { must } from "@/lib/indexed-access";

/** Full-history query floor; Xero orgs do not predate this. */
const MATRIX_FROM_MONTH = "2000-01";

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Add cents to a series' month bucket at `index`. `index` always comes from
 * `monthIndex`, built from the same `months` array every series' `valuesCents`
 * is sized to (`zeroes()`), so the position is always in range.
 */
function addCentsAtMonth(series: FinanceRatioSeries, index: number, amountCents: number): void {
  const current = must(
    series.valuesCents[index],
    `buildFinanceRatioMatrix: series ${series.id} has no month at index ${index}`
  );
  series.valuesCents[index] = current + amountCents;
}

export async function buildFinanceRatioMatrix(input: {
  financialYearEndMonth: number;
  currentMonth: string;
}): Promise<FinanceRatioMatrix> {
  const [categories, facts] = await Promise.all([
    listFinanceReportCategories(),
    listMonthlyFacts({
      statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
      fromMonth: MATRIX_FROM_MONTH,
      toMonth: input.currentMonth,
    }),
  ]);

  const months = Array.from(new Set(facts.map((record) => record.month))).sort();
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const provisionalMonths = Array.from(
    new Set(
      facts.filter((record) => record.isProvisional).map((record) => record.month)
    )
  ).sort();

  const active = categories.filter((category) => !category.archived);
  const categoryByCode = new Map<string, (typeof active)[number]>();
  for (const category of active) {
    for (const mapping of category.mappings) {
      const code = normalizeCode(mapping.accountCode);
      if (code && !categoryByCode.has(code)) {
        categoryByCode.set(code, category);
      }
    }
  }

  const zeroes = () => new Array<number>(months.length).fill(0);
  const seriesById = new Map<string, FinanceRatioSeries>();
  const ensureSeries = (
    id: string,
    name: string,
    kind: "REVENUE" | "EXPENSE",
    isTotal = false
  ): FinanceRatioSeries => {
    const existing = seriesById.get(id);
    if (existing) {
      return existing;
    }
    const created: FinanceRatioSeries = {
      id,
      name,
      kind,
      isTotal,
      valuesCents: zeroes(),
    };
    seriesById.set(id, created);
    return created;
  };

  // Stable ordering: totals first, then categories in treasurer sort order,
  // then the synthetic unmapped buckets when they carry data.
  const totalIncome = ensureSeries(
    FINANCE_RATIO_TOTAL_INCOME_ID,
    "Total income",
    "REVENUE",
    true
  );
  const totalExpenses = ensureSeries(
    FINANCE_RATIO_TOTAL_EXPENSES_ID,
    "Total expenses",
    "EXPENSE",
    true
  );
  for (const category of [...active].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  )) {
    ensureSeries(category.id, category.name, category.kind);
  }

  for (const record of facts) {
    const index = monthIndex.get(record.month);
    if (index === undefined) {
      continue;
    }

    const mapped = categoryByCode.get(normalizeCode(record.accountCode));
    const kind =
      mapped?.kind ??
      (record.accountClass?.toUpperCase() === "REVENUE" ? "REVENUE" : "EXPENSE");

    if (mapped) {
      addCentsAtMonth(seriesById.get(mapped.id)!, index, record.amountCents);
    } else {
      const unmappedId = `${UNMAPPED_FINANCE_CATEGORY_ID}-${kind.toLowerCase()}`;
      addCentsAtMonth(
        ensureSeries(
          unmappedId,
          kind === "REVENUE" ? "Unmapped income" : "Unmapped expenses",
          kind
        ),
        index,
        record.amountCents
      );
    }

    if (kind === "REVENUE") {
      addCentsAtMonth(totalIncome, index, record.amountCents);
    } else {
      addCentsAtMonth(totalExpenses, index, record.amountCents);
    }
  }

  return {
    months,
    provisionalMonths,
    series: Array.from(seriesById.values()),
    financialYearEndMonth: input.financialYearEndMonth,
    currentMonth: input.currentMonth,
  };
}

/**
 * Per-category totals for the three committee financial-year buckets — the
 * "Financial years" panel on the revenue and costs views.
 */
export function buildFinanceFinancialYearsPanelItems(input: {
  matrix: FinanceRatioMatrix;
  kind: "REVENUE" | "EXPENSE";
  formatCents: (cents: number) => string;
}): Array<{ label: string; value: string; detail: string; emphasis?: boolean }> {
  const buckets = financeFinancialYearBuckets(input.matrix);
  const rows = input.matrix.series.filter(
    (series) => series.kind === input.kind && !series.isTotal
  );
  const totalsRow = input.matrix.series.find(
    (series) =>
      series.id ===
      (input.kind === "REVENUE"
        ? FINANCE_RATIO_TOTAL_INCOME_ID
        : FINANCE_RATIO_TOTAL_EXPENSES_ID)
  );

  const bucketDetail = (
    series: Pick<FinanceRatioSeries, "valuesCents">
  ): string =>
    `${buckets[1].label} ${input.formatCents(
      sumRatioSeries(input.matrix, series, buckets[1])
    )} · ${buckets[2].label} ${input.formatCents(
      sumRatioSeries(input.matrix, series, buckets[2])
    )}`;

  const items = rows.map((series) => ({
    label: series.name,
    value: input.formatCents(sumRatioSeries(input.matrix, series, buckets[0])),
    detail: bucketDetail(series),
  }));

  if (totalsRow) {
    return [
      {
        label: totalsRow.name,
        value: input.formatCents(
          sumRatioSeries(input.matrix, totalsRow, buckets[0])
        ),
        detail: bucketDetail(totalsRow),
        emphasis: true,
      },
      ...items,
    ];
  }

  return items;
}
