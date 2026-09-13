import type { Invoice } from "xero-node";
import { parseOptionalDateOnly, toOptionalText } from "./date-format";
import type {
  FinanceAgedInvoiceBucketKey,
  FinanceAgedInvoiceBucketTotals,
  FinanceOpenInvoiceType,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createEmptyAgedInvoiceTotals(): FinanceAgedInvoiceBucketTotals {
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

export function addToAgedInvoiceTotals(
  totals: FinanceAgedInvoiceBucketTotals,
  bucket: FinanceAgedInvoiceBucketKey,
  amountDue: number
): void {
  totals[bucket] += amountDue;
  totals.total += amountDue;

  if (bucket !== "current") {
    totals.overdue += amountDue;
  }
}

export function getInvoiceContactName(invoice: Invoice): string | null {
  const name = toOptionalText(invoice.contact?.name);
  if (name) {
    return name;
  }

  const fallback = [invoice.contact?.firstName, invoice.contact?.lastName]
    .map((value) => toOptionalText(value))
    .filter((value): value is string => value !== null)
    .join(" ")
    .trim();

  return fallback || null;
}

export function getInvoiceCurrency(invoice: Invoice): string {
  return toOptionalText(invoice.currencyCode) ?? "UNKNOWN";
}

export function getInvoiceAmountDue(invoice: Invoice): number {
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

export function getAgedInvoiceBucket(
  asOfDate: Date,
  dueDate: Date | null
): {
  bucket: FinanceAgedInvoiceBucketKey;
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

export function buildOpenInvoiceWhereClause(
  invoiceType: FinanceOpenInvoiceType,
  asOfDateString: string
): string {
  const [year, month, day] = asOfDateString.split("-").map((value) => Number(value));

  return [`Type=="${invoiceType}"`, `Date <= DateTime(${year},${month},${day})`].join(
    " AND "
  );
}

export function compareNullableStrings(a: unknown, b: unknown): number {
  const left = toOptionalText(a);
  const right = toOptionalText(b);

  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left.localeCompare(right);
}

export function getContactAccumulatorKey(invoice: Invoice): string {
  const contactId = toOptionalText(invoice.contact?.contactID) ?? "";
  const contactName = getInvoiceContactName(invoice) ?? "";
  const invoiceId = toOptionalText(invoice.invoiceID) ?? "";
  const invoiceNumber = toOptionalText(invoice.invoiceNumber) ?? "";

  return [
    contactId || contactName || invoiceId || invoiceNumber || "unknown",
    getInvoiceCurrency(invoice),
  ].join("::");
}

export function isEligibleOpenInvoice(
  invoice: Invoice,
  asOfDate: Date,
  invoiceType: FinanceOpenInvoiceType
): boolean {
  if (!invoice.type || String(invoice.type) !== invoiceType) {
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

/**
 * Fold an invoice's due date into a contact accumulator's oldest/latest range.
 * Shared verbatim by the aged and open-invoice snapshot builders.
 */
export function updateContactDueDateRange(
  contact: { oldestDueDate: Date | null; latestDueDate: Date | null },
  dueDate: Date | null
): void {
  contact.oldestDueDate =
    !contact.oldestDueDate ||
    (dueDate && dueDate.getTime() < contact.oldestDueDate.getTime())
      ? dueDate ?? contact.oldestDueDate
      : contact.oldestDueDate;
  contact.latestDueDate =
    !contact.latestDueDate ||
    (dueDate && dueDate.getTime() > contact.latestDueDate.getTime())
      ? dueDate ?? contact.latestDueDate
      : contact.latestDueDate;
}

/**
 * Stable order for invoice payloads within a contact: due date, then invoice
 * number, then invoice id. Shared by the aged and open-invoice builders.
 */
export function compareOpenInvoicePayloadsByDueDate(
  left: { dueDate: string | null; invoiceNumber: string | null; invoiceId: string | null },
  right: { dueDate: string | null; invoiceNumber: string | null; invoiceId: string | null }
): number {
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
}

/**
 * A snapshot carries a currency only when every invoice shares one known
 * currency; mixed or unknown currencies leave it null. Shared by the aged and
 * open-invoice builders.
 */
export function deriveSnapshotCurrency(
  currencyPayloads: ReadonlyArray<{ currency: string }>
): string | null {
  // "Exactly one known currency" said as a first with no rest, so the currency
  // returned is the one this expression already checked (#2800).
  const [soleCurrency, ...extraCurrencies] = currencyPayloads.map(
    (payload) => payload.currency
  );
  return soleCurrency !== undefined &&
    extraCurrencies.length === 0 &&
    soleCurrency !== "UNKNOWN"
    ? soleCurrency
    : null;
}
