import { ManualRefundTaskKind, type Prisma, type StripeDisputeStatus } from "@prisma/client";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { isJournalHandBackTask, type HandBackFacts } from "@/lib/manual-refund-task-hand-back-population";
import { cancelCardShortfallPart, isEditRefundHandBackTask, isNonCancellationHandBackTask } from "@/lib/manual-refund-task-settlement-rules";
import { lockMemberCreditLedger, requireMemberCreditRecipient } from "@/lib/member-credit";
import { postHandBackPayment, postRefundObligation, restoreHandBackObligation, withdrawRefundObligation, type BookingJournalContext } from "@/lib/member-money/doors";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import {
  DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL, DISPUTED_HAND_BACK_LOST_NOT_PAYABLE, DISPUTED_HAND_BACK_NOTHING_TO_REDUCE, DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL,
  DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND_REDUCTION,
  DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING, DISPUTED_HAND_BACK_REDUCED_REFUSAL, DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE,
  disputedHandBackDismissRefusal, disputedHandBackReductionRefusal, JOURNAL_HAND_BACK_DISMISS_REFUSAL, NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL,
} from "@/lib/manual-refund-task-copy";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";
import { disputeHoldsCapture, disputeIsLost } from "@/lib/stripe-dispute-note";

/**
 * #4516 (Ledger M4d): WHICH MANUAL REFUND TASKS THE MEMBER-MONEY JOURNAL RECORDS AS A HAND-BACK DEBT, and the
 * journal steps `resolveManualRefundTask` takes for them. The raise posts the debt (R05, scope `hand-back`); a
 * completion pays it (R14). Dismissing a real bank or cash hand-back is refused for now (owner decision, 14 Nov
 * 2026), so its debt stays open until the task is paid. A card shortfall's part to check keeps its dismissal, and a
 * disputed card payment's hand-back, a cancellation's or a dispute-held edit's, is dismissed once lost disputes cover
 * it (owner decisions, 15 Nov and 18 Nov 2026), lost cents counted once across the payment's tasks; either dismissal
 * withdraws its debt exactly. Which tasks those are is `manual-refund-task-hand-back-population.ts`. Split out of
 * `manual-refund-task-resolution.ts` and `manual-refund-task-settlement-rules.ts` so neither crosses its size
 * budget; the lock order is unchanged.
 */

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
 * A hand-back a lost card dispute on its payment is set against (owner decisions, 15 Nov and 18 Nov 2026, #4516): a
 * cancellation's own hand-back, which a paid cancel of a disputed card payment raises (#5061), and an edit's, where a
 * dispute holds an edit's refund for the treasurer (#5151). Both are `INV-PAY-154`'s treasurer tasks.
 */
export function isDisputeLossHandBack(task: HandBackFacts): boolean {
  return isCancellationOwnHandBack(task) || (isJournalHandBackTask(task) && isEditRefundHandBackTask(task));
}

/** A task on the same payment, as the once-only allocation reads it: any status, its amounts and its age. */
export type PaymentHandBackTask = HandBackFacts & {
  id: string; paymentId: string | null; status: string; createdAt: Date; amountCents: number | null; raisedAmountCents: number | null;
};

/** What the dispute rules read for one task: the disputes on its booking and every task on its payment. */
export type HandBackDisputeContext = { disputes: HandBackDisputes; paymentTasks: readonly PaymentHandBackTask[] };
export const NO_HAND_BACK_DISPUTES: HandBackDisputeContext = { disputes: [], paymentTasks: [] };

/**
 * Lost cents one task has already taken off what the club owes: a dismissed one all it was raised for (the documented
 * step after a lost dispute was always to dismiss it, #5061), any other its reductions (raised less still owed, the
 * only change these tasks' amounts take).
 */
export function lossAppliedByTask(task: Pick<PaymentHandBackTask, "status" | "amountCents" | "raisedAmountCents">): number {
  const raised = handBackRaisedCents(task);
  return task.status === "DISMISSED" ? raised : Math.max(0, raised - (task.amountCents ?? 0));
}

/** What a task was raised for: a legacy row with no `raisedAmountCents` was never reduced, so its amount. */
export function handBackRaisedCents(task: Pick<PaymentHandBackTask, "amountCents" | "raisedAmountCents">): number {
  return task.raisedAmountCents ?? task.amountCents ?? 0;
}

/** The allocation's order (oldest first, then by id); #5197's late win walks it in reverse. */
export const olderThan = (a: Pick<PaymentHandBackTask, "createdAt" | "id">, b: Pick<PaymentHandBackTask, "createdAt" | "id">) =>
  a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id);

/** The cents of the disputes on this payment that read lost: what the allocation applies. */
export function lostCentsOnPayment(paymentId: string | null, disputes: HandBackDisputes): number {
  return disputesOnTaskPayment({ paymentId }, disputes).filter((dispute) => disputeIsLost(dispute.status))
    .reduce((sum, dispute) => sum + dispute.amountCents, 0);
}

