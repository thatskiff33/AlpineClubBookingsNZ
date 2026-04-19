import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type { Invoice, ReportCell, ReportFields, ReportWithRow } from "xero-node";
import { parseDateOnly } from "@/lib/date-only";
import {
  recordFinanceXeroApiUsage,
  type FinanceXeroRateLimitCategory,
} from "@/lib/finance-xero-api-usage";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import {
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import { callXeroApi, XeroDailyLimitError } from "@/lib/xero";

export const FINANCE_SYNC_DATA_TIMEZONE = "Pacific/Auckland";
export const FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY =
  "xero-profit-and-loss-monthly";
export const FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY =
  "xero-balance-sheet";
export const FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY =
  "xero-bank-balances";
export const FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY =
  "xero-aged-receivables";

const FINANCE_XERO_PAGE_SIZE = 100;
const FINANCE_AGED_RECEIVABLES_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FinanceAgedReceivablesBucketKey =
  | "current"
  | "days1To30"
  | "days31To60"
  | "days61To90"
  | "days91Plus";
type FinanceRateLimitObserver = (
  rateLimitCategory: FinanceXeroRateLimitCategory
) => void;

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

interface FinanceAgedReceivablesBucketTotals {
  current: number;
  days1To30: number;
  days31To60: number;
  days61To90: number;
  days91Plus: number;
  overdue: number;
  total: number;
}

interface FinanceAgedReceivablesInvoicePayload {
  invoiceId: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  expectedPaymentDate: string | null;
  updatedDateUTC: string | null;
  currency: string;
  currencyRate: number | null;
  total: number | null;
  amountPaid: number | null;
  amountCredited: number | null;
  amountDue: number;
  bucket: FinanceAgedReceivablesBucketKey;
  daysOverdue: number | null;
}

interface FinanceAgedReceivablesContactPayload {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  oldestDueDate: string | null;
  latestDueDate: string | null;
  totals: FinanceAgedReceivablesBucketTotals;
  invoices: FinanceAgedReceivablesInvoicePayload[];
}

interface FinanceAgedReceivablesCurrencyPayload {
  currency: string;
  invoiceCount: number;
  contactCount: number;
  totals: FinanceAgedReceivablesBucketTotals;
}

interface FinanceAgedReceivablesPayload {
  asOfDate: string;
  invoiceCount: number;
  contactCount: number;
  currencies: string[];
  totalsByCurrency: FinanceAgedReceivablesCurrencyPayload[];
  contacts: FinanceAgedReceivablesContactPayload[];
}

interface FinanceAgedReceivablesContactAccumulator {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  oldestDueDate: Date | null;
  latestDueDate: Date | null;
  totals: FinanceAgedReceivablesBucketTotals;
  invoices: FinanceAgedReceivablesInvoicePayload[];
}

interface FinanceAgedReceivablesCurrencyAccumulator {
  currency: string;
  invoiceCount: number;
  contactKeys: Set<string>;
  totals: FinanceAgedReceivablesBucketTotals;
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

function parseOptionalDateOnly(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function toDateOnlyString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
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
  if (error instanceof XeroDailyLimitError) {
    return "day";
  }

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
  fn: (observeRateLimit: FinanceRateLimitObserver) => Promise<T>,
  options: {
    operation: string;
    resourceType: string;
    workflow: string;
  }
): Promise<T> {
  const startedAt = Date.now();
  let observedRateLimitCategory: FinanceXeroRateLimitCategory = null;

  try {
    const result = await fn((rateLimitCategory) => {
      observedRateLimitCategory = rateLimitCategory;
    });

    await recordFinanceXeroApiUsage({
      operation: options.operation,
      resourceType: options.resourceType,
      workflow: options.workflow,
      success: true,
      rateLimitCategory: observedRateLimitCategory,
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (error) {
    await recordFinanceXeroApiUsage({
      operation: options.operation,
      resourceType: options.resourceType,
      workflow: options.workflow,
      success: false,
      rateLimitCategory:
        observedRateLimitCategory ?? getFinanceXeroRateLimitCategory(error),
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

function createEmptyAgedReceivablesTotals(): FinanceAgedReceivablesBucketTotals {
  return {
    current: 0,
    days1To30: 0,
    days31To60: 0,
    days61To90: 0,
    days91Plus: 0,
    overdue: 0,
    total: 0,
  };
}

function addToAgedReceivablesTotals(
  totals: FinanceAgedReceivablesBucketTotals,
  bucket: FinanceAgedReceivablesBucketKey,
  amountDue: number
): void {
  totals[bucket] += amountDue;
  totals.total += amountDue;

  if (bucket !== "current") {
    totals.overdue += amountDue;
  }
}

function getInvoiceContactName(invoice: Invoice): string | null {
  const name = invoice.contact?.name?.trim();
  if (name) {
    return name;
  }

  const fallback = [invoice.contact?.firstName, invoice.contact?.lastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();

  return fallback || null;
}

function getInvoiceCurrency(invoice: Invoice): string {
  return invoice.currencyCode ? String(invoice.currencyCode) : "UNKNOWN";
}

function getInvoiceAmountDue(invoice: Invoice): number {
  if (typeof invoice.amountDue === "number" && Number.isFinite(invoice.amountDue)) {
    return Math.max(invoice.amountDue, 0);
  }

  const total = typeof invoice.total === "number" ? invoice.total : 0;
  const amountPaid =
    typeof invoice.amountPaid === "number" ? invoice.amountPaid : 0;
  const amountCredited =
    typeof invoice.amountCredited === "number" ? invoice.amountCredited : 0;

  return Math.max(total - amountPaid - amountCredited, 0);
}

function getDaysOverdue(asOfDate: Date, dueDate: Date | null): number | null {
  if (!dueDate) {
    return null;
  }

  return Math.floor((asOfDate.getTime() - dueDate.getTime()) / MS_PER_DAY);
}

function getAgedReceivablesBucket(
  asOfDate: Date,
  dueDate: Date | null
): {
  bucket: FinanceAgedReceivablesBucketKey;
  daysOverdue: number | null;
} {
  const daysOverdue = getDaysOverdue(asOfDate, dueDate);

  if (daysOverdue === null || daysOverdue <= 0) {
    return { bucket: "current", daysOverdue };
  }

  if (daysOverdue <= 30) {
    return { bucket: "days1To30", daysOverdue };
  }

  if (daysOverdue <= 60) {
    return { bucket: "days31To60", daysOverdue };
  }

  if (daysOverdue <= 90) {
    return { bucket: "days61To90", daysOverdue };
  }

  return { bucket: "days91Plus", daysOverdue };
}

function buildAgedReceivablesInvoiceWhereClause(asOfDateString: string): string {
  const [year, month, day] = asOfDateString.split("-").map((value) => Number(value));

  return [
    `Type=="ACCREC"`,
    `Date <= DateTime(${year},${month},${day})`,
  ].join(" AND ");
}

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return a.localeCompare(b);
}

function getContactAccumulatorKey(invoice: Invoice): string {
  const contactId = invoice.contact?.contactID?.trim() ?? "";
  const contactName = getInvoiceContactName(invoice) ?? "";

  return [
    contactId || contactName || invoice.invoiceID || invoice.invoiceNumber || "unknown",
    getInvoiceCurrency(invoice),
  ].join("::");
}

function isEligibleAgedReceivablesInvoice(
  invoice: Invoice,
  asOfDate: Date
): boolean {
  if (!invoice.type || String(invoice.type) !== "ACCREC") {
    return false;
  }

  if (getInvoiceAmountDue(invoice) <= 0) {
    return false;
  }

  const invoiceDate = parseOptionalDateOnly(invoice.date);
  if (invoiceDate && invoiceDate.getTime() > asOfDate.getTime()) {
    return false;
  }

  return true;
}

async function listFinanceAgedReceivablesInvoices(
  context: FinanceSyncDatasetContext,
  asOfDateString: string
): Promise<Invoice[]> {
  const invoices: Invoice[] = [];
  let page = 1;

  while (true) {
    const response = await callFinanceXeroApi(
      (observeRateLimit) =>
        callXeroApi(
          () =>
            context.xero.accountingApi.getInvoices(
              context.xeroTenantId,
              undefined,
              buildAgedReceivablesInvoiceWhereClause(asOfDateString),
              "DueDate ASC",
              undefined,
              undefined,
              undefined,
              [...FINANCE_AGED_RECEIVABLES_INVOICE_STATUSES],
              page,
              false,
              false,
              undefined,
              false,
              FINANCE_XERO_PAGE_SIZE
            ),
          {
            operation: "getInvoices",
            resourceType: "INVOICE",
            workflow: context.workflow,
            context: `financeSyncDatasets agedReceivables page ${page}`,
            onRateLimit: (event) => observeRateLimit(event.rateLimitCategory),
          }
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: context.workflow,
      }
    );

    const pageInvoices = response.body.invoices ?? [];
    invoices.push(...pageInvoices);

    if (pageInvoices.length < FINANCE_XERO_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return invoices;
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

export function buildFinanceAgedReceivablesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  const contacts = new Map<string, FinanceAgedReceivablesContactAccumulator>();
  const totalsByCurrency = new Map<
    string,
    FinanceAgedReceivablesCurrencyAccumulator
  >();
  let sourceUpdatedAt: Date | null = null;
  let invoiceCount = 0;

  for (const invoice of input.invoices) {
    if (!isEligibleAgedReceivablesInvoice(invoice, input.asOfDate)) {
      continue;
    }

    const amountDue = getInvoiceAmountDue(invoice);
    const dueDate = parseOptionalDateOnly(invoice.dueDate);
    const { bucket, daysOverdue } = getAgedReceivablesBucket(
      input.asOfDate,
      dueDate
    );
    const currency = getInvoiceCurrency(invoice);
    const contactKey = getContactAccumulatorKey(invoice);
    const invoicePayload: FinanceAgedReceivablesInvoicePayload = {
      invoiceId: invoice.invoiceID ?? null,
      invoiceNumber: invoice.invoiceNumber ?? null,
      reference: invoice.reference ?? null,
      status: invoice.status ? String(invoice.status) : null,
      invoiceDate: invoice.date ?? null,
      dueDate: invoice.dueDate ?? null,
      expectedPaymentDate: invoice.expectedPaymentDate ?? null,
      updatedDateUTC: toOptionalDate(invoice.updatedDateUTC)?.toISOString() ?? null,
      currency,
      currencyRate:
        typeof invoice.currencyRate === "number" ? invoice.currencyRate : null,
      total: typeof invoice.total === "number" ? invoice.total : null,
      amountPaid:
        typeof invoice.amountPaid === "number" ? invoice.amountPaid : null,
      amountCredited:
        typeof invoice.amountCredited === "number" ? invoice.amountCredited : null,
      amountDue,
      bucket,
      daysOverdue,
    };

    const contactSummary =
      contacts.get(contactKey) ??
      {
        contactId: invoice.contact?.contactID ?? null,
        contactName: getInvoiceContactName(invoice),
        contactStatus: invoice.contact?.contactStatus
          ? String(invoice.contact.contactStatus)
          : null,
        currency,
        invoiceCount: 0,
        oldestDueDate: null,
        latestDueDate: null,
        totals: createEmptyAgedReceivablesTotals(),
        invoices: [],
      };

    contactSummary.invoiceCount += 1;
    contactSummary.oldestDueDate =
      !contactSummary.oldestDueDate ||
      (dueDate && dueDate.getTime() < contactSummary.oldestDueDate.getTime())
        ? dueDate ?? contactSummary.oldestDueDate
        : contactSummary.oldestDueDate;
    contactSummary.latestDueDate =
      !contactSummary.latestDueDate ||
      (dueDate && dueDate.getTime() > contactSummary.latestDueDate.getTime())
        ? dueDate ?? contactSummary.latestDueDate
        : contactSummary.latestDueDate;
    addToAgedReceivablesTotals(contactSummary.totals, bucket, amountDue);
    contactSummary.invoices.push(invoicePayload);
    contacts.set(contactKey, contactSummary);

    const currencySummary =
      totalsByCurrency.get(currency) ??
      {
        currency,
        invoiceCount: 0,
        contactKeys: new Set<string>(),
        totals: createEmptyAgedReceivablesTotals(),
      };

    currencySummary.invoiceCount += 1;
    currencySummary.contactKeys.add(contactKey);
    addToAgedReceivablesTotals(currencySummary.totals, bucket, amountDue);
    totalsByCurrency.set(currency, currencySummary);

    invoiceCount += 1;

    const updatedDate = toOptionalDate(invoice.updatedDateUTC);
    if (updatedDate && (!sourceUpdatedAt || updatedDate > sourceUpdatedAt)) {
      sourceUpdatedAt = updatedDate;
    }
  }

  const contactPayloads = Array.from(contacts.values())
    .map(
      (contact): FinanceAgedReceivablesContactPayload => ({
        contactId: contact.contactId,
        contactName: contact.contactName,
        contactStatus: contact.contactStatus,
        currency: contact.currency,
        invoiceCount: contact.invoiceCount,
        oldestDueDate: toDateOnlyString(contact.oldestDueDate),
        latestDueDate: toDateOnlyString(contact.latestDueDate),
        totals: contact.totals,
        invoices: contact.invoices.sort((left, right) => {
          const dueDateOrder = compareNullableStrings(left.dueDate, right.dueDate);
          if (dueDateOrder !== 0) {
            return dueDateOrder;
          }

          const invoiceNumberOrder = compareNullableStrings(
            left.invoiceNumber,
            right.invoiceNumber
          );
          if (invoiceNumberOrder !== 0) {
            return invoiceNumberOrder;
          }

          return compareNullableStrings(left.invoiceId, right.invoiceId);
        }),
      })
    )
    .sort((left, right) => {
      if (right.totals.total !== left.totals.total) {
        return right.totals.total - left.totals.total;
      }

      const nameOrder = compareNullableStrings(left.contactName, right.contactName);
      if (nameOrder !== 0) {
        return nameOrder;
      }

      return compareNullableStrings(left.currency, right.currency);
    });

  const currencyPayloads = Array.from(totalsByCurrency.values())
    .map(
      (currency): FinanceAgedReceivablesCurrencyPayload => ({
        currency: currency.currency,
        invoiceCount: currency.invoiceCount,
        contactCount: currency.contactKeys.size,
        totals: currency.totals,
      })
    )
    .sort((left, right) => left.currency.localeCompare(right.currency));

  const payload = {
    asOfDate: toDateOnlyString(input.asOfDate),
    invoiceCount,
    contactCount: contactPayloads.length,
    currencies: currencyPayloads.map((currency) => currency.currency),
    totalsByCurrency: currencyPayloads,
    contacts: contactPayloads,
  } as Prisma.InputJsonObject & FinanceAgedReceivablesPayload;

  const currencies = currencyPayloads.map((currency) => currency.currency);
  const snapshotCurrency =
    currencies.length === 1 && currencies[0] !== "UNKNOWN" ? currencies[0] : null;

  return {
    snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: contactPayloads.length,
    scope: "organisation",
    currency: snapshotCurrency,
    payload,
    sourceUpdatedAt,
  };
}

export async function syncFinanceProfitAndLossMonthlySnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await callFinanceXeroApi(
    (observeRateLimit) =>
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
          onRateLimit: (event) => observeRateLimit(event.rateLimitCategory),
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
    (observeRateLimit) =>
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
          onRateLimit: (event) => observeRateLimit(event.rateLimitCategory),
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
    (observeRateLimit) =>
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
          onRateLimit: (event) => observeRateLimit(event.rateLimitCategory),
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

export async function syncFinanceAgedReceivablesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const invoices = await listFinanceAgedReceivablesInvoices(
    context,
    window.asOfDateString
  );

  return buildFinanceAgedReceivablesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}
