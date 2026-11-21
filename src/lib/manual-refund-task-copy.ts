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

import type { ManualRefundTaskKind, StripeDisputeStatus } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { bankTransferRefundPayee, type BankTransferRefundPayee } from "@/lib/group-organiser-paid";
import {
  EDIT_REFUND_HAND_BACK_DISMISS_AFTER_CANCEL_MESSAGE,
  EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE,
  manualRefundTaskKindAllowsSettlement,
} from "@/lib/manual-refund-task-settlement-rules";
import { namedDisputes, STRIPE_DISPUTE_STATUS_LABEL } from "@/lib/stripe-dispute-note";
import { formatCents } from "@/lib/utils";

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
 *
 * ONLY ONE OF THE TWO IS EVER PRINTED IN THE BROWSER, and saying otherwise
 * sends a reader auditing the screen looking for a control that is not there. A
 * legacy hand-back has NO amount box on the settle dialog - the officer never
 * types a figure, so they cannot type a zero - so the screen calls this with
 * `true` and nothing else. The hand-back sentence is the server's, reached when
 * a zero arrives at the completion door by some other route, and it surfaces as
 * an error after posting rather than as guidance beside a box.
 */
export function zeroCompletionRefusal(isEditReview: boolean): string {
  return isEditReview
    ? "A settlement has to be more than zero. If the evidence shows nothing is owed either way, close the review with no adjustment instead — that records that somebody looked and found nothing, which a settlement of $0.00 cannot say."
    : "A completed refund must be more than zero. If nothing is due, dismiss the task with a note instead — that records the decision, where a refund of $0.00 would record money going back that never did.";
}

/**
 * WHICH WAY A COMPLETION'S MONEY WENT, AND HOW - asked once, answered once.
 *
 * The settle route already carries both facts: `additional-charge` is the only
 * one where the member pays the club, and the other three are three different
 * ways of the club handing money back. Two sentences have to turn that into
 * words - the officer's toast below, and the durable audit summary in
 * `manual-refund-task-audit.ts` - and before #3213's fix round only the toast
 * asked. The summary asserted a hand-back over every completion, so an
 * `EDIT_FINANCIAL_REVIEW` settled down the charge route wrote "refund paid back
 * by hand" into the booking's permanent history for money the member had just
 * been ASKED FOR. The transient message was more truthful than the permanent
 * record.
 *
 * So the classification is a function rather than a branch in each of them
 * (`INV-SSOT`). A second site deciding "was this a refund?" is exactly how the
 * two drifted in the first place, and the audit half is the half nobody sees go
 * wrong until they are reading a row months later.
 *
 * THE ROUTE IS ASKED, NOT `settlementDirection`. They cannot disagree - a charge
 * route is reachable only from `CHARGE_TO_MEMBER`, and that direction reaches no
 * other route (`chooseEditReviewSettlementRoute` refuses it on every other kind)
 * - and the route is the narrower fact, because it says how as well as which
 * way. Asking the coarser one would need a second branch to recover the how.
 *
 * AN UNRECOGNISED ROUTE READS AS A HAND-BACK, which is the wording every row
 * written before #3032 has: `local-allocation` and a null route are both the
 * ledger recording money an officer moved outside the system.
 */
export type CompletionSettlementShape =
  | "card-refund"
  | "account-credit"
  | "charge-on-invoice"
  | "charge-as-payment-request"
  | "hand-back";

export function completionSettlementShape(
  settlementRoute: { kind: string; collectVia?: "stripe" | "invoice" } | null,
): CompletionSettlementShape {
  if (settlementRoute?.kind === "stripe-refund") return "card-refund";
  // #3639: an approved late-capture refund goes back to the card, too.
  if (settlementRoute?.kind === "late-capture-refund") return "card-refund";
  if (settlementRoute?.kind === "account-credit") return "account-credit";
  if (settlementRoute?.kind === "additional-charge") {
    return settlementRoute.collectVia === "invoice"
      ? "charge-on-invoice"
      : "charge-as-payment-request";
  }
  return "hand-back";
}

/** #3791/#3835: a share the booking's cancellation had already returned, by credit or card. */
const NOTHING_FURTHER_RETURNED =
  "Nothing further was credited or refunded: the booking's cancellation had already returned this share to the member.";

