/**
 * #1992 / #4211 (`INV-PAY-043`): the `markBookingPaymentSucceeded` outcomes of
 * a capture that arrived on a booking ANOTHER payment had already settled -
 * refunded, its refund queued, or kept for an admin to check. The booking is
 * settled, but by the other payment, whose path already sent the confirmation
 * and queued the invoice, so a caller repeats neither. A leaf module, so a test
 * that mocks the settlement module still reads the real rule.
 */
export const SETTLED_BY_ANOTHER_CAPTURE_OUTCOMES = [
  "duplicate_capture_refunded",
  "duplicate_capture_refund_failed",
  "duplicate_capture_kept",
] as const;

export function settledByAnotherCapture(outcome: string): boolean {
  return (SETTLED_BY_ANOTHER_CAPTURE_OUTCOMES as readonly string[]).includes(outcome);
}
