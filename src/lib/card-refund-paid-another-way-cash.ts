import type { Prisma } from "@prisma/client";

import { paidAnotherWayCloseReceiptRecorded } from "@/lib/late-capture-paid-another-way";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  paidAnotherWayCloseXeroNote,
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
 * records which on its key (`paidAnotherWayCloseXeroNote`), and this reads that
 * record, never the invoice as it stands later.
 *
 * A NOTE THAT WAITS FOR ITS RECEIPT (#3924 round 6; owner, 8 Oct 2026: "Record
 * receipt, then credit"): a late card charge Xero holds no receipt for has
 * its receipt queued by the close, and its note raised by the receipt's worker
 * once the receipt is in Xero. Until then the close is counted nowhere - not as
 * noted, not as un-noted - and comes off the mirror like an un-noted one
 * (`awaitingReceiptCents`). So nothing can size a note for that money before
 * the receipt exists: not the close, not the nightly self-heal, not the
 * repair tool, not the note's own execution-time cap. That is the order.
 *
 * So the cash a refund note may answer on the payment
 * (`resolveStripeCashRefundEvidence`) counts a NOTED close and never an
 * UN-NOTED or WAITING one, on both of its paths:
 *
 * - provider ledger: the card refund rows plus the noted closes - the note the
 *   close queued is then answered by cash, and a card refund made later is not
 *   taken as covered by it;
 * - legacy mirror: `refundedAmountCents` already holds every close, so the
 *   un-noted and waiting ones come off it - or the nightly self-heal would
 *   raise a card note, settled from the Stripe account, for money that went
 *   back by bank with no invoice to credit.
 */

export interface PaidAnotherWayCash {
  /** Paid back on closes that queued a refund note. */
  notedCents: number;
  /** Paid back on closes with no invoice to credit: on the refunded total, never a card refund, never noted. */
  unnotedCents: number;
  /** Paid back on closes whose note waits for the late capture's receipt, which Xero does not hold yet. */
  awaitingReceiptCents: number;
}

/**
 * The bank cash every paid-another-way close on one payment sent back, split by
 * whether its close took a refund note. One read; almost no payment has any.
 */
export async function readPaidAnotherWayCash(
  db: Pick<
    Prisma.TransactionClient,
    "manualRefundTask" | "paymentRecoveryOperation" | "xeroObjectLink" | "xeroSyncOperation"
  >,
  paymentId: string,
): Promise<PaidAnotherWayCash> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { kind: true, occurrenceKey: true, amountCents: true },
  });
  const cash: PaidAnotherWayCash = { notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 };
  for (const task of tasks) {
    const cents = Math.max(0, task.amountCents ?? 0);
    const note = paidAnotherWayCloseXeroNote(task);
    if (note === "now") cash.notedCents += cents;
    else if (note !== "after-receipt") cash.unnotedCents += cents;
    else if (await paidAnotherWayCloseReceiptRecorded(task, db)) cash.notedCents += cents;
    else cash.awaitingReceiptCents += cents;
  }
  return cash;
}

/**
 * #3924 round 7 (money M1, `INV-PAY-121`): THE NOTED BANK CASH WHOSE OWN NOTE
 * HAS NOT LANDED. A close counted as noted (`readPaidAnotherWayCash`) puts its
 * bank cash into what a refund note may answer, and only its own
 * bank-transfer note - keyed on the close's record (`paidAnotherWayTaskId`) -
 * may answer it. While that note is queued, running or FAILED it covers
 * nothing, so the payment reads that cash as uncovered; a caller that sizes a
 * note WITHOUT the record - the nightly self-heal - would otherwise fill it
 * with a card note settled from the Stripe account. Such a caller takes this
 * off what it asks for. The close's note itself is retried as its own row.
 *
 * Landed: a refund-note create on the payment for this record, either
 * SUCCEEDED with the Xero note it raised or resolved by hand in Xero
 * (`INV-INT-025`). Matched by the record id the row carries, and by its key.
 */
export async function readPaidAnotherWayNotesNotLandedCents(
  db: Pick<
    Prisma.TransactionClient,
    "manualRefundTask" | "paymentRecoveryOperation" | "xeroObjectLink" | "xeroSyncOperation"
  >,
  paymentId: string,
): Promise<number> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { id: true, kind: true, occurrenceKey: true, amountCents: true },
  });
  let notLandedCents = 0;
  for (const task of tasks) {
    const note = paidAnotherWayCloseXeroNote(task);
    const noted =
      note === "now" || (note === "after-receipt" && (await paidAnotherWayCloseReceiptRecorded(task, db)));
    if (!noted) continue;
    const landed = await db.xeroSyncOperation.count({
      where: {
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: paymentId,
        OR: [
          { requestPayload: { path: ["paidAnotherWayTaskId"], equals: task.id } },
          { correlationKey: { endsWith: `:paid-another-way:${task.id}` } },
        ],
        AND: [
          {
            OR: [
              { status: "SUCCEEDED", xeroObjectId: { not: null } },
              { manuallyResolvedAt: { not: null } },
            ],
          },
        ],
      },
    });
    if (landed === 0) notLandedCents += Math.max(0, task.amountCents ?? 0);
  }
  return notLandedCents;
}
