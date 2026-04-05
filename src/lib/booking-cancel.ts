import { prisma } from "./prisma";
import { processRefund } from "./stripe";
import { isXeroConnected, createXeroCreditNote } from "./xero";
import {
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { sendBookingCancelledEmail } from "./email";
import { logAudit } from "./audit";

export interface CancelBookingResult {
  success: boolean;
  refundAmountCents: number;
  refundPercentage: number;
  stripeRefundId?: string;
  message: string;
}

/**
 * Shared cancellation service used by both cancel routes.
 * Handles: PENDING cancel, CONFIRMED without payment, CONFIRMED with refund
 * (Stripe + Xero credit note), promo cleanup, audit logging, email.
 */
export async function cancelBooking(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string
): Promise<
  | { status: 401; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 400; error: string }
  | { status: 200; data: CancelBookingResult }
> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return { status: 404, error: "Booking not found" };
  }

  if (booking.memberId !== sessionUserId && sessionUserRole !== "ADMIN") {
    return { status: 403, error: "Forbidden" };
  }

  if (booking.status !== "PENDING" && booking.status !== "CONFIRMED") {
    return {
      status: 400,
      error: "Only PENDING or CONFIRMED bookings can be cancelled",
    };
  }

  // Handle PENDING bookings (no payment taken yet)
  if (booking.status === "PENDING") {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });
    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: "Pending booking cancelled, no payment taken",
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch(() => {});

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        message: "Pending booking cancelled. No payment was taken.",
      },
    };
  }

  // Handle CONFIRMED bookings without successful payment
  if (!booking.payment || booking.payment.status !== "SUCCEEDED") {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });
    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: "Confirmed booking cancelled, no payment to refund",
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch(() => {});

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        message: "Booking cancelled. No refund applicable.",
      },
    };
  }

  // Calculate refund based on cancellation policy
  const paidAmountCents =
    booking.payment.amountCents - booking.payment.refundedAmountCents;
  const days = daysUntilDate(booking.checkIn);
  const policy = await loadCancellationPolicy(booking.checkIn);
  const { refundAmountCents, refundPercentage } = calculateRefundAmount(
    paidAmountCents,
    days,
    policy
  );

  // Process Stripe refund if applicable
  if (refundAmountCents > 0 && booking.payment.stripePaymentIntentId) {
    const refund = await processRefund({
      paymentIntentId: booking.payment.stripePaymentIntentId,
      amountCents: refundAmountCents,
      metadata: {
        bookingId: booking.id,
        reason: "cancellation",
        refundPercentage: refundPercentage.toString(),
      },
    });

    const newRefundedTotal =
      booking.payment.refundedAmountCents + refundAmountCents;
    const newStatus =
      newRefundedTotal >= booking.payment.amountCents
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: {
          refundedAmountCents: newRefundedTotal,
          status: newStatus,
        },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      }),
    ]);

    // Create Xero credit note if connected
    try {
      if (await isXeroConnected()) {
        await createXeroCreditNote(booking.payment.id, refundAmountCents);
      }
    } catch {
      // Xero credit note failure is non-fatal
    }

    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: `Refund ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      refundAmountCents
    ).catch(() => {});

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        stripeRefundId: refund.id,
        message: `Booking cancelled. ${refundPercentage}% refund of $${(refundAmountCents / 100).toFixed(2)} processed.`,
      },
    };
  }

  // No refund (0% policy or no payment intent)
  await prisma.booking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED" },
  });
  await cleanupPromoRedemption(bookingId);

  logAudit({
    action: "booking.cancel",
    memberId: sessionUserId,
    targetId: bookingId,
    details: "No refund per cancellation policy",
    ipAddress,
  });

  sendBookingCancelledEmail(
    booking.member.email,
    booking.member.firstName,
    booking.checkIn,
    booking.checkOut,
    0
  ).catch(() => {});

  return {
    status: 200,
    data: {
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      message:
        "Booking cancelled. No refund applicable per cancellation policy.",
    },
  };
}

/**
 * Clean up promo redemption if booking used a promo code.
 */
async function cleanupPromoRedemption(bookingId: string) {
  const redemption = await prisma.promoRedemption.findUnique({
    where: { bookingId },
  });
  if (redemption) {
    await prisma.$transaction([
      prisma.promoRedemption.delete({ where: { id: redemption.id } }),
      prisma.promoCode.update({
        where: { id: redemption.promoCodeId },
        data: { currentRedemptions: { decrement: 1 } },
      }),
    ]);
  }
}
