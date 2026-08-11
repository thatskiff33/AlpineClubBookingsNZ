import { prisma } from "@/lib/prisma";
import {
  canonicalPartnerPair,
  PARTNER_LINK_CONFIRMED,
  PARTNER_LINK_PENDING,
} from "@/lib/member-partner-link-shared";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";

// Structural minimum rather than `typeof prisma | Prisma.TransactionClient`:
// callers hold differently-Omitted transaction clients (e.g. capacity.ts's,
// #1745), and all this module needs are these two delegates.
type DoubleBedSharingDb = Pick<typeof prisma, "member" | "memberPartnerLink">;

export type DoubleBedSharingEvidenceCode =
  | "live_bed_missing"
  | "not_double_bed"
  | "single_occupant"
  | "corrupt_occupant_cardinality"
  | "ineligible_guest_not_member"
  | "ineligible_same_member"
  | "ineligible_member_missing"
  | "ineligible_member_inactive"
  | "ineligible_not_adult"
  | "eligible_confirmed_partners"
  | "ineligible_partner_link_pending"
  | "ineligible_partner_link_absent"
  | "ineligible_partner_link_unrecognised";

export interface DoubleBedSharingFacts {
  bedType: string | null;
  otherOccupantCount: number;
  memberIdA: string | null;
  memberIdB: string | null;
  memberAExists: boolean;
  memberBExists: boolean;
  memberAActive: boolean | null;
  memberBActive: boolean | null;
  memberAAgeTier: string | null;
  memberBAgeTier: string | null;
  partnerLinkStatus: string | null;
}

/**
 * Pure form of the canonical sharing rule, suitable for read-only evidence.
 * The async predicates below delegate their final verdict here so diagnostics,
 * placement and capacity cannot drift into separate definitions.
 */
export function classifyDoubleBedSharingFacts(
  facts: DoubleBedSharingFacts,
): DoubleBedSharingEvidenceCode {
  if (facts.bedType === null) return "live_bed_missing";
  if (facts.bedType !== "DOUBLE") return "not_double_bed";
  if (facts.otherOccupantCount === 0) return "single_occupant";
  if (facts.otherOccupantCount !== 1) return "corrupt_occupant_cardinality";
  if (!facts.memberIdA || !facts.memberIdB) return "ineligible_guest_not_member";
  if (facts.memberIdA === facts.memberIdB) return "ineligible_same_member";
  if (!facts.memberAExists || !facts.memberBExists) {
    return "ineligible_member_missing";
  }
  if (facts.memberAActive !== true || facts.memberBActive !== true) {
    return "ineligible_member_inactive";
  }
  if (facts.memberAAgeTier !== "ADULT" || facts.memberBAgeTier !== "ADULT") {
    return "ineligible_not_adult";
  }
  if (facts.partnerLinkStatus === PARTNER_LINK_CONFIRMED) {
    return "eligible_confirmed_partners";
  }
  if (facts.partnerLinkStatus === PARTNER_LINK_PENDING) {
    return "ineligible_partner_link_pending";
  }
  return facts.partnerLinkStatus === null
    ? "ineligible_partner_link_absent"
    : "ineligible_partner_link_unrecognised";
}

/**
 * Whether two members may share one DOUBLE bed for a night (#1701).
 *
 * The signal is a CONFIRMED Partner/Husband/Wife relationship — a
 * `MemberPartnerLink` row (#1742). #1744 swapped this in for the interim v1
 * rule (two ADULT members sharing a FamilyGroup), which wrongly permitted
 * e.g. a parent and an adult child to share. This is the **single source of
 * truth** for the who-may-share rule: admin-board placement and the board UI
 * both go through here, so the eligibility signal changes only in this
 * function body — not in the placement/UI/capacity code around it.
 *
 * Deliberately strict: both ids must resolve to real, ACTIVE members, be
 * distinct, and be ageTier ADULT (links are ADULT-only and active-only at
 * creation; both re-checked here so a later tier correction or deactivation
 * blocks new placements even while a stale link row survives), and the pair
 * must hold a CONFIRMED link — a PENDING request grants nothing. Anything
 * else returns false so the caller can reject the placement with a clear
 * domain error. This gates NEW placements; already-placed second occupants
 * are swept when the pair breaks — link dissolve, member deactivation, or an
 * ADULT→minor tier correction — by the lock-held partner-share sweep in
 * bed-allocation-lifecycle.ts (#1756), so no future isSecondOccupant row
 * outlives its partner link or the active-adult precondition.
 */
