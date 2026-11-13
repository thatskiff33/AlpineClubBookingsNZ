import { Invoice, LineAmountTypes, type Payment as XeroPayment } from "xero-node";
import { compareCalendarDates, type CalendarDate } from "../../club-time";
import { refundDocumentLineItem } from "../../xero-modification-line-items";
import type { ResolvedAccountMapping } from "../../xero-mappings";
import { buildRefundDocumentDescription, buildRefundDocumentReference } from "../../xero-refund-method";
import { buildXeroIdempotencyKey } from "../../xero-sync";
import { coverRefundExportComponent, refundExportPayloadHash, type RefundExportComponent, type RefundExportPlan, type RefundExportProblem } from "./refund-note-plan";

/**
 * THE FAILED-LATER REFUND REVERSAL, PLANNED (#4525, Ledger M13; design section 7,
 * rendered as #4361 decided). Pure, and planned only: no production caller sends
 * it, and nothing enqueues it. A card refund Stripe later reports failed is R13,
 * the exact reversal of its R12. In Xero it is one ACCREC invoice coded like the
 * credit note it undoes (the `hutFeeRefunds` mapping, `OUTPUT2`, inclusive, the
 * full R13 cents) and one payment into the Stripe bank account; it is never
 * emailed and never allocated.
 *
 * Its date is the club day the refund failed, or, when that day is on or before
 * Xero's lock date, the first open club day the caller names. Its reference
 * always carries the failure day. Its key names the payment and the Stripe
 * refund alone: no watermark and no after-void parts, so a retry after any
 * other note moved never mints a second reversal.
 */
export interface FailedLaterRefundReversalInput {
  paymentId: string;
  bookingId: string;
  stripeRefundId: string;
  contactId: string;
  /** The club day Stripe reported the refund failed. */
  failureDate: CalendarDate;
  /** Xero's lock date, or null when none is set. */
  lockDate: CalendarDate | null;
  /** The caller's first open club day after the lock date. */
  firstOpenDate: CalendarDate;
  refundMapping: ResolvedAccountMapping;
  stripeBankCode: string;
  /** The R13 cash slice on STRIPE_CLEARING (`memberMoneyEventKeys.reversal`), or why none could be named. */
  reversal: RefundExportComponent | RefundExportProblem;
}

export interface FailedLaterRefundReversalPlan {
  idempotencyKey: string;
  date: CalendarDate;
  invoice: Invoice;
  /** The payment into Stripe, sent once the invoice's id is known. */
  payment: Omit<XeroPayment, "invoice">;
  manifest: RefundExportPlan;
}

/** The reversal's Xero key: the payment and the Stripe refund, nothing that moves. */
export function failedLaterRefundReversalKey(paymentId: string, stripeRefundId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "card-refund-reversal-invoice", stripeRefundId, "v1");
}

/** The failure day, or the first open day when the failure day is on or before the lock date. */
export function failedLaterRefundReversalDate(failureDate: CalendarDate, lockDate: CalendarDate | null, firstOpenDate: CalendarDate): CalendarDate {
  return lockDate !== null && compareCalendarDates(failureDate, lockDate) <= 0 ? firstOpenDate : failureDate;
}

export function planFailedLaterRefundReversal(input: FailedLaterRefundReversalInput): FailedLaterRefundReversalPlan {
  const cents = "problem" in input.reversal ? 0 : input.reversal.cents;
  const date = failedLaterRefundReversalDate(input.failureDate, input.lockDate, input.firstOpenDate);
  const reference = `Reversal of ${buildRefundDocumentReference({ method: "card", bookingId: input.bookingId })} - refund failed ${input.failureDate}`;
  const line = refundDocumentLineItem(
    `Reversal of ${buildRefundDocumentDescription({ method: "card", bookingId: input.bookingId })} - refund failed ${input.failureDate}`,
    cents,
    input.refundMapping,
  );
  const invoice: Invoice = {
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: input.contactId },
    date,
    dueDate: date,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [line],
    reference,
    status: Invoice.StatusEnum.AUTHORISED,
  };
  const payment: Omit<XeroPayment, "invoice"> = {
    account: { code: input.stripeBankCode },
    amount: cents / 100,
    date,
    reference,
    isReconciled: false,
  };
  const idempotencyKey = failedLaterRefundReversalKey(input.paymentId, input.stripeRefundId);
  const manifest = coverRefundExportComponent({
    rendering: {
      legacyKey: idempotencyKey,
      payloadHash: refundExportPayloadHash({ invoice, payment }),
      frozenMapping: {
        lineAmountTypes: LineAmountTypes.Inclusive,
        lineCodes: [{ accountCode: line.accountCode ?? null, itemCode: line.itemCode ?? null, taxType: line.taxType ?? null }],
        stripeBankCode: input.stripeBankCode,
        failureDate: input.failureDate,
        lockDate: input.lockDate,
        date,
      },
      lineTotalCents: cents,
    },
    component: input.reversal,
    allowedAccounts: ["STRIPE_CLEARING"],
  });
  return { idempotencyKey, date, invoice, payment, manifest };
}