/**
 * #4272: a charge whose booking was cancelled after the completion committed.
 * Nothing was asked of the member and nothing will be retried; the uncollected
 * share is in the audit log (`settleCancelledEditReviewCharge`), written now or
 * by an earlier record.
 */
export const CHARGE_BOOKING_CANCELLED_COMPLETION =
  "The booking was cancelled before the request for payment could be raised, so the member has not been asked for this. Collect it another way. A record of the amount still owed has been added to the audit log.";
/** #4272: the same, when earlier records already cover what is still owed. */
export const CHARGE_BOOKING_CANCELLED_ALREADY_RECORDED_COMPLETION =
  "The booking was cancelled before the request for payment could be raised, so the member has not been asked for this. Collect it another way. The amount still owed is already recorded in the audit log, so no new record was added.";

/**
 * What the operator is told a completion actually did.
 *
 * One sentence per route, because the four outcomes are materially different
 * claims about the club's money and only one of them is "paid back by hand". The
 * failed-card case is the one that matters most: the refund did not go, the
 * durable recovery operation will retry it, and saying so is the difference
 * between an operator who checks back and one who does not.
 *
 * IT SAYS MORE THAN THE SUMMARY BELOW CAN, and the extra is deliberate rather
 * than drift. This runs after the commit, holding the provider's answer, so it
 * can say whether the refund or the request actually went; the summary is
 * written inside the transaction, before either is attempted, so it says which
 * way the closure settled and stops there.
 */
export function completionMessage(result: {
  amountAmended: boolean;
  settlementRoute: { kind: string; collectVia?: "stripe" | "invoice"; refundCents?: number; creditBackCents?: number } | null;
  stripeRefundId: string | null;
  additionalPaymentIntentId: string | null;
  /** #3791: what the account-credit route gave back and minted, where it ran. */
  accountCredit?: { givenBackCents: number; mintedCents: number } | null;
  /** #3835: the share the officer typed, beside what a cancelled booking still owed. */
  amountCents?: number | null;
  /** #4272: the booking was cancelled before the charge's request was raised;
   * `recorded` is whether this completion wrote the uncollected-share record. */
  chargeBookingCancelled?: { recorded: boolean };
}, format: ClubFormat) {
  const amended = result.amountAmended ? " at the confirmed amount" : "";
  // #3835: on a cancelled booking, the applied-credit part of what was still owed went back as credit.
  const creditBackCents = result.settlementRoute?.creditBackCents ?? 0;
  const creditBack = creditBackCents > 0 ? ` ${formatCents(creditBackCents, format)} was given back as account credit.` : "";
  switch (completionSettlementShape(result.settlementRoute)) {
    case "card-refund":
      // #3835: a share netted against a cancellation's refund can leave nothing to send.
      if (result.settlementRoute?.refundCents === 0) return creditBack ? `Nothing was sent to the card.${creditBack}` : NOTHING_FURTHER_RETURNED;
      return result.stripeRefundId
        ? `Refund sent back to the card${amended}.${creditBack}`
        : `The card refund could not be sent just now. It has been recorded and will be retried automatically — check this booking's payment history before handing the money back another way.${creditBack}`;
    case "account-credit":
      // #3791: a share netted against a cancellation's restore can leave
      // nothing to credit, and "credit issued" would be a receipt for nothing.
      return result.accountCredit && result.accountCredit.givenBackCents + result.accountCredit.mintedCents === 0
        ? NOTHING_FURTHER_RETURNED
        : `Account credit issued to the member${amended}.`;
    // #3170: the direction that asks for money rather than returning it. Its two
    // sentences say what the member will actually receive, because "adjustment
    // recorded" over a request that was never sent is the same false receipt the
    // failed-card case above exists to avoid - in the opposite direction.
    case "charge-on-invoice":
      return `Added to this booking's invoice for the member to pay${amended}.`;
    case "charge-as-payment-request":
      if (result.chargeBookingCancelled) {
        return result.chargeBookingCancelled.recorded
          ? CHARGE_BOOKING_CANCELLED_COMPLETION
          : CHARGE_BOOKING_CANCELLED_ALREADY_RECORDED_COMPLETION;
      }
      return result.additionalPaymentIntentId
        ? `The member has been asked to pay this${amended}. It is on the booking as an additional payment and they will be reminded until it is paid.`
        : "The request for payment could not be raised just now. It has been recorded and will be retried automatically — check this booking's payment history before asking the member another way.";
    case "hand-back": {
      // #3835: a share netted against a cancellation is handed back at what is
      // still owed, and the officer moving the money must be told that figure.
      const refundCents = result.settlementRoute?.refundCents;
      if (refundCents === 0) return creditBack ? `Nothing is to be handed back.${creditBack}` : NOTHING_FURTHER_RETURNED;
      if (refundCents !== undefined && result.amountCents != null && refundCents + creditBackCents < result.amountCents) {
        return `Only ${formatCents(refundCents + creditBackCents, format)} of the ${formatCents(result.amountCents, format)} share was still owed: the booking's cancellation had already returned the rest. ${formatCents(refundCents, format)} is recorded as paid back by hand - hand back that amount, not the full share.${creditBack}`;
      }
      if (creditBack) return `Refund recorded as paid back by hand${amended}.${creditBack}`;
      return `Refund recorded as paid back by hand${amended}.`;
    }
  }
}

