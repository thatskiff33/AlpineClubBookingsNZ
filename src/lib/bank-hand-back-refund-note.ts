import { PaymentSource, type Prisma } from "@prisma/client";

import { asRecord, readString } from "@/lib/xero-json";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { paymentCreditNoteOperationWhere } from "@/lib/xero-refund-note-in-flight";
import { findCanonicalPaymentRefundCreditNote } from "@/lib/xero-sync";

/**
 * #4287 (owner decision 22 Oct 2026, `INV-ADDPAY-043`): DOES A CANCELLATION
 * HAND-BACK'S XERO NOTE STAND ON ITS OWN RECORD?
 *
 * A bank-transfer (`INTERNET_BANKING`) payment keeps one canonical refund note,
 * for its first refund. Before #4287 every later hand-back completed on it was
 * taken as a replay of that note and raised nothing ("already linked"), so Xero
 * showed less credit than the club paid back. Now a hand-back's note is keyed
 * and sized on its own task - the per-record route a "Paid another way" close,
 * a card refund shortfall and a re-confirmed bank refund already take
 * (`paidAnotherWayTaskId`, `readPaidAnotherWayCloseShare`) - whenever the
 * payment-wide figure cannot answer it:
 *
 * - the payment already has its canonical refund note, linked
 *   (`findCanonicalPaymentRefundCreditNote`) or ON ITS WAY: a canonical create
 *   row still PENDING, RUNNING or FAILED, or one whose payload cannot be read.
 *   Without it two hand-backs of the same amount completed close together would
 *   both take the canonical route under the same key (`...:<amount>:v1`), and
 *   the second's enqueue would dedupe into the first's row: one note for two
 *   refunds. The completion holds the Payment row lock
 *   (`applyLocalRefundAllocation`, #4217) before this read, so a second
 *   completion reads after the first commits its row;
 * - or the payment has any STRIPE transaction row, in any status, or a card
 *   refund row.
 *   A canonical note is sized when it runs, against the payment's refund-note
 *   cash (`resolveStripeCashRefundEvidence`); once a card refund is recorded
 *   that cash is the card refunds alone, which leave the hand-back out. Asked
 *   of the charge, not the refund, so a card refund landing between this
 *   completion and its note's run cannot shrink the note. A wrong "own" is
 *   harmless; a wrong "canonical" would absorb.
 *
 * Otherwise - and on any payment that is not a bank transfer, whose note this
 * rule leaves exactly as before - the hand-back's note IS the canonical one.
 * Only a completion asks, at the moment it records the refund: nothing re-asks
 * for a hand-back already completed, so no refund made before #4287 is ever
 * given a note of its own (owner, 22 Oct 2026). A read only - no lock, no write.
 */
export async function cancellationHandBackNotedOnItsOwnRecord(
  store: Prisma.TransactionClient,
  paymentId: string,
  handBackTaskId: string,
): Promise<boolean> {
  const payment = await store.payment.findUnique({ where: { id: paymentId }, select: { source: true } });
  if (payment?.source !== PaymentSource.INTERNET_BANKING) return false;
  if (await findCanonicalPaymentRefundCreditNote(paymentId, store)) return true;
  if ((await store.paymentTransaction.count({ where: { paymentId, source: PaymentSource.STRIPE } })) > 0) return true;
  if ((await store.paymentRefund.count({ where: { paymentId } })) > 0) return true;
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      ...paymentCreditNoteOperationWhere(paymentId),
      operationType: "CREATE",
      status: { in: ["PENDING", "RUNNING", "FAILED"] },
      OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
    },
    select: { requestPayload: true },
  });
  return (rows ?? []).some((row) => isCanonicalRefundNoteRowOfAnother(row.requestPayload, handBackTaskId));
}

/**
 * A refund-note create row that may raise the payment's canonical note: one
 * whose payload cannot be read (taken as on its way - wrongly "own" is
 * harmless), or a refund note that names no record of its own (a review, a
 * close or other per-record task, a refund request) and is not stamped per
 * refund - and is not this hand-back's own. Only a readable account-credit note
 * is no canonical refund note.
 */
function isCanonicalRefundNoteRowOfAnother(requestPayload: unknown, handBackTaskId: string): boolean {
  const recorded = parsePaymentCreditNoteRetryInput({ requestPayload });
  if (!recorded) return true;
  if (recorded.kind !== "refund") return false;
  const payload = asRecord(requestPayload);
  if (recorded.refundRequestId || recorded.paidAnotherWayTaskId || readString(payload?.reviewTaskId) || payload?.perDelta === true) {
    return false;
  }
  return recorded.handBackTaskId !== handBackTaskId;
}
