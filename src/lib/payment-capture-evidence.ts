// Capture evidence over a payment whose ledger rows are already loaded
// (#1473/#1491), in its own module since #5404: the bank-transfer hold job, the
// orphaned-credit detector and the Xero applied-credit ledger state all ask it.
import type { PaymentSource, PaymentStatus } from "@prisma/client";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { paymentShowsCaptureEvidence } from "@/lib/booking-payment-state";

/**
 * What the predicate reads of a payment: the fields
 * `paymentShowsCaptureEvidence` needs, its ledger rows' statuses, and whose
 * booking it is. Callers select this shape so the predicate type-checks.
 */
export interface CaptureEvidencePayment {
  id: string;
  bookingId: string;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
  transactions: Array<{ status: PaymentStatus }>;
  /** #3949: whose payment it is - an Internet Banking organiser child's settle mirror is its capture. */
  booking: { organiserSettled: boolean; parentBookingId: string | null };
}

/**
 * The same capture evidence booking-cancel.ts `queryPaymentCaptureEvidence`
 * (#1473/#1491) asks: ledger truth first — any PaymentTransaction row holding a
 * captured status — else the STRIPE-only refund mirror for pre-ledger rows, so
 * a never-captured IB payment whose mirror the inbound reconcile folded stays
 * FAILED after cancel. The ledger half is `isCapturedTransactionStatus` and the
 * combination is `paymentShowsCaptureEvidence` (#3630, #3372); this one reads
 * the ledger rows already loaded rather than querying for them, and answers
 * synchronously. The two were both named `paymentHasCaptureEvidence` until
 * #5407: an auto-import of the asynchronous one into an `if` tests a Promise,
 * which is always truthy.
 */
export function paymentHasCaptureEvidence(
  payment: CaptureEvidencePayment
): boolean {
  const hasCapturedLedgerRow = payment.transactions.some((transaction) =>
    isCapturedTransactionStatus(transaction.status)
  );
  return paymentShowsCaptureEvidence(payment, hasCapturedLedgerRow, payment.booking);
}