/**
 * What the BOOKING'S PERMANENT HISTORY records a completion as.
 *
 * The audit half of the same fact, in the register an audit row is read in -
 * past tense, no operator instruction, no promise about what happens next.
 *
 * ONLY THE HAND-BACK SENTENCE IS THE OLD ONE, and it is byte-identical on
 * purpose: `local-allocation` and a null route are the ledger recording money an
 * officer moved by hand, which is exactly what it always said. The other three
 * were saying it too, and on the charge routes that was a claim in the wrong
 * DIRECTION - the club had not paid anybody back, it had asked to be paid. Rows
 * already written keep the words they were written with; this changes what the
 * next one says.
 *
 * NONE OF THEM ASSERTS THE PROVIDER SUCCEEDED. This is composed inside the
 * completion transaction, before the Stripe refund or the payment request is
 * attempted, so "settled as a card refund" is what is true at the moment it is
 * written - where "refund sent back to the card" would be a durable claim the
 * row cannot back if the call then fails. What actually happened out there is
 * the recovery operation's record and the payment history's, and the operator's
 * toast says it because the toast runs late enough to know.
 */
export function completionSummary(shape: CompletionSettlementShape): string {
  switch (shape) {
    case "card-refund":
      return "Manual booking refund settled as a card refund";
    case "account-credit":
      return "Manual booking refund settled as account credit";
    case "charge-on-invoice":
      return "Booking amount owed by the member added to the booking invoice";
    case "charge-as-payment-request":
      return "Booking amount owed by the member requested as an additional payment";
    case "hand-back":
      return "Manual booking refund paid back by hand";
  }
}

/**
 * #4344 (wave C1 of #4302): the resolve route's refusal for an officer edit
 * review. The review is retired - every edit is priced automatically, and wave
 * B closed every open one - so nothing settles or dismisses one any more. Said
 * in words a stale settle screen's officer can act on: there is nothing left to
 * do, and the record is still there. The finance queue's card for a retired
 * review shows this same sentence, so the card and the route cannot drift.
 */
export const RETIRED_EDIT_REVIEW_REFUSAL =
  "Officer edit reviews were retired, so this review stays as it is and cannot be settled or closed here. What was recorded for it is still on the booking's history. Reload the page.";

/**
 * #3213: what an officer is told a DISMISSAL actually did.
 *
 * The counterpart to `completionMessage` above, and it lives here for the reason
 * that one does: it is the sentence a closed task answers with, and until now it
 * was a bare literal on the admin route with nothing beside it to say which kind
 * of item it was describing.
 *
 * IT IS KIND-AWARE BECAUSE ONE KIND IS NOT A REFUND. On every kind older than
 * `UNCOLLECTED_EDIT_REVIEW_SHARE`, "dismissed" means the club decided not to pay
 * something back, and "Refund task dismissed." is the true sentence. On a
 * withheld share the officer has just done the opposite job - checked Xero and
 * billed a shortfall BY HAND - so telling them they dismissed a refund names the
 * wrong direction and the wrong act at the moment they finish it. That is the
 * `#3033` category confusion one kind further along, and it is the same reason
 * the dialog above the button says "Close this item" rather than "Dismiss".
 *
 * ASKED OF THE SHARED RULE, not of the label. A kind that cannot be settled is
 * exactly a kind where nothing moves money, which is the fact this sentence turns
 * on - so the two questions have one answer and one home
 * (`manual-refund-task-settlement-rules.ts`, `INV-SSOT`). An unrecognised kind
 * answers TRUE there and lands on the legacy sentence, which is the safe way
 * round: a stale client bundle gets the wording every row has always had rather
 * than a claim about an item type it does not know.
 */
