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
import { PaymentStatus, type PaymentTransactionKind } from "@prisma/client";

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

/**
 * The newest transaction of one kind on a payment, by `createdAt` (the first
 * of a tie wins) — the row the `Payment` mirror's summary columns are derived
 * from (`reconcilePaymentAggregates`). One home, so the booking-ledger census
 * (#3583) reads "the latest PRIMARY" and "the live ask" exactly as the mirror
 * it checks was written (`INV-SSOT`).
 */
export function latestTransactionOfKind<
  T extends {
    kind: PaymentTransactionKind;
    createdAt: Date;
  },
>(transactions: readonly T[], kind: PaymentTransactionKind): T | null {
  let latest: T | null = null;

  for (const transaction of transactions) {
    if (transaction.kind !== kind) {
      continue;
    }

    if (!latest || transaction.createdAt.getTime() > latest.createdAt.getTime()) {
      latest = transaction;
    }
  }

  return latest;
}

/** Stripe refund states that returned no money and are not counted. */
export const EXCLUDED_LEDGER_REFUND_STATUSES = ["failed", "canceled"];

/**
 * A `PaymentRefund` row counted as money back to the member.
 *
 * One home for the readers that must agree: the per-transaction refund sum
 * behind the `Payment` mirror, which newly recorded refund the mirror ADDS
 * (#3640), the Stripe cash-refund evidence the Xero refund notes are built from
 * (#2902), and the booking ledger's refund lines (#3581).
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

/**
 * #3639: HOW MUCH OF ONE CAPTURE HAS GONE BACK, and how much Stripe still holds
 * - one home for every late-capture reader that must not refund, approve or
 * record a hand-back twice (the webhook's verdict, the treasurer's approval,
 * the #2700 hand-back and its raise).
 *
 * `refundedAmountCents` is load-bearing, not `status`:
 * `markPaymentIntentTransactionSucceeded` rewrites a refunded row's status to
 * SUCCEEDED (a browser confirm finishing after the webhook refunded) but never
 * touches the refunded total, so a status-only test reads a refunded capture as
 * untouched. A refunded status still counts, for a row whose total was never
 * written (the refund arrived before the ledger knew the capture).
 */
export function captureRefundState(row: {
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
}): { anyRefunded: boolean; heldCents: number } {
  return {
    anyRefunded:
      row.refundedAmountCents > 0 ||
      row.status === PaymentStatus.REFUNDED ||
      row.status === PaymentStatus.PARTIALLY_REFUNDED,
    heldCents:
      row.status === PaymentStatus.REFUNDED
        ? 0
        : Math.max(row.amountCents - row.refundedAmountCents, 0),
  };
}

/**
 * The least a payment's refunded total can truthfully be (#3640): what it
 * captured, or - if less - its card refunds still counted plus the account
 * credit its booking issued. One home for two readers that must agree: the
 * card-refund writer's floor on a failed refund's subtraction, and the
 * refunded-total audit's expected figure.
 */
export function expectedRefundedFloorCents(input: {
  amountCents: number;
  cardRefundCents: number;
  accountCreditCents: number;
}): number {
  return Math.min(input.amountCents, input.cardRefundCents + input.accountCreditCents);
}
