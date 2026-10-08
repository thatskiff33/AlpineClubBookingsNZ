/**
 * WHICH `MemberCredit` ROWS BELONG TO A BOOKING — the one home (#3599,
 * `INV-SSOT`).
 *
 * Two questions, asked by the credit ledger itself and by the booking ledger's
 * credit sync, which must agree row for row: Σ `CREDIT_APPLIED` lines equals
 * `deriveBookingAppliedCreditCents` only while both read the same rows.
 *
 * - Credit applied TO the booking: `BOOKING_APPLIED` rows naming it in
 *   `appliedToBookingId` — negative when credit was consumed, positive for a
 *   clamp's give-back or a Xero allocation repair's offset.
 * - Credit minted FROM the booking: `CANCELLATION_REFUND` and
 *   `BOOKING_MODIFICATION_REFUND` rows naming it in `sourceBookingId`,
 *   including a cancellation's restore of applied credit.
 *
 * `ADMIN_ADJUSTMENT` names no booking and belongs to neither.
 *
 * A leaf: it imports only Prisma's types and the pure credit policy, so both
 * `member-credit.ts` and the ledger modules it calls can import it without a
 * cycle.
 */
import type { CreditType, Prisma } from "@prisma/client";

import { calculateRestoredCreditAmount } from "@/lib/policies/member-credit";

/**
 * The credit types minted FROM a booking - the one list (#3640, `INV-SSOT`).
 * `bookingIssuedCreditWhere` below, the cash-refund evidence's account-credit
 * dispositions and the credit reconciliation's Xero count all read it, so a new
 * booking-issued type is one edit.
 */
export const BOOKING_ISSUED_CREDIT_TYPES = [
  "CANCELLATION_REFUND",
  "BOOKING_MODIFICATION_REFUND",
] as const satisfies readonly CreditType[];

/** The credit type of a row applying credit TO a booking - the one spelling. */
const BOOKING_APPLIED_CREDIT_TYPE = "BOOKING_APPLIED" satisfies CreditType;

export function bookingAppliedCreditWhere(bookingId: string) {
  return { appliedToBookingId: bookingId, type: BOOKING_APPLIED_CREDIT_TYPE } satisfies Prisma.MemberCreditWhereInput;
}

export function bookingIssuedCreditWhere(bookingId: string) {
  return {
    sourceBookingId: bookingId,
    type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] },
  } satisfies Prisma.MemberCreditWhereInput;
}

/**
 * The description every cancellation's restore row is written with
 * (`restoreCreditFromBooking` in `member-credit.ts`, followed by the booking id's
 * first eight characters) - the one spelling, which the writer and every reader
 * of a pre-marker row share.
 */
export const RESTORED_CREDIT_PREFIX = "Credit restored from cancelled booking";

const CANCELLATION_REFUND_CREDIT_TYPE = "CANCELLATION_REFUND" satisfies CreditType;

/** The `MemberCredit` fields `isCancellationCreditRestoreRow` reads. */
export type CreditRestoreEvidence = {
  type: CreditType | string;
  description?: string | null;
  restoredFromBookingId: string | null;
};

/**
 * IS THIS ROW A CANCELLATION'S RESTORE OF APPLIED CREDIT? - the one test
 * (`INV-SSOT`; review of PR #3811, 3 Oct 2026).
 *
 * A restore gives back credit the member already spent on the booking; every
 * other `CANCELLATION_REFUND` converts money the booking held into credit. Since
 * 8 Jul 2026 (#1636) the restore row carries `restoredFromBookingId`, and that
 * marker decides. A restore written before then carries none and was never
 * backfilled, so it is recognised by what its writer has always written: type
 * `CANCELLATION_REFUND` and a description starting `RESTORED_CREDIT_PREFIX`.
 * Without the second half, a booking cancelled before 8 Jul reads its restored
 * credit as credit the club kept.
 *
 * Readers: `cancelledBookingKeptCreditCents` below, the booking ledger's credit
 * line shape (`booking-ledger-credit-posting.ts`), the cancellation settlement
 * breakdown (`payment-status-display.ts`), and - as a query, through
 * `cancellationCreditRestoreWhere` below - an edit review's netting of a share
 * against the restore (`edit-financial-review-account-credit.ts`).
 *
 * One reader still asks the marker alone, deliberately:
 * `ACCOUNT_CREDIT_DISPOSITION_WHERE` (`stripe-cash-refund-evidence.ts`) - see
 * the stated limit there for why moving it would move money.
 */
export function isCancellationCreditRestoreRow(row: CreditRestoreEvidence): boolean {
  // Present-or-absent, not `!== null`: a row read without the column selected
  // carries undefined, which is no marker.
  if (row.restoredFromBookingId) return true;
  return (
    row.type === CANCELLATION_REFUND_CREDIT_TYPE &&
    (row.description ?? "").startsWith(RESTORED_CREDIT_PREFIX)
  );
}

