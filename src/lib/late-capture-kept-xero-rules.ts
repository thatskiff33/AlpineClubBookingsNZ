import type { PaymentStatus } from "@prisma/client";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * #3635: THE ONE DECISION about a late capture on a cancelled booking - is it
 * refunded, awaiting a treasurer, or kept, and what does Xero owe it - plus the
 * names its record uses. Pure; every caller loads its own facts and asks here:
 * the waiting-invoice reaper and the late-capture release (through
 * `lateCaptureRefundState`), the dismissal (`late-capture-kept-xero.ts`), the
 * kept-invoice worker at send time (`xero-kept-late-capture-invoice.ts`) and
 * the booking-vs-Xero repair tool (`INV-SSOT`, `INV-PAY-110`).
 */

/** The link roles a kept capture's own invoice and its Stripe payment write. */
export const KEPT_LATE_CAPTURE_INVOICE_ROLE = "KEPT_LATE_CAPTURE_INVOICE";
export const KEPT_LATE_CAPTURE_PAYMENT_ROLE = "KEPT_LATE_CAPTURE_PAYMENT";

export type LateCaptureRefundState = "refunded" | "awaiting-decision" | "kept";

export type LateCaptureDecision = {
  state: LateCaptureRefundState;
  /**
   * What Xero owes this capture as its receipt: the GROSS captured cents when
   * it is kept and was captured, else 0. Gross, the way a card receipt is
   * recorded (orchestrator decision 29 Sep 2026 on #3635): any refund, from
   * the dashboard or on approval, is answered by its own refund credit note,
   * so netting it here as well would count it twice.
   */
  recordCents: number;
};

/**
 * - A #3639 approval task, when one owns the capture, decides: OPEN is
 *   awaiting (nothing may be sent or retired), COMPLETED refunded (the
 *   approval is the refund), DISMISSED kept (owner decision 29 Sep 2026).
 * - With no task, the webhook's own routing: a CANCELLED booking's late capture
 *   or a superseded intent's is refunded by design; anything else is kept.
 */
export function decideLateCapture(input: {
  taskStatus: "OPEN" | "COMPLETED" | "DISMISSED" | null;
  bookingStatus: string | null | undefined;
  superseded: boolean;
  capture: { status: PaymentStatus; amountCents: number } | null;
}): LateCaptureDecision {
  let state: LateCaptureRefundState;
  if (input.taskStatus === "OPEN") state = "awaiting-decision";
  else if (input.taskStatus === "COMPLETED") state = "refunded";
  else if (input.taskStatus === "DISMISSED") state = "kept";
  else if (isLateCaptureRefundedBookingStatus(input.bookingStatus) || input.superseded) {
    state = "refunded";
  } else state = "kept";
  const recordCents =
    state === "kept" && input.capture && isCapturedTransactionStatus(input.capture.status)
      ? Math.max(input.capture.amountCents, 0)
      : 0;
  return { state, recordCents };
}

/**
 * WHICH DOCUMENT RECORDS A KEPT CAPTURE. A change payment on a booking whose
 * original invoice exists keeps its own supplementary invoice (released by the
 * late-capture release). Everything else - the booking's own payment, and a
 * change payment on a booking Xero never invoiced (#3635 review F3) - gets the
 * kept-capture invoice, which needs no original.
 */
export function keptLateCaptureRecordRoute(input: {
  captureKind: "PRIMARY" | "ADDITIONAL";
  bookingHasPrimaryInvoice: boolean;
}): "change-invoice" | "kept-invoice" {
  return input.captureKind === "ADDITIONAL" && input.bookingHasPrimaryInvoice
    ? "change-invoice"
    : "kept-invoice";
}

/**
 * HAS THIS KEPT CAPTURE'S INVOICE ALREADY BEEN ASKED FOR? A kept-capture
 * invoice row anchored on its approval task, in any state but CANCELLED. A
 * FAILED or PARTIAL one counts: it is retried, never replaced. The enqueue and
 * the repair tool both ask this, and nothing else spells it.
 */
export function keptLateCaptureInvoiceAsked(
  taskOperations: ReadonlyArray<{ queueType: string | null; status: string }>,
): boolean {
  return taskOperations.some(
    (operation) =>
      operation.queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE &&
      operation.status !== "CANCELLED",
  );
}
