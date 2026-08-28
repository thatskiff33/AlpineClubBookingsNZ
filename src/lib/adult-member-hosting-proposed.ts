/**
 * Adult-member hosting for a party that is not persisted yet (the create path).
 *
 * Split verbatim out of `adult-member-hosting-review.ts` (#3128). This is the
 * only hosting entry point whose input is a submitted party rather than
 * database rows, which is why it is separable at all: the engine never calls
 * it, so the import runs one way only.
 */
import { type PrismaClient } from "@prisma/client";

import {
  loadAdultMemberHostingPolicy,
  loadSameBookingOwnerHosts,
  withSubscriptionSettlement,
} from "@/lib/adult-member-hosting-review";
import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import {
  evaluateAdultMemberHostingWithPolicy,
  hostingModeIsActive,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";

/**
 * Evaluate a party that is not persisted yet (the create path).
 *
 * Create has to know BEFORE the transaction whether the rule will trip, because
 * that decides whether a member must supply a justification and whether an admin
 * booking on somebody's behalf must supply an explicit reason. It cannot read
 * guest rows, so it evaluates the submitted party, resolving each member-linked
 * guest against the live Member row.
 *
 * The result is used ONLY for those two decisions. The snapshot that gets stored
 * is always the one the reconciler derives from the persisted rows afterwards,
 * so `guestRef` values in a stored snapshot are always real `BookingGuest` ids
 * and two snapshots of the same booking are always comparable.
 */
export async function evaluateProposedAdultMemberHosting(
  db: Pick<
    PrismaClient,
    // #2543 adds the subscription/membership-type reads the host bridge needs.
    | "member"
    | "booking"
    | "adultMemberHostingPolicy"
    | "lodge"
    | "memberSubscription"
    | "seasonalMembershipAssignment"
    | "membershipType"
  >,
  input: {
    /** The authoritative prospective Booking.memberId. */
    bookingOwnerMemberId?: string | null;
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    guests: ReadonlyArray<{
      firstName: string;
      lastName: string;
      memberId?: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
    }>;
  },
): Promise<AdultMemberHostingPolicyExceptionViolation | null> {
  const resolved = await loadAdultMemberHostingPolicy(input.lodgeId, db);
  if (!hostingModeIsActive(resolved.mode)) return null;

  const memberIds = [
    ...new Set(
      input.guests
        .map((guest) => guest.memberId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const members = memberIds.length
    ? await db.member.findMany({
        where: { id: { in: memberIds } },
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      })
    : [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  // The proposed row does not exist yet, but SAME_BOOKING_OWNER is still a live
  // relationship: another eligible booking under the prospective Booking.memberId
  // may cover these exact lodge-nights. This is a preflight answer only; the
  // persisted reconciler repeats the read under the owner lock inside the create
  // transaction before it commits.
  const sameOwnerHosts =
    resolved.hostScopes.sameBookingOwner && input.bookingOwnerMemberId
      ? await loadSameBookingOwnerHosts(
          {
            id: "__proposed_booking__",
            memberId: input.bookingOwnerMemberId,
            lodgeId: input.lodgeId,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
          },
          db,
          [],
        )
      : [];

  const participants: HostingParticipant[] = [
    ...input.guests.map((guest, index) => ({
      guestRef: `guest:${index}`,
      guestName: `${guest.firstName} ${guest.lastName}`.trim(),
      member: guest.memberId ? memberById.get(guest.memberId) ?? null : null,
      nights: proposedGuestNights(guest, input.checkIn, input.checkOut),
    })),
    ...sameOwnerHosts,
  ];

  return evaluateAdultMemberHostingWithPolicy(
    // #2543 — the same bridge the persisted path applies, so a proposed party
    // and the booking it becomes cannot disagree about who may host.
    await withSubscriptionSettlement(
      participants,
      db,
      seasonYearOfStoredDate(input.checkIn),
    ),
    resolved,
  );
}

function proposedGuestNights(
  guest: {
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
  },
  checkIn: Date,
  checkOut: Date,
): string[] {
  if (guest.nights && guest.nights.length > 0) {
    return guest.nights.map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 10);
      if (entry instanceof Date) return formatDateOnly(entry);
      const stayDate = entry.stayDate;
      return typeof stayDate === "string"
        ? stayDate.slice(0, 10)
        : formatDateOnly(stayDate);
    });
  }
  const start = guest.stayStart ?? checkIn;
  const endExclusive = guest.stayEnd ?? checkOut;
  // A zero- or negative-width range yields no nights rather than throwing; the
  // booking's own date validation owns that refusal.
  if (endExclusive <= start) return [];
  return eachDateOnlyInRange(start, endExclusive).map(formatDateOnly);
}