/**
 * `isCancellationCreditRestoreRow` as a query, for ONE booking's restore rows:
 * the marker naming the booking, or - for a restore written before the marker
 * existed - type `CANCELLATION_REFUND`, the booking as source and the restore
 * description. Built from the same constants, so the two cannot drift.
 */
export function cancellationCreditRestoreWhere(bookingId: string) {
  return {
    OR: [
      { restoredFromBookingId: bookingId },
      {
        sourceBookingId: bookingId,
        type: CANCELLATION_REFUND_CREDIT_TYPE,
        description: { startsWith: RESTORED_CREDIT_PREFIX },
      },
    ],
  } satisfies Prisma.MemberCreditWhereInput;
}

/**
 * Both questions for a page of bookings at once — what the booking-ledger
 * census reads (#3583) — so a row is fetched by whichever of its two links
 * names a booking on the page.
 */
export function bookingsCreditRowsWhere(bookingIds: readonly string[]) {
  return {
    OR: [
      { type: BOOKING_APPLIED_CREDIT_TYPE, appliedToBookingId: { in: [...bookingIds] } },
      { type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] }, sourceBookingId: { in: [...bookingIds] } },
    ],
  } satisfies Prisma.MemberCreditWhereInput;
}

/** The `MemberCredit` fields `cancelledBookingKeptCreditCents` reads. */
export type BookingCreditAmountRow = {
  type: CreditType | string;
  amountCents: number;
};

/**
 * Owner decision on #3372 (3 Oct 2026, refining the review on PR #3811): HOW
 * MUCH OF THE ACCOUNT CREDIT APPLIED TO A CANCELLED BOOKING THE CLUB KEPT.
 *
 * Applied is the SIGNED net of the booking's `BOOKING_APPLIED` rows, computed
 * by `calculateRestoredCreditAmount` - the net `restoreCreditFromBooking`
 * restores from - so a clamp's positive give-back is netted, not double
 * counted; so is a financial review's give-back (#3791, `INV-PAY-113`), which
 * also names the booking in `sourceBookingId` and so may sit in
 * `creditsFromCancellation` too, where it is no restore and is not read again.
 * Restored is the cancellation's restore row, told apart by
 * `isCancellationCreditRestoreRow`, the same test the booking ledger uses, so a
 * restore written before the marker existed (8 Jul 2026, #1636) is still a
 * restore. The paid slice refunded AS credit is not a restore, and that money
 * is already on the payment's `refundedAmountCents`, so it is not read here.
 * What is left is the credit half of what the cancellation kept - applied less
 * restored - never below zero.
 *
 * Pure, and it does not ask whether the booking is cancelled: the caller does
 * (`getNetCollectedPaymentParts`), because a live booking's applied credit is
 * not money kept.
 */
export function cancelledBookingKeptCreditCents(booking: {
  /** Rows naming the booking in `appliedToBookingId` (`creditsApplied`). */
  creditsApplied: ReadonlyArray<BookingCreditAmountRow>;
  /** Rows naming the booking in `sourceBookingId` (`creditsFromCancellation`). */
  creditsFromCancellation: ReadonlyArray<BookingCreditAmountRow & CreditRestoreEvidence>;
}): number {
  const appliedCents = calculateRestoredCreditAmount(
    booking.creditsApplied.filter((row) => row.type === BOOKING_APPLIED_CREDIT_TYPE),
  );
  const restoredCents = booking.creditsFromCancellation
    .filter(isCancellationCreditRestoreRow)
    .reduce((sum, row) => sum + row.amountCents, 0);
  return Math.max(0, appliedCents - restoredCents);

}

type CreditRowLinks = { type: CreditType; appliedToBookingId: string | null; sourceBookingId: string | null };

/** The row-level form of `bookingAppliedCreditWhere`: credit applied TO `bookingId`. */
export function isCreditAppliedToBooking(credit: CreditRowLinks, bookingId: string): boolean {
  return credit.type === BOOKING_APPLIED_CREDIT_TYPE && credit.appliedToBookingId === bookingId;
}

/** The row-level form of `bookingIssuedCreditWhere`: credit minted FROM `bookingId`. */
export function isCreditIssuedFromBooking(credit: CreditRowLinks, bookingId: string): boolean {
  return (BOOKING_ISSUED_CREDIT_TYPES as readonly CreditType[]).includes(credit.type) && credit.sourceBookingId === bookingId;
}

/** The one booking a row belongs to under the two questions above, or null (an `ADMIN_ADJUSTMENT`). */
export function bookingIdOfCreditRow(credit: CreditRowLinks): string | null {
  if (credit.type === BOOKING_APPLIED_CREDIT_TYPE) return credit.appliedToBookingId;
  return (BOOKING_ISSUED_CREDIT_TYPES as readonly CreditType[]).includes(credit.type) ? credit.sourceBookingId : null;
}
