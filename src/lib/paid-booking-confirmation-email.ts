import { bookingWorthCents } from "@/lib/booking-payment-state";
import { bookingOwner } from "@/lib/booking-owner";
import { bookingPromoEmailFields } from "@/lib/booking-promo-email-options";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import type { ClubFormat } from "@/lib/club-format";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The paid-booking confirmation email, sent once a payment has reconciled as a
 * fresh transition to PAID (#5398). Its two callers are the racing halves of
 * the exactly-once send (issue #772): the confirm-payment route and the Stripe
 * webhook. Each keeps its own `outcome === "paid"` gate, so whichever path
 * loses the race reads "already_paid" and never calls this. A send failure is
 * logged, never thrown: the payment has already settled.
 */
export async function sendPaidBookingConfirmedEmail(
  bookingId: string,
  format: ClubFormat,
): Promise<void> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        member: true,
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
        guests: true,
        promoRedemptions: { include: { promoCode: true } },
        // #3750: a change fee recorded on the payment was paid too.
        payment: { select: { changeFeeCents: true } },
      },
    });
    if (booking) {
      // Split-booking parent (#738): describe the provisional non-member
      // child so the confirmation explains the separate later charge.
      const provisionalGuests = await getProvisionalNonMemberChildSummary({
        id: booking.id,
        memberId: bookingOwner(booking).memberId,
      });
      await sendBookingConfirmedEmail(
        { bookingId: booking.id, recipientMemberId: bookingOwner(booking).memberId },
        bookingOwner(booking).member.email,
        bookingOwner(booking).member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        // #3955 review F8: what the member paid for — the booking's worth,
        // its price plus a recorded change fee (the email nets credit).
        bookingWorthCents({
          finalPriceCents: booking.finalPriceCents,
          changeFeeCents: booking.payment?.changeFeeCents ?? null,
        }),
        format,
        {
          lodgeId: booking.lodgeId,
          ...(provisionalGuests ? { provisionalGuests } : {}),
          ...bookingPromoEmailFields(booking),
        }
      );
    }
  } catch (emailErr) {
    logger.error({ err: emailErr, bookingId }, "Failed to send confirmation email");
  }
}
