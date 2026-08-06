/**
 * F-COMP-04: Admin — Approve or Reject a Deletion Request
 * POST /api/admin/deletion-requests/[id]
 * Body: { action: "approve" | "reject", note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { cancelBooking } from "@/lib/booking-cancel";
import { logAudit } from "@/lib/audit";
import {
  EMPTY_ORPHANED_FAMILY_LINKS,
  readFamilyLinkOrphans,
} from "@/lib/member-family-link-orphans";
import { isFullAdmin, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail,
  sendAdminPartnerShareSweptAlert,
} from "@/lib/email";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
  // #1788: absent/undefined = notify (default), false = suppress the member
  // email. Only honoured on the REJECT path; the APPROVE path's final privacy
  // receipt (sendAccountDeletionApprovedEmail) always sends regardless. A
  // non-boolean value fails the parse below and returns 400.
  notifyMember: z.boolean().optional(),
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
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  let body: { action: "approve" | "reject"; note?: string; notifyMember?: boolean };
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
            financeAccessLevel: true,
            active: true,
            accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
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

      // #1788 honesty rule — record the suppression in the audit ONLY on a path
      // that truly would have sent. The member is emailed unless they have no
      // address on file (member.email is a required field, so in practice this
      // is always present) or the admin opted out.
      const suppressedNotifyAudit =
        member.email && body.notifyMember === false
          ? { notifyMember: false }
          : undefined;

      logAudit({
        action: "member.deletion_rejected",
        memberId: session.user.id,
        targetId: member.id,
        details: body.note ? `Note: ${body.note}` : "No note",
        ipAddress: ip,
        ...(suppressedNotifyAudit ? { metadata: suppressedNotifyAudit } : {}),
      });

      // #1788: email the member unless the admin opted out (default = notify).
      if (body.notifyMember !== false) {
        sendAccountDeletionRejectedEmail(
          member.email,
          member.firstName,
          body.note ?? ""
        ).catch((err) =>
          logger.error({ err, memberId: member.id }, "Failed to send deletion rejected email")
        );
      }

      return NextResponse.json({ message: "Deletion request rejected." });
    }

    // --- APPROVE ---

    // Admin-account guards (issue #1604). Approving a deletion request
    // anonymises the member and sets active=false, so it is a deactivate of
    // the target. A member cannot self-request deletion while holding admin
    // access, but a request made before promotion could later target an
    // admin, so re-check at this execution point. Fail fast here (before any
    // booking cancellation) on the actor-permission and invariant; the
    // last-admin check is repeated inside the anonymise transaction below for
    // race-safety.
    if (!isFullAdmin(session.user) && memberHoldsPrivilegedRole(member)) {
      return NextResponse.json(
        { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
        { status: 403 },
      );
    }
    if (await wouldRemoveLastFullAdmin(prisma, member.id)) {
      return NextResponse.json(
        { error: LAST_FULL_ADMIN_GUARD_MESSAGE },
        { status: 409 },
      );
    }

    // checkIn is @db.Date (NZ calendar date at UTC midnight). Use the date-only
    // "today" rather than a raw instant so a stay checking in today still counts
    // as future for the whole NZ day, not just the first ~13h (F32, #1888).
    const today = getTodayDateOnly();

    // 1. Block approval while future paid stays still need financial/lodge follow-up.
    const futurePaidBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: "PAID",
        checkIn: { gte: today },
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
        checkIn: { gte: today },
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
    let sweptShares: SweptPartnerSharedAllocation[] = [];
    // #2255: who was still pointed at this member when we anonymised them.
    let detachedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;
    await prisma.$transaction(async (tx) => {
      await acquireFuturePartnerSharedAllocationLocks(tx, [member.id]);
      await acquireMemberLifecycleLocks(tx, [member.id]);
      // Race-safe re-check of the last-admin invariant inside the mutation
      // transaction (issue #1604): the fail-fast check above ran before the
      // booking cleanup, so re-count against this transaction's read view.
      if (await wouldRemoveLastFullAdmin(tx, member.id)) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE);
      }

      // #1756: anonymisation deactivates the member and unlinks their guest
      // rows, breaking the double-bed sharing precondition. Sweep their future
      // shared-double placements now, while bookingGuest.memberId (nulled in
      // step 5 below) still identifies them. Second-occupant appearances on
      // OTHER members' bookings survive the own-booking cancellation above, so
      // this is not vacuously empty.
      sweptShares = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
        memberId: member.id,
        reason: "member_deactivated",
        db: tx,
      });

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
          // Billing-family removal sweep (#1932, E6): the member is leaving all
          // families here, so clear any billing-family selection they hold.
          billingFamilyGroupId: null,
        },
      });

      // 4. Remove from all family groups
      await tx.familyGroupMember.deleteMany({
        where: { memberId: member.id },
      });

      // #2255: anonymisation nulled this member's OWN inheritance pointer but
      // left every pointer aimed AT them untouched, so their dependants — and,
      // at four generations, their grandchildren — kept resolving club email to
      // the `@deleted.invalid` address this route had just written. That is a
      // hard bounce on every send, forever, with nothing on any screen saying
      // so. The lifecycle paths (cancellation, archive) already sweep those
      // pointers; this one now does too, and names who it detached in the audit
      // rather than only counting them.
      //
      // The parent LINKS are deliberately left in place: anonymisation keeps
      // the member row for history, so the family structure is still true even
      // though the person's details are gone. It is only the mailbox that has
      // to stop being used.
      detachedFamilyLinks = await readFamilyLinkOrphans(tx, member.id);
      await tx.member.updateMany({
        where: { inheritEmailFromId: member.id },
        data: { inheritEmailFromId: null, inheritParentEmail: false },
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

    if (sweptShares.length > 0) {
      // Post-commit, fire-and-forget (#1756). Uses the pre-anonymisation name
      // captured above — admins keep an actionable reference, consistent with
      // the audit trail this route already retains.
      sendAdminPartnerShareSweptAlert({
        memberName: `${member.firstName} ${member.lastName}`.trim(),
        partnerName: partnerShareSweepCounterpartNames(sweptShares, member.id),
        reason: describePartnerSharedSweepReason("member_deactivated"),
        nights: partnerShareSweepNights(sweptShares),
      }).catch((alertErr) => {
        logger.error(
          { err: alertErr, memberId: member.id, sweptCount: sweptShares.length },
          "Failed to send partner share sweep alert"
        );
      });
    }

    logAudit({
      action: "member.deletion_approved",
      memberId: session.user.id,
      targetId: member.id,
      details: `Account anonymised. Cancelled ${cancelledBookingIds.length} future bookings.${body.note ? ` Note: ${body.note}` : ""}`,
      ipAddress: ip,
      metadata: {
        detachedEmailInheritorIds: detachedFamilyLinks.emailInheritors.map(
          (inheritor) => inheritor.id,
        ),
        dependantIds: detachedFamilyLinks.dependants.map(
          (dependant) => dependant.id,
        ),
      },
    });

    return NextResponse.json({
      message: "Account deletion approved. Member data has been anonymised.",
      cancelledBookings: cancelledBookingIds.length,
      orphanedLinks: detachedFamilyLinks,
    });
  } catch (err) {
    if (err instanceof AdminAccountGuardError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    logger.error({ err, requestId: id }, "Failed to process deletion request");
    return NextResponse.json({ error: "Failed to process deletion request" }, { status: 500 });
  }
}
