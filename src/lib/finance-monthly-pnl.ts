/**
 * Fact-table P&L summaries for the finance dashboard.
 *
 * Replaces the snapshot-walking `buildFinanceMappedPnlSummary` path for the
 * revenue/costs/pricing views: it reads FinanceAccountMonthlyBalance rows
 * (one discrete amount per month and GL account code), joins them to the
 * treasurer's FinanceReportCategory mappings by account code, and produces
 * whole-month totals, per-category groups, and a one-point-per-month trend
 * with an aligned comparison series. This is what fixes the multi-counted
 * totals and per-snapshot trend labels the old path produced.
 */

import { FinanceMonthlyStatementKind } from "@prisma/client";
import {
  financeDashboardWindowMonths,
  type FinanceDashboardDateWindow,
} from "@/lib/finance-dashboard-ranges";
import { financeDashboardTrendMonthLabel } from "@/lib/finance-dashboard-labels";
import {
  formatDollarsDisplay,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import {
  listMonthlyFacts,
  type FinanceMonthlyFactRecord,
} from "@/lib/finance-monthly-fact-store";
import {
  listFinanceReportCategories,
  UNMAPPED_FINANCE_CATEGORY_ID,
  type FinanceMappedPnlCategorySummary,
  type FinanceMappedPnlLineSummary,
  type FinanceReportCategoryDto,
} from "@/lib/finance-report-mappings";

type FinanceReportKind = "REVENUE" | "EXPENSE";

interface FinanceMonthlyPnlTrendPoint {
  monthKey: string;
  /** Short month label for chart axes, e.g. "Jun 2026". */
  label: string;
  amountCents: number;
  /** Positionally aligned comparison-month amount; null without comparison. */
  comparisonAmountCents: number | null;
  /** True when the month was in progress at the last sync (month-to-date). */
  isProvisional: boolean;
}

export interface FinanceMonthlyPnlSummary {
  kind: FinanceReportKind;
  amountCents: number;
  comparisonAmountCents: number | null;
  deltaCents: number | null;
  formattedAmount: string;
  formattedComparisonAmount: string | null;
  formattedDelta: string | null;
  groups: FinanceMappedPnlCategorySummary[];
  mix: Array<{ name: string; valueCents: number }>;
  trend: FinanceMonthlyPnlTrendPoint[];
  availableExpenseLines: Array<{
    value: string;
    label: string;
    categoryId: string;
  }>;
  warnings: string[];
  /** Months in the primary window that have stored fact rows. */
  monthsWithData: number;
  includesProvisionalMonth: boolean;
}

export interface BuildFinanceMonthlyPnlSummaryInput {
  kind: FinanceReportKind;
  primary: Pick<FinanceDashboardDateWindow, "fromMonth" | "toMonth" | "label">;
  comparison: Pick<
    FinanceDashboardDateWindow,
    "fromMonth" | "toMonth" | "label"
  > | null;
  /** Month key of the in-progress month; matching rows are month-to-date. */
  currentMonth: string;
  expenseCategoryId?: string | null;
  expenseLine?: string | null;
}

interface AccountLineAggregate {
  accountCode: string;
  lineLabel: string;
  sectionLabel: string;
  categoryId: string;
  amountCents: number;
  comparisonAmountCents: number;
  amountByMonth: Map<string, number>;
  comparisonAmountByMonth: Map<string, number>;
  monthsPresent: Set<string>;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function classKind(accountClass: string | null): FinanceReportKind | null {
  const normalized = accountClass?.toUpperCase();
  if (normalized === "REVENUE") return "REVENUE";
  if (normalized === "EXPENSE") return "EXPENSE";
  return null;
}

function sectionLabelForClass(accountClass: string | null): string {
  return classKind(accountClass) === "REVENUE" ? "Income" : "Expenses";
}

function buildCategoryLookup(categories: FinanceReportCategoryDto[]) {
  const categoryByCode = new Map<string, FinanceReportCategoryDto>();
  for (const category of categories) {
    if (category.archived) {
      continue;
    }
    for (const mapping of category.mappings) {
      const code = normalizeCode(mapping.accountCode);
      if (code && !categoryByCode.has(code)) {
        categoryByCode.set(code, category);
      }
    }
  }
  return categoryByCode;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function buildFinanceMonthlyPnlSummary(
  input: BuildFinanceMonthlyPnlSummaryInput
): Promise<FinanceMonthlyPnlSummary> {
  const [categories, facts, comparisonFacts] = await Promise.all([
    listFinanceReportCategories(),
    listMonthlyFacts({
      statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
      fromMonth: input.primary.fromMonth,
      toMonth: input.primary.toMonth,
    }),
    input.comparison
      ? listMonthlyFacts({
          statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
          fromMonth: input.comparison.fromMonth,
          toMonth: input.comparison.toMonth,
        })
      : Promise.resolve([] as FinanceMonthlyFactRecord[]),
  ]);

  const categoryByCode = buildCategoryLookup(categories);

  // A fact row belongs to this view when the treasurer mapped its code to a
  // category of this kind, or — unmapped — when its Xero account class says so.
  // Mappings win over class so deliberate re-grouping is honoured. An unmapped
  // account whose class is neither REVENUE nor EXPENSE (e.g. null on a stale
  // chart snapshot) falls into EXPENSE, matching the ratio explorer
  // (finance-ratio-insights.ts) so both views cover the same account set and
  // the "unmapped accounts stay in totals" promise holds — no row is silently
  // dropped from both views.
  const belongsToKind = (record: FinanceMonthlyFactRecord): boolean => {
    const mapped = categoryByCode.get(normalizeCode(record.accountCode));
    if (mapped) {
      return mapped.kind === input.kind;
    }
    return (classKind(record.accountClass) ?? "EXPENSE") === input.kind;
  };

  const lines = new Map<string, AccountLineAggregate>();
  const lineFor = (record: FinanceMonthlyFactRecord): AccountLineAggregate => {
    const code = normalizeCode(record.accountCode);
    const existing = lines.get(code);
    if (existing) {
      if (existing.lineLabel === code && record.accountName) {
        existing.lineLabel = record.accountName;
      }
      return existing;
    }

    const mapped = categoryByCode.get(code);
    const created: AccountLineAggregate = {
      accountCode: code,
      lineLabel: record.accountName ?? code,
      sectionLabel: sectionLabelForClass(record.accountClass),
      categoryId: mapped?.id ?? UNMAPPED_FINANCE_CATEGORY_ID,
      amountCents: 0,
      comparisonAmountCents: 0,
      amountByMonth: new Map(),
      comparisonAmountByMonth: new Map(),
      monthsPresent: new Set(),
    };
    lines.set(code, created);
    return created;
  };

  for (const record of facts) {
    if (!belongsToKind(record)) {
      continue;
    }
    const line = lineFor(record);
    line.amountCents += record.amountCents;
    line.amountByMonth.set(
      record.month,
      (line.amountByMonth.get(record.month) ?? 0) + record.amountCents
    );
    line.monthsPresent.add(record.month);
  }

  for (const record of comparisonFacts) {
    if (!belongsToKind(record)) {
      continue;
    }
    const line = lineFor(record);
    line.comparisonAmountCents += record.amountCents;
    line.comparisonAmountByMonth.set(
      record.month,
      (line.comparisonAmountByMonth.get(record.month) ?? 0) + record.amountCents
    );
  }

  const allLines = Array.from(lines.values());

  // Expense drill-down filters (costs view only). Options are built before
  // filtering so the selectors always list every available choice.
  const availableExpenseLines =
    input.kind === "EXPENSE"
      ? allLines
          .map((line) => ({
            value: line.accountCode,
            label: line.lineLabel,
            categoryId: line.categoryId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label))
      : [];

  const selectedCategoryId = normalizeText(input.expenseCategoryId);
  const selectedLine = normalizeText(input.expenseLine);
  const filteredLines =
    input.kind === "EXPENSE"
      ? allLines.filter((line) => {
          if (selectedCategoryId && line.categoryId !== selectedCategoryId) {
            return false;
          }
          if (
            selectedLine &&
            line.accountCode !== normalizeCode(selectedLine)
          ) {
            return false;
          }
          return true;
        })
      : allLines;

  const toLineSummary = (
    line: AccountLineAggregate
  ): FinanceMappedPnlLineSummary => ({
    key: line.accountCode,
    sectionLabel: line.sectionLabel,
    lineLabel: line.lineLabel,
    accountCode: line.accountCode,
    amountCents: line.amountCents,
    comparisonAmountCents: line.comparisonAmountCents,
    formattedAmount: formatDollarsDisplay(line.amountCents),
    formattedComparisonAmount: formatDollarsDisplay(line.comparisonAmountCents),
    formattedDelta: formatSignedDollarsDisplay(
      line.amountCents - line.comparisonAmountCents
    ),
    periodsPresent: line.monthsPresent.size,
  });

  const activeCategories = categories
    .filter((category) => !category.archived && category.kind === input.kind)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
    );

  const groups: FinanceMappedPnlCategorySummary[] = [];
  for (const category of activeCategories) {
    const memberLines = filteredLines
      .filter((line) => line.categoryId === category.id)
      .sort((left, right) => right.amountCents - left.amountCents);
    const amountCents = memberLines.reduce(
      (total, line) => total + line.amountCents,
      0
    );
    const comparisonAmountCents = memberLines.reduce(
      (total, line) => total + line.comparisonAmountCents,
      0
    );
    groups.push({
      id: category.id,
      name: category.name,
      subtype: category.subtype,
      kind: input.kind,
      sortOrder: category.sortOrder,
      amountCents,
      comparisonAmountCents,
      deltaCents: amountCents - comparisonAmountCents,
      formattedAmount: formatDollarsDisplay(amountCents),
      formattedComparisonAmount: formatDollarsDisplay(comparisonAmountCents),
      formattedDelta: formatSignedDollarsDisplay(
        amountCents - comparisonAmountCents
      ),
      lineCount: memberLines.length,
      lines: memberLines.map(toLineSummary),
    });
  }

  const unmappedLines = filteredLines
    .filter((line) => line.categoryId === UNMAPPED_FINANCE_CATEGORY_ID)
    .sort((left, right) => right.amountCents - left.amountCents);
  if (unmappedLines.length > 0) {
    const amountCents = unmappedLines.reduce(
      (total, line) => total + line.amountCents,
      0
    );
    const comparisonAmountCents = unmappedLines.reduce(
      (total, line) => total + line.comparisonAmountCents,
      0
    );
    groups.push({
      id: UNMAPPED_FINANCE_CATEGORY_ID,
      name: "Unmapped",
      subtype: null,
      kind: input.kind,
      sortOrder: Number.MAX_SAFE_INTEGER,
      amountCents,
      comparisonAmountCents,
      deltaCents: amountCents - comparisonAmountCents,
      formattedAmount: formatDollarsDisplay(amountCents),
      formattedComparisonAmount: formatDollarsDisplay(comparisonAmountCents),
      formattedDelta: formatSignedDollarsDisplay(
        amountCents - comparisonAmountCents
      ),
      lineCount: unmappedLines.length,
      lines: unmappedLines.map(toLineSummary),
    });
  }

  const amountCents = filteredLines.reduce(
    (total, line) => total + line.amountCents,
    0
  );
  const comparisonAmountCents = input.comparison
    ? filteredLines.reduce((total, line) => total + line.comparisonAmountCents, 0)
    : null;

  // Trend: exactly one point per month in the primary window, with the
  // comparison window's months aligned by position (month 1 vs month 1).
  const primaryMonths = financeDashboardWindowMonths(input.primary);
  const comparisonMonths = input.comparison
    ? financeDashboardWindowMonths(input.comparison)
    : [];
  // The stored flag is authoritative: if the sync stalls mid-month, last
  // month's facts stay flagged provisional even once the calendar moves on.
  const provisionalMonths = new Set(
    facts.filter((record) => record.isProvisional).map((record) => record.month)
  );
  const trend: FinanceMonthlyPnlTrendPoint[] = primaryMonths.map(
    (monthKey, index) => {
      const comparisonMonth = comparisonMonths[index] ?? null;
      return {
        monthKey,
        label: financeDashboardTrendMonthLabel(monthKey),
        amountCents: filteredLines.reduce(
          (total, line) => total + (line.amountByMonth.get(monthKey) ?? 0),
          0
        ),
        comparisonAmountCents: comparisonMonth
          ? filteredLines.reduce(
              (total, line) =>
                total + (line.comparisonAmountByMonth.get(comparisonMonth) ?? 0),
              0
            )
          : null,
        isProvisional:
          provisionalMonths.has(monthKey) || monthKey >= input.currentMonth,
      };
    }
  );

  const monthsWithData = new Set(facts.map((record) => record.month)).size;
  const includesProvisionalMonth = provisionalMonths.size > 0;

  const warnings: string[] = [];
  if (facts.length === 0) {
    warnings.push(
      `No monthly Xero data is stored for ${input.primary.label}. Run the finance sync, or the monthly-facts backfill for older history.`
    );
  } else if (monthsWithData < primaryMonths.length) {
    warnings.push(
      `Stored monthly Xero data covers ${monthsWithData} of ${primaryMonths.length} selected months. Run the monthly-facts backfill for the missing history.`
    );
  }
  if (input.comparison && comparisonFacts.length === 0) {
    warnings.push(
      `No monthly Xero data is stored for the comparison period (${input.comparison.label}).`
    );
  }
  if (includesProvisionalMonth) {
    const provisionalLabels = Array.from(provisionalMonths)
      .sort()
      .map((monthKey) => financeDashboardTrendMonthLabel(monthKey));
    warnings.push(
      `${provisionalLabels.join(", ")} ${
        provisionalLabels.length === 1 ? "is" : "are"
      } still in progress; the figures are month-to-date.`
    );
  }

  return {
    kind: input.kind,
    amountCents,
    comparisonAmountCents,
    deltaCents:
      comparisonAmountCents === null ? null : amountCents - comparisonAmountCents,
    formattedAmount: formatDollarsDisplay(amountCents),
    formattedComparisonAmount:
      comparisonAmountCents === null
        ? null
        : formatDollarsDisplay(comparisonAmountCents),
    formattedDelta:
      comparisonAmountCents === null
        ? null
        : formatSignedDollarsDisplay(amountCents - comparisonAmountCents),
    groups,
    mix: groups
      .filter((group) => group.amountCents > 0)
      .map((group) => ({ name: group.name, valueCents: group.amountCents })),
    trend,
    availableExpenseLines,
    warnings,
    monthsWithData,
    includesProvisionalMonth,
  };
}
