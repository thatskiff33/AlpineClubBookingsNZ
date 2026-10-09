import type { Prisma } from "@prisma/client";

import { paidAnotherWayCloseReceiptRecorded } from "@/lib/late-capture-paid-another-way";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  paidAnotherWayCloseXeroNote,
} from "@/lib/manual-refund-task-settlement-rules";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #3924 round 4 (money review, M1 and M3; `INV-PAY-122`): THE BANK CASH A
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

type CashStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "paymentRecoveryOperation" | "xeroObjectLink" | "xeroSyncOperation"
>;

/** One close on the payment, and how its bank cash counts (see the module comment). */
interface PaidAnotherWayCloseCash {
  id: string;
  amountCents: number;
  counted: "noted" | "unnoted" | "awaiting-receipt";
}

async function readPaidAnotherWayCloses(db: CashStore, paymentId: string): Promise<PaidAnotherWayCloseCash[]> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { id: true, kind: true, occurrenceKey: true, amountCents: true },
  });
  const closes: PaidAnotherWayCloseCash[] = [];
  for (const task of tasks ?? []) {
    const amountCents = Math.max(0, task.amountCents ?? 0);
    const note = paidAnotherWayCloseXeroNote(task);
    const counted =
      note === "now"
        ? "noted"
        : note !== "after-receipt"
          ? "unnoted"
          : (await paidAnotherWayCloseReceiptRecorded(task, db))
            ? "noted"
            : "awaiting-receipt";
    closes.push({ id: task.id, amountCents, counted });
  }
  return closes;
}

/**
 * The bank cash every paid-another-way close on one payment sent back, split by
 * whether its close took a refund note. One read; almost no payment has any.
 */
export async function readPaidAnotherWayCash(db: CashStore, paymentId: string): Promise<PaidAnotherWayCash> {
  const cash: PaidAnotherWayCash = { notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 };
  for (const close of await readPaidAnotherWayCloses(db, paymentId)) {
    if (close.counted === "noted") cash.notedCents += close.amountCents;
    else if (close.counted === "unnoted") cash.unnotedCents += close.amountCents;
    else cash.awaitingReceiptCents += close.amountCents;
  }
  return cash;
}

/**
 * #3924 round 8 (money review, `INV-SSOT`): THE ONE WAY TO FIND A CLOSE'S OWN
 * NOTE ROWS - the refund-note creates on its payment whose payload names its
 * record (`paidAnotherWayTaskId`), in any status. Every row the note pipeline
 * writes for the close carries it: the queued payload and the executed one. The
 * receipt's note step (`notePaidAnotherWayCloseOnReceipt`), the enqueue's
 * dedupe and the close's coverage all ask this, and nothing else.
 */
export function paidAnotherWayCloseNoteRowsWhere(paymentId: string, closeId: string) {
  return {
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    requestPayload: { path: ["paidAnotherWayTaskId"], equals: closeId },
  } satisfies Prisma.XeroSyncOperationWhereInput;
}

/**
 * #3924 round 8 (money review, `INV-PAY-122`): WHAT A CLOSE'S OWN NOTE STILL
 * HAS TO ANSWER. The close's record holds what it paid back
 * (`amountCents`); its own notes - and only those - answer it, counted as the
 * payment's coverage counts them (`sumRefundCreditNoteCoverageOfRowsCents`).
 * So a note the close raised whose refund payment failed (PARTIAL) covers its
 * amount here, as it does in the payment's coverage, and a row that raised no
 * note covers nothing. `uncoveredCents` sizes the close's note exactly: the
 * enqueue and the note's execution both ask it, never the payment-wide gap.
 * Null when the payment has no such record.
 */
export async function readPaidAnotherWayCloseShare(
  db: Pick<Prisma.TransactionClient, "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">,
  paymentId: string,
  closeId: string,
): Promise<{ amountCents: number; coveredCents: number; uncoveredCents: number } | null> {
  const record = await db.manualRefundTask.findFirst({
    where: { id: closeId, paymentId, ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE },
    select: { amountCents: true },
  });
  if (!record) return null;
  const amountCents = Math.max(0, record.amountCents ?? 0);
  const coveredCents = await sumRefundCreditNoteCoverageOfRowsCents(
    paymentId,
    paidAnotherWayCloseNoteRowsWhere(paymentId, closeId),
    db,
  );
  return { amountCents, coveredCents, uncoveredCents: Math.max(0, amountCents - coveredCents) };
}

/**
 * #3924 round 7 (money M1) and round 8 (`INV-PAY-122`): THE NOTED BANK CASH
 * THE CLOSES' OWN NOTES DO NOT YET COVER. A close counted as noted puts its
 * bank cash into what a refund note may answer, and only its own bank-transfer
 * note may answer it. The payment's gap (`readRefundCreditNoteGap`) is that
 * cash and the card cash, less all coverage; this is the closes' part of it,
 * by the same coverage (`readPaidAnotherWayCloseShare`), so a caller that sizes
 * a CARD note - the nightly self-heal, the repair tool - takes off exactly what
 * coverage does not already count for the closes, and never fills it with a
 * card note settled from the Stripe account. Each close's note is retried as
 * its own row.
 */
export async function readPaidAnotherWayUncoveredCents(db: CashStore, paymentId: string): Promise<number> {
  let uncoveredCents = 0;
  for (const close of await readPaidAnotherWayCloses(db, paymentId)) {
    if (close.counted !== "noted") continue;
    uncoveredCents += (await readPaidAnotherWayCloseShare(db, paymentId, close.id))?.uncoveredCents ?? 0;
  }
  return uncoveredCents;
}
