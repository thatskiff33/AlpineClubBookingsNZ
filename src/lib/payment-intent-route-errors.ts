// The typed refusals `POST /api/payments/create-payment-intent` throws inside
// its pay transaction, moved verbatim from that route to keep it under its size
// ceiling (#5145).

export class PaymentIntentCapacityError extends Error {
  constructor() {
    super("Not enough beds available for your dates. Please choose different dates.");
    this.name = "PaymentIntentCapacityError";
  }
}

/**
 * The booking moved out of the status this request read before the pay
 * transaction could claim it — a concurrent cancel, admin action or a second
 * pay attempt. Nothing was written (the transaction rolls back), so this is a
 * plain conflict, not a failure.
 */
export class PaymentIntentConflictError extends Error {
  constructor() {
    super("This booking is no longer payable. Reload the booking and try again.");
    this.name = "PaymentIntentConflictError";
  }
}

/** #3864: another tab attached an intent beside the one retired; nothing spent. */
export class CreditElectionIntentConflictError extends Error {}

/**
 * Defence in depth (#2266): a DRAFT carrying an unresolved admin review must
 * not become payable here. The writers park review-flagged drafts to
 * AWAITING_REVIEW (booking-create and the modify path alike), so this state
 * should not exist — but the no-adult review rule is a child-safety gate, so
 * the pay door checks it too rather than trusting every writer forever.
 */
export class PaymentIntentReviewPendingError extends Error {
  constructor() {
    super("This booking needs admin review before it can be paid.");
    this.name = "PaymentIntentReviewPendingError";
  }
}
