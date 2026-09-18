import type { AgeTier } from "@prisma/client";
import {
  membershipTypeAgeExemption,
  type MembershipTypeAgeExemption,
} from "./membership-types";
import { bookingOwner } from "@/lib/booking-owner";

// Shared age-tier enforcement (#2106).
//
// A member's stored `Member.ageTier` must stay consistent with two independent
// forces at EVERY write site that can touch it (member edit, self-service
// profile, delegated family details, seasonal-assignment save, roll-forward,
// bulk set-role). This single resolver decides the tier to persist so the rule
// can never drift between sites. Precedence, highest first:
//
//   1. org force            — organisation/school accounts (ORG access role or
//                             legacy SCHOOL role) are always N/A (#1440).
//   2. type force           — the member's CURRENT-season membership type is
//                             FORCED (allowed tiers == {N/A}); everyone on it is
//                             N/A.
//   3. manual N/A (ALLOWED) — an admin explicitly picked N/A and the type
//                             permits it (ALLOWED). A previously hand-picked N/A
//                             is preserved when nothing explicit is submitted.
//   4. person tier restore  — otherwise the member holds a real person tier:
//                             the explicit person pick, else the caller's
//                             precomputed `restorePersonTier` (DOB-derived when
//                             recomputing, else ADULT).
//
// Pure and DB-free: the caller resolves org-ness, the current-season type's
// exemption, and the person-tier fallback, then applies the returned tier.

export const NOT_APPLICABLE_TYPE_REJECTION_MESSAGE =
  "The N/A age tier applies only to organisation accounts and membership types configured to allow it.";

export type ResolveEnforcedAgeTierParams = {
  /** ORG access role (or legacy SCHOOL role) after this write. */
  isOrganisation: boolean;
  /**
   * Exemption of the member's current-season membership type, or null when the
   * member has no current-season assignment (no type force / no manual N/A).
   */
  typeExemption: MembershipTypeAgeExemption | null;
  /**
   * The age tier the write explicitly requests, when the caller carries a
   * user/admin selection (the member-edit dialog). `undefined`/`null` at
   * DOB-recompute sites, which never submit a tier directly.
   */
  requestedAgeTier?: AgeTier | null;
  /** Member's current stored tier (used to preserve a hand-picked N/A). */
  currentAgeTier: AgeTier;
  /**
   * The real person tier to persist when the member must hold one and no
   * explicit person tier was requested. The caller precomputes this: the
   * DOB-derived tier at recompute sites, the DOB-derived restore (else ADULT)
   * when un-forcing a previously-N/A member, or the member's current person
   * tier for an edit that does not touch age.
   */
  restorePersonTier: AgeTier;
};

export type ResolveEnforcedAgeTierResult =
  | { ok: true; ageTier: AgeTier }
  | { ok: false; error: string };

