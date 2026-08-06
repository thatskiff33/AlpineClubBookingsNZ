import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AdminReviewStatus, BookingStatus, type Prisma } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { cancelBooking } from "@/lib/booking-cancel";
import {
  sendBookingReviewApprovedEmail,
  sendBookingReviewRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";

const reviewSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    // Optional when approving; required when rejecting so the member always
    // gets a reason.
    adminNotes: z.string().trim().max(2000).optional().default(""),
    // #1790: admin per-decision email choice. Absent/undefined = notify
    // (default), false = suppress the member-facing review email. Both member
    // sends here are unconditional, so a non-boolean is a 400 via this parse.
    notifyMember: z.boolean().optional(),
  })
  .refine((data) => data.status === "APPROVED" || data.adminNotes.length > 0, {
    message: "Admin notes are required when rejecting",
    path: ["adminNotes"],
  });

async function loadPendingReviewUnderEligibilityLocks(
  tx: Prisma.TransactionClient,
  bookingId: string,
  lodgeId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await acquireLodgeCapacityLock(tx, lodgeId);

  const current = await tx.booking.findUnique({
    where: { id: bookingId },
    include: { member: true },
  });
  if (
    !current ||
    current.deletedAt ||
    current.adminReviewStatus !== AdminReviewStatus.PENDING
  ) {
    return null;
  }
  return current;
}

