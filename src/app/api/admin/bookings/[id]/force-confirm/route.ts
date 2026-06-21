import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import {
  checkCapacityForGuestRanges,
  type NightAvailability,
} from "@/lib/capacity";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { z } from "zod";

const forceConfirmSchema = z.object({
  allowOverbook: z.boolean().optional(),
});

function formatOverbookDate(night: NightAvailability) {
  return night.date.toISOString().slice(0, 10);
}

function getOverbookedNights(nightDetails: NightAvailability[]) {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => ({
      date: formatOverbookDate(night),
      availableBeds: night.availableBeds,
    }));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = forceConfirmSchema.safeParse(body);
  const allowOverbook = parsed.success ? parsed.data.allowOverbook : false;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: { include: { nights: true } }, member: true, promoRedemption: { include: { promoCode: true } } },
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
      const overbookedNights = getOverbookedNights(nightDetails);
      const overbookDates = overbookedNights.map((night) => night.date);

      if (!available && !allowOverbook) {
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
      const overbooked = !available;
      const auditAction = overbooked
        ? "waitlist.force_confirmed_overbook"
        : "waitlist.force_confirmed";

      await createAuditLog(
        {
          action: auditAction,
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: booking.memberId,
          targetId: bookingId,
          entityType: "Booking",
          entityId: bookingId,
          category: "booking",
          severity: overbooked ? "critical" : "important",
          outcome: "success",
          summary: overbooked
            ? "Waitlist booking force-confirmed with overbook"
            : "Waitlist booking force-confirmed",
          details:
            nextStatus === BookingStatus.AWAITING_REVIEW
              ? "Admin force-confirmed waitlisted booking but it was parked for admin review."
              : overbooked
                ? "Admin force-confirmed waitlisted booking despite capacity being exceeded."
                : "Admin force-confirmed waitlisted booking.",
          metadata: {
            previousStatus: booking.status,
            nextStatus,
            allowOverbook,
            overbooked,
            overbookDates,
            overbookedNights,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            guestCount: booking.guests.length,
            finalPriceCents: booking.finalPriceCents,
            parkedForAdminReview: nextStatus === BookingStatus.AWAITING_REVIEW,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
          retentionClass: overbooked ? "critical" : undefined,
          incidentPreserved: overbooked,
        },
        tx,
      );

      return {
        success: true,
        booking,
        auditAction,
        overbookDates,
        overbooked,
        status: nextStatus,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error, ...("overbookDates" in result ? { overbookDates: result.overbookDates } : {}) },
        { status: result.status as number }
      );
    }

    const { booking, overbooked, overbookDates, auditAction, status } = result;

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
      auditAction,
      overbooked,
      overbookDates,
      status,
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to force-confirm waitlisted booking");
    return NextResponse.json({ error: "Failed to force-confirm booking" }, { status: 500 });
  }
}
