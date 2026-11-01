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
 * A leaf with no imports of its own beyond the enum and the ledger's order
 * (`payment-ledger-order.ts`, itself a leaf), so both can depend on it without
 * `payment-transactions.ts` and the ledger sync importing each other.
 */
import { PaymentStatus, type PaymentTransactionKind } from "@prisma/client";

import { compareLedgerRowsOldestFirst, type LedgerOrderedRow } from "@/lib/payment-ledger-order";

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

/**
 * The `PaymentTransaction.status` values of an intent that is still OPEN - not
 * captured, not failed: it can still be confirmed, so it is what a supersede or
 * a retirement cancels (#4316 review round 3, one list).
 */
export const OPEN_INTENT_TRANSACTION_STATUS_LIST = [
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
] as const satisfies readonly PaymentStatus[];

/** Is this transaction's intent still open (`OPEN_INTENT_TRANSACTION_STATUS_LIST`)? */
export function isOpenIntentTransactionStatus(status: string): boolean {
  return (OPEN_INTENT_TRANSACTION_STATUS_LIST as readonly string[]).includes(status);
}

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
 * #3979 (`INV-SSOT`): what a payment has captured, gross of refunds - the sum of
 * its captured rows. The `Payment.amountCents` projection
 * (`reconcilePaymentAggregates`) and the Internet Banking settle that writes
 * the same figure (`settle-from-cash.ts`) both read it here.
 */
export function grossCapturedCents(
  rows: ReadonlyArray<{ status: PaymentStatus; amountCents: number }>,
): number {
  return rows.reduce((sum, row) => sum + (isCapturedTransactionStatus(row.status) ? row.amountCents : 0), 0);
}

/**
 * The `Payment.status` its rows project: refunded, part refunded or settled
 * once anything is captured, else the latest PRIMARY row's status (or the
 * fallback). One home for `reconcilePaymentAggregates` and the Internet
 * Banking settle (#3979), which writes the same columns itself.
 */
export function deriveAggregatePaymentStatus(
  fallbackStatus: PaymentStatus,
  grossCapturedAmountCents: number,
  refundedAmountCents: number,
  latestPrimaryStatus: PaymentStatus | null
): PaymentStatus {
  if (grossCapturedAmountCents > 0) {
    if (refundedAmountCents >= grossCapturedAmountCents) {
      return PaymentStatus.REFUNDED;
    }

    if (refundedAmountCents > 0) {
      return PaymentStatus.PARTIALLY_REFUNDED;
    }

    return PaymentStatus.SUCCEEDED;
  }

  return latestPrimaryStatus ?? fallbackStatus;
}

/**
 * The newest transaction of one kind on a payment: the latest `createdAt`, and
 * on a tie the row inserted LAST, the highest `insertionSeq` (#4132,
 * `INV-PAY-133`, owner decision 15 Oct 2026). The row the `Payment` mirror's
 * summary columns are derived from (`reconcilePaymentAggregates`). One home,
 * so the booking-ledger census (#3583) reads "the latest PRIMARY" and "the
 * live ask" exactly as the mirror it checks was written (`INV-SSOT`), and the
 * answer never depends on the order the rows were read in.
 *
 * Before #4132 a tie went to the first row of the input, which over the
 * oldest-first ledger read was the EARLIEST of the tie, while the ask chain
 * (`readUnpaidPriceAsk`) took its last row as the live ask.
 */
export function latestTransactionOfKind<
  T extends {
    kind: PaymentTransactionKind;
  } & LedgerOrderedRow,
>(transactions: readonly T[], kind: PaymentTransactionKind): T | null {
  let latest: T | null = null;

  for (const transaction of transactions) {
    if (transaction.kind !== kind) {
      continue;
    }

    if (!latest || compareLedgerRowsOldestFirst(transaction, latest) > 0) {
      latest = transaction;
    }
  }

  return latest;
}

/**
 * The `reason` the mirror's backfill stamps on the transaction rows it seeds
 * for a legacy payment from that payment's columns (`payment-transactions.ts`).
 * Such a row's `refundedAmountCents` is copied from the column, with no
 * `PaymentRefund` row behind it. One home for the writer and the census that
 * names that seeded figure (#3583).
 */
