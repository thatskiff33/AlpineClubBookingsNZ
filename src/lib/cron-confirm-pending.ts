import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { checkCapacity, LODGE_CAPACITY } from "./capacity";
import { chargePaymentMethod } from "./stripe";
import { isXeroConnected, createXeroInvoiceForBooking } from "./xero";
import {
  sendBookingConfirmedEmail,
  sendBookingBumpedEmail,
} from "./email";

export interface CronConfirmResult {
  confirmedBookingIds: string[];
  bumpedBookingIds: string[];
  failedBookingIds: string[];
}

/**
 * Process pending bookings that have reached their hold deadline.
 *
 * For each PENDING booking where nonMemberHoldUntil <= now():
 * 1. Re-check bed availability for the booking's date range
 * 2. If beds available AND saved payment method exists:
 *    - Charge the saved PaymentMethod via Stripe
 *    - Set status to CONFIRMED
 *    - Send confirmation email
 * 3. If beds NOT available:
 *    - Set status to BUMPED
 *    - Send bumped notification email
 */
export async function confirmPendingBookings(): Promise<CronConfirmResult> {
  const now = new Date();

  // Find all PENDING bookings past their hold deadline
  const pendingBookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: { lte: now },
    },
    include: {
      member: true,
      guests: true,
      payment: true,
    },
    orderBy: { createdAt: "asc" }, // Process oldest first
  });

  const result: CronConfirmResult = {
    confirmedBookingIds: [],
    bumpedBookingIds: [],
    failedBookingIds: [],
  };

  for (const booking of pendingBookings) {
    try {
      // Check capacity (excluding this booking since it's already counted as PENDING)
      const capacityCheck = await checkCapacity(
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.id
      );

      if (!capacityCheck.available) {
        // No beds available - bump this booking
        await prisma.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.BUMPED },
        });

        result.bumpedBookingIds.push(booking.id);

        try {
          await sendBookingBumpedEmail(
            booking.member.email,
            booking.member.firstName,
            booking.checkIn,
            booking.checkOut,
            booking.guests.length
          );
        } catch (emailErr) {
          console.error(`Failed to send bumped email for booking ${booking.id}:`, emailErr);
        }

        continue;
      }

      // Beds available - try to charge saved payment method
      if (!booking.payment?.stripePaymentMethodId || !booking.payment?.stripeCustomerId) {
        console.error(
          `Booking ${booking.id} has no saved payment method - cannot auto-confirm`
        );
        result.failedBookingIds.push(booking.id);
        continue;
      }

      // Charge the saved card
      const paymentIntent = await chargePaymentMethod({
        amountCents: booking.finalPriceCents,
        customerId: booking.payment.stripeCustomerId,
        paymentMethodId: booking.payment.stripePaymentMethodId,
        metadata: {
          bookingId: booking.id,
          memberId: booking.memberId,
        },
      });

      if (paymentIntent.status === "succeeded") {
        await prisma.$transaction([
          prisma.payment.update({
            where: { bookingId: booking.id },
            data: {
              stripePaymentIntentId: paymentIntent.id,
              status: "SUCCEEDED",
              amountCents: paymentIntent.amount,
            },
          }),
          prisma.booking.update({
            where: { id: booking.id },
            data: { status: BookingStatus.CONFIRMED },
          }),
        ]);

        result.confirmedBookingIds.push(booking.id);

        // Create Xero invoice if connected
        try {
          if (await isXeroConnected()) {
            await createXeroInvoiceForBooking(booking.id);
            console.log(`[CRON] Xero invoice created for booking ${booking.id}`);
          }
        } catch (xeroErr) {
          console.error(`[CRON] Failed to create Xero invoice for booking ${booking.id}:`, xeroErr);
        }

        try {
          await sendBookingConfirmedEmail(
            booking.member.email,
            booking.member.firstName,
            booking.checkIn,
            booking.checkOut,
            booking.guests.length,
            booking.finalPriceCents
          );
        } catch (emailErr) {
          console.error(`Failed to send confirmation email for booking ${booking.id}:`, emailErr);
        }
      } else {
        // Payment is processing (requires_action, etc.)
        await prisma.payment.update({
          where: { bookingId: booking.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            status: "PROCESSING",
          },
        });

        // Will be resolved by Stripe webhook
        console.log(
          `Booking ${booking.id} payment processing (status: ${paymentIntent.status})`
        );
      }
    } catch (err) {
      console.error(`Error processing pending booking ${booking.id}:`, err);
      result.failedBookingIds.push(booking.id);
    }
  }

  return result;
}
