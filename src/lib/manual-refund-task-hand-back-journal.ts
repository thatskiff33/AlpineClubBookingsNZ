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
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL, disputedHandBackDismissRefusal, JOURNAL_HAND_BACK_DISMISS_REFUSAL } from "@/lib/manual-refund-task-copy";
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

/** The card disputes recorded on the task's booking (#5061, `readDisputesByBookingId`): their statuses and cents. */
export type HandBackDisputes = readonly { status: StripeDisputeStatus; amountCents: number }[];

/** A cancellation's own journal hand-back: not a card shortfall part, nor an edit's or an appeal's hand-back. */
export function isCancellationOwnHandBack(task: HandBackFacts): boolean {
  return isJournalHandBackTask(task) && !isNonCancellationHandBackTask(task) && cancelCardShortfallPart(task) === null;
}

/**
 * A cancellation's own hand-back on a booking with a card dispute recorded: the task a paid cancel of a disputed card
 * payment raises (#5061, `INV-PAY-154`).
 */
export function isDisputedCancellationHandBack(task: HandBackFacts, disputes: HandBackDisputes): boolean {
  return disputes.length > 0 && isCancellationOwnHandBack(task);
}

/** What a dismissal of this task does: refused (with the sentence shown), or allowed and withdrawing its debt. */
export type JournalHandBackDismissal = { refusal: string | null; withdraws: boolean; disputeLost: boolean };

/**
 * THE dismissal rule for a journal hand-back (`INV-SSOT`): the server's door and the queue payload both ask it.
 * - A card shortfall's part to check keeps its dismissal (owner decision, 15 Nov 2026).
 * - A disputed card payment's hand-back is dismissed only once its disputes are lost (owner decision, 15 Nov 2026),
 *   and only when the lost cents cover the task's: the decision rests on the cardholder already having the money
 *   back, which is true only of what the bank took back. While one is open, if they cover less, or if they were won
 *   or closed with no funds taken, it is refused: the club may still owe it.
 * - Every other journal hand-back is refused until the four-way dismissal ships (owner decision, 14 Nov 2026, Q6).
 * An allowed dismissal withdraws the task's refund debt exactly. Any other task is not this rule's.
 */
export function journalHandBackDismissal(task: HandBackFacts & { amountCents: number | null }, disputes: HandBackDisputes): JournalHandBackDismissal {
  if (!isJournalHandBackTask(task)) return { refusal: null, withdraws: false, disputeLost: false };
  if (isDismissibleCheckPart(task)) return { refusal: null, withdraws: true, disputeLost: false };
  if (!isDisputedCancellationHandBack(task, disputes)) return { refusal: JOURNAL_HAND_BACK_DISMISS_REFUSAL, withdraws: false, disputeLost: false };
  const refused = (refusal: string) => ({ refusal, withdraws: false, disputeLost: false });
  const open = disputes.find((dispute) => disputeHoldsCapture(dispute.status) && !disputeIsLost(dispute.status));
  if (open) return refused(disputedHandBackDismissRefusal(open.status));
  const lostCents = disputes.filter((dispute) => disputeIsLost(dispute.status)).reduce((sum, dispute) => sum + dispute.amountCents, 0);
  if (task.amountCents !== null && lostCents >= task.amountCents) return { refusal: null, withdraws: true, disputeLost: true };
  return refused(lostCents > 0 ? DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL : disputedHandBackDismissRefusal(disputes[0]!.status));
}

/**
 * The rule, asked by the door under the claim's locks. `lock(1)` and the booking row are held; a cancellation's own
 * hand-back then takes its Payment row (completion's order; the withdrawal re-takes it, waiting on nothing) and only
 * then re-reads its booking's disputes, never trusting a read made before the locks. The dispute writer takes none
 * of these locks, so the dismissal answers the disputes as recorded at that read: one that reads open, won or short
 * refuses, writing nothing. A dispute never reopens to open (`INV-PAY-154`); Stripe calls lost final but allows a rare
 * "late win", which this decision cannot foresee (a stated limit in `docs/guides/payments.md`). Others read no disputes.
 */
export async function decideJournalHandBackDismissal(tx: Prisma.TransactionClient,
  task: HandBackFacts & { bookingId: string; paymentId: string | null; amountCents: number | null },
  resolution: "completed" | "dismissed"): Promise<JournalHandBackDismissal> {
  if (resolution !== "dismissed" || !isJournalHandBackTask(task)) return { refusal: null, withdraws: false, disputeLost: false };
  if (!isNonCancellationHandBackTask(task) && task.paymentId !== null) await lockPaymentForRefundedTotal(tx, task.paymentId);
  const disputes = isCancellationOwnHandBack(task) ? (await readDisputesByBookingId(tx, [task.bookingId])).get(task.bookingId) ?? [] : [];
  return journalHandBackDismissal(task, disputes);
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
