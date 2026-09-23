/**
 * WHAT COUNTS AS CAPTURED, AND WHAT COUNTS AS A RECORDED REFUND — one home
 * (#3581, `INV-SSOT`).
 *
 * Two readers must agree on these to the transaction: `reconcilePaymentAggregates`,
 * which derives the `Payment` mirror columns from the rows, and the booking
 * ledger's settlement sync, which posts one line per captured transaction and
 * per recorded refund. C4's census (#3583) checks
 * `Payment.amountCents == Σ capture lines`; if the two ever used different
 * predicates, that identity would disagree on every booking with a payment and
 * nobody could tell a posting bug from a census bug.
 *
 * A leaf with no imports of its own beyond the enum, so both can depend on it
 * without `payment-transactions.ts` and the ledger sync importing each other.
 */
import { PaymentStatus } from "@prisma/client";

/**
 * Money was taken. A refunded transaction stays captured — its capture
 * happened; the refund is a separate fact with its own line.
 */
const CAPTURED_TRANSACTION_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

export function isCapturedTransactionStatus(status: PaymentStatus): boolean {
  return CAPTURED_TRANSACTION_STATUSES.has(status);
}

/** Stripe refund states that returned no money and are not counted. */
export const EXCLUDED_LEDGER_REFUND_STATUSES = ["failed", "canceled"];

/** A `PaymentRefund` row whose money actually went back to the member. */
export function isRecordedRefundStatus(status: string): boolean {
  return !EXCLUDED_LEDGER_REFUND_STATUSES.includes(status);
}
