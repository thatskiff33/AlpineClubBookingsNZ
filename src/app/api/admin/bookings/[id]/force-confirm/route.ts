import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  type NightAvailability,
} from "@/lib/capacity";
import { wholeLodgeBlockedNights } from "@/lib/over-capacity-confirmation";
import { getDefaultLodgeId } from "@/lib/lodges";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";
import { sendBookingConfirmedEmail } from "@/lib/email";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import logger from "@/lib/logger";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { z } from "zod";

const forceConfirmSchema = z.object({
  allowOverbook: z.boolean().optional(),
  // #1769b (#1705 semantics): per-action member-email choice. This route is
  // requireAdmin()-only, so no actor gate is needed. Absent = notify (default);
  // false suppresses the confirmation email (only reachable when the booking
  // lands PAID). A non-boolean value is rejected with 400.
  notifyMember: z.boolean().optional(),
});

function formatOverbookDate(night: NightAvailability) {
  return formatDateOnly(night.date);
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
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = forceConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const allowOverbook = parsed.data.allowOverbook ?? false;
  const notifyMember = parsed.data.notifyMember;
  const auditRequest = getAuditRequestContext(request);
  // The club's calendar day from the PERSISTED timezone (CT-4, #2870; INV-CONFIG-002),
  // as the UTC-midnight value `Booking.checkOut` (`@db.Date`) compares against. Resolved
  // before the transaction, which holds the global advisory lock and must not wait on a
  // settings read over a second connection.
  const clubTodayDateOnly = await clubTodayDateOnlyInstant();

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

      const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      // Check capacity
      const { available, nightDetails } = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        undefined,
        tx
      );
      const overbookedNights = getOverbookedNights(nightDetails);
      const overbookDates = overbookedNights.map((night) => night.date);

      // Exclusive whole-lodge hold (ADR-001 decision 5, issue #118): a held
      // night is NOT bypassable — refuse even when the admin set allowOverbook,
      // and BEFORE any status advance. Held nights never appear in overbookDates
      // (they are pinned to 0, not negative), so this is the only guard that
      // catches them.
      const blockedNights = wholeLodgeBlockedNights({ nightDetails });
      if (blockedNights.length > 0) {
        return {
          error: "WHOLE_LODGE_HOLD_BLOCKED",
          code: "WHOLE_LODGE_HOLD_BLOCKED",
          blockedNights,
          status: 409,
        };
      }

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
          // Persisted capacity override (#1771): a waitlist force-confirm that
          // admits over the ceiling (!available under allowOverbook) stamps the
          // acting admin so payment-time re-checks honour it. Guarded — never
          // set when the force-confirm fit within capacity.
          ...(!available
            ? {
                capacityOverriddenAt: new Date(),
                capacityOverriddenByMemberId: session.user.id,
              }
            : {}),
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
      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
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

      // #1723 path 1 (owner decision B): a past-dated force-confirm that
      // lands PAYMENT_PENDING creates a card obligation for a stay that has
      // already finished. Allowed, but flagged at creation — in the audit
      // trail and in the response — so the admin who just created it knows it
      // now sits on the Unpaid Finished Stays queue.
      const createdUnpaidFinishedStay =
        nextStatus === BookingStatus.PAYMENT_PENDING &&
        booking.checkOut.getTime() <= clubTodayDateOnly.getTime();

      // #1769b honesty rule: record the notify choice only when a member email
      // was actually suppressed. The confirmation email only sends when the
      // booking lands PAID, so that is the only outcome a suppression is real.
      const notifyAuditFields =
        nextStatus === BookingStatus.PAID && notifyMember === false
          ? { notifyMember: false }
          : {};

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
          details: [
            nextStatus === BookingStatus.AWAITING_REVIEW
              ? "Admin force-confirmed waitlisted booking but it was parked for admin review."
              : overbooked
                ? "Admin force-confirmed waitlisted booking despite capacity being exceeded."
                : "Admin force-confirmed waitlisted booking.",
            ...(createdUnpaidFinishedStay
              ? [
                  "The stay's check-out date has already passed, so this created an unpaid finished stay; it appears on the Unpaid Finished Stays queue until payment is settled.",
                ]
              : []),
          ].join(" "),
          metadata: {
            createdUnpaidFinishedStay,
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
            ...notifyAuditFields,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
          retentionClass: overbooked ? "critical" : undefined,
          incidentPreserved: overbooked,
        },
        tx,
      );

      // #2576 §9. A waitlist force-confirm is a confirmation — §9 names "officer
      // approval" and "waitlist promotion" explicitly — and WAITLISTED /
      // WAITLIST_OFFERED are both outside `ACTIVE_BOOKING_STATUSES`, so a waitlisted
      // booking is invisible to the strand check that guards a source cancellation.
      // A member could therefore cancel the booking supplying cover (nothing
      // stranded, nothing queued) and an officer force-confirm this one straight to
      // PAID with no hosting evaluation at all.
      //
      // ENQUEUE rather than refuse: this is the officer's deliberate act on a
      // booking whose beds have just been claimed, possibly over capacity, so §8's
      // rule applies — allow the authoritative change, record the obligation in the
      // same transaction, and raise an urgent incident afterwards. Nothing is queued
      // when the booking parked for review instead of confirming.
      if (nextStatus !== BookingStatus.AWAITING_REVIEW) {
        await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
          cause: "SYSTEM_CHANGE",
          actorMemberId: session.user.id,
        });
      }

      return {
        success: true,
        booking,
        auditAction,
        overbookDates,
        overbooked,
        status: nextStatus,
        unpaidFinishedStay: createdUnpaidFinishedStay,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        {
          error: result.error,
          ...("code" in result ? { code: result.code } : {}),
          ...("overbookDates" in result ? { overbookDates: result.overbookDates } : {}),
          ...("blockedNights" in result ? { blockedNights: result.blockedNights } : {}),
        },
        { status: result.status as number }
      );
    }

    const { booking, overbooked, overbookDates, auditAction, status, unpaidFinishedStay } = result;

    // #2576 §9: drain what the force-confirm queued, now that it has committed.
    await settleHostingCoverageAfterCommit({ bookingId });

    if (status === BookingStatus.PAID && notifyMember !== false) {
      // Split-booking parent (#738/#1942): describe the provisional non-member
      // child so the force-confirm confirmation explains the separate later
      // charge. Read-only; null on non-split bookings.
      const provisionalGuests = await getProvisionalNonMemberChildSummary({
        id: booking.id,
        memberId: booking.memberId,
      });
      sendBookingConfirmedEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents,
        {
          lodgeId: booking.lodgeId,
          ...(provisionalGuests ? { provisionalGuests } : {}),
          ...(booking.promoRedemption?.promoCode
            ? {
                discountCents: booking.discountCents,
                promoAdjustmentCents: booking.promoAdjustmentCents,
                promoCode: booking.promoRedemption.promoCode.code,
              }
            : {}),
        },
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send confirmation after force-confirm"));
    }

    return NextResponse.json({
      success: true,
      auditAction,
      overbooked,
      overbookDates,
      status,
      unpaidFinishedStay,
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    logger.error({ err, bookingId }, "Failed to force-confirm waitlisted booking");
    return NextResponse.json({ error: "Failed to force-confirm booking" }, { status: 500 });
  }
}
