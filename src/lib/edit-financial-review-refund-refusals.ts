/**
 * THE REFUSALS A REVIEW REFUND OR CREDIT CAN GIVE, AND WHY EACH ONE IS A
 * REFUSAL (#3032, #3170, epic #2797).
 *
 * Lifted out of `edit-financial-review-settlement.ts` on #3529, on the seam
 * `edit-financial-review-charge-refusals.ts` was cut on in #3181: these three
 * are officer-facing SENTENCES, each carrying the reason it exists, and the
 * module they came from is about choosing a route and moving the money.
 * Deliberately dependency-free - no `server-only`, no Prisma, no provider
 * client - so a surface that needs to show one of these before the click can
 * import it without dragging the settlement machinery in behind it.
 */

/**
 * Raised when the review carries no `BookingModification` to settle against -
 * either because none was recorded, or because the stored `reviewContext` cannot
 * be read back at all. Two of the three routes key their exactly-once on that
 * id, so without one the only alternatives are to guess which row to settle
 * against or to mint a second anchor silently. Both are worse than telling the
 * operator plainly and leaving the task open.
 */
export const REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE =
  "This review is not linked to the booking change it came from, so the amount cannot be settled automatically. Hand the amount back another way, then dismiss this task with a note recording what you paid and how - the note is the record that the money was settled outside the system.";

/**
 * Owner decision D-3032-1 obliges this case to be handled deliberately rather
 * than discovered at runtime. A confirmed review amount settles against the
 * ORIGINAL edit's `BookingModification` row, and
 * `MemberCredit.sourceBookingModificationId` is `@unique` - so if that edit had
 * already issued a credit of its own, a second credit against the same row
 * cannot be represented.
 *
 * Left unhandled it is not a clean failure: `createBookingModificationCredit`
 * would reach `assertMatchingBookingModificationCredit` and throw an untyped
 * `Error`, which falls past the route's `instanceof ManualBookingPaymentError`
 * check and reaches the operator as "Could not close the refund task" with a 500
 * in monitoring - for a database doing exactly what it was asked to.
 *
 * ANY pre-existing credit on the anchor is refused, including one whose amount
 * happens to equal the confirmed figure. That is not over-caution: a matching
 * amount is indistinguishable from a coincidence, and treating it as a replay
 * would mark the task COMPLETED having moved nothing - money lost in silence,
 * which is the failure this epic exists to prevent. A genuine replay never gets
 * here, because a second completion of a COMPLETED task is refused by the status
 * check in the caller.
 *
 * It is a DEFENSIVE refusal rather than a routine one: an edit whose amount
 * could not be proven computes no settlement, so it issues no credit of its own
 * and leaves the anchor free.
 *
 * WHAT THE OPERATOR IS TOLD TO DO WITH IT, and why that leaves an honest row.
 * The amount IS owed, so "dismiss it" would be wrong under a reading of DISMISSED
 * as "no adjustment is due". That is not what DISMISSED means here: the epic's
 * requirement is that a dismissal must not PRETEND MONEY MOVED, and the note is
 * REQUIRED on every dismissal precisely so the row says which decision it was.
 * The wording below therefore asks for the note to record the hand-back, and the
 * DISMISSED definition in `manual-refund-task-resolution.ts` and `INV-PAY-051` is
 * stated to match. Leaving the task OPEN instead would be the dishonest option:
 * it would hold a money question that has already been answered, and the
 * pending-review fence would keep refusing the member's edits for as long as it
 * stayed there.
 */
export const REVIEW_CREDIT_ANCHOR_TAKEN_MESSAGE =
  "The booking change behind this review has already issued account credit, so a second credit cannot be recorded against it. Hand the amount back another way, then dismiss this task with a note recording what you paid and how - the note is the record that the money was settled outside the system.";

/**
 * The pre-claim cap on the card route.
 *
 * `refundPaymentTransactions` refuses an amount larger than the captured Stripe
 * total - but it runs AFTER the commit, where a refusal is the worst possible
 * outcome: the failure was swallowed, a recovery operation that could never
 * succeed was enqueued, no `REFUNDED` event was written, and the route still
 * answered "Refund recorded as paid back by hand" over a permanently COMPLETED
 * task with nothing moved. Asking the same question here, before the claim, turns
 * that into a refusal the operator can act on with the task still OPEN.
 *
 * It is the captured-payment check as well. `Payment.source` defaults to `STRIPE`
 * in the schema, so routing on that column alone sends a hand-settled booking
 * with nothing captured down the card path; the refundable total this cap is
 * measured against is zero there, so the same refusal catches it.
 */
export const REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE =
  "That is more than this booking's card payment can give back - check the amount against the booking's payment history, or hand the money back another way and dismiss this task with a note saying what was done.";
