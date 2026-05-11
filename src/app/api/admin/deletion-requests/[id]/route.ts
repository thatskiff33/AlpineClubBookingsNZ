/**
 * F-COMP-04: Admin — Approve or Reject a Deletion Request
 * POST /api/admin/deletion-requests/[id]
 * Body: { action: "approve" | "reject", note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { cancelBooking } from "@/lib/booking-cancel";
import { logAudit } from "@/lib/audit";
import {
  sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

const CANCELLABLE_DELETION_BOOKING_STATUSES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: { action: "approve" | "reject"; note?: string };
  try {
    const raw = await request.json();
    body = actionSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

  try {
    const deletionRequest = await prisma.deletionRequest.findUnique({
      where: { id },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            active: true,
          },
        },
      },
    });

    if (!deletionRequest) {
      return NextResponse.json({ error: "Deletion request not found" }, { status: 404 });
    }

    if (deletionRequest.status !== "PENDING") {
      return NextResponse.json(
        { error: "This request has already been reviewed." },
        { status: 409 }
      );
    }

    const member = deletionRequest.member;

    if (body.action === "reject") {
      await prisma.deletionRequest.update({
        where: { id },
        data: {
          status: "REJECTED",
          adminNote: body.note ?? null,
          reviewedBy: session.user.id,
          reviewedAt: new Date(),
        },
      });

      logAudit({
        action: "member.deletion_rejected",
        memberId: session.user.id,
        targetId: member.id,
        details: body.note ? `Note: ${body.note}` : "No note",
        ipAddress: ip,
      });

      sendAccountDeletionRejectedEmail(
        member.email,
        member.firstName,
        body.note ?? ""
      ).catch((err) =>
        logger.error({ err, memberId: member.id }, "Failed to send deletion rejected email")
      );

      return NextResponse.json({ message: "Deletion request rejected." });
    }

    // --- APPROVE ---

    const now = new Date();

    // 1. Block approval while future paid stays still need financial/lodge follow-up.
    const futurePaidBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: "PAID",
        checkIn: { gte: now },
      },
      select: { id: true },
    });

    if (futurePaidBookings.length > 0) {
      const paidBookingIds = futurePaidBookings.map((booking) => booking.id);
      logger.warn(
        { memberId: member.id, paidBookingIds },
        "Blocked account deletion approval because future paid bookings remain active"
      );
      logAudit({
        action: "member.deletion_approval_blocked",
        memberId: session.user.id,
        targetId: member.id,
        details: `Future paid bookings must be resolved before anonymisation: ${paidBookingIds.join(", ")}`,
        ipAddress: ip,
        category: "privacy",
        severity: "important",
        outcome: "blocked",
      });

      return NextResponse.json(
        {
          error:
            "Account deletion cannot be approved while this member has future paid bookings. Cancel or refund the paid bookings first.",
          paidBookingIds,
        },
        { status: 409 }
      );
    }

    // 2. Cancel all future unpaid/hold bookings for the member.
    const futureBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: { in: [...CANCELLABLE_DELETION_BOOKING_STATUSES] },
        checkIn: { gte: now },
      },
      select: { id: true },
    });

    const cancelledBookingIds: string[] = [];
    const failedBookingIds: string[] = [];
    for (const booking of futureBookings) {
      const result = await cancelBooking(
        booking.id,
        session.user.id,
        "ADMIN",
        ip
      );
      if (result.status === 200) {
        cancelledBookingIds.push(booking.id);
      } else {
        failedBookingIds.push(booking.id);
        logger.warn(
          { bookingId: booking.id, memberId: member.id, result },
          "Failed to cancel booking during account deletion"
        );
      }
    }

    if (failedBookingIds.length > 0) {
      logAudit({
        action: "member.deletion_cleanup_failed",
        memberId: session.user.id,
        targetId: member.id,
        details: `Account deletion approval stopped; failed to cancel future bookings: ${failedBookingIds.join(", ")}`,
        ipAddress: ip,
        category: "privacy",
        severity: "critical",
        outcome: "failure",
      });

      return NextResponse.json(
        {
          error:
            "Account deletion could not be approved because future bookings could not be cancelled. No member data was anonymised.",
          failedBookingIds,
          cancelledBookings: cancelledBookingIds.length,
        },
        { status: 409 }
      );
    }

    // 3. Send confirmation email BEFORE anonymising (so we have real name/email).
    try {
      await sendAccountDeletionApprovedEmail(member.email, member.firstName);
    } catch (err) {
      logger.error({ err, memberId: member.id }, "Failed to send deletion approved email");
      // Continue — email failure should not block deletion
    }

    // 4-7: Anonymise atomically in a single transaction
    const anonymisedEmail = `deleted-${member.id.substring(0, 8)}@deleted.invalid`;
    await prisma.$transaction(async (tx) => {
      // 3. Anonymise the member record
      await tx.member.update({
        where: { id: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          email: anonymisedEmail,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          dateOfBirth: null,
          streetAddressLine1: null,
          streetAddressLine2: null,
          streetCity: null,
          streetRegion: null,
          streetPostalCode: null,
          streetCountry: null,
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
          passwordHash: "DELETED_ACCOUNT",
          active: false,
          xeroContactId: null,
          inheritEmailFromId: null,
        },
      });

      // 4. Remove from all family groups
      await tx.familyGroupMember.deleteMany({
        where: { memberId: member.id },
      });

      // 5. Anonymise BookingGuest names for this member's guest appearances
      await tx.bookingGuest.updateMany({
        where: { memberId: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          memberId: null,
        },
      });

      // 6. Mark deletion request as approved
      await tx.deletionRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          adminNote: body.note ?? null,
          reviewedBy: session.user.id,
          reviewedAt: new Date(),
        },
      });
    });

    logAudit({
      action: "member.deletion_approved",
      memberId: session.user.id,
      targetId: member.id,
      details: `Account anonymised. Cancelled ${cancelledBookingIds.length} future bookings.${body.note ? ` Note: ${body.note}` : ""}`,
      ipAddress: ip,
    });

    return NextResponse.json({
      message: "Account deletion approved. Member data has been anonymised.",
      cancelledBookings: cancelledBookingIds.length,
    });
  } catch (err) {
    logger.error({ err, requestId: id }, "Failed to process deletion request");
    return NextResponse.json({ error: "Failed to process deletion request" }, { status: 500 });
  }
}
