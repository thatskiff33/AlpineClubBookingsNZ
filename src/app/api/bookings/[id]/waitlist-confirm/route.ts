import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { confirmWaitlistOffer } from "@/lib/waitlist";
import {
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
} from "@/lib/email";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import logger from "@/lib/logger";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: bookingId } = await params;

  const result = await confirmWaitlistOffer(bookingId, session.user.id);

  if (!result.success) {
    const status = result.error === "Forbidden" ? 403
      : result.error === "Booking not found" ? 404
      : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  // Handle zero-dollar bookings — auto-create payment and set PAID
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.CONFIRMED) {
    await prisma.$transaction([
      prisma.payment.create({
        data: {
          bookingId,
          amountCents: 0,
          status: "SUCCEEDED",
        },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.PAID },
      }),
    ]);

    sendBookingConfirmedEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
      booking.discountCents > 0
        ? { discountCents: booking.discountCents, promoCode: booking.promoRedemption?.promoCode?.code }
        : undefined
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send confirmation email after waitlist confirm"));

    isXeroConnected().then((connected) => {
      if (connected) {
        createXeroInvoiceForBooking(bookingId).catch((err) =>
          logger.error({ err, bookingId }, "Failed to create Xero invoice after waitlist confirm")
        );
      }
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      status: "PAID",
      requiresPayment: false,
    });
  }

  // For PENDING bookings, send pending email
  if (result.newStatus === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
    sendBookingPendingEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.nonMemberHoldUntil
    ).catch((err) => logger.error({ err }, "Failed to send pending email after waitlist confirm"));
  }

  return NextResponse.json({
    success: true,
    status: result.newStatus,
    requiresPayment: result.newStatus === BookingStatus.CONFIRMED && booking.finalPriceCents > 0,
    requiresSetup: result.newStatus === BookingStatus.PENDING,
  });
}
