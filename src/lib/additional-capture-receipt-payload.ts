/**
 * #3953 (`INV-PAY-139`): the queued payload of the operation that records a
 * booking change's card capture against the Xero invoice that bills it, when
 * no supplementary invoice was waiting on that capture. A leaf - it imports
 * nothing of the outbox - so the outbox's payload parser and the worker
 * (`additional-capture-xero-receipt.ts`) read one shape (`INV-SSOT`).
 */
import { asRecord, readNumber, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE = "ADDITIONAL_CAPTURE_RECEIPT";

/** Which invoice the capture is recorded against. */
export type AdditionalCaptureReceiptTarget = "GAP_INVOICE" | "CHANGE_INVOICE" | "PRIMARY_INVOICE";

/**
 * The payment the worker decided to write, stored on the row BEFORE it calls
 * Xero. A retry re-uses it as it stands - the same invoice, amount, date and
 * Xero key - and never decides again, so a write whose response was lost can
 * never be followed by a second one against a different invoice.
 */
export interface AdditionalCaptureReceiptPlan {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  amountCents: number;
  /** The capture's gross cents; more than `amountCents` when the invoice had less due. */
  capturedCents: number;
  /** `YYYY-MM-DD`, the club day of the payment. */
  date: string;
}

export interface QueuedAdditionalCaptureReceiptOutboxPayload {
  queueType: typeof XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE;
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  plan?: AdditionalCaptureReceiptPlan;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readPlan(value: unknown): AdditionalCaptureReceiptPlan | null {
  const plan = asRecord(value);
  if (!plan) return null;
  const target =
    plan.target === "GAP_INVOICE" || plan.target === "CHANGE_INVOICE" || plan.target === "PRIMARY_INVOICE"
      ? plan.target
      : null;
  const invoiceId = readString(plan.invoiceId);
  const amountCents = readNumber(plan.amountCents);
  const capturedCents = readNumber(plan.capturedCents);
  const date = readString(plan.date);
  if (
    !target ||
    !invoiceId ||
    amountCents === null ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    capturedCents === null ||
    !Number.isInteger(capturedCents) ||
    capturedCents < amountCents ||
    !date ||
    !DATE_PATTERN.test(date)
  ) {
    return null;
  }
  return { target, invoiceId, amountCents, capturedCents, date };
}

/**
 * The payload, or null when it is not a readable one. A stored plan that does
 * not parse makes the whole payload unreadable rather than silently dropping
 * it: a dropped plan would let a retry decide again.
 */
export function readAdditionalCaptureReceiptPayload(
  value: unknown,
): QueuedAdditionalCaptureReceiptOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload || payload.queueType !== XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE) return null;
  const bookingId = readString(payload.bookingId);
  const paymentId = readString(payload.paymentId);
  const paymentTransactionId = readString(payload.paymentTransactionId);
  const paymentIntentId = readString(payload.paymentIntentId);
  if (!bookingId || !paymentId || !paymentTransactionId || !paymentIntentId) return null;
  const base = {
    queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
    bookingId,
    paymentId,
    paymentTransactionId,
    paymentIntentId,
  } as const;
  if (payload.plan === undefined || payload.plan === null) return base;
  const plan = readPlan(payload.plan);
  return plan ? { ...base, plan } : null;
}

/**
 * #3953 review round 1: the #3980 gap invoice's queued payload names itself,
 * and the captures its own Stripe payment takes (`attributeGapCash`), so each
 * of those captures has one recorder. The supplementary handler keeps its
 * queued payload when it sends, so the names survive the send.
 */
export const GAP_COVERED_INTENTS_KEY = "coveredPaymentIntentIds";
export const GAP_COVERED_CENTS_KEY = "coveredCaptureCents";

export function primaryInvoiceGapPayload(
  gap: { coveredCaptures: ReadonlyArray<{ paymentIntentId: string; cents: number }> } | undefined,
): Record<string, unknown> {
  if (!gap) return {};
  return {
    primaryInvoiceGap: true,
    [GAP_COVERED_INTENTS_KEY]: gap.coveredCaptures.map((capture) => capture.paymentIntentId),
    [GAP_COVERED_CENTS_KEY]: Object.fromEntries(gap.coveredCaptures.map((capture) => [capture.paymentIntentId, capture.cents])),
  };
}

/**
 * #4494 (`INV-ADDPAY-046`): a gap invoice's queued payload turned unpaid at
 * its send, because a capture it would pay from is the credit-release sweep's.
 * An unpaid gap invoice names no capture, as the enqueue writes one, so every
 * reader of its coverage sees the same thing.
 */
export function unpaidPrimaryInvoiceGapPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, recordPayment: false, ...primaryInvoiceGapPayload({ coveredCaptures: [] }) };
}
