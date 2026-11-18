import "server-only";

import { ManualRefundTaskStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { disputedHandBackReductionSummary } from "@/lib/manual-refund-task-copy";
import { decideJournalHandBackDismissal, withdrawReducedHandBackDebt, type JournalHandBackDismissal } from "@/lib/manual-refund-task-hand-back-journal";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { resolveBookingDoorClock } from "@/lib/member-money/doors";
import { prisma } from "@/lib/prisma";

/**
 * #4516 (owner decision, 15 Nov 2026, comment 6893252570): REDUCE A DISPUTED CARD PAYMENT'S HAND-BACK BY A DISPUTE
 * LOST FOR PART OF IT. #5061 hands a disputed card cancel's refund to the treasurer as a cash hand-back. When the
 * disputes on that payment are lost for less than what is still owed, the cardholder already has that much back
 * through their bank: the officer reduces the hand-back by exactly the lost cents not yet applied, the journal
 * withdraws exactly that part of its refund debt, and the task stays OPEN for the rest, which the club still owes.
 * Lost for all of it, the existing dismissal applies; open or won, both are refused (`journalHandBackDismissal`).
 *
 * Order, as the dismissal's: `lock(1)`, the booking row, the task re-read, then (in the shared decision) the Payment
 * row and the disputes re-read; then an amount- and status-guarded claim, then the journal and the audit row. The
 * amount the officer saw must still be the task's, so a second click, a retry or a replay reduces nothing twice: the
 * first changes the amount, and every later request names the old one and is refused. The reduction the officer
 * confirmed must also be the one the re-read finds, so a dispute recorded since the queue was read refuses rather
 * than reducing by an amount nobody confirmed. A lost claim writes nothing.
 */

const SELECT = {
  id: true, bookingId: true, paymentId: true, kind: true, occurrenceKey: true, partPaymentReviewPaymentId: true, reason: true,
  status: true, createdAt: true, amountCents: true, raisedAmountCents: true, booking: { select: { memberId: true } },
} satisfies Prisma.ManualRefundTaskSelect;

/** What a reduction did: what the refund was, what it was reduced by and what is still owed. */
export type DisputedHandBackReduction = { taskId: string; wasCents: number; reducedByCents: number; stillOwedCents: number };

export const DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE =
  "This refund changed while you were reducing it - refresh and try again.";

export async function reduceDisputedHandBack(input: {
  taskId: string; actingMemberId: string;
  /** What the officer's confirmation showed: still owed, and the reduction. Either changed since is a stale screen. */
  expectedAmountCents: number; expectedReducedByCents: number;
}): Promise<DisputedHandBackReduction> {
  // `INV-LOCK-004`: the journal is read outside the transaction.
  const { journal } = await resolveBookingDoorClock();
  // `INV-LOCK-006`: it waits for lock(1) behind the same holders the dismissal does.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const head = await tx.manualRefundTask.findUnique({ where: { id: input.taskId }, select: { bookingId: true } });
    if (!head) throw new ManualBookingPaymentError("Refund task not found.", 404);
    await lockBookingRowForOwnerRead(tx, head.bookingId);
    const task = await tx.manualRefundTask.findUniqueOrThrow({ where: { id: input.taskId }, select: SELECT });
    if (task.status !== ManualRefundTaskStatus.OPEN) throw new ManualBookingPaymentError("This refund task has already been closed.", 409);
    if (task.amountCents === null || task.amountCents !== input.expectedAmountCents) throw new ManualBookingPaymentError(DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE, 409);
    // The dismissal's own decision: its Payment row, then the booking's disputes re-read under every lock above.
    const decision: JournalHandBackDismissal = await decideJournalHandBackDismissal(tx, task, "dismissed");
    if (!decision.reduction) throw new ManualBookingPaymentError(decision.reductionRefusal ?? "This refund can't be reduced.", 409);
    const wasCents = task.amountCents;
    const reducedByCents = Math.min(decision.reduction.cents, wasCents);
    // A dispute recorded lost (or won) since the queue was read changes the reduction: answered as a stale screen.
    if (reducedByCents !== input.expectedReducedByCents) throw new ManualBookingPaymentError(DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE, 409);
    const stillOwedCents = wasCents - reducedByCents;
    const claimed = await tx.manualRefundTask.updateMany({
      where: { id: task.id, status: ManualRefundTaskStatus.OPEN, amountCents: wasCents },
      // A legacy row raised before `raisedAmountCents` existed records its original here, so applied = raised less owed.
      data: { amountCents: stillOwedCents, ...(task.raisedAmountCents === null ? { raisedAmountCents: wasCents } : {}) },
    });
    if (claimed.count === 0) throw new ManualBookingPaymentError(DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE, 409);
    await withdrawReducedHandBackDebt(tx, journal, { task, reduction: { ...decision.reduction, cents: reducedByCents }, actingMemberId: input.actingMemberId });
    await createAuditLog({
      action: "booking-payment.manual-refund-task.reduce-by-lost-dispute",
      memberId: input.actingMemberId, actorMemberId: input.actingMemberId, subjectMemberId: bookingOwner(task.booking).memberId,
      targetId: task.bookingId, entityType: "ManualRefundTask", entityId: task.id,
      category: "payment", severity: "important", outcome: "success",
      summary: "Disputed card payment's refund reduced by a dispute lost for part of it",
      metadata: { taskId: task.id, bookingId: task.bookingId, paymentId: task.paymentId, raisedAmountCents: task.raisedAmountCents,
        wasCents, reducedByCents, stillOwedCents, lostDisputeIds: decision.reduction.lostDisputeIds.join(",") },
    }, tx);
    return { taskId: task.id, wasCents, reducedByCents, stillOwedCents };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}

/** The officer's toast: the same amounts the confirmation stated. */
export function disputedHandBackReductionMessage(reduction: DisputedHandBackReduction, format: ClubFormat): string {
  return `Refund reduced. ${disputedHandBackReductionSummary(reduction, format)}`;
}
