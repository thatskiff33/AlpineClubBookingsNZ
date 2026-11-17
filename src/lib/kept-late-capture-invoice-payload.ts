/**
 * #3635: the queued payload of the invoice, paid from the Stripe account, that
 * records a late card capture on a cancelled booking a treasurer KEPT. Anchored
 * on the #3639 approval task (`xero-kept-late-capture-invoice.ts`). A leaf, like
 * `additional-capture-receipt-payload.ts`: the outbox's payload parser and the
 * worker read one shape (`INV-SSOT`).
 */
import { isCalendarDate } from "@/lib/club-time";
import { asRecord, readNumber, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE = "KEPT_LATE_CAPTURE_INVOICE";

/**
 * #3635: the GROSS captured cents and the club day Stripe took them, frozen
 * when the treasurer kept them, so a retry sends the same receipt on the same
 * date (orchestrator decision 29 Sep 2026). `paymentIntentId` names the
 * capture whose refunds the refund note answers.
 */
export interface QueuedKeptLateCaptureInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE;
  bookingId: string;
  manualRefundTaskId: string;
  paymentIntentId: string;
  capturedCents: number;
  /** `YYYY-MM-DD`, the club's calendar day of the capture. */
  capturedOn: string;
  /**
   * #3635 round-3 R2: set once `capturedOn` was read from the Stripe charge
   * (`readStripeCaptureDocumentDate`) and stored before the Xero call, so a
   * retry never reads it again or drifts. Absent, `capturedOn` is the task's
   * raise day, the enqueue's estimate.
   */
  capturedOnFromStripe?: boolean;
}

/** The payload, or null when it is not a readable one. */
export function readKeptLateCaptureInvoicePayload(
  value: unknown,
): QueuedKeptLateCaptureInvoiceOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload || payload.queueType !== XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE) return null;
  const bookingId = readString(payload.bookingId);
  const manualRefundTaskId = readString(payload.manualRefundTaskId);
  const paymentIntentId = readString(payload.paymentIntentId);
  const capturedCents = readNumber(payload.capturedCents);
  const capturedOn = readString(payload.capturedOn);
  if (
    !bookingId ||
    !manualRefundTaskId ||
    !paymentIntentId ||
    capturedCents === null ||
    !Number.isInteger(capturedCents) ||
    capturedCents <= 0 ||
    !capturedOn ||
    // Strict on purpose: written from a real charge day, so a non-day is
    // corruption and would only be refused by Xero later.
    !isCalendarDate(capturedOn)
  ) {
    return null;
  }
  return {
    queueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
    bookingId,
    manualRefundTaskId,
    paymentIntentId,
    capturedCents,
    capturedOn,
    ...(payload.capturedOnFromStripe === true ? { capturedOnFromStripe: true } : {}),
  };
}