/**
 * THE ONCE-ONLY ALLOCATION (owner decision, 18 Nov 2026, #4516; `INV-SSOT`): the lost cents this task may take. The
 * payment's lost disputes, less what every dispute-loss hand-back on that payment has already applied, go to its open
 * tasks OLDEST FIRST: a task gets what is left after every older open task's whole still-owed amount. So the sum of
 * every task's share never exceeds the lost cents, and the queue and the doors, reading the same rows, agree on which
 * task takes them. Dismiss, Reduce and the Mark paid refusal all ask this, for both kinds of task.
 */
export function disputeLossAvailableToTask(task: PaymentHandBackTask, context: HandBackDisputeContext): number {
  if (task.paymentId === null) return 0;
  const lost = lostCentsOnPayment(task.paymentId, context.disputes);
  const tasks = [task, ...context.paymentTasks.filter((other) => other.id !== task.id)]
    .filter((other) => other.paymentId === task.paymentId && isDisputeLossHandBack(other));
  const applied = tasks.reduce((sum, other) => sum + lossAppliedByTask(other), 0);
  const olderOwed = tasks.filter((other) => other.id !== task.id && other.status === "OPEN" && olderThan(other, task))
    .reduce((sum, other) => sum + (other.amountCents ?? 0), 0);
  return Math.max(0, lost - applied - olderOwed);
}

