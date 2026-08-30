/**
 * #3195 (epic #2797): a refusal the settle screen and the server both have to
 * say, in the same words, at the same moment.
 *
 * ## Why a module rather than a string beside each of them
 *
 * The screen disables the confirm button at $0.00 and the server refuses a $0.00
 * completion. Those are two halves of one behaviour, and until #3195 only the
 * server said anything about it - so an officer who typed a zero got a control
 * that simply would not press, with no sentence anywhere. That is the outcome
 * the owner's 31 Aug 2026 decision names as "the worst version of this
 * behaviour". The sentence therefore has to reach the browser, and a copy
 * written there could drift from the one the server throws (`INV-SSOT`).
 *
 * It is client-safe on purpose: `manual-refund-task-resolution.ts` is
 * `server-only`, so the settle screen cannot import the refusal from where it is
 * raised. The same split `edit-financial-review-context.ts` records for the
 * review shape, for the same reason.
 */

/**
 * A completion at zero stays refused, and the refusal names the way out.
 *
 * THE RULE IS UNCHANGED and is `INV-PAY-051`'s: an officer who means "nothing to
 * adjust" has a control for exactly that, and once a zero is recorded as a
 * completion the two statements are indistinguishable forever after - which is
 * the separation this epic spent its effort on everywhere else. What the owner
 * would not accept is the bare refusal that came with it. The accepted cost of
 * keeping the rule is that an officer who has genuinely decided the answer is
 * zero must reach for a differently-named action, so the sentence has to name
 * that action at the moment they hit it.
 *
 * TWO SENTENCES, BECAUSE THE CONTROL HAS TWO NAMES. On a financial review the
 * button says "No adjustment"; on a legacy hand-back it says "Dismiss". Naming
 * the wrong one sends an officer looking for a control that is not on their
 * screen, which is the same dead end as saying nothing. This is the ONE home for
 * both: the admin route no longer refuses a zero of its own, precisely so the
 * layers that know the task's kind - the server's completion door and the screen
 * - are the only ones that speak.
 */
export function zeroCompletionRefusal(isEditReview: boolean): string {
  return isEditReview
    ? "A settlement has to be more than zero. If the evidence shows nothing is owed either way, close the review with no adjustment instead — that records that somebody looked and found nothing, which a settlement of $0.00 cannot say."
    : "A completed refund must be more than zero. If nothing is due, dismiss the task with a note instead — that records the decision, where a refund of $0.00 would record money going back that never did.";
}
