import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type {
  ReportCell,
  ReportFields,
  ReportWithRow,
} from "xero-node";
import type { FinanceSyncSnapshotInput } from "@/lib/finance-sync-service";
import {
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import { XERO_REPORT_OAUTH_SCOPES } from "@/lib/xero-config";
import { toOptionalDate, toOptionalReportDateText } from "./date-format";

const XERO_REPORT_SCOPE_BY_OPERATION = {
  getReportProfitAndLoss: XERO_REPORT_OAUTH_SCOPES.profitAndLoss,
  getReportBalanceSheet: XERO_REPORT_OAUTH_SCOPES.balanceSheet,
  getReportBankSummary: XERO_REPORT_OAUTH_SCOPES.bankSummary,
} as const;

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

function getFinanceXeroScopeErrorMessage(
  error: unknown,
  operation: string
): string | null {
  if (getXeroErrorStatusCode(error) !== 401) {
    return null;
  }

  const wwwAuthenticate = getXeroErrorHeader(error, "www-authenticate")?.toLowerCase();
  if (!wwwAuthenticate?.includes("insufficient_scope")) {
    return null;
  }

  const requiredScope =
    XERO_REPORT_SCOPE_BY_OPERATION[
      operation as keyof typeof XERO_REPORT_SCOPE_BY_OPERATION
    ] ?? null;

  return requiredScope
    ? `Xero is missing a required OAuth scope for ${operation}. Add ${requiredScope} to the Xero app and reconnect Xero from the admin panel.`
    : `Xero is missing a required OAuth scope for ${operation}. Update the Xero app scopes and reconnect Xero from the admin panel.`;
}

function normalizeFinanceXeroError(error: unknown, operation: string): unknown {
  const scopeErrorMessage = getFinanceXeroScopeErrorMessage(error, operation);
  if (!scopeErrorMessage) {
    return error;
  }

  return new Error(scopeErrorMessage);
}

/**
 * Wrap a finance report Xero call so a 401 insufficient_scope failure is
 * rethrown with an actionable "reconnect Xero" message. Usage metering and
 * rate-limit handling are already done by the inner callXeroApi against the
 * operational connection.
 */
export async function withFinanceReportScopeError<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw normalizeFinanceXeroError(error, operation);
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

export function getRequiredReport(
  reportResponse: { reports?: ReportWithRow[] },
  operation: string
): ReportWithRow {
  const report = reportResponse.reports?.[0];

  if (!report) {
    throw new Error(`${operation} did not return a report`);
  }

  return report;
}

// test seam
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
    reportDate: toOptionalReportDateText(input.report.reportDate),
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
