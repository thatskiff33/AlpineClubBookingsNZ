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
 * A leaf: it imports only Prisma's types, so both `member-credit.ts` and the
 * ledger modules it calls can import it without a cycle.
 */
import type { CreditType, Prisma } from "@prisma/client";

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

/** The `MemberCredit` fields `cancelledBookingKeptCreditCents` reads. */
export type BookingCreditAmountRow = {
  type: CreditType | string;
  amountCents: number;
};

/**
 * Owner decision on #3372 (3 Oct 2026, refining the review on PR #3811): HOW
 * MUCH OF THE ACCOUNT CREDIT APPLIED TO A CANCELLED BOOKING THE CLUB KEPT.
 *
 * Applied is the SIGNED net of the booking's `BOOKING_APPLIED` rows - the same
 * net `deriveBookingAppliedCreditCents` and `restoreCreditFromBooking` read,
 * so a clamp's positive give-back is netted, not double counted. Restored is
 * the cancellation's restore row, told apart by `restoredFromBookingId` exactly
 * as the booking ledger tells it apart (`booking-ledger-credit-posting.ts`):
 * the paid slice refunded AS credit has no such marker, and that money is
 * already on the payment's `refundedAmountCents`, so it is not read here. What
 * is left is `cancellationKeptCents`' credit half - applied less restored -
 * never below zero.
 *
 * KNOWN LIMIT, shared with the booking ledger: a restore row written before
 * the marker existed (8 Jul 2026, #1636, no backfill) carries none, so on a
 * booking cancelled before then the restored credit reads as kept.
 *
 * Pure, and it does not ask whether the booking is cancelled: the caller does
 * (`getNetCollectedPaymentCents`), because a live booking's applied credit is
 * not money kept.
 */
export function cancelledBookingKeptCreditCents(booking: {
  /** Rows naming the booking in `appliedToBookingId` (`creditsApplied`). */
  creditsApplied: ReadonlyArray<BookingCreditAmountRow>;
  /** Rows naming the booking in `sourceBookingId` (`creditsFromCancellation`). */
  creditsFromCancellation: ReadonlyArray<
    BookingCreditAmountRow & { restoredFromBookingId: string | null }
  >;
}): number {
  const appliedCents = Math.max(
    0,
    -booking.creditsApplied
      .filter((row) => row.type === BOOKING_APPLIED_CREDIT_TYPE)
      .reduce((sum, row) => sum + row.amountCents, 0),
  );
  const restoredCents = booking.creditsFromCancellation
    .filter((row) => row.restoredFromBookingId !== null)
    .reduce((sum, row) => sum + row.amountCents, 0);
  return Math.max(0, appliedCents - restoredCents);
}
