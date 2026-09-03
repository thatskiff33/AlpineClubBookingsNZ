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
  // REQUIRED, not optional (#3200 review). Optional would let a caller whose
  // payment select omits the column type-check clean and be told "no invoice"
  // for ever — the under-answering direction, where the difference is simply
  // never billed and nothing fails. `INV-SSOT-001` prefers unrepresentable
  // over policed: a narrowed select is now a compile error at the call site.
  payment: { xeroInvoiceId: string | null } | null | undefined;
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
 * The payment shape the two accessors below need, spelled out so a caller cannot
 * hand them a payment row loaded without its id.
 */
export type EditReviewSettlementPayment =
  | (BookingPaymentState & { id: string })
  | null
  | undefined;

/**
 * #3166 / #3194 (epic #2797): the captured payment a PARKED edit's financial
 * review settles against, or `null` — THE one derivation of that rule
 * (`INV-SSOT`), asked at both ends of the review's life.
 *
 * It answers "is there money behind this booking that a refund could come out
 * of?", and it answers it the way the whole settlement surface already does: the
 * booking is inside its payment lifecycle AND the payment row has actually
 * captured something. Neither half is sufficient on its own. `Payment.source`
 * defaults to `STRIPE` in the schema, so a hand-settled booking carries that
 * column with nothing captured behind it; and a DRAFT or WAITLISTED booking can
 * hold a `PENDING` payment row that has never taken a cent. It is the same test
 * `applyPaymentAdjustments` uses, so a booking with nothing taken carries null
 * and a confirmed amount can never be routed to a refund of money that was never
 * received. Null is an ordinary answer, not a gap: owner decision D2 makes the
 * task's `paymentId` nullable precisely because a credit owed for a surrendered
 * night need not sit against any one captured payment.
 *
 * TWO CALLERS, ONE QUESTION, and the second is why this returns the payment ROW:
 *
 *  - AT RAISE TIME, `raiseParkedEditFinancialReviewTasks` stamps the id onto the
 *    task. Four parked edit doors (the batch edit, the date change, the
 *    single-guest removal and the guest-add route) each computed it inline from
 *    the same two predicates before #3166 gathered them.
 *  - AT COMPLETION, `chooseEditReviewSettlementRoute` re-asks it of the booking
 *    as it stands NOW, but ONLY where the task carries no id — the stamped value
 *    is a snapshot of the moment the edit parked and nothing backfills it, so a
 *    member who paid afterwards would otherwise be refunded as club credit for
 *    ever. That path needs the row's `source` as well as its id to tell a card
 *    refund from a hand-settled ledger mirror, and re-reading the same row
 *    through a second accessor would reintroduce the disagreement this removes.
 *
 * Getting it wrong does not fail: it routes real money down the wrong path weeks
 * later, in front of an admin with no way to tell. That is why both ends read
 * this and not a copy of it.
 *
 * Lives here beside `hasIssuedPrimaryXeroInvoice`, which is the same shape for
 * the same reason, rather than in `edit-financial-review.ts` — that module is
 * deliberately about the review STATE and reads no payment policy of its own.
 *
 * NOT the same question as the `account-credit` route's
 * `allocateAgainstPaymentId`, which deliberately drops the settled-status half;
 * `edit-financial-review-settlement.ts` states why at that site.
 */
export function editReviewSettlementPayment<
  T extends BookingPaymentState & { id: string },
>(booking: { status: string; payment: T | null | undefined }): T | null {
  return isSettledBookingStatus(booking.status) &&
    hasCapturedPayment(booking.payment)
    ? (booking.payment ?? null)
    : null;
}

/**
 * The id half of `editReviewSettlementPayment` above, which is all a raise site
 * stores. Derived from it rather than repeating its two predicates, so the two
 * ends of a review's life cannot drift apart (`INV-SSOT`).
 */
export function editReviewSettlementPaymentId(booking: {
  status: string;
  payment: EditReviewSettlementPayment;
}): string | null {
  return editReviewSettlementPayment(booking)?.id ?? null;
}
