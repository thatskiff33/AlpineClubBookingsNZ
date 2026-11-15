import { ManualRefundTaskKind, type Prisma, type StripeDisputeStatus } from "@prisma/client";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { isGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back-rules";
import { isLateCaptureHandBackTask } from "@/lib/late-capture-hand-back-task";
import {
  cancelCardShortfallPart,
  editRefundHandBackOccurrenceKey,
  isCardRefundPaidAnotherWayTask,
  isNonCancellationHandBackTask,
  isPartPaymentReviewTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { lockMemberCreditLedger, requireMemberCreditRecipient } from "@/lib/member-credit";
import { postHandBackPayment, postRefundObligation, withdrawRefundObligation, type BookingJournalContext } from "@/lib/member-money/doors";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import {
  DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL, DISPUTED_HAND_BACK_LOST_NOT_PAYABLE, DISPUTED_HAND_BACK_NOTHING_TO_REDUCE, DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL,
  DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING, DISPUTED_HAND_BACK_REDUCED_REFUSAL,
  disputedHandBackDismissRefusal, disputedHandBackReductionRefusal, JOURNAL_HAND_BACK_DISMISS_REFUSAL, NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL,
} from "@/lib/manual-refund-task-copy";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";
import { disputeHoldsCapture, disputeIsLost } from "@/lib/stripe-dispute-note";

/**
 * #4516 (Ledger M4d): WHICH MANUAL REFUND TASKS THE MEMBER-MONEY JOURNAL RECORDS AS A HAND-BACK DEBT, and the
 * journal steps `resolveManualRefundTask` takes for them. The raise posts the debt (R05, scope `hand-back`); a
 * completion pays it (R14). Dismissing a real bank or cash hand-back is refused for now (owner decision, 14 Nov
 * 2026), so its debt stays open until the task is paid. A card shortfall's part to check keeps its dismissal, and a
 * disputed card payment's hand-back is dismissed once its dispute is lost (owner decisions, 15 Nov 2026); either
 * dismissal withdraws its debt exactly. Split out of `manual-refund-task-resolution.ts` and
 * `manual-refund-task-settlement-rules.ts` so neither crosses its size budget; the lock order is unchanged.
 */

type HandBackFacts = {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
  partPaymentReviewPaymentId: string | null;
  reason: string | null;
};

/**
 * An edit hand-back raised for organiser-extra raced cash. It wears an edit hand-back's key, but the cash is an
 * organiser share (M6), so it is not a member-money hand-back debt. The prefix is the key
 * `organiser-extra-raced-cash.ts` builds.
 */
const ORGANISER_EXTRA_HAND_BACK_PREFIX = editRefundHandBackOccurrenceKey("organiser-extra-");
export function isOrganiserExtraRacedHandBackTask(task: Pick<HandBackFacts, "kind" | "occurrenceKey">): boolean {
  return task.kind === "CANCELLED_BOOKING_HAND_BACK" && (task.occurrenceKey?.startsWith(ORGANISER_EXTRA_HAND_BACK_PREFIX) ?? false);
}

/**
 * A hand-back the member-money journal records as a refund debt (R05, scope `hand-back`). Exactly the tasks a
 * raise posts: a cancellation's cash hand-back, a card shortfall's bank part or part to check, an edit hand-back,
 * a refund request's bank part, and an organisation's late cash. Not a part-payment review, a
 * group organiser's hand-back, a paid-another-way close, a bank-refund void follow-up, organiser-extra raced cash,
 * or a late capture's own question (including a legacy row whose only mark is its reason). A legacy row with no
 * kind and any other reason is a cancellation's hand-back.
 */
export function isJournalHandBackTask(task: HandBackFacts): boolean {
  if (task.kind !== "CANCELLED_BOOKING_HAND_BACK" && task.kind !== null) return false;
  if (isPartPaymentReviewTask(task)) return false;
  if (isGroupOrganiserHandBackTask(task)) return false;
  if (isCardRefundPaidAnotherWayTask(task)) return false;
  if (isBankRefundVoidFollowUpTask(task)) return false;
  if (isOrganiserExtraRacedHandBackTask(task)) return false;
  if (isLateCaptureHandBackTask({ kind: task.kind, reason: task.reason ?? "" })) return false;
  return true;
}

/**
 * A card shortfall's part to check (`INV-PAY-129`), a capacity race's included (`INV-PAY-135`): money the records
 * show may already have gone back. Owner decision, 15 Nov 2026 (#4516): it keeps its dismissal, which an officer
 * uses once they have confirmed the card refund reached the member, so its debt is withdrawn exactly with the claim.
 */
export function isDismissibleCheckPart(task: HandBackFacts): boolean {
  return isJournalHandBackTask(task) && cancelCardShortfallPart(task) === "check";
}

/** The card disputes recorded on the task's booking (#5061, `readDisputesByBookingId`): id, status, cents and payment. */
export type HandBackDisputes = readonly { stripeDisputeId: string; status: StripeDisputeStatus; amountCents: number; paymentId: string | null }[];

/** A cancellation's own journal hand-back: not a card shortfall part, nor an edit's or an appeal's hand-back. */
export function isCancellationOwnHandBack(task: HandBackFacts): boolean {
  return isJournalHandBackTask(task) && !isNonCancellationHandBackTask(task) && cancelCardShortfallPart(task) === null;
}

/**
 * The disputes on this task's own payment. A group organiser's settlement dispute (no payment, filed against the
 * organiser's booking) is the joiners' money, already held from their refunds (`INV-PAY-154`), so it never counts
 * against the organiser's own hand-back.
 */
function disputesOnTaskPayment(task: { paymentId: string | null }, disputes: HandBackDisputes): HandBackDisputes {
  return task.paymentId === null ? [] : disputes.filter((dispute) => dispute.paymentId === task.paymentId);
}

/**
 * A cancellation's own hand-back whose payment has a card dispute recorded: the task a paid cancel of a disputed card
 * payment raises (#5061, `INV-PAY-154`).
 */
export function isDisputedCancellationHandBack(task: HandBackFacts & { paymentId: string | null }, disputes: HandBackDisputes): boolean {
  return disputesOnTaskPayment(task, disputes).length > 0 && isCancellationOwnHandBack(task);
}

/**
 * What a dismissal of this task does: refused (with the sentence shown), or allowed and withdrawing its debt; and,
 * for a disputed card payment's hand-back whose lost disputes cover only part of what is still owed, the reduction
 * the officer may make instead (owner decision, 15 Nov 2026, comment 6893252570): by exactly the lost cents not yet
 * applied, naming every lost dispute counted.
 */
export type JournalHandBackDismissal = {
  refusal: string | null; withdraws: boolean; disputeLost: boolean;
  reduction: { cents: number; lostDisputeIds: string[] } | null;
  /** Why the reduction is refused, in the officer's words, or null when `reduction` is offered. */
  reductionRefusal: string | null;
};
const notThisRules: JournalHandBackDismissal = { refusal: null, withdraws: false, disputeLost: false, reduction: null, reductionRefusal: NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL };

/**
 * THE dismissal rule for a journal hand-back (`INV-SSOT`): the server's door and the queue payload both ask it.
 * - A card shortfall's part to check keeps its dismissal (owner decision, 15 Nov 2026).
 * - A disputed card payment's hand-back (owner decisions, 15 Nov 2026) counts the disputes on its own payment only.
 *   Lost cents not yet applied cover what is still owed: dismissible. They cover part: Dismiss is refused and the
 *   officer may reduce it by exactly those cents instead, the rest still owed. Applied = raised less still owed, the
 *   only change a cancellation's own hand-back's amount ever takes. An open dispute, or none lost, refuses both.
 * - Every other journal hand-back is refused until the four-way dismissal ships (owner decision, 14 Nov 2026, Q6).
 * An allowed dismissal withdraws the task's refund debt exactly. Any other task is not this rule's.
 */
export function journalHandBackDismissal(task: HandBackFacts & { amountCents: number | null; raisedAmountCents: number | null; paymentId: string | null },
  bookingDisputes: HandBackDisputes): JournalHandBackDismissal {
  if (!isJournalHandBackTask(task)) return notThisRules;
  if (isDismissibleCheckPart(task)) return { ...notThisRules, withdraws: true };
  const refused = (refusal: string, reductionRefusal: string = NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL) => ({ ...notThisRules, refusal, reductionRefusal });
  if (!isDisputedCancellationHandBack(task, bookingDisputes) || task.amountCents === null) return refused(JOURNAL_HAND_BACK_DISMISS_REFUSAL);
  const disputes = disputesOnTaskPayment(task, bookingDisputes);
  const open = disputes.find((dispute) => disputeHoldsCapture(dispute.status) && !disputeIsLost(dispute.status));
  if (open) return refused(disputedHandBackDismissRefusal(open.status), disputedHandBackReductionRefusal(open.status));
  const lost = disputes.filter((dispute) => disputeIsLost(dispute.status));
  const applied = Math.max(0, (task.raisedAmountCents ?? task.amountCents) - task.amountCents);
  const unapplied = lost.reduce((sum, dispute) => sum + dispute.amountCents, 0) - applied;
  if (unapplied >= task.amountCents) return { ...notThisRules, withdraws: true, disputeLost: true, reductionRefusal: DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL };
  if (unapplied > 0) {
    return { ...refused(DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL), reductionRefusal: null,
      reduction: { cents: unapplied, lostDisputeIds: lost.map((dispute) => dispute.stripeDisputeId) } };
  }
  return lost.length > 0 ? refused(DISPUTED_HAND_BACK_REDUCED_REFUSAL, DISPUTED_HAND_BACK_NOTHING_TO_REDUCE)
    : refused(disputedHandBackDismissRefusal(disputes[0]!.status), disputedHandBackReductionRefusal(disputes[0]!.status));
}

/**
 * The rule, asked by the dismissal door and the reduction door under their claim's locks, and by a completion,
 * which it refuses while lost disputes are unapplied (it would pay the lost part again). `lock(1)` and the booking row are held; a cancellation's own
 * hand-back then takes its Payment row (completion's order; the withdrawal re-takes it, waiting on nothing) and only
 * then re-reads its booking's disputes, never trusting a read made before the locks. The dispute writer takes none
 * of these locks, so the dismissal answers the disputes as recorded at that read: one that reads open, won or short
 * refuses, writing nothing. A dispute never reopens to open (`INV-PAY-154`); Stripe calls lost final but allows a rare
 * "late win", which this decision cannot foresee (a stated limit in `docs/guides/payments.md`). Others read no disputes.
 */
export async function decideJournalHandBackDismissal(tx: Prisma.TransactionClient,
  task: HandBackFacts & { bookingId: string; paymentId: string | null; amountCents: number | null; raisedAmountCents: number | null },
  resolution: "completed" | "dismissed"): Promise<JournalHandBackDismissal> {
  if (!isJournalHandBackTask(task)) return notThisRules;
  const readDisputes = async () => (await readDisputesByBookingId(tx, [task.bookingId])).get(task.bookingId) ?? [];
  if (resolution === "completed") {
    // #4516 review: Mark paid would pay again what the cardholder already has back. Read without the Payment row,
    // which a completion takes after its member-credit lock (`lockCancellationHandBackBeforeClaim`, INV-LOCK-002).
    if (!isCancellationOwnHandBack(task)) return notThisRules;
    const rule = journalHandBackDismissal(task, await readDisputes());
    const refusal = rule.reduction ? DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING : rule.disputeLost ? DISPUTED_HAND_BACK_LOST_NOT_PAYABLE : null;
    return { ...notThisRules, refusal };
  }
  if (!isNonCancellationHandBackTask(task) && task.paymentId !== null) await lockPaymentForRefundedTotal(tx, task.paymentId);
  return journalHandBackDismissal(task, isCancellationOwnHandBack(task) ? await readDisputes() : []);
}

/** Whether the completion takes `lock(1)` and the booking row first: a late-capture approval or a journal hand-back. */
export function takesHandBackJournalLocksFirst(head: HandBackFacts & { lateCaptureApprovalIntentId: string | null }): boolean {
  return head.lateCaptureApprovalIntentId != null || isJournalHandBackTask(head);
}

/**
 * A cancellation hand-back's completion takes its Payment row before the claim, after `lock(1)`, the booking row and
 * its member-credit lock. (Its dismissal took the same row in `decideJournalHandBackDismissal`.) An edit or appeal
 * hand-back already holds `lock(1)` and the booking row; its Payment row stays with the allocation after the claim.
 */
export async function lockCancellationHandBackBeforeClaim(tx: Prisma.TransactionClient, input: {
  task: HandBackFacts & { paymentId: string | null };
  route: EditReviewSettlementRoute | null;
  ownerMemberId: () => string | null;
}): Promise<void> {
  const { task, route } = input;
  if (route?.kind !== "local-allocation" || !isJournalHandBackTask(task) || isNonCancellationHandBackTask(task)) return;
  if ("creditBackCents" in route && route.creditBackCents > 0) {
    await lockMemberCreditLedger(requireMemberCreditRecipient(input.ownerMemberId()), tx);
  }
  await lockPaymentForRefundedTotal(tx, route.paymentId);
}

/**
 * An allowed dismissal of a journal hand-back (a part to check, or a disputed card payment's once its dispute is
 * lost): the member already has that money another way, so the debt the raise posted is withdrawn exactly, as the
 * 14 Nov 2026 decisions treat a refund debt raised for money that already went back ("raised in error or a
 * duplicate": cancelled exactly). Raised then dismissed, the journal is left as it was before the raise. With the
 * claim, so a lost claim leaves the debt; a journal refusal rolls the dismissal back. Every other dismissal posts
 * nothing.
 */
export async function withdrawDismissedHandBackDebt(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: { id: string; bookingId: string };
  dismissal: JournalHandBackDismissal;
  actingMemberId: string;
}): Promise<void> {
  const { task } = input;
  if (!input.dismissal.withdraws) return;
  await withdrawRefundObligation(tx, journal, {
    bookingId: task.bookingId, scope: "hand-back", id: task.id, actorMemberId: input.actingMemberId,
    reason: input.dismissal.disputeLost
      ? "Disputed card payment's hand-back dismissed: the dispute was lost, so the cardholder already has the money"
      : "Card refund shortfall part to check dismissed: the officer confirmed the member already has it",
    senderKeyPrefix: `hand-back-dismiss:${task.id}`,
    // A debt a lost dispute already reduced is no longer whole: its open rest is withdrawn instead of a reversal.
    part: { eventKey: memberMoneyEventKeys.handBackRestWithdrawn(task.id), amountCents: "open", debtorRead: "booking-row" },
  });
}

/**
 * A disputed card payment's hand-back reduced by lost disputes covering part of it (owner decision, 15 Nov 2026,
 * comment 6893252570): exactly those cents of its refund debt withdrawn, through the same shared withdrawal, under
 * the reduction's own key. After the amount-guarded claim, so a lost claim writes nothing.
 */
export async function withdrawReducedHandBackDebt(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: { id: string; bookingId: string };
  reduction: NonNullable<JournalHandBackDismissal["reduction"]>;
  actingMemberId: string;
}): Promise<boolean> {
  const { task, reduction } = input;
  return withdrawRefundObligation(tx, journal, {
    bookingId: task.bookingId, scope: "hand-back", id: task.id, actorMemberId: input.actingMemberId,
    reason: "Disputed card payment's hand-back reduced: a dispute lost for part of it, so the cardholder already has that part",
    senderKeyPrefix: `hand-back-reduce:${task.id}`,
    part: { eventKey: memberMoneyEventKeys.handBackReduced(task.id, reduction.lostDisputeIds), amountCents: reduction.cents, debtorRead: "booking-row" },
  });
}