export interface PartnerSharingCandidate {
  id: string;
  firstName: string;
  lastName: string;
  partnerOfMemberId: string;
  partnerOfName: string;
}

/**
 * Confirmed partners of the member guests already on a booking who could be
 * added as partner-sharers (#1746): active ADULT members holding a CONFIRMED
 * link with a booking member, and not themselves a guest on the booking yet.
 * Server-computed so the admin edit UI renders policy rather than
 * re-implementing it; the admission path (mayShareDoubleBed +
 * checkCapacityForPartnerSharedAdmission) still re-validates at apply time.
 *
 * "Member guests already on a booking" means two different sets here, and the
 * body explains why: only an operationally present guest may ANCHOR an offer
 * (owner decision D-12, #2307), but every guest — consented or not — counts as
 * already on the booking for the purpose of not being offered again.
 */
export async function listBookingPartnerSharingCandidates(
  bookingId: string,
  db: Pick<typeof prisma, "bookingGuest" | "memberPartnerLink" | "member"> = prisma,
): Promise<PartnerSharingCandidate[]> {
  // Fetched UNFILTERED on purpose — this one query does two different jobs, and
  // owner decision D-12 (#2307) applies to only one of them.
  //
  // The naive fix is to put OPERATIONALLY_PRESENT_GUEST_WHERE in this `where`.
  // It gets the first job right and the second one badly wrong. The ANCHORS
  // (whose partners become offers) must exclude an unconsented guest: nobody
  // should be offered a bed-share with a member who has not yet agreed to be on
  // the booking at all. But the "already a guest here" EXCLUSION set must
  // include them, because they ARE already a row on this booking — drop them
  // from it and the admin is offered the very member who is sitting there
  // PENDING, and adding them again is a duplicate guest row on a booking that
  // is already holding their bed (D-4).
  //
  // So: one query, one full set for the exclusion, one filtered set for the
  // anchors. Both halves are tested.
  const memberGuests = await db.bookingGuest.findMany({
    where: { bookingId, memberId: { not: null } },
    select: {
      memberId: true,
      firstName: true,
      lastName: true,
      consentStatus: true,
    },
  });

  // Job 2: every member already on this booking, consented or not.
  const guestIdSet = new Set(
    memberGuests
      .map((guest) => guest.memberId)
      .filter((id): id is string => Boolean(id)),
  );

  // Job 1: only the operationally present members may anchor an offer.
  const anchorMemberIds = [
    ...new Set(
      memberGuests
        .filter((guest) => isOperationallyPresentConsent(guest.consentStatus))
        .map((guest) => guest.memberId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (anchorMemberIds.length === 0) return [];

  const links = await db.memberPartnerLink.findMany({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      OR: [
        { memberAId: { in: anchorMemberIds } },
        { memberBId: { in: anchorMemberIds } },
      ],
    },
    select: { memberAId: true, memberBId: true },
  });
  if (links.length === 0) return [];

  // Candidate id -> the booking member they share with. At most one confirmed
  // partner per member, so a candidate maps to exactly one anchor; a link
  // whose both sides are already booking guests offers no candidate.
  //
  // Note which set each side is tested against, because they are different sets
  // (D-12, #2307): the ANCHOR side is identified from the filtered anchor set —
  // every link here was fetched because at least one side is an anchor — while
  // `other` is excluded against the FULL guest set, so a member already sitting
  // on this booking with PENDING consent is never offered as a new candidate.
  const anchorIdSet = new Set(anchorMemberIds);
  const candidateToAnchor = new Map<string, string>();
  for (const link of links) {
    const [inBooking, other] = anchorIdSet.has(link.memberAId)
      ? [link.memberAId, link.memberBId]
      : [link.memberBId, link.memberAId];
    if (!guestIdSet.has(other)) {
      candidateToAnchor.set(other, inBooking);
    }
  }
  if (candidateToAnchor.size === 0) return [];

  const candidates = await db.member.findMany({
    where: {
      id: { in: [...candidateToAnchor.keys()] },
      active: true,
      ageTier: "ADULT",
    },
    select: { id: true, firstName: true, lastName: true },
  });
  const anchorName = (anchorId: string) => {
    const anchor = memberGuests.find((guest) => guest.memberId === anchorId);
    return anchor ? `${anchor.firstName} ${anchor.lastName}`.trim() : "";
  };

  return candidates.map((candidate) => {
    const anchorId = candidateToAnchor.get(candidate.id) as string;
    return {
      id: candidate.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      partnerOfMemberId: anchorId,
      partnerOfName: anchorName(anchorId),
    };
  });
}

export async function mayShareDoubleBed(
  memberIdA: string,
  memberIdB: string,
  db: DoubleBedSharingDb = prisma,
): Promise<boolean> {
  if (!memberIdA || !memberIdB || memberIdA === memberIdB) return false;

  const members = await db.member.findMany({
    where: { id: { in: [memberIdA, memberIdB] } },
    select: { id: true, ageTier: true, active: true },
  });
  const memberA = members.find((member) => member.id === memberIdA);
  const memberB = members.find((member) => member.id === memberIdB);
  const baseFacts: DoubleBedSharingFacts = {
    bedType: "DOUBLE",
    otherOccupantCount: 1,
    memberIdA,
    memberIdB,
    memberAExists: Boolean(memberA),
    memberBExists: Boolean(memberB),
    memberAActive: memberA?.active ?? null,
    memberBActive: memberB?.active ?? null,
    memberAAgeTier: memberA?.ageTier ?? null,
    memberBAgeTier: memberB?.ageTier ?? null,
    partnerLinkStatus: null,
  };
  if (
    classifyDoubleBedSharingFacts(baseFacts) !==
    "ineligible_partner_link_absent"
  ) {
    return false;
  }

  // The link row is a canonical ordered pair (memberAId < memberBId), so one
  // indexed unique lookup covers both argument orders.
  const link = await db.memberPartnerLink.findUnique({
    where: { memberAId_memberBId: canonicalPartnerPair(memberIdA, memberIdB) },
    select: { status: true },
  });
  return (
    classifyDoubleBedSharingFacts({
      ...baseFacts,
      partnerLinkStatus: link?.status ?? null,
    }) === "eligible_confirmed_partners"
  );
}

/**
 * The batched form of `mayShareDoubleBed` — the SAME rule, asked once for many
 * candidate partners (#2251).
 *
 * A range assignment can meet a different occupying member on every night of a
 * double bed, and asking `mayShareDoubleBed` per pair inside the assignment's
 * transaction makes its statement count grow with the range. This answers the
 * whole set in two statements. The rule is deliberately re-stated here rather
 * than looped over the single-pair function, and is pinned to it by a parity
 * test (`double-bed-sharing.test.ts`): distinct real ACTIVE ADULT members on
 * both sides, plus a CONFIRMED link.
 *
 * Returns the subset of `candidateMemberIds` that may share a double with
 * `memberId`.
 */
export async function mayShareDoubleBedWith(
  memberId: string,
  candidateMemberIds: string[],
  db: DoubleBedSharingDb = prisma,
): Promise<Set<string>> {
  const candidates = [
    ...new Set(candidateMemberIds.filter((id) => id && id !== memberId)),
  ];
  if (!memberId || candidates.length === 0) return new Set();

  const members = await db.member.findMany({
    where: { id: { in: [memberId, ...candidates] } },
    select: { id: true, ageTier: true, active: true },
  });
  const activeAdults = new Set(
    members
      .filter((member) => member.ageTier === "ADULT" && member.active)
      .map((member) => member.id),
  );
  // The anchor itself must be a real, active adult, or nobody may share.
  if (!activeAdults.has(memberId)) return new Set();

  const eligibleCandidates = candidates.filter((id) => activeAdults.has(id));
  if (eligibleCandidates.length === 0) return new Set();

  // Link rows are canonical ordered pairs (memberAId < memberBId), so each
  // candidate contributes exactly one pair to look up.
  const links = await db.memberPartnerLink.findMany({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      OR: eligibleCandidates.map((id) => canonicalPartnerPair(memberId, id)),
    },
    select: { memberAId: true, memberBId: true },
  });

  const linked = new Set<string>();
  for (const link of links) {
    const other = link.memberAId === memberId ? link.memberBId : link.memberAId;
    if (eligibleCandidates.includes(other)) linked.add(other);
  }
  return linked;
}
