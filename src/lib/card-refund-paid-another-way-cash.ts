import type { Prisma } from "@prisma/client";

import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  paidAnotherWayCloseTookXeroRefundNote,
} from "@/lib/manual-refund-task-settlement-rules";

/**
 * #3924 round 4 (money review, M1 and M3; `INV-PAY-121`): THE BANK CASH A
 * "PAID ANOTHER WAY" CLOSE SENT BACK, AS THE XERO REFUND-NOTE PIPELINE READS IT.
 *
 * The close raises the payment's `refundedAmountCents` by the amount paid back
 * (`applyLocalRefundAllocation`) and writes no `PaymentRefund` row: no card
 * refund happened. Its persisted record is a COMPLETED
 * `ManualRefundTask` under `CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX`, written
 * in the same transaction (`isCardRefundPaidAnotherWayTask`) - never the
 * operation's `lastError` wording.
 *
 * WHICH CLOSE TOOK A REFUND NOTE (#3924 round 5; owner, 8 Oct 2026: "Raise a
 * refund note for all"): every kind of card refund takes one - a bank-transfer
 * refund note for exactly the amount paid back (`INV-PAY-101`) - wherever the
 * payment has an invoice to credit (`paidAnotherWayNoteInvoice`). The close
 * records which on its key (`paidAnotherWayCloseTookXeroRefundNote`), and this
 * reads that record, never the invoice as it stands later.
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
 *   note, settled from the Stripe account, for money that went back by bank
 *   with no invoice to credit.
 */

export interface PaidAnotherWayCash {
  /** Paid back on closes that queued a refund note. */
  notedCents: number;
  /** Paid back on closes with no invoice to credit: on the refunded total, never a card refund, never noted. */
  unnotedCents: number;
}

/**
 * The bank cash every paid-another-way close on one payment sent back, split by
 * whether its close took a refund note. One read; almost no payment has any.
 */
export async function readPaidAnotherWayCash(
  db: Pick<Prisma.TransactionClient, "manualRefundTask">,
  paymentId: string,
): Promise<PaidAnotherWayCash> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { kind: true, occurrenceKey: true, amountCents: true },
  });
  let notedCents = 0;
  let unnotedCents = 0;
  for (const task of tasks) {
    const cents = Math.max(0, task.amountCents ?? 0);
    if (paidAnotherWayCloseTookXeroRefundNote(task)) notedCents += cents;
    else unnotedCents += cents;
  }
  return { notedCents, unnotedCents };
}