/**
 * A hand-back paid by bank or cash, and an edit review closed by hand (its R05, then the payment). Funded only
 * from the receipts the allocation just consumed. A journal refusal rolls the completion back.
 */
export async function postHandBackCompletion(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: HandBackFacts & { id: string; bookingId: string; paymentId: string | null };
  route: EditReviewSettlementRoute | null;
  settled: boolean;
  inCash: boolean;
  fundingTransactionIds: readonly string[];
  actingMemberId: string;
}): Promise<void> {
  const { task, route } = input;
  if (!input.settled || route?.kind !== "local-allocation" || route.refundCents <= 0 || task.paymentId === null) return;
  const review = task.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW;
  if (!review && !isJournalHandBackTask(task)) return;
  if (review) {
    await postRefundObligation(tx, journal, { bookingId: task.bookingId, scope: "review", id: task.id, amountCents: route.refundCents,
      origin: "OFFICER", actorMemberId: input.actingMemberId, debtorRead: "booking-row", reason: "Refund owed, paid back by hand" });
  }
  await postHandBackPayment(tx, journal, { bookingId: task.bookingId, taskId: task.id, cents: route.refundCents,
    account: input.inCash ? "CASH" : "BANK", fundingTransactionIds: input.fundingTransactionIds,
    actorMemberId: input.actingMemberId, debtorRead: "booking-row" });
}
