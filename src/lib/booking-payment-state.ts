const CAPTURED_PAYMENT_STATUSES = new Set([
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

/**
 * M6 (#2262): the `Payment.status` values a manual cash / off-Xero settlement
 * may settle FROM. PENDING/PROCESSING are the ordinary unsettled shapes; FAILED
 * is a legitimate settle-from too — a declined or expired card attempt is
 * exactly what an admin remedies with cash at the lodge. SUCCEEDED and the
 * refunded variants can never be flipped: money has already moved through this
 * payment, and recording cash over the top of it would misstate the ledger.
 *
 * Lives in this leaf module (#2397) because THREE places must agree: the
 * read-time refusal and the fenced write in `payment-reconciliation.ts`, and
 * the admin page's advisory state in `manual-booking-payment-state.ts`. Keeping
 * it here lets the last of those share it without dragging the whole
 * reconciliation module (and Stripe with it) into a page's import graph.
 */
export const MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST = [
  "PENDING",
  "PROCESSING",
  "FAILED",
] as const;

const MANUAL_SETTLE_FROM_PAYMENT_STATUSES = new Set<string>(
  MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST
);

/**
 * #2397: the refusal an already-captured payment gets, shared so the admin page
 * shows the SAME sentence before the click that the server returns after it.
 */
export const MANUAL_CAPTURED_PAYMENT_REFUSAL =
  "This booking's payment has already taken money — it cannot also be recorded as a cash settlement. Check the payment (and any refund owing) before recording anything.";

/** Whether a manual cash / off-Xero settlement may settle from this status. */
export function isManualSettleFromPaymentStatus(status: string): boolean {
  return MANUAL_SETTLE_FROM_PAYMENT_STATUSES.has(status);
}

// Booking statuses whose payment lifecycle has been entered (an invoice can
// exist / money can have moved). Moved here from booking-modify-settlement
// (#1729) so the Xero period lock-date guard can share the derivation below
// without importing the whole modify-settlement chain.
const SETTLED_BOOKING_STATUSES = new Set([
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
]);

export function isSettledBookingStatus(status: string): boolean {
  return SETTLED_BOOKING_STATUSES.has(status);
}

/**
 * A booking's PRIMARY Xero invoice counts as issued for edit-settlement
 * purposes when the booking is in a settled-lifecycle status and its payment
 * row carries the Xero invoice id. This is the exact `hasIssuedXeroInvoice`
 * that `applyPaymentAdjustments` feeds `queueXeroBookingEditSettlement`,
 * shared with the pre-transaction ordinary-edit lock-date guard (#1729).
 */
export function hasIssuedPrimaryXeroInvoice(booking: {
  status: string;
  payment: { xeroInvoiceId?: string | null } | null | undefined;
}): boolean {
  return (
    isSettledBookingStatus(booking.status) &&
    Boolean(booking.payment?.xeroInvoiceId)
  );
}

export interface BookingPaymentState {
  status: string;
  amountCents?: number | null;
  refundedAmountCents?: number | null;
}

export function hasCapturedPayment(
  payment: BookingPaymentState | null | undefined
): boolean {
  if (!payment || !CAPTURED_PAYMENT_STATUSES.has(payment.status)) {
    return false;
  }

  if (typeof payment.amountCents === "number") {
    return payment.amountCents > 0;
  }

  return true;
}

export function getRemainingRefundableCents(
  payment: BookingPaymentState | null | undefined
): number {
  if (!payment || !hasCapturedPayment(payment)) {
    return 0;
  }

  return Math.max(
    (payment.amountCents ?? 0) - (payment.refundedAmountCents ?? 0),
    0
  );
}

/**
 * #3194 (epic #2797): the booking's OWN captured money, or `null` when it has
 * none — the ONE derivation of that question, and the reason it is here.
 *
 * It answers "is there money behind this booking that a refund could come out
 * of?", and it answers it the way the whole settlement surface already does: the
 * booking is inside its payment lifecycle AND the payment row has actually
 * captured something. Neither half is sufficient on its own.
 * `Payment.source` defaults to `STRIPE` in the schema, so a hand-settled booking
 * carries that column with nothing captured behind it; and a DRAFT or WAITLISTED
 * booking can hold a `PENDING` payment row that has never taken a cent.
 *
 * ONE HOME, and it exists because there were two identical copies with
 * near-identical comments (`INV-SSOT`): the guest-removal service and the batch
 * modification service each derived the payment id a parked edit's review task
 * is raised with, and #3194 needed the same question asked a THIRD time — at
 * COMPLETION, by `chooseEditReviewSettlementRoute`, on a booking that may have
 * been paid since the review was raised. Three spellings of one rule is exactly
 * the shape `INV-SSOT` calls the defect, and the third spelling is the one where
 * disagreeing with the other two sends a member's refund to the wrong place.
 *
 * Returns the PAYMENT rather than its id, because the completion path needs its
 * `source` as well and re-reading the same row through a second accessor would
 * reintroduce the disagreement this removes.
 */
export function capturedBookingPayment<
  T extends { id: string; status: string; amountCents?: number | null },
>(booking: {
  status: string;
  payment: T | null | undefined;
}): T | null {
  return isSettledBookingStatus(booking.status) &&
    hasCapturedPayment(booking.payment)
    ? (booking.payment ?? null)
    : null;
}
