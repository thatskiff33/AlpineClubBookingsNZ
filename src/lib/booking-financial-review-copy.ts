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
 *  - NO AMOUNT APPEARS, in any of them. Not `$0`, not an estimate, and above all
 *    not the booking's own stored total — which on a parked edit is the total
 *    from BEFORE the change, written back unchanged by both parking services
 *    (`booking-guest-removal-service.ts`, `booking-batch-modification-service.ts`)
 *    while the dates and the guest rows around it move. Printing it beside these
 *    sentences would put an authoritative-looking figure next to a statement that
 *    the figure is unknown, and the figure would be out of date as well;
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
 * THE TWO AMOUNTS ARE DIFFERENT AMOUNTS, said out loud.
 *
 * For a surface that shows the member a FIGURE OF ITS OWN and therefore has to
 * place the unpriced change outside it. Without this sentence the review clauses
 * land beside a total and read as being about that total, which is the one
 * reading that is false: the total is priced and payable, and the change's
 * amount is the thing nobody knows yet.
 *
 * MOVED HERE FROM `booking-narrative.ts` (#3194), which composed it inline while
 * it had one caller.
 *
 * "That figure" is money the club HAS — a payment already received, or the "no
 * payment was required" that stands in for one. The claim is exact there: what
 * arrived is a settled historical fact, and the change's amount is a separate,
 * unknown one that sits outside it.
 *
 * IT IS NOT THE SENTENCE FOR AN AMOUNT STILL DUE, and the fix round of #3194
 * moved that case off it. There the figure is the booking's stored total, which
 * a parked edit leaves at its PRE-change value — so "not part of that figure" is
 * true about the change and quietly wrong about the figure, which reads as the
 * settled price for the dates and guests shown beside it.
 * {@link FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE} is that sentence, and
 * {@link financialReviewNoteBesideAnAmount} is where the two are chosen between.
 */
export const FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE =
  "You have also made a change to this booking whose amount is not part of that figure.";

/**
 * THE FIGURE BESIDE THIS SENTENCE IS OUT OF DATE, said out loud (#3194).
 *
 * For a surface showing an amount the member is being asked TO PAY. It is the
 * booking's stored total, and on a parked edit that total is the one from BEFORE
 * the change: both services that can park an edit write `finalPriceCents` back
 * unchanged, deliberately, so nothing settles on a change whose money nobody
 * could work out. What they do NOT write back are the dates and the guest rows —
 * the departing guest's row is deleted, the new dates are saved — so the payment
 * card puts a post-edit stay beside a pre-edit price and looks entirely settled.
 *
 * A member reading that pays it, and overpays by exactly the amount nobody could
 * compute. The club can still put that right, and this sentence is what stops
 * them being surprised by it.
 *
 * ## Why this is not {@link FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE}
 *
 * That sentence says the change's amount is not INSIDE the figure, which is true
 * here — and it implies the figure is otherwise the settled price for what is on
 * screen, which is not. Beside money already RECEIVED it is exactly right: a
 * payment that arrived is a historical fact, complete in itself, and an unpriced
 * change genuinely sits outside it and always will. Beside money still DUE it is
 * the smaller half of the truth. So the two sentences split by which kind of
 * amount they stand next to, rather than one covering both.
 *
 * ## What it does and does not promise
 *
 * It does NOT say "don't pay". The controls stay armed on purpose: a parked
 * change can surrender nights nobody can value while the booking's own stay is
 * still going ahead, an unregistered guest has no other way to pay, and a hold
 * that expires costs the member the booking. What it removes is the false
 * reassurance that the number is final.
 *
 * It also carries "the change you made", so the clauses composed after it —
 * {@link FINANCIAL_REVIEW_NOTHING_TO_DO} and the rest, which all say "that
 * change" — have something to refer back to. That is the same job
 * {@link FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE} does in the composition it opens.
 *
 * Everything else the member needs to hear is already a constant here and is
 * composed after it rather than restated: that the club is working the amount
 * out, that nothing has moved yet, that there is nothing for them to do, and
 * that the club will be in touch before anything is charged or refunded.
 */
export const FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE =
  "This amount does not yet reflect the change you made to this booking.";

/**
 * The club closes the loop; the member does not have to chase it — the ONE
 * wording of that promise, in its two terminations.
 *
 * The clause is private and both public forms end it, so rewording it moves
 * every surface at once. That is not decoration: the long form below shipped as
 * `buildFinancialReviewPendingNarrative`'s own literal while the short one was
 * already a shared constant, so the two said the same thing twice and a reword
 * of the constant would have left the review-pending narrative promising the old
 * wording (`INV-SSOT`, "cannot change a fact in one place is the defect").
 */
const FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_CLAUSE =
  "We'll be in touch once the amount is confirmed";

/**
 * The SHORT form, for a surface the member did not go looking for.
 *
 * Beside a payment they are in the middle of making, an invitation to ask where
 * something else is up to is a distraction from the thing they came to do.
 */
export const FINANCIAL_REVIEW_WILL_BE_IN_TOUCH = `${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_CLAUSE}.`;

/**
 * The LONG form, for a screen the member reached DELIBERATELY — their own
 * booking — where "can I ask?" is a question they are already there to ask.
 *
 * Derived from the same clause rather than restated (#3194). Byte-identical to
 * the literal it replaces.
 */
export const FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK =
  `${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_CLAUSE} — please get in touch if you'd like to know where it's up to.`;

/**
 * The whole note, for a surface that renders it as ONE BLOCK: the two email
 * surfaces, and the public payment-link page's confirmation card (#3194).
 *
 * Composed here rather than at each of them, so the HTML email, the
 * admin-editable flat body and the pay page cannot say different things — which
 * was the original defect this module fixes.
 *
 * NAMED FOR WHAT IT IS RATHER THAN FOR WHO CALLED IT FIRST (#3194). It shipped
 * as `financialReviewEmailNote` while both callers were emails; the sentences in
 * it are about a member's money and not about email, and the third caller is a
 * web page. Nothing it returns changed in the rename.
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
export function financialReviewNote({
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

/**
 * The whole note for a surface that has ALREADY PUT AN AMOUNT IN FRONT OF THE
 * MEMBER and now has to say the unpriced change is not inside it (#3194).
 *
 * The public payment-link page is that surface. It renders its own payment card
 * — dates, guests, "Amount due: $120.00", the link's expiry — so it cannot show
 * the booking page's composed banner message, which restates all of that in
 * prose. What it needs is the review half on its own, and the review half is
 * exactly these five sentences in this order.
 *
 * ## Why this is one home and not a second one
 *
 * `buildPayableWithFinancialReviewNarrative` and
 * `buildPaidWithFinancialReviewNarrative` say the same five sentences beside a
 * narrative of their own — the first three in `message`, the last two in
 * `nextStep`, because that banner renders those as separate paragraphs. Both
 * build them from these same constants, and
 * `booking-financial-review-copy.test.ts` pins all three compositions against
 * each other sentence for sentence, by DERIVING what each narrative adds rather
 * than restating it. So the payment-link page and the booking page cannot come
 * to say different things about one member's money, which is the whole of what
 * #3194 is closing.
 *
 * ## Why it takes WHICH KIND OF AMOUNT, and why that is not a style choice
 *
 * The two surfaces that show a figure show two different KINDS of figure, and
 * only one of them is out of date.
 *
 * An amount already RECEIVED is a historical fact read off a durable payment
 * event. Nothing about a parked edit can change what arrived, so
 * {@link FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE} is the whole truth beside it.
 *
 * An amount still DUE is the booking's stored `finalPriceCents`, and a parked
 * edit writes that back UNCHANGED while saving the new dates and deleting the
 * departing guest's row. So it is the price of the stay as it was BEFORE the
 * change, sitting under the change's own dates and guest count, looking settled.
 * A member who pays it overpays. That figure needs
 * {@link FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE}, which says so.
 *
 * REQUIRED, with no default, for the same reason `moneyAlreadyMoved` is: a
 * fourth surface has to answer the question rather than inherit a silent
 * "received", which is the answer that hides a stale price (`INV-SSOT`,
 * "prefer unrepresentable over policed").
 *
 * There is no settlement-note parameter, unlike {@link financialReviewNote}:
 * these surfaces compose no settlement note beside them and never can — a review
 * parks with nothing settled, so there is no refund or credit sentence of their
 * own to contradict.
 */
export function financialReviewNoteBesideAnAmount({
  amountPredatesTheChange,
}: {
  /**
   * Whether the amount this surface has just shown is the booking's stored total
   * — which a parked edit leaves at its pre-change value — rather than money the
   * club has already received.
   */
  amountPredatesTheChange: boolean;
}): string {
  return [
    amountPredatesTheChange
      ? FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE
      : FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
    FINANCIAL_REVIEW_WORKING_IT_OUT,
    FINANCIAL_REVIEW_NOTHING_MOVED,
    FINANCIAL_REVIEW_NOTHING_TO_DO,
    FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
  ].join(" ");
}
