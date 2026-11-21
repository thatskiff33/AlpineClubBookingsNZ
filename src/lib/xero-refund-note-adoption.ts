// #4279: a refund note becomes the payment's one canonical refund note
// (`Payment.xeroRefundCreditNoteId`) only inside the transaction that records
// it, after that transaction's claim wins and under the Payment row: the
// create's record (`recordCreatedRefundNote`) and a refund-note repair's
// completion (`completeXeroSyncOperation` carrying `canonicalRefundNote`).
// The eligibility rule itself stays in `xero-refund-note-status.ts`.
import type { Prisma } from "@prisma/client";
import { mayRecordAsCanonicalRefundNote } from "@/lib/xero-refund-note-status";

/**
 * #4279: a completion's request that its note become the payment's one
 * canonical refund note (`Payment.xeroRefundCreditNoteId`), carried on the
 * completion (`XeroSyncOperationCompletion.canonicalRefundNote`) so the write
 * commits with the claim it depends on, or not at all.
 */
export interface CanonicalRefundNoteAdoption {
  paymentId: string;
  creditNoteId: string;
}

/**
 * #4279: write the note into the payment's pointer when it may be the
 * canonical note (`mayRecordAsCanonicalRefundNote`, asked on the caller's
 * transaction). The caller holds the Payment row, so a void naming the note
 * has committed before the check or waits until after this commit, where its
 * own pointer release runs. Answers whether it wrote. Shared by the create's
 * record and a repair's completion: the one pointer-adoption rule.
 */
export async function adoptCanonicalRefundNote(
  adoption: CanonicalRefundNoteAdoption,
  db: Prisma.TransactionClient,
): Promise<boolean> {
  if (!(await mayRecordAsCanonicalRefundNote(adoption.paymentId, adoption.creditNoteId, db))) return false;
  await db.payment.update({ where: { id: adoption.paymentId }, data: { xeroRefundCreditNoteId: adoption.creditNoteId } });
  return true;
}

type InteractiveTransactionRunner = {
  $transaction<R>(run: (tx: Prisma.TransactionClient) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
};

/**
 * #4279 (`INV-LOCK-002`, `INV-INT-029`): the transaction a completion carrying
 * a pointer adoption runs in - the create's record order. The Payment row
 * first (`lockPaymentForRefundedTotal`, with the Payment-row wait budget), then
 * `complete`: the guarded claim, the adoption only after the claim wins, then
 * the links. Nothing waits on the Payment row while holding the operation row.
 *
 * Only a retry's own claim may carry it: a refused retry claim writes nothing
 * at all, so a lost claim publishes no pointer and no link. An injected store
 * is refused, since this transaction must take the Payment row before its
 * claim and a caller's transaction may already hold other rows.
 */
export async function completeAdoptingCanonicalRefundNote<T>(
  db: InteractiveTransactionRunner,
  adoption: CanonicalRefundNoteAdoption,
  options: { store?: Prisma.TransactionClient; retryClaim?: true } | undefined,
  complete: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (options?.store || !options?.retryClaim) {
    throw new Error(
      `Refund credit note ${adoption.creditNoteId} may become payment ${adoption.paymentId}'s refund note only in a retry claim's own completion transaction (#4279).`,
    );
  }
  // Loaded when needed, as the link funnel loads it, so coverage readers cannot initialise through a cycle.
  const { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } = await import("@/lib/payment-transactions");
  return db.$transaction(async (tx) => {
    await lockPaymentForRefundedTotal(tx, adoption.paymentId);
    return complete(tx);
  }, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
}
