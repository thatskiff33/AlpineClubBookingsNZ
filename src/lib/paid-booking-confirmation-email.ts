import { Prisma } from "@prisma/client";

import { bookingWorthCents } from "@/lib/booking-payment-state";
import { confirmationOutstandingBalance } from "@/lib/booking-confirmation-outstanding";
import { bookingOwner } from "@/lib/booking-owner";
import { bookingPromoEmailFields } from "@/lib/booking-promo-email-options";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import type { ClubFormat } from "@/lib/club-format";
import { sendBookingConfirmedEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";

/**
 * The paid-booking confirmation email (#5398), sent once a card payment has
 * settled as a fresh transition to PAID. Since #5433 (owner decision D1) it is
 * an owed notice: the settle records it in its own transaction and
 * `paid-booking-confirmation-notice.ts`, this module's only caller, delivers it
 * right after the commit, or a later run's sweep does. Either way it is
 * rendered here from the booking as it stands then: its current dates, party,
 * price, lodge and door code, and any upward change since not yet collected.
 */

const PAID_CONFIRMATION_INCLUDE = Prisma.validator<Prisma.BookingInclude>()({
  member: true,
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { select: { name: true, email: true } },
  guests: true,
  promoRedemptions: { include: { promoCode: true } },
  // #3750: a change fee recorded on the payment was paid too. #2397: an upward
  // change since the payment, not yet collected, is stated as still owing.
  payment: { select: { changeFeeCents: true, additionalAmountCents: true, additionalPaymentStatus: true } },
});

/** The booking as the confirmation reads it. */
export type PaidConfirmationBooking = Prisma.BookingGetPayload<{ include: typeof PAID_CONFIRMATION_INCLUDE }>;

/** The booking as it stands now, read outside any transaction; null when it is gone. */
export function loadPaidConfirmationBooking(bookingId: string): Promise<PaidConfirmationBooking | null> {
  return prisma.booking.findUnique({ where: { id: bookingId }, include: PAID_CONFIRMATION_INCLUDE });
}

/**
 * Send the confirmation for `booking`, with the owed notice's event key (none
 * for a confirmation that could not be recorded as owed, sent as before
 * #5433). Throws when the send does: its caller decides what a failure means.
 */
export async function sendPaidBookingConfirmation(
  booking: PaidConfirmationBooking,
  format: ClubFormat,
  idempotencyKey: string | undefined,
) {
  const owner = bookingOwner(booking);
  // Split-booking parent (#738): describe the provisional non-member child so
  // the confirmation explains the separate later charge.
  const provisionalGuests = await getProvisionalNonMemberChildSummary({ id: booking.id, memberId: owner.memberId });
  const outstandingBalance = confirmationOutstandingBalance(booking);
  return sendBookingConfirmedEmail(
    { bookingId: booking.id, recipientMemberId: owner.memberId, idempotencyKey },
    owner.member.email,
    owner.member.firstName,
    booking.checkIn,
    booking.checkOut,
    booking.guests.length,
    // #3955 review F8: what the member paid for, the booking's worth, its
    // price plus a recorded change fee (the email nets credit).
    bookingWorthCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment?.changeFeeCents ?? null,
    }),
    format,
    {
      lodgeId: booking.lodgeId,
      ...(provisionalGuests ? { provisionalGuests } : {}),
      ...(outstandingBalance ? { outstandingBalance } : {}),
      ...bookingPromoEmailFields(booking),
    },
  );
}
