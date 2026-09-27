/**
 * WHAT COUNTS AS CAPTURED, AND WHAT COUNTS AS A RECORDED REFUND — one home
 * (#3581, `INV-SSOT`).
 *
 * Two readers must agree on these to the transaction: `reconcilePaymentAggregates`,
 * which derives the `Payment` mirror columns from the rows, and the booking
 * ledger's settlement sync, which posts one line per captured transaction and
 * per recorded refund. C4's census (#3583) checks the capture side
 * (`Payment.amountCents == Σ capture lines` whenever anything is captured); if
 * the two used different predicates that identity would disagree on every
 * booking with a payment, and nobody could tell a posting bug from a census
 * bug. The refund side is NOT an identity: the mirror's `refundedAmountCents`
 * only rises and is moved by writers with no refund row (review of #3604), so
 * C4 classifies that difference rather than asserting it away.
 *
 * A leaf with no imports of its own beyond the enum, so both can depend on it
 * without `payment-transactions.ts` and the ledger sync importing each other.
 */
import { PaymentStatus } from "@prisma/client";

/**
 * Money was taken. A refunded transaction stays captured — its capture
 * happened; the refund is a separate fact with its own line.
 */
/**
 * The `PaymentTransaction.status` values whose money was captured. Prisma
 * readers use this list; in-memory readers use the predicate below.
 */
export const CAPTURED_TRANSACTION_STATUS_LIST = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
] as const satisfies readonly PaymentStatus[];

const CAPTURED_TRANSACTION_STATUSES = new Set<PaymentStatus>(
  CAPTURED_TRANSACTION_STATUS_LIST
);

/** Captured rows that still hold cash after refunds. */
export const CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
] as const satisfies readonly PaymentStatus[];

/**
 * #3170 exported this. "Has this transaction's money actually been taken?" had
 * three inline spellings and a fourth was about to be written in
 * `edit-financial-review-charge.ts`. `INV-SSOT`: one definition, imported.
 */
export function isCapturedTransactionStatus(status: PaymentStatus): boolean {
  return CAPTURED_TRANSACTION_STATUSES.has(status);
}

/** Stripe refund states that returned no money and are not counted. */
export const EXCLUDED_LEDGER_REFUND_STATUSES = ["failed", "canceled"];

/**
 * A `PaymentRefund` row counted as money back to the member.
 *
 * One home for three readers that must agree: the per-transaction refund sum
 * behind the `Payment` mirror, the Stripe cash-refund evidence the Xero refund
 * notes are built from (#2902), and the booking ledger's refund lines (#3581).
 * The evidence module used to carry its own copy, "deliberately the same".
 *
 * OWNER DECISION, 21 Aug 2026 (#2902): a refund Stripe has accepted but not
 * yet settled COUNTS. An earlier draft counted only `succeeded`, which would
 * have under-stated cash in an accounting document whenever a report ran
 * mid-settlement; understating cash was judged the more damaging mistake, and
 * a refund Stripe has accepted almost always settles. The rare overstatement,
 * if one later fails, is corrected by the next run — and on the ledger, by a
 * reversal line.
 */
export function isRecordedRefundStatus(status: string): boolean {
  return !EXCLUDED_LEDGER_REFUND_STATUSES.includes(status);
}