/** Every task on these payments, for the allocation: read under the caller's locks. */
export async function readPaymentHandBackTasks(db: Pick<Prisma.TransactionClient, "manualRefundTask">, paymentIds: readonly string[]): Promise<PaymentHandBackTask[]> {
  if (paymentIds.length === 0) return [];
  return db.manualRefundTask.findMany({
    where: { paymentId: { in: [...paymentIds] } },
    select: { id: true, paymentId: true, status: true, createdAt: true, amountCents: true, raisedAmountCents: true, kind: true, occurrenceKey: true, partPaymentReviewPaymentId: true, reason: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * What a dismissal of this task does: refused (with the sentence shown), or allowed and withdrawing its debt; and,
 * for a disputed card payment's hand-back whose lost disputes cover only part of what is still owed, the reduction
 * the officer may make instead (owner decision, 15 Nov 2026, comment 6893252570): by exactly the lost cents this task
 * may take (`disputeLossAvailableToTask`), naming every lost dispute counted.
 */
export type JournalHandBackDismissal = {
  refusal: string | null; withdraws: boolean; disputeLost: boolean;
  reduction: { cents: number; lostDisputeIds: string[] } | null;
  /** Why the reduction is refused, in the officer's words, or null when `reduction` is offered. */
  reductionRefusal: string | null;
  /**
   * The lost cents this task may take, whatever else is open: the cardholder already has them back, so Mark paid at
   * the full amount refuses while any remain (#4516 review), even while another dispute on the same payment is still
   * open and the reduction waits for it.
   */
  unappliedLostCents: number;
  /** Why Mark paid is refused, or null: the completion door's answer and the queue's, which then offers no Mark paid. */
  markPaidRefusal: string | null;
};
const notThisRules: JournalHandBackDismissal = {
  refusal: null, withdraws: false, disputeLost: false, reduction: null, reductionRefusal: NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL,
  unappliedLostCents: 0, markPaidRefusal: null,
};

/**
 * THE dismissal rule for a journal hand-back (`INV-SSOT`): the server's doors and the queue payload all ask it.
 * - A card shortfall's part to check keeps its dismissal (owner decision, 15 Nov 2026).
 * - A disputed card payment's hand-back, a cancellation's or a dispute-held edit's (owner decisions, 15 and 18 Nov
 *   2026), counts the disputes on its own payment only, and the lost cents it may take (`disputeLossAvailableToTask`).
 *   They cover what is still owed: dismissible, and Mark paid refused. They cover part: Dismiss and Mark paid are
 *   refused and the officer may reduce it by exactly those cents instead, the rest still owed. An open dispute, or none
 *   lost, refuses Dismiss and Reduce; Mark paid refuses while this task may take lost cents, even beside an open
 *   dispute. A won dispute leaves it payable.
 * - Every other journal hand-back is refused until the four-way dismissal ships (owner decision, 14 Nov 2026, Q6).
 * An allowed dismissal withdraws the task's refund debt exactly. Any other task is not this rule's.
 */
export function journalHandBackDismissal(task: PaymentHandBackTask, context: HandBackDisputeContext): JournalHandBackDismissal {
  if (!isJournalHandBackTask(task)) return notThisRules;
  if (isDismissibleCheckPart(task)) return { ...notThisRules, withdraws: true };
  const refused = (refusal: string, reductionRefusal: string = NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL) => ({ ...notThisRules, refusal, reductionRefusal });
  const disputes = disputesOnTaskPayment(task, context.disputes);
  if (!isDisputeLossHandBack(task) || disputes.length === 0 || task.amountCents === null) return refused(JOURNAL_HAND_BACK_DISMISS_REFUSAL);
  const lost = disputes.filter((dispute) => disputeIsLost(dispute.status));
  // Counted before the open check (#4516 review): a dispute lost on one charge beside one still open on another.
  const share = disputeLossAvailableToTask(task, context);
  const open = disputes.find((dispute) => disputeHoldsCapture(dispute.status) && !disputeIsLost(dispute.status));
  if (open) {
    return { ...refused(disputedHandBackDismissRefusal(open.status), disputedHandBackReductionRefusal(open.status)),
      unappliedLostCents: share, markPaidRefusal: share > 0 ? DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE : null };
  }
  if (share >= task.amountCents) {
    return { ...notThisRules, withdraws: true, disputeLost: true, reductionRefusal: DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL,
      unappliedLostCents: share, markPaidRefusal: DISPUTED_HAND_BACK_LOST_NOT_PAYABLE };
  }
  if (share > 0) {
    return { ...refused(DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL), reductionRefusal: null, unappliedLostCents: share,
      markPaidRefusal: DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING, reduction: { cents: share, lostDisputeIds: lost.map((dispute) => dispute.stripeDisputeId) } };
  }
  if (lost.length === 0) return refused(disputedHandBackDismissRefusal(disputes[0]!.status), disputedHandBackReductionRefusal(disputes[0]!.status));
  // Lost, but nothing left for this task: its own reductions took it, or an older refund on the payment takes it.
  return lossAppliedByTask(task) > 0 ? refused(DISPUTED_HAND_BACK_REDUCED_REFUSAL, DISPUTED_HAND_BACK_NOTHING_TO_REDUCE)
    : refused(DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND_REDUCTION);
}

/**
 * The rule, asked by the dismissal door and the reduction door under their claim's locks, and by a completion,
 * which it refuses while this task may take lost cents (it would pay the lost part again). `lock(1)` and the booking
 * row are held; every door that applies lost cents (dismissal, reduction) holds `lock(1)`, so two officers on two
 * tasks of one payment are serialised and the second re-reads what the first applied. A dismissal or reduction of a
 * dispute-loss hand-back (and a cancellation's own, as before) then takes its Payment row (completion's order; the
 * withdrawal re-takes it, waiting on nothing) and only then re-reads the booking's disputes and the payment's tasks,
 * never trusting a read made before the locks. The dispute writer takes none of these locks, so the decision answers
 * the disputes as recorded at that read: one that reads open, won or short refuses, writing nothing. A dispute never
 * reopens to open (`INV-PAY-154`); Stripe calls lost final but allows a rare "late win", which this decision cannot
 * foresee (a stated limit in `docs/guides/payments.md`). Others read no disputes.
 */
export async function decideJournalHandBackDismissal(tx: Prisma.TransactionClient,
  task: PaymentHandBackTask & { bookingId: string },
  resolution: "completed" | "dismissed"): Promise<JournalHandBackDismissal> {
  if (!isJournalHandBackTask(task)) return notThisRules;
  const readContext = async (): Promise<HandBackDisputeContext> => {
    const disputes = (await readDisputesByBookingId(tx, [task.bookingId])).get(task.bookingId) ?? [];
    const onPayment = disputesOnTaskPayment(task, disputes).length > 0;
    return { disputes, paymentTasks: onPayment && task.paymentId !== null ? await readPaymentHandBackTasks(tx, [task.paymentId]) : [] };
  };
  if (resolution === "completed") {
    // #4516 review: Mark paid would pay again what the cardholder already has back. Read without the Payment row,
    // which a completion takes later (a cancellation's after its member-credit lock, `lockCancellationHandBackBeforeClaim`,
    // INV-LOCK-002; an edit's with its allocation); `lock(1)` already excludes every door that applies lost cents.
    if (!isDisputeLossHandBack(task)) return notThisRules;
    return { ...notThisRules, refusal: journalHandBackDismissal(task, await readContext()).markPaidRefusal };
  }
  if ((!isNonCancellationHandBackTask(task) || isDisputeLossHandBack(task)) && task.paymentId !== null) await lockPaymentForRefundedTotal(tx, task.paymentId);
  return journalHandBackDismissal(task, isDisputeLossHandBack(task) ? await readContext() : NO_HAND_BACK_DISPUTES);
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
 * #5197: a dispute-loss hand-back put back on the queue, by a late win (Stripe reports a lost dispute won) or by an
 * officer, owes the member again: its refund debt is posted again exactly as its dismissal withdrew it
 * (`restoreHandBackObligation`), so the journal owes what the reopened task does. With the reopen's status claim and
 * under its locks (`lock(1)`, the booking row, the Payment row), as the dismissal took them. Every other kind posts
 * nothing, as before.
 */
export async function restoreReopenedHandBackDebt(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: HandBackFacts & { id: string; bookingId: string; amountCents: number | null };
  origin: "OFFICER" | "STRIPE";
  actorMemberId: string | null;
}): Promise<void> {
  const { task } = input;
  if (!isDisputeLossHandBack(task) || task.amountCents === null) return;
  await restoreHandBackObligation(tx, journal, {
    bookingId: task.bookingId, taskId: task.id, amountCents: task.amountCents, origin: input.origin, actorMemberId: input.actorMemberId,
    reason: input.origin === "STRIPE"
      ? "Disputed card payment's hand-back reopened: Stripe reports the lost dispute won, so the club owes the member again"
      : "Disputed card payment's hand-back put back on the queue by an officer: the refund is owed again",
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
