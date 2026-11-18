import { bookingWorthCents, type BookingAmountOwed } from "@/lib/booking-payment-state";
import { isBookingOwnAmountOwed } from "@/lib/booking-status";
import { getNetCollectedCashParts, type NetCollectedCashRow } from "@/lib/payment-net-collected";

/**
 * The short account summary beside the booking's Xero invoice (#5066; owner
 * decision on PR #5201, 17 Nov 2026: invoice total, credits applied, payments
 * received and balance, from the app's own records). Pure, integer cents, and
 * every figure is one the booking page already shows or decides by, from its
 * one home (`INV-SSOT`) — nothing is summed here:
 *
 * - `totalCents`: what the booking is worth now, its price plus any recorded
 *   change fee (`bookingWorthCents`, the figure the primary invoice bills);
 * - `creditAppliedCents`: the ledger's account credit applied to it
 *   (`readBookingAmountOwed`, the page's one read);
 * - `paidCents`: what the payment took and the club still holds, net of
 *   refunds and of refunds still owed back (`getNetCollectedCashParts`, the
 *   page's own "retained" figure);
 * - `balanceCents`: what is still to pay on the booking's own price — the
 *   page's pay-card amount (`dueCents`) while the booking still owes it
 *   (`isBookingOwnAmountOwed`), otherwise nothing.
 *
 * Not a statement: an additional ask or supplementary invoice is not covered
 * (those bookings get the "ask the club" line instead, `resolveBookingInvoiceOffer`),
 * and the single statement document is a later slice of #5066.
 */
export type BookingInvoiceSummary = {
  totalCents: number;
  creditAppliedCents: number;
  paidCents: number;
  balanceCents: number;
};

/** The booking page's loaded record satisfies this (`loadBookingDetail`). */
export type BookingInvoiceSummaryBooking = NetCollectedCashRow["booking"] & {
  finalPriceCents: number;
  payment: (Omit<NetCollectedCashRow, "booking"> & { status: string; changeFeeCents: number }) | null;
};

export function bookingInvoiceSummary(
  booking: BookingInvoiceSummaryBooking,
  amountOwed: BookingAmountOwed,
): BookingInvoiceSummary {
  const paidCents = booking.payment ? getNetCollectedCashParts({ ...booking.payment, booking }).heldCashCents : 0;
  return {
    totalCents: bookingWorthCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment?.changeFeeCents ?? null,
    }),
    creditAppliedCents: amountOwed.appliedCreditCents,
    paidCents,
    balanceCents: isBookingOwnAmountOwed(booking) ? amountOwed.dueCents : 0,
  };
}
