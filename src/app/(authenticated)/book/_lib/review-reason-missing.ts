/**
 * The wizard's two refusals for a missing review reason (#4945).
 *
 * A child with no adult needs a reason for the booking officer, and pressing
 * Continue to Payment or Join Waitlist without one stops in the browser. The
 * sentences are named once here: the hook writes them, and the reason field
 * points at the error box only while the box holds one of them, so the two can
 * never describe different refusals.
 */
export const REVIEW_REASON_MISSING_MESSAGE =
  "Please add a reason for booking without an adult guest. This goes to an admin for review.";

export const REVIEW_REASON_MISSING_WAITLIST_MESSAGE =
  "Please add a reason for booking without an adult guest before joining the waitlist.";

/** True while `message` is one of the two refusals above. */
export function isReviewReasonMissingMessage(message: string): boolean {
  return (
    message === REVIEW_REASON_MISSING_MESSAGE ||
    message === REVIEW_REASON_MISSING_WAITLIST_MESSAGE
  );
}
