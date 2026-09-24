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
import type { Prisma } from "@prisma/client";

export function bookingAppliedCreditWhere(bookingId: string) {
  return { appliedToBookingId: bookingId, type: "BOOKING_APPLIED" } satisfies Prisma.MemberCreditWhereInput;
}

export function bookingIssuedCreditWhere(bookingId: string) {
  return {
    sourceBookingId: bookingId,
    type: { in: ["CANCELLATION_REFUND", "BOOKING_MODIFICATION_REFUND"] },
  } satisfies Prisma.MemberCreditWhereInput;
}