export function dismissalMessage(
  kind: ManualRefundTaskKind | string | null | undefined,
  /** #3643: a part-payment review, settled in Xero rather than here. Required. */
  partPaymentReview: boolean,
): string {
  if (partPaymentReview) {
    return "Item closed. It moved no money here — your note is the record of how the payment was settled in Xero.";
  }
  if (manualRefundTaskKindAllowsSettlement(kind, false)) return "Refund task dismissed.";
  return "Item closed. It moved no money and raised no invoice — your note is the only record of what the booking's Xero invoices showed and what you billed by hand.";
}

/**
 * #3827, #3949 (`INV-PAY-137`): THE REASON LINE of an edit's refund hand-back
 * (`INV-PAY-117`) and of an approved appeal's (`INV-PAY-118`), as the finance
 * queue shows it - naming who the bank transfer goes to. A joiner's booking the
 * group organiser paid for by internet banking is refunded to the ORGANISER
 * (owner decision on #3949, 21 Oct 2026), never to the joiner, so the officer
 * paying it must be told whose account to send it to. #5212 (`INV-PAY-160`):
 * the member wording also covers a card payment Stripe holds no record of,
 * which has no card to refund and so arrives here too.
 */
export function editRefundHandBackReason({ bookingId, editLabel, payee }: { bookingId: string; editLabel: string; payee: BankTransferRefundPayee }): string {
  return payee === "organiser"
    ? `Booking ${bookingId} lowered by a ${editLabel}; the group organiser paid for it by internet banking, so the club refunds the difference to the group organiser by bank transfer.`
    : `Booking ${bookingId} lowered by a ${editLabel}; paid by internet banking or by hand, or by a card payment with no Stripe record, so the club refunds the difference by bank transfer (#3827).`;
}

export function refundRequestHandBackReason({ bookingId, payee }: { bookingId: string; payee: BankTransferRefundPayee }): string {
  return payee === "organiser"
    ? `Refund appeal approved on booking ${bookingId}; the group organiser paid for it by internet banking, so the club refunds this to the group organiser by bank transfer.`
    : `Refund appeal approved on booking ${bookingId}; not paid by card, so the club refunds this by bank transfer (#3827).`;
}

/**
 * #3949 (`INV-PAY-137`): the two refusals `INV-PAY-117` gives an edit refund
 * hand-back once its booking is cancelled (dismissing an open one, reopening a
 * dismissed one), on the booking as the door read it. On a joiner's booking the
 * group organiser paid for by internet banking they name the organiser, whose
 * money it is (`bankTransferRefundPayee`); the rule is unchanged, because the
 * group cancel nets an open edit refund out of the organiser's refund just as a
 * member's cancel does. The member wording is exactly what it was.
 */
type PayeeBooking = Parameters<typeof bankTransferRefundPayee>[0];

export function editRefundHandBackDismissAfterCancelMessage(booking: PayeeBooking): string {
  return bankTransferRefundPayee(booking) === "organiser"
    ? "This group booking has been cancelled since this edit refund was raised, and the cancellation's refund to the group organiser was worked out on the basis that this money goes back to the organiser. Send it to the organiser and mark it paid back. If the club has decided not to pay it, that changes the cancellation's own figures, so take it to the treasurer to correct the cancelled booking rather than dismissing the task here."
    : EDIT_REFUND_HAND_BACK_DISMISS_AFTER_CANCEL_MESSAGE;
}

export function editRefundHandBackReopenAfterCancelMessage(booking: PayeeBooking): string {
  return bankTransferRefundPayee(booking) === "organiser"
    ? "This group booking has been cancelled since this edit refund was dismissed, and the cancellation's refund to the group organiser was worked out without it. Putting it back on the queue would promise the organiser money the cancellation already accounted for. If more is owed, raise it against the cancelled booking, for example as a refund appeal."
    : EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE;
}

/**
 * #4516 (owner decisions, 14 and 15 Nov 2026): a real bank or cash hand-back the member-money journal records as a
 * refund debt (`journalHandBackDismissal`; never a card shortfall's part to check) is not dismissed until
 * dismissal asks the officer why. The server refuses it and the queue shows this sentence where the Dismiss button
 * would be, in the same words (`INV-SSOT`).
 */
