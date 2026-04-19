import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type { ReportCell, ReportFields, ReportWithRow } from "xero-node";
import { parseDateOnly } from "@/lib/date-only";
import {
  recordFinanceXeroApiUsage,
  type FinanceXeroRateLimitCategory,
} from "@/lib/finance-xero-api-usage";
import {
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import { callXeroApi } from "@/lib/xero";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";

export const FINANCE_SYNC_DATA_TIMEZONE = "Pacific/Auckland";
export const FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY =
  "xero-profit-and-loss-monthly";
export const FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY =
  "xero-balance-sheet";
export const FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY =
  "xero-bank-balances";

interface XeroReportAttributeLike {
  id?: string;
  value?: string;
}

interface XeroReportRowLike {
  rowType?: unknown;
  title?: string;
  cells?: XeroReportCellLike[];
  rows?: XeroReportRowLike[];
}

interface XeroReportCellLike extends ReportCell {
  attributes?: XeroReportAttributeLike[];
}

interface FinanceSnapshotReportCell {
  value: string | null;
  attributes: Array<{
    id: string | null;
    value: string | null;
  }>;
}

interface FinanceSnapshotReportRow {
  rowType: string | null;
  title: string | null;
  cells: FinanceSnapshotReportCell[];
  rows: FinanceSnapshotReportRow[];
}

interface FinanceSnapshotReportPayload {
  reportId: string | null;
  reportName: string | null;
  reportType: string | null;
  reportTitle: string | null;
  reportTitles: string[];
  reportDate: string | null;
  updatedDateUTC: string | null;
  fields: Array<{
    fieldId: string | null;
    description: string | null;
    value: string | null;
  }>;
  rows: FinanceSnapshotReportRow[];
}

function getDateOnlyStringForTimeZone(
  date: Date,
  timeZone = FINANCE_SYNC_DATA_TIMEZONE
): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive finance date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function parseRequiredDateOnly(value: string, fieldName: string): Date {
  const parsed = parseDateOnly(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date-only string`);
  }

  return parsed;
}

function getFinanceReportWindow(startedAt: Date) {
  const asOfDateString = getDateOnlyStringForTimeZone(startedAt);
  const periodStartString = `${asOfDateString.slice(0, 7)}-01`;

  return {
    asOfDate: parseRequiredDateOnly(asOfDateString, "asOfDate"),
    asOfDateString,
    periodStart: parseRequiredDateOnly(periodStartString, "periodStart"),
    periodStartString,
  };
}

function toOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFinanceXeroErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return error ? String(error) : null;
}

function getFinanceXeroRateLimitCategory(
  error: unknown
): FinanceXeroRateLimitCategory {
  if (getXeroErrorStatusCode(error) !== 429) {
    return null;
  }

  const rateLimitProblem = getXeroErrorHeader(error, "x-rate-limit-problem");
  if (rateLimitProblem === "day" || rateLimitProblem === "minute") {
    return rateLimitProblem;
  }

  return "unknown";
}

async function callFinanceXeroApi<T>(
  fn: () => Promise<T>,
  options: {
    operation: string;
    resourceType: string;
    workflow: string;
  }
): Promise<T> {
  const startedAt = Date.now();

  try {
    const result = await fn();

    await recordFinanceXeroApiUsage({
      operation: options.operation,
      resourceType: options.resourceType,
      workflow: options.workflow,
      success: true,
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (error) {
    await recordFinanceXeroApiUsage({
      operation: options.operation,
      resourceType: options.resourceType,
      workflow: options.workflow,
      success: false,
      rateLimitCategory: getFinanceXeroRateLimitCategory(error),
      statusCode: getXeroErrorStatusCode(error) ?? null,
      durationMs: Date.now() - startedAt,
      errorMessage: getFinanceXeroErrorMessage(error),
    });

    throw error;
  }
}

function mapReportField(field: ReportFields) {
  return {
    fieldId: field.fieldID ?? null,
    description: field.description ?? null,
    value: field.value ?? null,
  };
}

function mapReportCell(cell: XeroReportCellLike): FinanceSnapshotReportCell {
  return {
    value: cell.value ?? null,
    attributes: (cell.attributes ?? []).map((attribute) => ({
      id: attribute.id ?? null,
      value: attribute.value ?? null,
    })),
  };
}

function mapReportRows(rows: readonly XeroReportRowLike[]): FinanceSnapshotReportRow[] {
  return rows.map((row) => ({
    rowType: row.rowType ? String(row.rowType) : null,
    title: row.title ?? null,
    cells: (row.cells ?? []).map((cell) => mapReportCell(cell)),
    rows: mapReportRows(row.rows ?? []),
  }));
}

function countReportRows(rows: readonly FinanceSnapshotReportRow[]): number {
  return rows.reduce((count, row) => {
    const rowCount =
      row.rowType === "Row" || row.rowType === "SummaryRow" ? 1 : 0;

    return count + rowCount + countReportRows(row.rows);
  }, 0);
}

function getRequiredReport(
  reportResponse: { reports?: ReportWithRow[] },
  operation: string
): ReportWithRow {
  const report = reportResponse.reports?.[0];

  if (!report) {
    throw new Error(`${operation} did not return a report`);
  }

  return report;
}

export function buildFinanceReportSnapshot(input: {
  snapshotType: FinanceSnapshotType;
  asOfDate: Date;
  report: ReportWithRow;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): FinanceSyncSnapshotInput {
  const rows = mapReportRows(input.report.rows ?? []);
  const payload = {
    reportId: input.report.reportID ?? null,
    reportName: input.report.reportName ?? null,
    reportType: input.report.reportType ?? null,
    reportTitle: input.report.reportTitle ?? null,
    reportTitles: input.report.reportTitles ?? [],
    reportDate: input.report.reportDate ?? null,
    updatedDateUTC: toOptionalDate(input.report.updatedDateUTC)?.toISOString() ?? null,
    fields: (input.report.fields ?? []).map((field) => mapReportField(field)),
    rows,
  } as Prisma.InputJsonObject & FinanceSnapshotReportPayload;

  return {
    snapshotType: input.snapshotType,
    asOfDate: input.asOfDate,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    rowCount: countReportRows(rows),
    payload,
    sourceUpdatedAt: toOptionalDate(input.report.updatedDateUTC),
  };
}

export async function syncFinanceProfitAndLossMonthlySnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await callFinanceXeroApi(
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportProfitAndLoss(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString,
            1,
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
          context: "financeSyncDatasets profitAndLossMonthly",
        }
      ),
    {
      operation: "getReportProfitAndLoss",
      resourceType: "REPORT",
      workflow: context.workflow,
    }
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportProfitAndLoss"),
  });
}

export async function syncFinanceBalanceSheetSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await callFinanceXeroApi(
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBalanceSheet(
            context.xeroTenantId,
            window.asOfDateString,
            1,
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
          context: "financeSyncDatasets balanceSheet",
        }
      ),
    {
      operation: "getReportBalanceSheet",
      resourceType: "REPORT",
      workflow: context.workflow,
    }
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BALANCE_SHEET,
    asOfDate: window.asOfDate,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBalanceSheet"),
  });
}

export async function syncFinanceBankBalancesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await callFinanceXeroApi(
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBankSummary(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString
          ),
        {
          operation: "getReportBankSummary",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets bankBalances",
        }
      ),
    {
      operation: "getReportBankSummary",
      resourceType: "REPORT",
      workflow: context.workflow,
    }
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBankSummary"),
  });
}
