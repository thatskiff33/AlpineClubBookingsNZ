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

export function bookingAppliedCreditWhere(bookingId: string) {
  return { appliedToBookingId: bookingId, type: "BOOKING_APPLIED" } satisfies Prisma.MemberCreditWhereInput;
}

export function bookingIssuedCreditWhere(bookingId: string) {
  return {
    sourceBookingId: bookingId,
    type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] },
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
      { type: "BOOKING_APPLIED", appliedToBookingId: { in: [...bookingIds] } },
      { type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] }, sourceBookingId: { in: [...bookingIds] } },
    ],
  } satisfies Prisma.MemberCreditWhereInput;
}

type CreditRowLinks = { type: CreditType; appliedToBookingId: string | null; sourceBookingId: string | null };

/** The row-level form of `bookingAppliedCreditWhere`: credit applied TO `bookingId`. */
export function isCreditAppliedToBooking(credit: CreditRowLinks, bookingId: string): boolean {
  return credit.type === "BOOKING_APPLIED" && credit.appliedToBookingId === bookingId;
}

/** The row-level form of `bookingIssuedCreditWhere`: credit minted FROM `bookingId`. */
export function isCreditIssuedFromBooking(credit: CreditRowLinks, bookingId: string): boolean {
  return (BOOKING_ISSUED_CREDIT_TYPES as readonly CreditType[]).includes(credit.type) && credit.sourceBookingId === bookingId;
}

/** The one booking a row belongs to under the two questions above, or null (an `ADMIN_ADJUSTMENT`). */
export function bookingIdOfCreditRow(credit: CreditRowLinks): string | null {
  if (credit.type === "BOOKING_APPLIED") return credit.appliedToBookingId;
  return (BOOKING_ISSUED_CREDIT_TYPES as readonly CreditType[]).includes(credit.type) ? credit.sourceBookingId : null;
}