export const JOURNAL_HAND_BACK_DISMISS_REFUSAL =
  "This refund can't be dismissed yet. Mark it paid once the money has gone back, or leave it open. Dismissing with a reason is coming in a later update.";

/**
 * #4516 (owner decision, 15 Nov 2026): the hand-back a paid cancel of a disputed card payment raises (#5061) is
 * dismissed only once the dispute is recorded as lost. Before then the server refuses, and the queue prints the
 * same words where the Dismiss button would be. Named by the dispute that is not yet lost.
 */
export function disputedHandBackDismissRefusal(status: StripeDisputeStatus): string {
  return status === "OPEN"
    ? "This refund can't be dismissed while the card payment's dispute is open: the club may still owe it. Once Stripe records the dispute as lost, the cardholder already has the money back and this task can be dismissed."
    : `This refund can't be dismissed: the card payment's dispute was ${STRIPE_DISPUTE_STATUS_LABEL[status]}, so the club still owes it. Mark it paid once the money has gone back.`;
}

/**
 * That hand-back when its lost disputes cover only part of what is still owed (owner decision, 15 Nov 2026, comment
 * 6893252570): not dismissed, and not marked paid in full (that would pay the lost part twice), but reduced.
 */
export const DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL =
  "This refund can't be dismissed: the lost card dispute covered only part of it. Reduce it by the lost amount instead; the rest stays owed. Do not mark it paid in full: the cardholder already has the lost part back.";

/** Mark paid on that hand-back while a lost dispute's cents are not yet applied: it would pay the lost part twice. */
export const DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING =
  "This refund can't be marked paid at its full amount: a card dispute was lost for part of it, and the cardholder already has that part back. Reduce it by the lost amount first.";

/**
 * Mark paid on that hand-back while a dispute on its payment was lost (cents not yet applied) and another is still
 * open (#4516 review): paying in full would pay the lost part twice, and the reduction waits for the open dispute
 * (owner decision, 15 Nov 2026, comment 6893252570).
 */
export const DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE =
  "This refund can't be marked paid at its full amount: one card dispute on this payment was lost, so the cardholder already has that part back, and another is still open. Wait until the open dispute is decided, then reduce the refund by what was lost, or dismiss it if the disputes cover all of it.";

/** Mark paid on that hand-back once its lost disputes cover it: the cardholder already has all of it back. */
export const DISPUTED_HAND_BACK_LOST_NOT_PAYABLE =
  "This refund can't be marked paid: the card dispute was lost for all of it, so the cardholder already has the money back. Dismiss it instead.";

/** The reduce action failed for a reason the server did not name: the route's answer and the screen's fallback. */
export const DISPUTED_HAND_BACK_REDUCTION_FAILED = "Could not reduce the refund.";

/** That hand-back once every lost dispute has reduced it and the rest is still owed. */
export const DISPUTED_HAND_BACK_REDUCED_REFUSAL =
  "This refund can't be dismissed: the lost card dispute has already reduced it, and the club still owes the rest. Mark it paid once the money has gone back.";

/**
 * That hand-back while the payment's lost disputes go to an older refund on the same payment first (owner decision,
 * 18 Nov 2026: lost cents are counted once across the payment's refunds, oldest first). The club still owes this one.
 */
export const DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND =
  "This refund can't be dismissed: the lost card dispute is set against an earlier refund on the same card payment, so the club still owes this one. Mark it paid once the money has gone back.";

/** The reduce action on that hand-back: nothing of the lost dispute is left for it. */
export const DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND_REDUCTION =
  "There is nothing to reduce here: the lost card dispute is set against an earlier refund on the same card payment.";

/** The reduce action refused on a task that is not a disputed card payment's hand-back. */
export const NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL =
  "Only a refund handed to the treasurer because its card payment is disputed can be reduced by a lost dispute.";

/** The reduce action refused by the dispute's state: still open, or won or closed with no funds taken. */
export function disputedHandBackReductionRefusal(status: StripeDisputeStatus): string {
  return status === "OPEN"
    ? "This refund can't be reduced while the card payment's dispute is open: the club may still owe it."
    : `This refund can't be reduced: the card payment's dispute was ${STRIPE_DISPUTE_STATUS_LABEL[status]}, so the club still owes it.`;
}

