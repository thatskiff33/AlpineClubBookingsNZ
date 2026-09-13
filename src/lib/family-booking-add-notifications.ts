import { bookingOwner } from "@/lib/booking-owner";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  familyAdultDelegateResolver,
  type MemberGuestConsentDelegateResolver,
} from "@/lib/member-guest-delegate";
import { prisma } from "@/lib/prisma";

/**
 * The post-commit dispatcher for the family-scope "you were added to a booking"
 * FYI (#2284, S2).
 *
 * WHAT A "FAMILY-SCOPE ADD" IS. A guest row created with a `memberId` that is in
 * the booker's OWN family group and is not the booker themselves. Beyond-family
 * member guests are deliberately excluded: those are the MG2 flow's job, which
 * sends its own consent request or added-notice, and this must never double it.
 * The scope is decided by `computeMemberGuestBoundary` — the same
 * `getAllowedGuestMemberIds` set MG1's authorization and MG2's planner use — so
 * there is no second, drifting definition of "family".
 *
 * WHY IT RUNS REGARDLESS OF THE `memberGuests` MODULE. Owner decision (2 Aug
 * 2026): this is general family behaviour, not a member-guest feature. With the
 * module off, a family add is the ONLY cross-member add that can happen, and it
 * still deserves the notice; with the module on, family adds sit alongside
 * member-guest adds and each gets its own, appropriate message.
 *
 * DISCIPLINE, mirrored from `member-guest-consent-notifications.ts`:
 *  - Call AFTER the transaction commits — never inside it. An SES call under the
 *    per-lodge capacity lock would hold it across a network round trip.
 *  - Never rejects. The booking is already committed and paid for, so a
 *    notification problem is logged and reported in the result, never surfaced
 *    as a booking failure.
 *  - Each send is isolated: one recipient's failure stops nothing else.
 *  - Best-effort at-most-once, exactly like the booking-confirmation mail: no
 *    column records "told", so a failed send is logged and not retried.
 */

export interface FamilyBookingAddNotificationResult {
  /** Target members at least one of whose recipients was emailed (or withheld). */
  notifiedTargetMemberIds: string[];
  /** Target members where every recipient send threw. */
  failedTargetMemberIds: string[];
  /** Target members with nobody left to tell (see the note below). */
  unreachableTargetMemberIds: string[];
  /** Recipients skipped because they turned this FYI off in their preferences. */
  suppressedByPreferenceMemberIds: string[];
}

function fullName(member: {
  firstName?: string | null;
  lastName?: string | null;
}): string {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

export async function sendFamilyMemberBookingAddNotifications(params: {
  bookingId: string;
  /** The member whose family groups define "family scope" — the booking owner. */
  bookerMemberId: string;
  /** Who performed the add (session user); never told about their own action. */
  actorMemberId: string;
  /** Every member id this operation added as a guest (self and beyond-family ok). */
  addedMemberIds: readonly string[];
  db?: typeof prisma;
  delegateResolver?: MemberGuestConsentDelegateResolver;
}): Promise<FamilyBookingAddNotificationResult> {
  const {
    bookingId,
    bookerMemberId,
    actorMemberId,
    addedMemberIds,
    db = prisma,
    delegateResolver = familyAdultDelegateResolver,
  } = params;

  const result: FamilyBookingAddNotificationResult = {
    notifiedTargetMemberIds: [],
    failedTargetMemberIds: [],
    unreachableTargetMemberIds: [],
    suppressedByPreferenceMemberIds: [],
  };

  // Unique, non-empty, and never the booker on their own booking.
  const candidateIds = [
    ...new Set(
      addedMemberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ].filter((id) => id !== bookerMemberId);
  if (candidateIds.length === 0) {
    // The overwhelming majority of bookings: no family co-member added, no reads
    // and no sends. Returning here keeps this a genuine no-op.
    return result;
  }

  const boundary = await computeMemberGuestBoundary(db, bookerMemberId, candidateIds);
  const familyTargetIds = candidateIds.filter(
    (id) => boundary.scopeByMemberId.get(id) === "FAMILY",
  );
  if (familyTargetIds.length === 0) return result;

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });
  if (!booking) {
    logger.error(
      { bookingId, targetMemberIds: familyTargetIds },
      "Family booking-add notifications skipped: booking not found after commit",
    );
    result.failedTargetMemberIds.push(...familyTargetIds);
    return result;
  }

  const bookerName = fullName(bookingOwner(booking).member ?? {}) || "A family member";

  const targetMembers = await db.member.findMany({
    where: { id: { in: familyTargetIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(targetMembers.map((m) => [m.id, fullName(m)]));

  const { sendFamilyMemberBookingAddedEmail } = await import(
    "@/lib/email/family-booking"
  );

  for (const targetId of familyTargetIds) {
    let recipients;
    try {
      recipients = await delegateResolver.resolveNotificationRecipients({
        targetMemberId: targetId,
        db,
      });
    } catch (err) {
      logger.error(
        { err, bookingId, targetMemberId: targetId },
        "Failed to resolve family booking-add notification recipients",
      );
      result.failedTargetMemberIds.push(targetId);
      continue;
    }

    // The actor did the add and the booking owner gets the confirmation — both
    // already know, so neither is told again.
    const toTell = recipients.filter(
      (recipient) =>
        recipient.memberId !== actorMemberId &&
        recipient.memberId !== bookerMemberId,
    );

    if (toTell.length === 0) {
      // Nobody to tell, and that is a real state of the data, not an error: a
      // non-login member in no family group with an active login-holding adult
      // other than whoever added them. Made VISIBLE rather than swallowed.
      logger.info(
        { bookingId, targetMemberId: targetId },
        "Family booking-add notification has no recipient to tell",
      );
      logAudit({
        action: "booking.family_add.notification_unreachable",
        memberId: bookerMemberId,
        targetId: bookingId,
        subjectMemberId: targetId,
        entityType: "Booking",
        entityId: bookingId,
        category: "communication",
        severity: "info",
        outcome: "blocked",
        summary: "Family member could not be notified of a booking add",
      });
      result.unreachableTargetMemberIds.push(targetId);
      continue;
    }

    const prefs = await db.notificationPreference.findMany({
      where: { memberId: { in: toTell.map((recipient) => recipient.memberId) } },
      select: { memberId: true, bookingAddedByFamily: true },
    });
    const optedOut = new Set(
      prefs
        .filter((pref) => pref.bookingAddedByFamily === false)
        .map((pref) => pref.memberId),
    );

    let anyHandled = false;
    let anyFailed = false;
    for (const recipient of toTell) {
      if (optedOut.has(recipient.memberId)) {
        result.suppressedByPreferenceMemberIds.push(recipient.memberId);
        continue;
      }
      try {
        await sendFamilyMemberBookingAddedEmail({
          bookingId,
          recipient: { kind: "member", memberId: recipient.memberId },
          email: recipient.email,
          firstName: recipient.firstName,
          bookerName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          lodgeId: booking.lodgeId,
          audience: recipient.isTarget
            ? { kind: "TARGET" }
            : {
                kind: "DELEGATE",
                addedMemberName: nameById.get(targetId) || "a family member",
              },
        });
        anyHandled = true;
      } catch (err) {
        logger.error(
          { err, bookingId, targetMemberId: targetId, recipientMemberId: recipient.memberId },
          "Failed to send family booking-add notification",
        );
        anyFailed = true;
      }
    }

    if (anyHandled) result.notifiedTargetMemberIds.push(targetId);
    else if (anyFailed) result.failedTargetMemberIds.push(targetId);
  }

  return result;
}
