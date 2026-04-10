import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { eachDayOfInterval, subDays } from "date-fns";
import { getSeasonYear } from "@/lib/utils";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { guests: true, member: true, promoRedemption: { include: { promoCode: true } } },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status !== BookingStatus.DRAFT) {
    return NextResponse.json({ error: "Booking is not a draft" }, { status: 400 });
  }

  if (booking.finalPriceCents !== 0) {
    return NextResponse.json(
      { error: "Use the payment flow to complete non-zero bookings" },
      { status: 400 }
    );
  }

  // Subscription check (non-admins only)
  if (session.user.role !== "ADMIN") {
    const seasonYear = getSeasonYear(new Date(booking.checkIn));
    const paidSub = await prisma.memberSubscription.findFirst({
      where: { memberId: session.user.id, seasonYear, status: "PAID" },
    });
    if (!paidSub) {
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
        },
        { status: 403 }
      );
    }
  }

  // Check capacity + transition to PAID in transaction
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

    const freshBooking = await tx.booking.findUnique({
      where: { id },
      include: { guests: true },
    });

    if (!freshBooking || freshBooking.status !== BookingStatus.DRAFT) {
      throw new Error("Booking is no longer a draft");
    }

    const overlapping = await tx.booking.findMany({
      where: {
        id: { not: id },
        checkIn: { lt: freshBooking.checkOut },
        checkOut: { gt: freshBooking.checkIn },
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
      },
      include: { guests: true },
    });

    const nights = eachDayOfInterval({
      start: new Date(freshBooking.checkIn),
      end: subDays(new Date(freshBooking.checkOut), 1),
    });

    for (const night of nights) {
      const nightTime = night.getTime();
      let occupiedBeds = 0;
      for (const b of overlapping) {
        const bIn = new Date(b.checkIn).getTime();
        const bOut = new Date(b.checkOut).getTime();
        if (nightTime >= bIn && nightTime < bOut) {
          occupiedBeds += b.guests.length;
        }
      }
      if (occupiedBeds + freshBooking.guests.length > LODGE_CAPACITY) {
        throw new Error("Not enough beds available for your dates.");
      }
    }

    await tx.payment.create({
      data: {
        bookingId: id,
        amountCents: 0,
        status: "SUCCEEDED",
      },
    });

    await tx.booking.update({
      where: { id },
      data: { status: BookingStatus.PAID, draftExpiresAt: null },
    });
  });

  // Fire-and-forget: confirmation email + Xero invoice
  sendBookingConfirmedEmail(
    booking.member.email,
    booking.member.firstName,
    booking.checkIn,
    booking.checkOut,
    booking.guests.length,
    0,
    booking.promoRedemption?.promoCode
      ? { discountCents: booking.discountCents, promoCode: booking.promoRedemption.promoCode.code }
      : undefined
  ).catch((err) => logger.error({ err, bookingId: id }, "Failed to send confirmation email for confirmed draft"));

  isXeroConnected().then((connected) => {
    if (connected) {
      createXeroInvoiceForBooking(id).catch((err) =>
        logger.error({ err, bookingId: id }, "Failed to create Xero invoice for confirmed draft")
      );
    }
  }).catch((err) => logger.error({ err }, "Failed to check Xero connection for confirmed draft"));

  return NextResponse.json({ success: true, status: BookingStatus.PAID });
}