/** The reduce action refused because every lost dispute has already reduced it. */
export const DISPUTED_HAND_BACK_NOTHING_TO_REDUCE =
  "There is nothing more to reduce: every lost card dispute has already reduced this refund, and the rest is still owed.";

/** The reduce action refused because the lost disputes now cover everything still owed. */
export const DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL =
  "The lost card dispute now covers all of this refund: dismiss it instead.";

/** The reduce action's confirmation and its toast: what the refund was, what it is reduced by and what is still owed. */
export function disputedHandBackReductionSummary(cents: { wasCents: number; reducedByCents: number; stillOwedCents: number }, format: ClubFormat): string {
  return `Was ${formatCents(cents.wasCents, format)}. Reduced by ${formatCents(cents.reducedByCents, format)}, the lost card dispute: the cardholder already has that back through their bank. Still owed ${formatCents(cents.stillOwedCents, format)}.`;
}

/** The dismiss dialog's sentence for that hand-back once its lost dispute covers it (#4516, owner decision 15 Nov 2026). */
export const DISPUTED_HAND_BACK_LOST_DISMISS_DESCRIPTION =
  "The card payment's dispute was lost, so the cardholder already has this money back through their bank. Dismissing closes the task without refunding anything and takes the refund off what the club owes. Say so in the note.";

/**
 * B5 (#2262), #3949 (owner decision, 22 Oct 2026): THE REASON LINE of a paid
 * cancellation's hand-back task. A cash settlement's refund goes back to the
 * member; a joiner's own cancel of a place the group organiser paid for by
 * internet banking goes back to the ORGANISER by bank transfer, named when
 * known (review round 4). Officer-facing, so it cites no issue numbers. The
 * member wording is exactly what it was.
 */
export function cancellationHandBackReason({ bookingId, refundPercentage, payee, organiserName = null }: {
  bookingId: string;
  refundPercentage: number;
  payee: BankTransferRefundPayee;
  /** The organiser it is repaid to, named in the line (`bookingOwnerName` of the organiser's booking). */
  organiserName?: string | null;
}): string {
  return payee === "organiser"
    ? `Booking ${bookingId} cancelled by its joiner; the group organiser${organiserName ? ` (${organiserName})` : ""} paid for it by internet banking, so the club refunds ${refundPercentage}% (under the policy in effect at the time, on the card refund tiers) to the group organiser by bank transfer.`
    : `Booking ${bookingId} cancelled — cash/manual settlement, refund by hand (${refundPercentage}% under the policy in effect at the time).`;
}

/**
 * #4911 (`INV-PAY-154`): THE REASON LINE of a paid cancellation handed to the
 * treasurer because the cardholder is disputing the card payment, or has won the
 * dispute. It names each dispute, so the treasurer can find it in Stripe before
 * deciding what, if anything, is still owed. Officer-facing, so no issue numbers.
 */
export function disputedCancellationHandBackReason({ bookingId, refundPercentage, disputes }: {
  bookingId: string;
  refundPercentage: number;
  disputes: readonly { stripeDisputeId: string; status: StripeDisputeStatus }[];
}): string {
  return `Booking ${bookingId} cancelled while its card payment is disputed by the cardholder (Stripe dispute ${namedDisputes(disputes)}). No card refund or account credit was issued; check the dispute in Stripe before refunding any of the ${refundPercentage}% due under the policy in effect at the time. If the dispute is lost for at least this refund, the cardholder already has it: dismiss this task.`;
}

/**
 * #5061 follow-up (`INV-PAY-154`): THE REASON LINE of an edit's refund
 * hand-back raised because the card payment is disputed - a lowered price whose
 * refund the app neither sends to the card nor holds as credit. Worded as the
 * cancel's (`disputedCancellationHandBackReason`), naming each dispute.
 */
export function disputedEditRefundHandBackReason({ bookingId, editLabel, disputes }: {
  bookingId: string;
  editLabel: string;
  disputes: readonly { stripeDisputeId: string; status: StripeDisputeStatus }[];
}): string {
  return `Booking ${bookingId} lowered by a ${editLabel} while its card payment is disputed by the cardholder (Stripe dispute ${namedDisputes(disputes) || "since closed"}). No card refund or account credit was issued; check the dispute in Stripe before refunding any of the difference.`;
}
