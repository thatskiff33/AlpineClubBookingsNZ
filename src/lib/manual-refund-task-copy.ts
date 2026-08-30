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
 *
 * ## What else lives here, and why
 *
 * The two SENTENCES A CLOSED TASK ANSWERS WITH, moved off the admin route (#3191)
 * when it crossed its size budget. Only the server composes those today, but they
 * are the same kind of thing - the words this one screen uses about one decision
 * - and pure strings carry nothing across the client boundary. Keeping them
 * beside the refusal is what stops the receipt and the refusal describing the
 * same behaviour in two vocabularies.
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

/**
 * What the operator is told a completion actually did.
 *
 * One sentence per route, because the four outcomes are materially different
 * claims about the club's money and only one of them is "paid back by hand". The
 * failed-card case is the one that matters most: the refund did not go, the
 * durable recovery operation will retry it, and saying so is the difference
 * between an operator who checks back and one who does not.
 */
export function completionMessage(result: {
  amountAmended: boolean;
  settlementRoute: { kind: string; collectVia?: "stripe" | "invoice" } | null;
  stripeRefundId: string | null;
  additionalPaymentIntentId: string | null;
}) {
  const amended = result.amountAmended ? " at the confirmed amount" : "";
  if (result.settlementRoute?.kind === "stripe-refund") {
    return result.stripeRefundId
      ? `Refund sent back to the card${amended}.`
      : "The card refund could not be sent just now. It has been recorded and will be retried automatically — check this booking's payment history before handing the money back another way.";
  }
  if (result.settlementRoute?.kind === "account-credit") {
    return `Account credit issued to the member${amended}.`;
  }
  // #3170: the direction that asks for money rather than returning it. Its two
  // sentences say what the member will actually receive, because "adjustment
  // recorded" over a request that was never sent is the same false receipt the
  // failed-card case above exists to avoid - in the opposite direction.
  if (result.settlementRoute?.kind === "additional-charge") {
    if (result.settlementRoute.collectVia === "invoice") {
      return `Added to this booking's invoice for the member to pay${amended}.`;
    }
    return result.additionalPaymentIntentId
      ? `The member has been asked to pay this${amended}. It is on the booking as an additional payment and they will be reminded until it is paid.`
      : "The request for payment could not be raised just now. It has been recorded and will be retried automatically — check this booking's payment history before asking the member another way.";
  }
  return `Refund recorded as paid back by hand${amended}.`;
}

/**
 * #3191: the second half of the receipt, when the officer also said what the
 * booking's unpriced nights sold for.
 *
 * Appended rather than folded into the sentences above, because it is a
 * different claim about a different thing - one says what happened to the money,
 * this says what the booking now records - and it has to be able to follow a
 * DISMISSAL, which those sentences never describe. Empty when nothing was
 * recorded, which is the ordinary case.
 *
 * It says what the officer gained, not what was written: "will not be sent for
 * review again" is the outcome they were promised when they filled the boxes in,
 * and it is the thing they would otherwise have to take on trust.
 */
export function nightPricesRecordedMessage(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " One night's price was recorded, so this booking will not be sent for review again for want of it."
    : ` ${count} nights' prices were recorded, so this booking will not be sent for review again for want of them.`;
}
