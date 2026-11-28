// #4279: a refund note becomes the payment's one canonical refund note
// (`Payment.xeroRefundCreditNoteId`) only inside the transaction that records
// it, after that transaction's claim wins and under the Payment row: the
// create's record (`recordCreatedRefundNote`) and a refund-note repair's
// completion (`completeXeroSyncOperation` carrying `canonicalRefundNote`, in
// the Payment-first transaction `completeUnderPaymentRows`).
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
