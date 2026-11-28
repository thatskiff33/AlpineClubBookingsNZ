/**
 * B5 (#2262) guard 2, read side, for the officer's settlements in
 * `payment-reconciliation.ts` (the manual settle, the deposit settle and the
 * manual reversal). Moved here unchanged (#5008) so that module stays within its
 * size ceiling; the settlement body and its doors remain there.
 */
import type { Prisma } from "@prisma/client";

import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { XERO_ACTIVE_OPERATION_STATUSES } from "@/lib/xero-active-operation-statuses";
import { NOT_CARD_REFUND_REVERSAL_INVOICE } from "@/lib/xero-card-refund-reversal-outbox";

const MANUAL_XERO_INVOICE_REFUSAL =
  "This booking has an outstanding Xero invoice — record the payment against the invoice in Xero instead.";
const MANUAL_XERO_QUEUED_MINT_REFUSAL =
  "A Xero invoice for this booking is already queued — let it finish, then record the payment against the invoice in Xero.";

/**
 * B5 (#2262) guard 2, read side. Every piece of evidence that a Xero invoice
 * exists — or is about to — for this payment. Run under lock(1) inside the
 * settlement/reversal transaction, before any write.
 *
 * The payment-level and transaction-level conditions are ALSO re-asserted in
 * the fenced write, because an invoice can be minted between this read and that
 * write. The object-link and outbox-operation evidence are read-time refusals:
 * they cannot be expressed as a Payment WHERE, and the settle-time refusal plus
 * the choke-point and handler fences in the Xero mint path close that race from
 * the other side.
 */
export async function assertNoXeroInvoiceEvidence(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
  }
) {
  if (payment.xeroInvoiceId || payment.xeroRefundCreditNoteId) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // Transaction-stamped-but-payment-null is a MODELED drift state, not a
  // hypothesis: the zero-cash inbound arm stamps the transaction rows in writes
  // that do not also stamp the payment, and the repair classifier backfills the
  // payment-level id from exactly that transaction-level evidence. A
  // payment-level check alone is a hole.
  const stampedTransaction = await tx.paymentTransaction.findFirst({
    where: { paymentId: payment.id, xeroInvoiceId: { not: null } },
    select: { id: true },
  });
  if (stampedTransaction) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const activeInvoiceLink = await tx.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });
  if (activeInvoiceLink) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const completedMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: "SUCCEEDED",
      // A failed-card-refund reversal is not a bill the member was sent (`INV-PAY-151`).
      ...NOT_CARD_REFUND_REVERSAL_INVOICE,
    },
    select: { id: true },
  });
  if (completedMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // An invoice mint that is queued but has not fired yet. Without this the
  // common ordering — an operation enqueued minutes before the cron picks it up
  // — lets a mark-paid commit while a real awaiting-payment invoice is about to
  // be created AND EMAILED to the member for money already collected in cash.
  // The repair classifier already models this exact state as its own finding
  // (BLOCKED_BY_XERO_OPERATION), so it is a real, observed state.
  //
  // Deliberately a SUPERSET of the choke point's own predicate: WAITING_PAYMENT
  // is included alongside PENDING/RUNNING because such an operation is
  // unambiguously a mint that has not happened yet and will fire later.
  const inFlightMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: { in: [...XERO_ACTIVE_OPERATION_STATUSES] },
      ...NOT_CARD_REFUND_REVERSAL_INVOICE,
    },
    select: { id: true },
  });
  if (inFlightMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_QUEUED_MINT_REFUSAL, 409);
  }
}
