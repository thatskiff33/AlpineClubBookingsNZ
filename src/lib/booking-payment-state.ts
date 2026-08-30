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
 * The payment shape `editReviewSettlementPaymentId` needs, spelled out so a
 * caller cannot hand it a payment row loaded without its id.
 */
export type EditReviewSettlementPayment =
  | (BookingPaymentState & { id: string })
  | null
  | undefined;

/**
 * #3166 (epic #2797): the captured payment a PARKED edit's financial review
 * settles against, or null — the one home for that rule (`INV-SSOT`).
 *
 * Four parked edit doors (the batch edit, the date change, the single-guest
 * removal and the guest-add route) each computed this inline from the same two
 * predicates. It is not a formatting detail: `chooseEditReviewSettlementRoute`
 * reads the id at COMPLETION to decide whether the confirmed amount goes back to
 * the card, is mirrored as a hand-settled allocation, or becomes account credit.
 * A copy that drifted would re-route real money, weeks later, with nothing
 * failing.
 *
 * Gated on a CAPTURED payment in a settled booking status — the same test
 * `applyPaymentAdjustments` uses — so a booking with nothing taken carries null
 * and a confirmed amount can never be routed to a refund of money that was never
 * received. Null is an ordinary answer, not a gap: owner decision D2 makes the
 * task's `paymentId` nullable precisely because a credit owed for a surrendered
 * night need not sit against any one captured payment.
 *
 * Lives here beside `hasIssuedPrimaryXeroInvoice`, which is the same shape for
 * the same reason, rather than in `edit-financial-review.ts` — that module is
 * deliberately about the review STATE and reads no payment policy of its own.
 */
export function editReviewSettlementPaymentId(booking: {
  status: string;
  payment: EditReviewSettlementPayment;
}): string | null {
  return isSettledBookingStatus(booking.status) &&
    hasCapturedPayment(booking.payment)
    ? (booking.payment?.id ?? null)
    : null;
}
