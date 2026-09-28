import { XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * #3635: the pure rules for recording a KEPT late capture of a booking's own
 * payment in Xero, shared by the dismissal (`late-capture-kept-xero.ts`) and the
 * booking-vs-Xero repair tool (`xero-booking-repair-classify.ts`), so the two
 * cannot disagree about how much was kept or whether its invoice was already
 * asked for (`INV-SSOT`). No I/O here.
 */

/**
 * WHAT WAS KEPT: the capture net of whatever Stripe has refunded since (a
 * treasurer who refunded it in the dashboard closes the task without refunding,
 * as the payments guide says). Zero means nothing was kept and nothing is
 * recorded.
 */
export function keptLateCaptureCents(capture: {
  amountCents: number;
  refundedAmountCents: number;
}): number {
  return Math.max(capture.amountCents - capture.refundedAmountCents, 0);
}

/**
 * HAS THIS KEPT CAPTURE'S INVOICE ALREADY BEEN ASKED FOR? A kept-late-capture
 * invoice row anchored on its approval task, in any state but CANCELLED. A
 * FAILED or PARTIAL one counts: it is retried, never replaced. A CANCELLED one
 * (withdrawn by an approval, or skipped while the task was reopened) does not,
 * so a later keep asks again.
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
