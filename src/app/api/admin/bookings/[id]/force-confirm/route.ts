import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { logAudit } from "@/lib/audit";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { z } from "zod";

const forceConfirmSchema = z.object({
  allowOverbook: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = forceConfirmSchema.safeParse(body);
  const allowOverbook = parsed.success ? parsed.data.allowOverbook : false;

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: true, member: true, promoRedemption: { include: { promoCode: true } } },
      });

      if (!booking) {
        return { error: "Booking not found", status: 404 };
      }

      if (booking.status !== BookingStatus.WAITLISTED && booking.status !== BookingStatus.WAITLIST_OFFERED) {
        return { error: "Booking is not waitlisted", status: 400 };
      }

      // Check capacity
      const { available, nightDetails } = await checkCapacityForGuestRanges(
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        undefined,
        tx
      );

      if (!available && !allowOverbook) {
        const overbookDates = nightDetails
          .filter((n) => n.availableBeds < 0)
          .map((n) => n.date.toISOString().split("T")[0]);

        return {
          error: "CAPACITY_EXCEEDED",
          overbookDates,
          status: 409,
        };
      }

      // Re-check the no-adult rule before letting a waitlisted booking
      // bypass review. If it still trips and review hasn't been resolved,
      // park it in AWAITING_REVIEW instead of advancing to payment.
      const ruleStillTrips = requiresAdultSupervisionReview(booking.guests);
      const reviewUnresolved =
        ruleStillTrips &&
        booking.adminReviewStatus !== AdminReviewStatus.APPROVED;

      const nextStatus = reviewUnresolved
        ? BookingStatus.AWAITING_REVIEW
        : booking.finalPriceCents === 0
          ? BookingStatus.PAID
          : BookingStatus.PAYMENT_PENDING;

      // Backfill the review fields if they weren't set when the booking
      // was originally created (older waitlisted rows pre-date the new
      // review workflow).
      const reviewBackfill =
        reviewUnresolved && booking.adminReviewStatus === null
          ? {
              requiresAdminReview: true,
              adminReviewStatus: AdminReviewStatus.PENDING,
              adminReviewReason:
                booking.adminReviewReason ??
                "This booking does not include an adult guest, so it should be reviewed by an admin.",
            }
          : {};

      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: nextStatus,
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          ...reviewBackfill,
        },
      });

      // No payment row needed when parking for review.
      if (nextStatus === BookingStatus.AWAITING_REVIEW) {
        // Nothing further; admin must approve via the booking requests
        // queue before payment can be taken.
      } else if (nextStatus === BookingStatus.PAID) {
        await tx.payment.upsert({
          where: { bookingId },
          create: {
            bookingId,
            amountCents: 0,
            status: "SUCCEEDED",
          },
          update: {
            amountCents: 0,
            status: "SUCCEEDED",
          },
        });
      }
      await reconcileBedAllocationsForBooking({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      return {
        success: true,
        booking,
        overbooked: !available,
        status: nextStatus,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error, ...("overbookDates" in result ? { overbookDates: result.overbookDates } : {}) },
        { status: result.status as number }
      );
    }

    const { booking, overbooked, status } = result;

    logAudit({
      action: "waitlist.force_confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      details:
        status === BookingStatus.AWAITING_REVIEW
          ? "Admin force-confirmed waitlisted booking but it was parked for admin review (no adult on booking)"
          : overbooked
            ? `Admin force-confirmed waitlisted booking (OVERBOOKED)`
            : `Admin force-confirmed waitlisted booking`,
    });

    if (status === BookingStatus.PAID) {
      sendBookingConfirmedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents,
        booking.promoRedemption?.promoCode
          ? {
              discountCents: booking.discountCents,
              promoAdjustmentCents: booking.promoAdjustmentCents,
              promoCode: booking.promoRedemption.promoCode.code,
            }
          : undefined,
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send confirmation after force-confirm"));
    }

    return NextResponse.json({
      success: true,
      overbooked,
      status,
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to force-confirm waitlisted booking");
    return NextResponse.json({ error: "Failed to force-confirm booking" }, { status: 500 });
  }
}
