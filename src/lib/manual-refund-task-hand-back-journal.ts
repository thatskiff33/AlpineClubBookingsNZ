import { ManualRefundTaskKind, type Prisma } from "@prisma/client";
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
import { JOURNAL_HAND_BACK_DISMISS_REFUSAL } from "@/lib/manual-refund-task-copy";

/**
 * #4516 (Ledger M4d): WHICH MANUAL REFUND TASKS THE MEMBER-MONEY JOURNAL RECORDS AS A HAND-BACK DEBT, and the
 * journal steps `resolveManualRefundTask` takes for them. The raise posts the debt (R05, scope `hand-back`); a
 * completion pays it (R14). Dismissing a real bank or cash hand-back is refused for now (owner decision, 14 Nov
 * 2026), so its debt stays open until the task is paid. A card shortfall's part to check keeps its dismissal (owner
 * decision, 15 Nov 2026), which withdraws its debt exactly. Split out of `manual-refund-task-resolution.ts` and
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

/**
 * Whether this task's dismissal is refused: a journal hand-back that is not a part to check. Owner decisions, 14 and
 * 15 Nov 2026 (#4516, Q6 and the split): a real bank or cash hand-back is not dismissed until the four-way dismissal
 * ships, so its debt stays open until it is paid. The door and the queue payload both ask this (`INV-SSOT`).
 */
export function refusesJournalHandBackDismissal(task: HandBackFacts): boolean {
  return isJournalHandBackTask(task) && !isDismissibleCheckPart(task);
}

/**
 * Why this dismissal is refused, or null. The completion door asks this under `lock(1)` and the booking row, before
 * its claim, so a refusal writes nothing.
 */
export function journalHandBackDismissRefusal(task: HandBackFacts, resolution: "completed" | "dismissed"): string | null {
  return resolution === "dismissed" && refusesJournalHandBackDismissal(task) ? JOURNAL_HAND_BACK_DISMISS_REFUSAL : null;
}

/** Whether the completion takes `lock(1)` and the booking row first: a late-capture approval or a journal hand-back. */
export function takesHandBackJournalLocksFirst(head: HandBackFacts & { lateCaptureApprovalIntentId: string | null }): boolean {
  return head.lateCaptureApprovalIntentId != null || isJournalHandBackTask(head);
}

/**
 * A cancellation hand-back's Payment row before the claim, after `lock(1)`, the booking row and its member-credit
 * lock: a completion's, and a part to check's dismissal (whose withdrawal then re-takes it, waiting on nothing). An
 * edit or appeal hand-back already holds `lock(1)` and the booking row; its Payment row stays with the allocation
 * after the claim.
 */
export async function lockCancellationHandBackBeforeClaim(tx: Prisma.TransactionClient, input: {
  task: HandBackFacts & { paymentId: string | null };
  resolution: "completed" | "dismissed";
  route: EditReviewSettlementRoute | null;
  ownerMemberId: () => string | null;
}): Promise<void> {
  const { task, route } = input;
  if (input.resolution === "dismissed") {
    if (isDismissibleCheckPart(task) && task.paymentId !== null) await lockPaymentForRefundedTotal(tx, task.paymentId);
    return;
  }
  if (route?.kind !== "local-allocation" || !isJournalHandBackTask(task) || isNonCancellationHandBackTask(task)) return;
  if ("creditBackCents" in route && route.creditBackCents > 0) {
    await lockMemberCreditLedger(requireMemberCreditRecipient(input.ownerMemberId()), tx);
  }
  await lockPaymentForRefundedTotal(tx, route.paymentId);
}

/**
 * A part to check, dismissed: the officer has confirmed the member already has that money, so the debt its raise
 * posted is withdrawn exactly, as the 14 Nov 2026 decisions treat a refund debt raised for money that already went
 * back another way ("raised in error or a duplicate": cancelled exactly).
 * Raised then dismissed, the journal is left as it was before the raise. With the claim, so a lost claim leaves the
 * debt; a journal refusal rolls the dismissal back. Every other kind's dismissal posts nothing.
 */
export async function withdrawDismissedCheckPartDebt(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  task: HandBackFacts & { id: string; bookingId: string };
  resolution: "completed" | "dismissed";
  actingMemberId: string;
}): Promise<void> {
  const { task } = input;
  if (input.resolution !== "dismissed" || !isDismissibleCheckPart(task)) return;
  await withdrawRefundObligation(tx, journal, {
    bookingId: task.bookingId, scope: "hand-back", id: task.id, actorMemberId: input.actingMemberId,
    reason: "Card refund shortfall part to check dismissed: the officer confirmed the member already has it",
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
