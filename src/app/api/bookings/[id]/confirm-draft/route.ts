import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getSeasonYear } from "@/lib/utils";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { requiresPaidSubscriptionForBooking } from "@/lib/member-subscription-eligibility";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

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

  // Subscription check (non-admins only; bypassed when the Xero module is
  // effectively off, because subscriptions are invoiced through Xero)
  if (
    session.user.role !== "ADMIN" &&
    await requiresPaidSubscriptionForBooking(booking.member.ageTier)
  ) {
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

    const capacity = await checkCapacityForGuestRanges(
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      id,
      tx,
    );
    if (!capacity.available) {
      throw new Error("Not enough beds available for your dates.");
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
    await reconcileBedAllocationsForBooking({
      bookingId: id,
      db: tx,
      previousRange: {
        checkIn: freshBooking.checkIn,
        checkOut: freshBooking.checkOut,
      },
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
      ? {
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promoCode: booking.promoRedemption.promoCode.code,
        }
      : undefined
  ).catch((err) => logger.error({ err, bookingId: id }, "Failed to send confirmation email for confirmed draft"));

  // The admin alert for review-flagged bookings is sent once at creation
  // time; no second alert when a flagged draft is confirmed.

  void enqueueXeroBookingInvoiceOperation(id, {
    createdByMemberId: session.user.id,
  })
    .then(async (queuedInvoice) => {
      if (!queuedInvoice.queueOperationId) {
        return;
      }

      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    })
    .catch((err) =>
      logger.error(
        { err, bookingId: id },
        "Failed to queue Xero invoice for confirmed draft"
      )
    );

  return NextResponse.json({ success: true, status: BookingStatus.PAID });
}