// Approve/decline a booking request: a bookings write. Explicit bookings:edit
// matches the area the route-area matrix already infers for /api/admin/bookings
// (#1997), pairing the queue's view-only UI gating with a route-level guard.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id: bookingId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // A PENDING review can sit on a parked pre-payment booking
  // (AWAITING_REVIEW) or on a live paid/confirmed booking flagged by an edit
  // that left no adult (#1100) — both are decisioned here.
  if (booking.adminReviewStatus !== AdminReviewStatus.PENDING) {
    return NextResponse.json(
      { error: "This booking is not awaiting admin review" },
      { status: 409 },
    );
  }
  const reviewedAt = new Date();
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // #1790: only record the notify choice when a member email was actually
  // suppressed. Both review sends below are unconditional, so this reflects
  // exactly whether the admin opted out.
  const notifyAuditFields =
    parsed.data.notifyMember === false ? { notifyMember: false } : {};

  if (parsed.data.status === "APPROVED") {
    // Approval can make a live booking operationally eligible for the roster.
    // Join the roster's global -> immutable-lodge order, then re-read and claim
    // under those locks so an empty roster partition cannot validate the old
    // PENDING state and insert after this commit.
    const reviewedBooking = await prisma.$transaction(async (tx) => {
      const current = await loadPendingReviewUnderEligibilityLocks(
        tx,
        bookingId,
        booking.lodgeId,
      );
      if (!current) return null;

      const parkedForReview = current.status === BookingStatus.AWAITING_REVIEW;
      const claim = await tx.booking.updateMany({
        where: {
          id: bookingId,
          deletedAt: null,
          adminReviewStatus: AdminReviewStatus.PENDING,
          status: current.status,
        },
        data: {
          adminReviewStatus: AdminReviewStatus.APPROVED,
          adminReviewNotes: parsed.data.adminNotes || null,
          adminReviewedById: session.user.id,
          adminReviewedAt: reviewedAt,
          // Only a parked pre-payment booking is released toward payment; a
          // flagged paid/confirmed booking keeps its status (#1100) — the
          // approval clears the review, never re-opens the payment lifecycle.
          ...(parkedForReview ? { status: BookingStatus.PAYMENT_PENDING } : {}),
        },
      });
      if (claim.count !== 1) return null;

      await reconcileBedAllocationsForBookingWithLodgeLockHeld({ bookingId, db: tx });
      return current;
    });

    if (!reviewedBooking) {
      return NextResponse.json(
        { error: "This booking has already been reviewed" },
        { status: 409 },
      );
    }

    // #1790: approve always emails the member unless the admin chose not to
    // notify (default is notify; the suppression is audited below).
    if (parsed.data.notifyMember !== false) {
      sendBookingReviewApprovedEmail({
        email: reviewedBooking.member.email,
        firstName: reviewedBooking.member.firstName,
        checkIn: reviewedBooking.checkIn,
        checkOut: reviewedBooking.checkOut,
        adminNotes: parsed.data.adminNotes,
        bookingId,
        recipientMemberId: reviewedBooking.memberId,
        lodgeId: reviewedBooking.lodgeId,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking review approved email"),
      );
    }

    logAudit({
      action: "booking.review.approve",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: reviewedBooking.memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "booking",
      outcome: "success",
      summary: "Admin approved booking awaiting review",
      details: parsed.data.adminNotes,
      metadata: { decision: "APPROVED", ...notifyAuditFields },
      ipAddress,
    });

    return NextResponse.json({ success: true, decision: "APPROVED" });
  }

  // A rejected review remains operationally ineligible until cancellation has
  // finished. Claim it in the same global -> lodge order as approval and the
  // roster, eliminating the old PENDING -> REJECTED eligibility window. The
  // shared cancellation flow runs after commit because it owns its own global
  // transaction and may call payment providers outside that transaction.
  const reviewedBooking = await prisma.$transaction(async (tx) => {
    const current = await loadPendingReviewUnderEligibilityLocks(
      tx,
      bookingId,
      booking.lodgeId,
    );
    if (!current) return null;

    const legacyDraft = current.status === BookingStatus.DRAFT;
    const claim = await tx.booking.updateMany({
      where: {
        id: bookingId,
        deletedAt: null,
        adminReviewStatus: AdminReviewStatus.PENDING,
        status: current.status,
      },
      data: {
        adminReviewStatus: AdminReviewStatus.REJECTED,
        adminReviewNotes: parsed.data.adminNotes,
        adminReviewedById: session.user.id,
        adminReviewedAt: reviewedAt,
        ...(legacyDraft
          ? { status: BookingStatus.CANCELLED, draftExpiresAt: null }
          : {}),
      },
    });
    if (claim.count !== 1) return null;

    if (legacyDraft) {
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({ bookingId, db: tx });
    }
    return current;
  });

  if (!reviewedBooking) {
    return NextResponse.json(
      { error: "This booking has already been reviewed" },
      { status: 409 },
    );
  }

  // Legacy PENDING+DRAFT rows are rejected and cancelled in the claim above;
  // every other status uses the shared cancellation/refund flow after commit.
  if (reviewedBooking.status !== BookingStatus.DRAFT) {
    const cancelResult = await cancelBooking(
      bookingId,
      session.user.id,
      "ADMIN",
      ipAddress,
      "card",
    );

    // A concurrent cancel won the single-flight claim (#1160): surface the 409
    // rather than mislabelling it a 500. The review was already recorded and the
    // booking is being/has been cancelled, so this is a benign race, not a fault.
    if (cancelResult.status === 409) {
      return NextResponse.json(
        { error: cancelResult.error },
        { status: 409 },
      );
    }

    if ("error" in cancelResult) {
      logger.error(
        { bookingId, error: cancelResult.error },
        "Failed to cancel rejected booking",
      );
      return NextResponse.json(
        { error: "Review recorded but booking could not be cancelled", details: cancelResult.error },
        { status: 500 },
      );
    }
  }

  // #1790: reject always emails the member unless the admin chose not to
  // notify (default is notify; the suppression is audited below). This gates
  // only the rejection notice — the shared cancelBooking flow is untouched.
  if (parsed.data.notifyMember !== false) {
    sendBookingReviewRejectedEmail({
      bookingId: reviewedBooking.id,
      recipientMemberId: reviewedBooking.memberId,
      email: reviewedBooking.member.email,
      firstName: reviewedBooking.member.firstName,
      checkIn: reviewedBooking.checkIn,
      checkOut: reviewedBooking.checkOut,
      adminNotes: parsed.data.adminNotes,
      lodgeId: reviewedBooking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send booking review rejected email"),
    );
  }

  logAudit({
    action: "booking.review.reject",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: reviewedBooking.memberId,
    entityType: "Booking",
    entityId: bookingId,
    category: "booking",
    outcome: "success",
    summary: "Admin rejected booking awaiting review",
    details: parsed.data.adminNotes,
    metadata: { decision: "REJECTED", ...notifyAuditFields },
    ipAddress,
  });

  return NextResponse.json({ success: true, decision: "REJECTED" });
}
