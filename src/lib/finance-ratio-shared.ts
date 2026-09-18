/**
 * Client-safe types and pure helpers for the finance ratio explorer. The
 * server builds the category-month matrix (finance-ratio-insights.ts); the
 * explorer component recomputes ratios instantly in the browser using these
 * helpers. No server imports allowed here.
 */

import { shiftMonthKey } from "@/lib/finance-monthly-facts";
import { must } from "@/lib/indexed-access";

export const FINANCE_RATIO_TOTAL_INCOME_ID = "total-income";
export const FINANCE_RATIO_TOTAL_EXPENSES_ID = "total-expenses";

export interface FinanceRatioSeries {
  id: string;
  name: string;
  kind: "REVENUE" | "EXPENSE";
  /** True for the synthetic Total income / Total expenses series. */
  isTotal: boolean;
  /** Cents per month, aligned to the matrix months array. */
  valuesCents: number[];
}

export interface FinanceRatioMatrix {
  /** Every month with stored P&L facts, oldest first ("YYYY-MM"). */
  months: string[];
  /** Months whose figures are provisional (month-to-date). */
  provisionalMonths: string[];
  series: FinanceRatioSeries[];
  financialYearEndMonth: number;
  /** Month key of the in-progress month at build time. */
  currentMonth: string;
}

export interface FinanceFinancialYearBucket {
  /** e.g. "FY2027 (YTD)" */
  label: string;
  fromMonth: string;
  toMonth: string;
  isYearToDate: boolean;
}

function financialYearStartMonth(
  monthKey: string,
  yearEndMonth: number
): string {
  // Month keys are always the internal "YYYY-MM" form, so a split on "-"
  // always yields both parts.
  const parts = monthKey.split("-");
  const year = Number(must(parts[0], `financialYearStartMonth: malformed month key "${monthKey}"`));
  const month = Number(must(parts[1], `financialYearStartMonth: malformed month key "${monthKey}"`));
  const startMonth = (yearEndMonth % 12) + 1;
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startMonth).padStart(2, "0")}`;
}

function financialYearName(fyStartMonth: string): string {
  return `FY${shiftMonthKey(fyStartMonth, 11).slice(0, 4)}`;
}

/**
 * The three financial-year buckets the committee compares: this FY (to date),
 * last FY, and the FY before. Always exactly these three, in this order — a
 * fixed triple rather than an open-ended array, so a caller reading
 * `buckets[0]`/`[1]`/`[2]` (this FY / last FY / the FY before) never has to
 * guard against a missing bucket.
 */
export type FinanceFinancialYearBucketTriple = readonly [
  FinanceFinancialYearBucket,
  FinanceFinancialYearBucket,
  FinanceFinancialYearBucket,
];

export function financeFinancialYearBuckets(input: {
  currentMonth: string;
  financialYearEndMonth: number;
}): FinanceFinancialYearBucketTriple {
  const thisFyStart = financialYearStartMonth(
    input.currentMonth,
    input.financialYearEndMonth
  );

  const bucketFor = (yearsBack: 0 | 1 | 2): FinanceFinancialYearBucket => {
    const fromMonth = shiftMonthKey(thisFyStart, -12 * yearsBack);
    const toMonth =
      yearsBack === 0 ? input.currentMonth : shiftMonthKey(fromMonth, 11);
    return {
      label:
        yearsBack === 0
          ? `${financialYearName(fromMonth)} (YTD)`
          : financialYearName(fromMonth),
      fromMonth,
      toMonth,
      isYearToDate: yearsBack === 0,
    };
  };

  return [bucketFor(0), bucketFor(1), bucketFor(2)];
}

/**
 * The "last 12 months" window: 12 calendar months ending at the latest data
 * month (that month plus the 11 before it). Using calendar arithmetic — not
 * `months[length - 12]` — keeps the window exactly 12 months wide even when
 * stored history has gaps; the missing months are simply absent data points
 * rather than stretching the window past a year.
 */
export function last12MonthWindow(
  matrix: Pick<FinanceRatioMatrix, "months" | "currentMonth">
): { fromMonth: string; toMonth: string } {
  const lastDataMonth = matrix.months.at(-1) ?? matrix.currentMonth;
  return {
    fromMonth: shiftMonthKey(lastDataMonth, -11),
    toMonth: lastDataMonth,
  };
}

/** Sum a series over an inclusive month-key window. */
export function sumRatioSeries(
  matrix: Pick<FinanceRatioMatrix, "months">,
  series: Pick<FinanceRatioSeries, "valuesCents">,
  window: { fromMonth: string; toMonth: string }
): number {
  return matrix.months.reduce((total, month, index) => {
    if (month < window.fromMonth || month > window.toMonth) {
      return total;
    }
    return total + (series.valuesCents[index] ?? 0);
  }, 0);
}

/** Ratio of two sums over a window; null when the denominator is zero. */
export function ratioForWindow(
  matrix: Pick<FinanceRatioMatrix, "months">,
  numerator: Pick<FinanceRatioSeries, "valuesCents">,
  denominator: Pick<FinanceRatioSeries, "valuesCents">,
  window: { fromMonth: string; toMonth: string }
): number | null {
  const denominatorCents = sumRatioSeries(matrix, denominator, window);
  if (denominatorCents === 0) {
    return null;
  }
  return sumRatioSeries(matrix, numerator, window) / denominatorCents;
}
