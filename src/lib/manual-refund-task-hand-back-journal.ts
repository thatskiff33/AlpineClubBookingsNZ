import { ManualRefundTaskKind, type Prisma } from "@prisma/client";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { isGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back-rules";
import { isLateCaptureHandBackTask } from "@/lib/late-capture-hand-back-task";
import {
  editRefundHandBackOccurrenceKey,
  isCardRefundPaidAnotherWayTask,
  isNonCancellationHandBackTask,
  isPartPaymentReviewTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { lockMemberCreditLedger, requireMemberCreditRecipient } from "@/lib/member-credit";
import { postHandBackPayment, postRefundObligation, withdrawRefundObligation, type BookingJournalContext } from "@/lib/member-money/doors";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";

/**
 * #4516 (Ledger M4d): WHICH MANUAL REFUND TASKS THE MEMBER-MONEY JOURNAL RECORDS AS A HAND-BACK DEBT, and the
 * journal steps `resolveManualRefundTask` takes for them. The raise posts the debt (R05, scope `hand-back`); a
 * completion pays it (R14); a dismissal withdraws it. Split out of `manual-refund-task-resolution.ts` and
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
 * raise posts and a dismissal withdraws: a cancellation's cash hand-back, a card shortfall's bank or cheque part,
 * an edit hand-back, a refund request's bank part, and an organisation's late cash. Not a part-payment review, a
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

/** Whether the completion takes `lock(1)` and the booking row first: a late-capture approval or a journal hand-back. */
export function takesHandBackJournalLocksFirst(head: HandBackFacts & { lateCaptureApprovalIntentId: string | null }): boolean {
  return head.lateCaptureApprovalIntentId != null || isJournalHandBackTask(head);
}

/**
 * A cancellation hand-back's Payment row before the claim, after `lock(1)`, the booking row and its member-credit
 * lock. An edit or appeal hand-back already holds `lock(1)` and the booking row; its Payment row stays with the
 * allocation after the claim.
 */
export async function lockCancellationHandBackBeforeClaim(tx: Prisma.TransactionClient, input: {
  task: HandBackFacts;
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
 * Dismissing a hand-back means the club is not paying it. The refund debt raised with the task is withdrawn with
 * the claim, so a lost claim leaves the debt. A debt already paid cannot be withdrawn.
 */
export async function withdrawDismissedHandBackDebt(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: HandBackFacts & { id: string; bookingId: string };
  resolution: "completed" | "dismissed";
  actingMemberId: string;
}): Promise<void> {
  const { task } = input;
  if (input.resolution !== "dismissed" || !isJournalHandBackTask(task)) return;
  await withdrawRefundObligation(tx, journal, {
    bookingId: task.bookingId, scope: "hand-back", id: task.id, actorMemberId: input.actingMemberId,
    reason: "Hand-back dismissed: the club is not paying it back", senderKeyPrefix: `hand-back-dismiss:${task.id}`,
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