export function resolveEnforcedAgeTier(
  params: ResolveEnforcedAgeTierParams,
): ResolveEnforcedAgeTierResult {
  const {
    isOrganisation,
    typeExemption,
    requestedAgeTier,
    currentAgeTier,
    restorePersonTier,
  } = params;

  // 1. Org force — always N/A regardless of type, DOB or submitted tier.
  if (isOrganisation) {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 2. Type force — a FORCED (only-N/A) current-season type forces N/A.
  if (typeExemption === "FORCED") {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 3a. Explicit manual N/A request: only honoured when the type ALLOWS it.
  if (requestedAgeTier === "NOT_APPLICABLE") {
    if (typeExemption === "ALLOWED") {
      return { ok: true, ageTier: "NOT_APPLICABLE" };
    }
    return { ok: false, error: NOT_APPLICABLE_TYPE_REJECTION_MESSAGE };
  }

  // 3b. Explicit person tier wins (narrowed to a non-N/A tier by 3a above).
  if (requestedAgeTier) {
    return { ok: true, ageTier: requestedAgeTier };
  }

  // 3c. No explicit tier submitted. Preserve a previously hand-picked N/A while
  // the type still ALLOWS it (a DOB recompute must not silently un-set an
  // admin's manual N/A choice).
  if (currentAgeTier === "NOT_APPLICABLE" && typeExemption === "ALLOWED") {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 4. Restore/keep a real person tier.
  return { ok: true, ageTier: restorePersonTier };
}

// DB helper: resolve the age-exemption of a member's CURRENT-season membership
// type (the type whose allowed tiers gate whether the member may hold N/A).
// Returns null when the member has no assignment for the season — no type force
// and no manual-N/A permission apply. Typed structurally so it accepts the
// prisma client or a transaction client.
export interface MemberSeasonTypeExemptionClient {
  seasonalMembershipAssignment: {
    findUnique(args: {
      where: {
        memberId_seasonYear: { memberId: string; seasonYear: number };
      };
      select: {
        membershipType: {
          select: { allowedAgeTiers: { select: { ageTier: true } } };
        };
      };
    }): Promise<{
      membershipType: { allowedAgeTiers: Array<{ ageTier: AgeTier }> };
    } | null>;
  };
}

export async function loadMemberCurrentSeasonTypeExemption(
  db: MemberSeasonTypeExemptionClient,
  memberId: string,
  seasonYear: number,
): Promise<MembershipTypeAgeExemption | null> {
  const assignment = await db.seasonalMembershipAssignment.findUnique({
    where: { memberId_seasonYear: { memberId, seasonYear } },
    select: {
      membershipType: {
        select: { allowedAgeTiers: { select: { ageTier: true } } },
      },
    },
  });
  if (!assignment) {
    return null;
  }
  return membershipTypeAgeExemption(
    assignment.membershipType.allowedAgeTiers.map((tier) => tier.ageTier),
  );
}

// #2106 owner decision ("no frozen bookings"): a flip that makes a member
// age-exempt (N/A) is blocked while the member is still a linked guest on
// SOMEONE ELSE'S future booking — N/A members are not bookable guests, so those
// guest links must be removed first. This shared query is the single source for
// that block across every N/A-flip site (seasonal assignment save, admin member
// edit, bulk ORG grant) so they stay consistent. `today` is the NZ date-only
// "now"; a booking guest counts as future when its stayEnd is strictly after it.
export type FutureLinkedGuestBooking = {
  id: string;
  bookingId: string;
  stayStart: Date;
  stayEnd: Date;
  booking: {
    id: string;
    memberId: string | null;
    checkIn: Date;
    checkOut: Date;
  };
};

export interface FutureLinkedGuestClient {
  bookingGuest: {
    findMany(args: {
      where: {
        memberId: string;
        isMember: true;
        stayEnd: { gt: Date };
        booking: { deletedAt: null; memberId: { not: string } };
      };
      orderBy: Array<{ stayStart: "asc" }>;
      select: {
        id: true;
        bookingId: true;
        stayStart: true;
        stayEnd: true;
        booking: {
          select: {
            id: true;
            memberId: true;
            checkIn: true;
            checkOut: true;
          };
        };
      };
    }): Promise<FutureLinkedGuestBooking[]>;
  };
}

export async function loadFutureLinkedGuestBookingsForMember(
  db: FutureLinkedGuestClient,
  memberId: string,
  today: Date,
): Promise<FutureLinkedGuestBooking[]> {
  return db.bookingGuest.findMany({
    where: {
      memberId,
      isMember: true,
      stayEnd: { gt: today },
      booking: { deletedAt: null, memberId: { not: memberId } },
    },
    orderBy: [{ stayStart: "asc" }],
    select: {
      id: true,
      bookingId: true,
      stayStart: true,
      stayEnd: true,
      booking: {
        select: {
          id: true,
          memberId: true,
          checkIn: true,
          checkOut: true,
        },
      },
    },
  });
}

const LINKED_GUEST_SUMMARY_LIMIT = 10;

// Bounded serialization of the linked-guest block for a 409 body, matching the
// shape the seasonal-assignment preview surfaces.
export function summarizeFutureLinkedGuestBookings(
  guests: FutureLinkedGuestBooking[],
  formatDate: (date: Date) => string,
) {
  return {
    count: guests.length,
    truncatedCount: Math.max(0, guests.length - LINKED_GUEST_SUMMARY_LIMIT),
    list: guests.slice(0, LINKED_GUEST_SUMMARY_LIMIT).map((guest) => ({
      bookingGuestId: guest.id,
      bookingId: guest.bookingId,
      ownerMemberId: bookingOwner(guest.booking).memberId,
      checkIn: formatDate(guest.booking.checkIn),
      checkOut: formatDate(guest.booking.checkOut),
      stayStart: formatDate(guest.stayStart),
      stayEnd: formatDate(guest.stayEnd),
    })),
  };
}

export const LINKED_GUEST_NOT_APPLICABLE_BLOCK_MESSAGE =
  "This change would make the member age-exempt (N/A), but they are still a linked guest on future bookings owned by other members. Remove those guest links before making the member N/A.";
