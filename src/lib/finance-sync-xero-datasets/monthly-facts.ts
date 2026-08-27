import { FinanceMonthlyStatementKind, FinanceSnapshotType } from "@prisma/client";
import {
  extractMonthlyFactsFromReport,
  type FinanceMonthlyChartContext,
} from "@/lib/finance-monthly-facts";
import { loadFinanceMonthlyChartContext } from "@/lib/finance-monthly-fact-store";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import { callXeroApi } from "@/lib/xero";
import {
  getFinanceMonthKeyForDate,
  monthEndString,
  monthStartString,
  parseRequiredDateOnly,
} from "./date-format";
import {
  buildFinanceReportSnapshot,
  getRequiredReport,
  withFinanceReportScopeError,
} from "./report-snapshot";

/**
 * Prior monthly periods requested alongside the primary month, so one report
 * call yields 12 monthly columns. Xero caps report comparison periods at 11.
 */
const FINANCE_MONTHLY_FACTS_PRIOR_PERIODS = 11;

export interface FinanceMonthlyFactsWindowInput {
  /** Window end month key ("YYYY-MM", inclusive); covers this + 11 prior. */
  endMonth: string;
  /** Month key of the sync date in NZ time; months >= it flag provisional. */
  currentMonth: string;
  /** Injectable chart context so backfill chunks avoid reloading it. */
  chart?: FinanceMonthlyChartContext;
}

function requireMonthlyFactChartContext(
  chart: FinanceMonthlyChartContext
): FinanceMonthlyChartContext {
  if (chart.accountsById.size === 0) {
    throw new Error(
      "No chart-of-accounts snapshot is stored yet, so monthly account facts cannot be derived. The xero-chart-of-accounts dataset must succeed first."
    );
  }

  return chart;
}

/**
 * Derive fact rows from a freshly pulled multi-period report and attach them
 * to the snapshot for runFinanceSync to persist. Throws instead of returning
 * partial facts when the report cannot be fully read — an unparseable period
 * header, a header whose date cells only partially parse, or any leaf row that
 * carries an amount but does not resolve to a GL code — so a bad pull fails the
 * dataset loudly rather than silently replacing stored months with an
 * incomplete set (the throw runs before persistence, so the stored months are
 * left untouched and only this dataset is marked failed).
 */
function attachMonthlyFacts(input: {
  snapshot: FinanceSyncSnapshotInput;
  chart: FinanceMonthlyChartContext;
  statementKind: FinanceMonthlyStatementKind;
  sourceReport: string;
  currentMonth: string;
  operation: string;
}): FinanceSyncSnapshotInput {
  const extraction = extractMonthlyFactsFromReport({
    payload: input.snapshot.payload,
    chart: input.chart,
    provisionalFromMonth: input.currentMonth,
  });

  if (extraction.months.length === 0) {
    throw new Error(
      `${input.operation} returned a report without parseable monthly period columns`
    );
  }

  if (extraction.months.length < extraction.periodColumnCount) {
    throw new Error(
      `${input.operation} returned a report whose period header only partially parsed (${extraction.months.length} of ${extraction.periodColumnCount} monthly columns). Refusing to replace stored monthly facts because the unparsed months would linger stale; report an unrecognised Xero date format.`
    );
  }

  if (extraction.unresolvedRowLabels.length > 0) {
    throw new Error(
      `${input.operation} report rows could not be matched to GL codes (${extraction.unresolvedRowLabels.length} unresolved). Refusing to replace stored monthly facts because the unresolved amounts would be dropped; run the chart-of-accounts sync and retry.`
    );
  }

  return {
    ...input.snapshot,
    periodStart: parseRequiredDateOnly(
      monthStartString(extraction.months[0]),
      "periodStart"
    ),
    monthlyFacts: {
      statementKind: input.statementKind,
      months: extraction.months,
      rows: extraction.rows,
      sourceReport: input.sourceReport,
      unresolvedRowLabels: extraction.unresolvedRowLabels,
    },
  };
}

/**
 * Pull a 12-month profit-and-loss report (endMonth + 11 prior monthly
 * columns) and derive PROFIT_AND_LOSS fact rows. The raw report is stored as
 * a PROFIT_AND_LOSS_BY_MONTH snapshot keyed on the window end month, so daily
 * re-pulls overwrite one row per month instead of accumulating.
 */
export async function fetchFinanceProfitAndLossByMonthSnapshot(
  context: FinanceSyncDatasetContext,
  window: FinanceMonthlyFactsWindowInput
): Promise<FinanceSyncSnapshotInput> {
  const chart = requireMonthlyFactChartContext(
    window.chart ?? (await loadFinanceMonthlyChartContext())
  );
  const fromDateString = monthStartString(window.endMonth);
  const toDateString = monthEndString(window.endMonth);
  const response = await withFinanceReportScopeError(
    "getReportProfitAndLoss",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportProfitAndLoss(
            context.xeroTenantId,
            fromDateString,
            toDateString,
            FINANCE_MONTHLY_FACTS_PRIOR_PERIODS,
            "MONTH",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportProfitAndLoss",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets profitAndLossByMonth",
        }
      )
  );

  return attachMonthlyFacts({
    snapshot: buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
      asOfDate: parseRequiredDateOnly(fromDateString, "asOfDate"),
      periodEnd: parseRequiredDateOnly(toDateString, "periodEnd"),
      report: getRequiredReport(response.body, "getReportProfitAndLoss"),
    }),
    chart,
    statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
    sourceReport: "getReportProfitAndLoss",
    currentMonth: window.currentMonth,
    operation: "getReportProfitAndLoss",
  });
}

/**
 * Pull a 12-month balance-sheet report (month-end positions for endMonth +
 * 11 prior) and derive BALANCE_SHEET fact rows, stored the same way as the
 * profit-and-loss window above.
 */
export async function fetchFinanceBalanceSheetByMonthSnapshot(
  context: FinanceSyncDatasetContext,
  window: FinanceMonthlyFactsWindowInput
): Promise<FinanceSyncSnapshotInput> {
  const chart = requireMonthlyFactChartContext(
    window.chart ?? (await loadFinanceMonthlyChartContext())
  );
  const toDateString = monthEndString(window.endMonth);
  const response = await withFinanceReportScopeError(
    "getReportBalanceSheet",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBalanceSheet(
            context.xeroTenantId,
            toDateString,
            FINANCE_MONTHLY_FACTS_PRIOR_PERIODS,
            "MONTH",
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportBalanceSheet",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets balanceSheetByMonth",
        }
      )
  );

  return attachMonthlyFacts({
    snapshot: buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET_BY_MONTH,
      asOfDate: parseRequiredDateOnly(monthStartString(window.endMonth), "asOfDate"),
      periodEnd: parseRequiredDateOnly(toDateString, "periodEnd"),
      report: getRequiredReport(response.body, "getReportBalanceSheet"),
    }),
    chart,
    statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
    sourceReport: "getReportBalanceSheet",
    currentMonth: window.currentMonth,
    operation: "getReportBalanceSheet",
  });
}

export async function syncFinanceProfitAndLossByMonthFacts(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const currentMonth = getFinanceMonthKeyForDate(context.startedAt, context.clubTimeZone);

  return fetchFinanceProfitAndLossByMonthSnapshot(context, {
    endMonth: currentMonth,
    currentMonth,
  });
}

export async function syncFinanceBalanceSheetByMonthFacts(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const currentMonth = getFinanceMonthKeyForDate(context.startedAt, context.clubTimeZone);

  return fetchFinanceBalanceSheetByMonthSnapshot(context, {
    endMonth: currentMonth,
    currentMonth,
  });
}
