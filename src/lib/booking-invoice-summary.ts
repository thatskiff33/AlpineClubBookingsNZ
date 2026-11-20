import { BookingStatus, PaymentStatus } from "@prisma/client";

import { recordedChangeFeeCents, type BookingAmountOwed } from "@/lib/booking-payment-state";
import { isBookingOwnAmountOwed } from "@/lib/booking-status";
import { getNetCollectedCashParts, type NetCollectedCashRow } from "@/lib/payment-net-collected";

/**
 * The short account summary beside the booking's Xero invoice (#5066; owner
 * decision on PR #5201, 17 Nov 2026: invoice total, credits applied, payments
 * received and balance, from the app's own records). Pure, integer cents, and
 * every figure but `keptCents` is one the booking page already shows or decides
 * by, from its one home (`INV-SSOT`):
 *
 * - `totalCents`: the booking's price, `finalPriceCents` — the Payment card's
 *   own "Total", so the two cards cannot disagree;
 * - `changeFeeCents`: the change fee recorded on the payment
 *   (`recordedChangeFeeCents`), which the primary invoice also bills;
 * - `creditAppliedCents`: the ledger's account credit applied to it
 *   (`readBookingAmountOwed`, the page's one read);
 * - `paidCents`: what the payment took and the club still holds, net of
 *   refunds, of credit returned to the member's account (`INV-PAY-050`) and of
 *   refunds still owed back (`getNetCollectedCashParts`, the page's own
 *   "retained" figure);
 * - `balanceCents` / `balanceWhen`: the amount due (`dueCents`). `NOW` while
 *   the booking owes its own price (`isBookingOwnAmountOwed`, the pay card's
 *   rule); `AFTER_REVIEW` / `AFTER_CONFIRMATION` for a booking held in review
 *   or pending with nothing paid, whose invoice may already be issued (an
 *   internet-banking booking parked for review keeps its invoice); otherwise
 *   nothing is due.
 * - `keptCents`: what makes the rows reconcile when a reduction was refunded
 *   only in part under the booking's change terms (the cancellation-policy
 *   tier on a removed guest or shortened stay): `paid + credit + due - (total +
 *   fee)`, shown only when above zero. No reader records that retention as a
 *   figure of its own, so this is the one sum in the summary.
 *
 * So `paid = total + fee - credit - due + kept` whenever `kept > 0`.
 *
 * Not a statement: an additional ask or supplementary invoice is not covered
 * (those bookings get the "ask the club" line instead, `resolveBookingInvoiceOffer`),
 * and the single statement document is a later slice of #5066.
 */
export type BookingInvoiceSummary = {
  totalCents: number;
  changeFeeCents: number;
  creditAppliedCents: number;
  paidCents: number;
  keptCents: number;
  balanceCents: number;
  balanceWhen: "NOW" | "AFTER_REVIEW" | "AFTER_CONFIRMATION";
};

/** The booking page's loaded record satisfies this (`loadBookingDetail`). */
export type BookingInvoiceSummaryBooking = NetCollectedCashRow["booking"] & {
  finalPriceCents: number;
  payment: (Omit<NetCollectedCashRow, "booking"> & { status: string; changeFeeCents: number }) | null;
};

const DUE_LATER: Readonly<Partial<Record<string, BookingInvoiceSummary["balanceWhen"]>>> = {
  [BookingStatus.AWAITING_REVIEW]: "AFTER_REVIEW",
  [BookingStatus.PENDING]: "AFTER_CONFIRMATION",
};

function balanceOf(booking: BookingInvoiceSummaryBooking, amountOwed: BookingAmountOwed): Pick<BookingInvoiceSummary, "balanceCents" | "balanceWhen"> {
  if (isBookingOwnAmountOwed(booking)) return { balanceCents: amountOwed.dueCents, balanceWhen: "NOW" };
  const later = DUE_LATER[booking.status];
  if (later && booking.payment?.status !== PaymentStatus.SUCCEEDED) return { balanceCents: amountOwed.dueCents, balanceWhen: later };
  return { balanceCents: 0, balanceWhen: "NOW" };
}

export function bookingInvoiceSummary(
  booking: BookingInvoiceSummaryBooking,
  amountOwed: BookingAmountOwed,
): BookingInvoiceSummary {
  const totalCents = booking.finalPriceCents;
  const changeFeeCents = recordedChangeFeeCents(booking.payment);
  const creditAppliedCents = amountOwed.appliedCreditCents;
  const paidCents = booking.payment ? getNetCollectedCashParts({ ...booking.payment, booking }).heldCashCents : 0;
  const balance = balanceOf(booking, amountOwed);
  const keptCents = Math.max(0, paidCents + creditAppliedCents + balance.balanceCents - (totalCents + changeFeeCents));
  return { totalCents, changeFeeCents, creditAppliedCents, paidCents, keptCents, ...balance };
}
