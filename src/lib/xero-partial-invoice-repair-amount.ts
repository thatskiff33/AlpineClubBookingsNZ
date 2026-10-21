/**
 * What the Xero Operations repair of a PARTIAL invoice create records as paid
 * (`xero-operation-retry.ts`): the invoice total read from the stored payloads
 * and, for a primary booking invoice, the cash its create stored (#4010).
 */
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asArray, asRecord, readNumber } from "@/lib/xero-json";
import {
  parsePrimaryInvoiceFeeAtLink,
  PRIMARY_INVOICE_NOTHING_LEFT_DUE_REASON,
} from "@/lib/xero-primary-invoice-fee-at-link";

/**
 * The invoice's total: Xero's response total, else the sum of the request's
 * lines; null when neither can be read. A supplementary invoice's cash.
 */
export function readStoredInvoiceTotalCents(
  operation: { requestPayload: unknown; responsePayload: unknown },
): number | null {
  const responsePayload = asRecord(operation.responsePayload);
  const invoiceResponse = asRecord(responsePayload?.invoice);
  const responseInvoice = asRecord(asArray(invoiceResponse?.invoices)[0]);
  const responseTotalCents = providerAmountToCents(readNumber(responseInvoice?.total));
  if (responseTotalCents !== null) {
    return responseTotalCents;
  }

  const requestPayload = asRecord(operation.requestPayload);
  const requestInvoice = asRecord(asArray(requestPayload?.invoices)[0]);
  const lineItems = asArray(requestInvoice?.lineItems)
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => Boolean(value));

  if (lineItems.length === 0) {
    return null;
  }

  const totalCents = lineItems.reduce((sum, lineItem) => {
    const quantity = readNumber(lineItem.quantity) ?? 1;
    const unitAmount = readNumber(lineItem.unitAmount);
    if (unitAmount === null) {
      return sum;
    }

    // `unitAmount * quantity` first, then the cents boundary — the same
    // left-to-right evaluation the inline `Math.round(unitAmount * quantity *
    // 100)` performed, so the stored-total comparison is unchanged (#2685).
    const lineTotalCents = providerAmountToCents(unitAmount * quantity);
    return lineTotalCents === null ? sum : sum + lineTotalCents;
  }, 0);

  return totalCents > 0 || lineItems.some((lineItem) => readNumber(lineItem.unitAmount) === 0)
    ? totalCents
    : null;
}

/**
 * The Stripe cash the Xero Operations repair of a PARTIAL primary-invoice
 * create records (#4010): the payment that create tried to write, which it
 * stored with the invoice link. Never the invoice total, which on a card
 * booking with applied account credit overstates the card cash and leaves the
 * credit allocation nothing to settle; and never the stored invoice cash
 * alone, which is floored at an earlier unmatched payment already on the
 * invoice. Fallbacks, by the record's age (see `parsePrimaryInvoiceFeeAtLink`):
 * attempted payment, else stored cash (before #4010), else the total (before
 * #3955).
 */
export function primaryInvoiceRepairCashCents(
  requestPayload: unknown,
  xeroInvoiceId: string,
  invoiceTotalCents: number,
): number {
  const atLink = parsePrimaryInvoiceFeeAtLink(requestPayload, xeroInvoiceId);
  return atLink?.primaryInvoiceAttemptedCashCents ?? atLink?.primaryInvoiceCashCents ?? invoiceTotalCents;
}

/**
 * The skip reason and officer message for a repair that records no payment.
 * `creditTookAllCash` (a primary invoice whose stored cash is zero though its
 * total is not) is defensive: a create that skipped its payment says so with
 * `paymentSkipped`, which refuses the repair before this is reached, so the
 * path is effectively unreachable today.
 */
export function zeroCashRepairOutcome(repair: {
  linkRole: string;
  creditTookAllCash?: boolean;
}): { skipReason: string; message: string } {
  if (repair.creditTookAllCash) {
    return {
      skipReason: PRIMARY_INVOICE_NOTHING_LEFT_DUE_REASON,
      message:
        "Marked Xero booking invoice as repaired without payment recording: its applied account credit leaves no card cash to record.",
    };
  }
  const invoice = repair.linkRole === "INVOICE_PAYMENT" ? "booking" : "supplementary";
  return {
    skipReason: "Zero-total invoice does not require Xero payment recording.",
    message: `Marked zero-total Xero ${invoice} invoice as repaired without payment recording.`,
  };
}
