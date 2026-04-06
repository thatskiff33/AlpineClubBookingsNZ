import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { checkCapacity, LODGE_CAPACITY } from "./capacity";
import { chargePaymentMethod } from "./stripe";
import { isXeroConnected, createXeroInvoiceForBooking } from "./xero";
import {
  sendBookingConfirmedEmail,
  sendBookingBumpedEmail,
  sendAdminPaymentFailureAlert,
} from "./email";
import logger from "@/lib/logger";

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
      promoRedemption: { include: { promoCode: true } },
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
          logger.error({ err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send bumped email");
        }

        continue;
      }

      // Beds available - try to charge saved payment method
      if (!booking.payment?.stripePaymentMethodId || !booking.payment?.stripeCustomerId) {
        logger.error({ bookingId: booking.id, job: "confirmPendingBookings" }, "Booking has no saved payment method - cannot auto-confirm");
        result.failedBookingIds.push(booking.id);
        continue;
      }

      // Atomically claim the booking to prevent double-charge with manual confirm
      const claimed = await prisma.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: { status: BookingStatus.CONFIRMED },
      });
      if (claimed.count === 0) {
        // Another process already changed the status - skip
        logger.info({ bookingId: booking.id, job: "confirmPendingBookings" }, "Booking already processed by another handler");
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
        await prisma.payment.update({
          where: { bookingId: booking.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            status: "SUCCEEDED",
            amountCents: paymentIntent.amount,
          },
        });

        result.confirmedBookingIds.push(booking.id);

        // Create Xero invoice if connected
        try {
          if (await isXeroConnected()) {
            await createXeroInvoiceForBooking(booking.id);
            logger.info({ bookingId: booking.id, job: "confirmPendingBookings" }, "Xero invoice created");
          }
        } catch (xeroErr) {
          logger.error({ err: xeroErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to create Xero invoice");
        }

        try {
          await sendBookingConfirmedEmail(
            booking.member.email,
            booking.member.firstName,
            booking.checkIn,
            booking.checkOut,
            booking.guests.length,
            booking.finalPriceCents,
            booking.discountCents > 0
              ? { discountCents: booking.discountCents, promoCode: booking.promoRedemption?.promoCode?.code }
              : undefined
          );
        } catch (emailErr) {
          logger.error({ err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send confirmation email");
        }
      } else {
        // Payment is processing (requires_action, etc.) - revert to PENDING for webhook to handle
        await prisma.$transaction([
          prisma.payment.update({
            where: { bookingId: booking.id },
            data: {
              stripePaymentIntentId: paymentIntent.id,
              status: "PROCESSING",
            },
          }),
          prisma.booking.update({
            where: { id: booking.id },
            data: { status: BookingStatus.PENDING },
          }),
        ]);

        // Will be resolved by Stripe webhook
        logger.info({ bookingId: booking.id, paymentStatus: paymentIntent.status, job: "confirmPendingBookings" }, "Booking payment processing");
      }
    } catch (err) {
      logger.error({ err, bookingId: booking.id, job: "confirmPendingBookings" }, "Error processing pending booking");
      // Revert status if we claimed it but the charge failed
      await prisma.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.CONFIRMED },
        data: { status: BookingStatus.PENDING },
      }).catch((revertErr) => logger.error({ err: revertErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to revert booking status"));
      result.failedBookingIds.push(booking.id);

      // N-04: Send admin alert for payment failure from cron
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.finalPriceCents,
        errorMessage: err instanceof Error ? err.message : String(err),
        paymentIntentId: booking.payment?.stripePaymentIntentId || "N/A",
      }).catch((alertErr) =>
        logger.error({ err: alertErr, bookingId: booking.id }, "Failed to send admin payment failure alert")
      );
    }
  }

  return result;
}
