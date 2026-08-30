/**
 * #3033 (epic #2797): the sentences a MEMBER reads when a stay change saved and
 * the money for it is with the club.
 *
 * ONE HOME, and it exists because there were three (`INV-SSOT`). The HTML
 * "Booking Modified" template and the sender that composes that email's
 * admin-editable flat body each held the identical sentence, verbatim, with no
 * interpolation — two files that had to be edited together or the two halves of
 * one email would disagree about a member's money. "Cannot change a fact in one
 * place" is the defect the rule names, so the fact moved here and every surface
 * composes from it: the booking page's narrative banner, the HTML email, and the
 * flat body.
 *
 * ## Why they are CLAUSES rather than one paragraph
 *
 * Because the surfaces compose them differently, and one of them has to place
 * another sentence in between. The narrative banner puts the first two in its
 * `message` and the third in its `nextStep`, which are rendered as separate
 * paragraphs; the email puts all three in one note. A single frozen paragraph
 * would have forced the banner to re-say it in its own words, which is how the
 * duplication started.
 *
 * ## The rules every string here is written against
 *
 * From the epic and this issue, and each is visible in the wording rather than
 * assumed:
 *
 *  - NO AMOUNT APPEARS, in any of them. Not `$0`, not an estimate, not the
 *    booking's own post-edit total — which the structural edit has already
 *    updated, so printing it beside these sentences would put an
 *    authoritative-looking figure next to a statement that the figure is
 *    unknown;
 *  - no verb here is in the past tense about money. The club is *working it
 *    out*; nothing *has been* refunded or charged;
 *  - nothing internal and nothing about the member: no cause, no diagnostic
 *    category, no "corrupt", "missing" or "inconsistent". The evidence
 *    vocabulary stays on the admin screen (`EDIT_FINANCIAL_REVIEW_CAUSE_LABEL`);
 *  - each one names WHAT it is about — "that change" — rather than relying on
 *    where it happens to sit. That is what lets them be composed after a
 *    sentence about something else without changing meaning, which is the
 *    property the payable banner and the additional-payment email both need.
 *
 * These are the DEFAULT wording. The club's own explanation of what the state
 * means sits beside them in the `booking.detail.financialReviewPending` message
 * key, which a club may edit; these facts are not editable, because they are the
 * same for every club and are shared with the public payment-link page.
 */

/** The club has the question, and will come back with an answer. */
export const FINANCIAL_REVIEW_WORKING_IT_OUT =
  "The club is working out what that change means for the amount, and will confirm it with you.";

/** No money has moved. Present-perfect negative, never "will not". */
export const FINANCIAL_REVIEW_NOTHING_MOVED =
  "Nothing has been refunded or charged for it yet.";

/**
 * SCOPED TO THE CHANGE, not to the message it appears in — and that scoping is
 * load-bearing rather than stylistic.
 *
 * A single edit can surrender nights that cannot be valued while adding nights
 * that price normally under current policy, so a review-pending change can carry
 * a real amount the member has to pay. This sentence is composed alongside that
 * payment instruction, so an unscoped "there is nothing for you to do" would
 * cancel it: the member would be told to do nothing, not pay, and lose the
 * booking when the hold expired. It says "about that change" so that the
 * instruction beside it still stands.
 */
export const FINANCIAL_REVIEW_NOTHING_TO_DO =
  "There is nothing you need to do about that change.";

/**
 * The whole note, for the two email surfaces that render it as one block.
 *
 * Composed here rather than at each of them, so the HTML email and the
 * admin-editable flat body cannot say different things — which was the original
 * defect this module fixes.
 *
 * ## Why `moneyAlreadyMoved` exists
 *
 * Both surfaces compose this note with a settlement note beside it, and two of
 * that note's four arms are PAST TENSE ABOUT MONEY: "A refund of $X has been
 * processed" and "Account credit of $X has been added". Beside them
 * `FINANCIAL_REVIEW_NOTHING_MOVED` — "Nothing has been refunded or charged for
 * it yet" — is a flat contradiction in one email about one change, and the
 * member has no way to tell which sentence to believe.
 *
 * The remaining two arms are compatible and stay: "an additional payment is
 * required" is about money that has NOT moved, which is what the sentence says.
 *
 * NOT REACHABLE TODAY, and built anyway. A parked edit settles nothing, so its
 * refund, credit and additional amounts are all zero and no settlement arm fires
 * — the two paths that can park (#3032's guest removal; the batch path still
 * refuses, #3170) both produce zeros by construction. But "unreachable" is a
 * property of today's callers rather than of the copy, and the cost of making the
 * contradiction unrepresentable is one boolean, whereas the cost of discovering
 * it is a member being told two opposite things about their own money. With
 * `moneyAlreadyMoved: false` the string is byte-identical to what shipped before.
 */
export function financialReviewEmailNote({
  moneyAlreadyMoved,
}: {
  /**
   * Whether the settlement note composed BESIDE this one says money has already
   * moved — a refund processed or account credit added. Required with no
   * default, so a third surface has to answer the question rather than inherit a
   * silent "no" (`INV-SSOT`, "prefer unrepresentable over policed").
   */
  moneyAlreadyMoved: boolean;
}): string {
  return [
    FINANCIAL_REVIEW_WORKING_IT_OUT,
    ...(moneyAlreadyMoved ? [] : [FINANCIAL_REVIEW_NOTHING_MOVED]),
    FINANCIAL_REVIEW_NOTHING_TO_DO,
  ].join(" ");
}
