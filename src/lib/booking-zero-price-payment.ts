import { PaymentStatus, type Prisma } from "@prisma/client";

/**
 * The Payment row a booking created already worth $0 is confirmed with
 * (#4660): nothing charged, so $0 SUCCEEDED, with any member credit the create
 * applied mirrored on the row. `createConfirmedBooking` (`booking-create.ts`)
 * and the paid-booking import's free stay (`booking-import/write.ts`, #5005)
 * both write it here, so a new provenance column, a PaymentTransaction row or
 * a change to the credit mirror reaches both at once (#5167 review, INV-SSOT).
 *
 * Each caller then writes PAID with its own status write (the create stamps a
 * confirmed capacity override on it; the import guards it on PAYMENT_PENDING)
 * and calls `postStoredBookingConfirmationLedgerLines` in the same function,
 * which the sale-status census requires. The order is fixed by
 * `zero-price-payment-call-sites.test.ts`: this row, then PAID, then the lines.
 *
 * It creates, never upserts: the booking was created in the same transaction,
 * so it has no Payment row yet. A pending-guest confirm of an older booking
 * uses `writeZeroWorthConfirmPayment` instead.
 */
export async function createZeroPriceConfirmationPayment(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; creditAppliedCents: number },
): Promise<void> {
  await tx.payment.create({
    data: {
      bookingId: input.bookingId,
      amountCents: 0,
      creditAppliedCents: input.creditAppliedCents,
      status: PaymentStatus.SUCCEEDED,
    },
  });
}
