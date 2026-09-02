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
  loadSameGroupTripHosts,
  withSubscriptionSettlement,
} from "@/lib/adult-member-hosting-review";
import { groupTripIdentityForJoin } from "@/lib/group-trip-identity";
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
    /**
     * The Group Trip this party is JOINING, when it is joining one (#3038).
     *
     * THE PRE-PERSIST CASE THE EPIC'S CONTRACT NAMES. A join's group identity is
     * available strictly EARLIER than its `Booking` row is — it came from the
     * join code the joiner redeemed — so a party with no booking yet can still
     * be asked whether a sibling booking covers it. Taking it from the container
     * rather than from a row that does not exist is what makes that possible,
     * and it is exactly as canonical as the persisted answer: the
     * `GroupBookingJoin` this becomes will carry this same `groupBookingId`
     * (`INV-HOST-043`).
     *
     * REQUIRED, AND NULLABLE RATHER THAN OPTIONAL — the same choice, for the
     * same reason, that `GroupTripIdentityRow` makes about its two relations.
     * `null` is an ANSWER ("this party is joining no Group Trip"); optional
     * would be permission to say nothing, and saying nothing resolves to "no
     * Group Trip" SILENTLY. That silence is not hypothetical: this function
     * gained its third scope while `booking-exception-request-service.ts` kept
     * calling it with the two it already knew about, so a modification proposal
     * on a group-covered booking was re-judged group-blind and froze a hosting
     * violation that does not exist — put in front of an officer, and under
     * `HOLD` reserving beds for a hazard nobody has. With the field required the
     * compiler enumerates every call site and each has to state its answer out
     * loud. Unrepresentable beats policed (`INV-SSOT`).
     *
     * `null` for every ordinary create, including the ORGANISER's own booking —
     * a `GroupBooking` is opened on a booking that already exists, so at create
     * time there is no container and no siblings.
     */
    groupBookingId: string | null;
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
      : { participants: [] as HostingParticipant[], sourceIds: [] };

  // And the same again for a JOIN's Group Trip (#3038). The joiner's own booking
  // does not exist yet, so `id` is `null` — the shared coverage envelope adds no
  // self-exclusion for a row that cannot match a query anyway — while the
  // container's id is already authoritative. This is a preflight answer only;
  // the persisted reconciler repeats the read inside the creating transaction,
  // by which time the `GroupBookingJoin` row exists and resolves the identical
  // group.
  //
  // The same-owner sources are excluded, so an adult on a booking that is BOTH
  // this joiner's own and in this Group Trip is counted once, under the
  // narrower scope.
  const groupTripHosts =
    resolved.hostScopes.sameGroupTrip && input.groupBookingId
      ? await loadSameGroupTripHosts(
          {
            id: null,
            lodgeId: input.lodgeId,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
          },
          groupTripIdentityForJoin({ groupBookingId: input.groupBookingId }),
          db,
          sameOwnerHosts.sourceIds,
        )
      : { participants: [] as HostingParticipant[], sourceIds: [] };

  const participants: HostingParticipant[] = [
    ...input.guests.map((guest, index) => ({
      guestRef: `guest:${index}`,
      guestName: `${guest.firstName} ${guest.lastName}`.trim(),
      member: guest.memberId ? memberById.get(guest.memberId) ?? null : null,
      nights: proposedGuestNights(guest, input.checkIn, input.checkOut),
    })),
    ...sameOwnerHosts.participants,
    ...groupTripHosts.participants,
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