export const LEGACY_PRIMARY_BACKFILL_REASON = "legacy_primary_backfill";
export const LEGACY_ADDITIONAL_BACKFILL_REASON = "legacy_additional_backfill";
export const LEGACY_BACKFILL_REASONS: readonly string[] = [LEGACY_PRIMARY_BACKFILL_REASON, LEGACY_ADDITIONAL_BACKFILL_REASON];

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
 * #4083: Stripe answered the refund but refused it (`failed`, `canceled`), so
 * no money went back and it is still owed. A refund with no status counts as
 * made (#4070), as the ledger counts it.
 */
export function isRefusedRefundStatus(status: string | null | undefined): boolean {
  return !isRecordedRefundStatus(status ?? "unknown");
}

/** #4103: what Stripe's answers refused, in cents - the one sum the late-capture hold and the repair pass read. */
export function refusedRefundAnswerCents(refunds: ReadonlyArray<{ status?: string | null; amountCents: number }>): number {
  return refunds.filter((refund) => isRefusedRefundStatus(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
}

/**
 * #4070, #4084: a refund to the member's own card, sent after commit by
 * `refundPaymentTransactions`, is made when that call returned (every slice
 * refunded at Stripe and recorded) with at least one refund, and Stripe
 * answered each with a status counted as money back (`isRecordedRefundStatus`:
 * `pending` and `succeeded` count, `failed` and `canceled` do not; no status
 * counts, as the organiser executor reads it). Judged by the refunds that
 * exist, never assumed. A call that threw made nothing here. ONE rule for the
 * "Booking Modified" (`executeBookingModificationRefund`) and "Booking
 * Cancelled" (`booking-cancel.ts`) emails and the cancel's confirmation.
 */
export function ownCardRefundMade(refunds: ReadonlyArray<{ status: string | null }>): boolean {
  return refunds.length > 0 && !refunds.some((refund) => isRefusedRefundStatus(refund.status));
}

/**
 * #3639: HOW MUCH OF ONE CAPTURE HAS GONE BACK TO THE MEMBER, in any form, and
 * how much the club may still hand back from it - one home for every
 * late-capture reader that must not refund, approve or record a hand-back twice
 * (the webhook's verdict, the treasurer's approval, the #2700 hand-back and its
 * raise).
 *
 * It measures LEDGER headroom, not what Stripe still holds: `refundedAmountCents`
 * also counts a refund made as account credit or by hand
 * (`applyLocalRefundAllocation`), which leaves the money on the card. Every
 * reader uses it as a cap or a refusal on handing more back, where money
 * already returned another way must count, or the member is paid twice; so a
 * credit-filled row makes them hand back less, never more. A reader that must
 * say what the CARD still holds subtracts the card refunds recorded against it
 * instead (`sumRecordedRefundsForCapture`, #4285 review).
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
 * credit its booking issued plus (#4280) the bank cash its "Paid another way"
 * closes recorded (`readPaidAnotherWayCloseBankCashByPayment`). One home for
 * two readers that must agree: the card-refund writer's floor on a failed
 * refund's subtraction, and the refunded-total audit's expected figure.
 */
export function expectedRefundedFloorCents(input: {
  amountCents: number;
  cardRefundCents: number;
  accountCreditCents: number;
  paidAnotherWayCents: number;
}): number {
  return Math.min(input.amountCents, input.cardRefundCents + input.accountCreditCents + input.paidAnotherWayCents);
}

/**
 * #3640, #4154: whether a card refund made at `createdSeconds` predates the
 * install's refund ledger. A null start (no migration history) predates
 * nothing. An undated refund is the caller's to read: the refund sync takes it
 * as made since (`since-ledger`, the safe direction for adding it), #4154's
 * correction as made before (`pre-ledger`, the safe direction for lowering).
 */
export function predatesRefundLedger(
  createdSeconds: number | null | undefined,
  ledgerStartSeconds: number | null,
  undated: "pre-ledger" | "since-ledger",
): boolean {
  if (typeof createdSeconds !== "number") return undated === "pre-ledger";
  return ledgerStartSeconds !== null && createdSeconds < ledgerStartSeconds;
}

/** The card-refund shortfall refusal, shared by the inline planner and the edit door (#3984). */
export const STRIPE_REFUND_EXCEEDS_CAPTURED_MESSAGE = "Refund amount exceeds captured Stripe payments";
