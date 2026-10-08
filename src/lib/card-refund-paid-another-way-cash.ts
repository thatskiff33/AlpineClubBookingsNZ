import type { Prisma } from "@prisma/client";

import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  paymentRecoveryOperationIdOfPaidAnotherWay,
} from "@/lib/manual-refund-task-settlement-rules";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";

/**
 * #3924 round 4 (money review, M1 and M3; `INV-PAY-119`): THE BANK CASH A
 * "PAID ANOTHER WAY" CLOSE SENT BACK, AS THE XERO REFUND-NOTE PIPELINE READS IT.
 *
 * The close raises the payment's `refundedAmountCents` by the amount paid back
 * (`applyLocalRefundAllocation`) and writes no `PaymentRefund` row: no card
 * refund happened. Its persisted record is a COMPLETED
 * `ManualRefundTask` under `CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX`, written
 * in the same transaction (`isCardRefundPaidAnotherWayTask`) - never the
 * operation's `lastError` wording.
 *
 * WHICH CLOSE TAKES A REFUND NOTE (`takesPaidAnotherWayRefundNote`): only a
 * cancellation's card refund. Its note is the one the cancellation's card refund
 * would have raised, worded as a bank transfer (`INV-PAY-101`), queued by the
 * close for exactly the amount paid back. Every other close takes none: an
 * edit's refund was already credited on the invoice by the edit's own note, as
 * an edit's bank-transfer hand-back is (`INV-PAY-117`).
 *
 * So the cash a refund note may answer on the payment
 * (`resolveStripeCashRefundEvidence`) counts a NOTED close and never an
 * UN-NOTED one, on both of its paths:
 *
 * - provider ledger: the card refund rows plus the noted closes - the note the
 *   close queued is then answered by cash, and a card refund made later is not
 *   taken as covered by it;
 * - legacy mirror: `refundedAmountCents` already holds every close, so the
 *   un-noted ones come off it - or the nightly self-heal would raise a card
 *   note settled from the Stripe account for money the edit's note already
 *   credited.
 */

/** Whether a paid-another-way close of this operation takes a Xero refund note: a cancellation's card refund only. */
export function takesPaidAnotherWayRefundNote(operation: { idempotencyKey: string; bookingId: string }): boolean {
  return operation.idempotencyKey === buildBookingCancellationRefundIdempotencyKey(operation.bookingId);
}

export interface PaidAnotherWayCash {
  /** Paid back on closes that take a refund note (a cancellation's card refund). */
  notedCents: number;
  /** Paid back on every other close: on the refunded total, never a card refund, never noted. */
  unnotedCents: number;
}

/**
 * The bank cash every paid-another-way close on one payment sent back, split by
 * whether its close took a refund note. Two reads, the second only when the
 * payment has any such close (almost none do).
 */
export async function readPaidAnotherWayCash(
  db: Pick<Prisma.TransactionClient, "manualRefundTask" | "paymentRecoveryOperation">,
  paymentId: string,
): Promise<PaidAnotherWayCash> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { kind: true, occurrenceKey: true, amountCents: true },
  });
  if (tasks.length === 0) return { notedCents: 0, unnotedCents: 0 };
  const operationIds = tasks
    .map((task) => paymentRecoveryOperationIdOfPaidAnotherWay(task))
    .filter((id): id is string => id !== null);
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { id: { in: operationIds } },
    select: { id: true, idempotencyKey: true, bookingId: true },
  });
  const noted = new Set(operations.filter(takesPaidAnotherWayRefundNote).map((operation) => operation.id));
  let notedCents = 0;
  let unnotedCents = 0;
  for (const task of tasks) {
    const cents = Math.max(0, task.amountCents ?? 0);
    const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(task);
    if (operationId !== null && noted.has(operationId)) notedCents += cents;
    else unnotedCents += cents;
  }
  return { notedCents, unnotedCents };
}
