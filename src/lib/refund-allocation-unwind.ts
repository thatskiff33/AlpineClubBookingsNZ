import { prisma } from "@/lib/prisma";
import { withStoreTransaction } from "@/lib/db-transaction";
import { compareLedgerRowsNewestFirst } from "@/lib/payment-ledger-order";
import {
  compareAndSetRefundedAmount,
  ensurePaymentTransactionsBackfilled,
  lockPaymentForRefundedTotal,
  RefundAllocationRacedError,
  type PaymentStore,
} from "@/lib/payment-transactions";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";

/**
 * Raised when an unwind asks to take back more than the payment's
 * transactions record as refunded by hand, before anything is written (#4162).
 */
export class RefundUnwindExceedsAllocatedError extends Error {
  constructor() {
    super("Refund unwind exceeds what the payment's transactions record as refunded");
    this.name = "RefundUnwindExceedsAllocatedError";
  }
}

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): take a refund the club
 * recorded by hand BACK OUT of the payment's transaction detail, because Xero
 * voided the credit note that recorded it. The inverse of
 * `applyLocalRefundAllocation`: the Payment row first
 * (`lockPaymentForRefundedTotal`), then each transaction that records a refund
 * in the REVERSE of the fill's order (the fill places newest first, so this
 * takes back oldest first), each lowered through the shared compare-and-set
 * with its refund status re-derived, and never below the card refunds Stripe
 * recorded against it (its counted `PaymentRefund` rows): money that went back
 * by card is never "unwound".
 *
 * It does NOT re-derive the payment's refunded total: its one caller
 * (`bank-refund-void-follow-up.ts`) reverses the hand-back's ledger line in
 * the same transaction and then calls `reconcilePaymentAggregates` itself, so
 * the total, the detail and the line move together.
 *
 * Refuses before writing anything when the transactions do not record that
 * much (`RefundUnwindExceedsAllocatedError`), and loudly
 * (`RefundAllocationRacedError`) when a concurrent writer took what it needed.
 */
export async function unwindLocalRefundAllocation({
  paymentId,
  amountCents,
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  store?: PaymentStore;
}): Promise<void> {
  await withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const payment = await ensurePaymentTransactionsBackfilled(db, paymentId);
    if (!payment) {
      throw new Error("Payment not found");
    }
    const cardFloorCents = await cardRefundFloorByTransaction(db, paymentId);
    const unwindable = (row: { id: string; refundedAmountCents: number }) =>
      Math.max(0, row.refundedAmountCents - (cardFloorCents.get(row.id) ?? 0));
    const refundedTransactions = [...payment.transactions]
      .filter((transaction) => unwindable(transaction) > 0)
      .sort((a, b) => compareLedgerRowsNewestFirst(b, a));
    const allocatedCents = refundedTransactions.reduce((sum, transaction) => sum + unwindable(transaction), 0);
    if (amountCents > allocatedCents) {
      throw new RefundUnwindExceedsAllocatedError();
    }

    let remainingAmountCents = amountCents;
    for (const transaction of refundedTransactions) {
      if (remainingAmountCents <= 0) {
        break;
      }
      const take = remainingAmountCents;
      const floorCents = cardFloorCents.get(transaction.id) ?? 0;
      const { previousCents, nextCents } = await compareAndSetRefundedAmount(
        db,
        transaction.id,
        (row) => row.refundedAmountCents - Math.min(Math.max(row.refundedAmountCents - floorCents, 0), take),
        { writeStatus: true }
      );
      remainingAmountCents -= previousCents - nextCents;
    }
    if (remainingAmountCents > 0) {
      throw new RefundAllocationRacedError();
    }
  });
}

/**
 * #4162: what each transaction's refunded total holds by card - its counted
 * `PaymentRefund` rows - which an unwind of a hand-back never takes. Also what
 * the voided-note scan reads as the part of the detail a hand-back cannot
 * unwind (`unwindableHandBackCents`).
 */
async function cardRefundFloorByTransaction(db: PaymentStore, paymentId: string): Promise<Map<string, number>> {
  const cardFloorCents = new Map<string, number>();
  for (const refund of await db.paymentRefund.findMany({
    where: { paymentId, paymentTransactionId: { not: null } },
    select: { paymentTransactionId: true, amountCents: true, status: true },
  })) {
    if (!refund.paymentTransactionId || !isRecordedRefundStatus(refund.status)) continue;
    cardFloorCents.set(refund.paymentTransactionId, (cardFloorCents.get(refund.paymentTransactionId) ?? 0) + Math.max(0, refund.amountCents));
  }
  return cardFloorCents;
}

/**
 * #4162: how much of a payment's transaction detail an unwind could take back
 * - its refunded totals less the card refunds Stripe recorded against them.
 * Read on the caller's client, no lock taken (the writer re-reads under its
 * Payment row lock).
 */
export async function unwindableHandBackCents(db: PaymentStore, paymentId: string): Promise<number> {
  const transactions = await db.paymentTransaction.findMany({
    where: { paymentId },
    select: { id: true, refundedAmountCents: true },
  });
  const cardFloorCents = await cardRefundFloorByTransaction(db, paymentId);
  return transactions.reduce(
    (sum, row) => sum + Math.max(0, row.refundedAmountCents - (cardFloorCents.get(row.id) ?? 0)),
    0,
  );
}
