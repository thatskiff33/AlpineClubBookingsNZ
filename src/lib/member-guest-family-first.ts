import {
  assertLinkedBookingMembersCanBeBooked,
  computeMemberGuestBoundary,
  resolveLinkedBookingMembersWithBoundary,
  type BookingGuestLookupDb,
  type LinkedBookingMember,
} from "@/lib/booking-guests";
import type { MemberGuestBoundaryState } from "@/lib/member-guest-consent";
import { normalizeMemberIds } from "@/lib/member-id-normalization";

/**
 * FAMILY FIRST: resolve and gate the booker's own family before any member from
 * beyond it (#3770, `INV-GUEST-020`; owner decision 2 Oct 2026, issue comment
 * 5946598639).
 *
 * A refusal that can only be reached once a named member resolved tells the
 * caller that member is real. So every door that resolves a party for a member
 * splits the one lookup in two:
 *
 *  1. {@link resolveFamilyPhase} computes the boundary (it reads only the
 *     booker's family groups), lets the caller spend its throttle on it,
 *     refuses a beyond-family id outright where member guests are switched off
 *     (that refusal reads no member row, so it is the pre-#3770 answer, still
 *     first), and resolves and profile-gates the family with no collapse — so
 *     a family refusal is the same whether a named outsider is real or nobody;
 *  2. the caller runs its own family refusals, then
 *     {@link resolveBeyondFamilyPhase} resolves and gates the outsiders with
 *     D-8's collapse.
 *
 * This reverses the "cross-family refusal wins" order the profile gate keeps
 * when handed both at once; the gate itself is unchanged for other doors. The
 * two halves call the lookup with the caller's own `skipAuthorization` and
 * widening answers, so nothing about who may be booked moves.
 */
export type FamilyFirstOptions = {
  /** The member the booking is FOR; null for an organisation (#3369). */
  bookerMemberId: string | null;
  /** The person the profile gate judges as vouching for the guests. */
  actorMemberId: string | null;
  skipAuthorization: boolean;
  memberGuestWideningEnabled: boolean;
  profileGate: { actorRole?: string | null; onBehalfOfMemberId?: string | null };
  /** Spend a throttle on the boundary, before any member row is read. */
  onBoundaryResolved?: (boundary: MemberGuestBoundaryState) => Promise<void>;
};

export type FamilyPhase = {
  boundary: MemberGuestBoundaryState;
  beyondFamilyMemberIds: readonly string[];
  familyMembers: Map<string, LinkedBookingMember>;
};

export async function resolveFamilyPhase(
  db: BookingGuestLookupDb,
  memberIds: ReadonlyArray<string | null | undefined>,
  options: FamilyFirstOptions,
): Promise<FamilyPhase> {
  const claimed = normalizeMemberIds(memberIds);
  if (claimed.length === 0) {
    return {
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      beyondFamilyMemberIds: [],
      familyMembers: new Map(),
    };
  }
  const boundary = await computeMemberGuestBoundary(
    db,
    options.bookerMemberId,
    claimed,
  );
  if (options.onBoundaryResolved) await options.onBoundaryResolved(boundary);
  const beyond = new Set(boundary.beyondFamilyMemberIds);
  if (beyond.size > 0 && !options.skipAuthorization && !options.memberGuestWideningEnabled) {
    // Member guests are switched off: the lookup refuses any beyond-family id
    // before it reads a member row, so asking it here gives the club's own,
    // byte-identical refusal, still ahead of every family check (#3770 F4).
    await resolveLinkedBookingMembersWithBoundary(
      db,
      options.bookerMemberId,
      [...beyond],
      {
        skipAuthorization: options.skipAuthorization,
        memberGuestWideningEnabled: options.memberGuestWideningEnabled,
      },
    );
  }
  const family = await resolveLinkedBookingMembersWithBoundary(
    db,
    options.bookerMemberId,
    claimed.filter((id) => !beyond.has(id)),
    {
      skipAuthorization: options.skipAuthorization,
      memberGuestWideningEnabled: options.memberGuestWideningEnabled,
    },
  );
  await assertLinkedBookingMembersCanBeBooked(db, family.members, options.actorMemberId, {
    ...options.profileGate,
    crossFamilyMemberIds: [],
  });
  return {
    boundary,
    beyondFamilyMemberIds: boundary.beyondFamilyMemberIds,
    familyMembers: family.members,
  };
}

export async function resolveBeyondFamilyPhase(
  db: BookingGuestLookupDb,
  family: FamilyPhase,
  options: FamilyFirstOptions,
): Promise<Map<string, LinkedBookingMember>> {
  if (family.beyondFamilyMemberIds.length === 0) return new Map();
  const beyond = await resolveLinkedBookingMembersWithBoundary(
    db,
    options.bookerMemberId,
    [...family.beyondFamilyMemberIds],
    {
      skipAuthorization: options.skipAuthorization,
      memberGuestWideningEnabled: options.memberGuestWideningEnabled,
    },
  );
  await assertLinkedBookingMembersCanBeBooked(db, beyond.members, options.actorMemberId, {
    ...options.profileGate,
    // D-8: a blocked cross-family member gets the one neutral refusal instead of
    // their name, their missing profile fields and their login state.
    crossFamilyMemberIds: family.beyondFamilyMemberIds,
  });
  return beyond.members;
}
