import type { Prisma } from "@prisma/client";
import { collectPrismaErrorText } from "@/lib/prisma-errors";
import {
  canonicalPartnerPair,
  compareMemberIds,
} from "@/lib/member-partner-link-shared";

/** INV-LIFE-024: one pair cannot carry both relationship meanings. */
export const MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE =
  "The same two members cannot be both direct parent/dependant and partners.";

/**
 * Cross-language contract for Child B's PostgreSQL backstop. Keep these exact
 * values synchronized with the migration; the contract test deliberately pins
 * both so a SQL-only rename cannot turn a mixed-runtime race into a generic 500.
 */
export const MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT =
  "MemberParentPartnerExclusion_no_overlap";
export const MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE =
  "member_parent_partner_exclusion_conflict";

export type DirectParentMember = {
  id: string;
  parentMemberId: string | null;
  secondaryParentId: string | null;
};

export const DIRECT_PARENT_MEMBER_SELECT = {
  id: true,
  parentMemberId: true,
  secondaryParentId: true,
} as const;

/**
 * Loaded-row partner facts used by selectors and previews. The select, required
 * result shape, and orientation-independent predicate stay together so omitting
 * either canonical side is a compile-time error (INV-SSOT-001).
 */
export const MEMBER_PARTNER_RELATIONSHIP_SELECT = {
  partnerLinksAsMemberA: { select: { memberBId: true } },
  partnerLinksAsMemberB: { select: { memberAId: true } },
} satisfies Prisma.MemberSelect;

export type MemberPartnerRelationshipFacts = {
  partnerLinksAsMemberA: ReadonlyArray<{ memberBId: string }>;
  partnerLinksAsMemberB: ReadonlyArray<{ memberAId: string }>;
};

export function memberHasPartnerRelationshipWith(
  member: MemberPartnerRelationshipFacts,
  otherMemberId: string,
) {
  return (
    member.partnerLinksAsMemberA.some(
      (link) => link.memberBId === otherMemberId,
    ) ||
    member.partnerLinksAsMemberB.some(
      (link) => link.memberAId === otherMemberId,
    )
  );
}

/** Pure, orientation-independent direct-parent test for rows already read under lock. */
export function membersAreDirectParentPair(
  memberOne: DirectParentMember,
  memberTwo: DirectParentMember,
) {
  return (
    memberOne.parentMemberId === memberTwo.id ||
    memberOne.secondaryParentId === memberTwo.id ||
    memberTwo.parentMemberId === memberOne.id ||
    memberTwo.secondaryParentId === memberOne.id
  );
}

/** Query shape for re-reading a pair's parent columns after its locks are held. */
export function directParentPairWhere(
  memberOneId: string,
  memberTwoId: string,
): Prisma.MemberWhereInput {
  return {
    OR: [
      {
        id: memberOneId,
        OR: [
          { parentMemberId: memberTwoId },
          { secondaryParentId: memberTwoId },
        ],
      },
      {
        id: memberTwoId,
        OR: [
          { parentMemberId: memberOneId },
          { secondaryParentId: memberOneId },
        ],
      },
    ],
  };
}

type ParentRelationshipReader = Pick<Prisma.TransactionClient, "member">;

export async function hasDirectParentRelationship(
  db: ParentRelationshipReader,
  memberOneId: string,
  memberTwoId: string,
) {
  const relationship = await db.member.findFirst({
    where: directParentPairWhere(memberOneId, memberTwoId),
    select: { id: true },
  });
  return Boolean(relationship);
}

type PartnerRelationshipReader = Pick<
  Prisma.TransactionClient,
  "memberPartnerLink"
>;

/** Any partner row conflicts with direct parentage; status is intentionally absent. */
export async function hasAnyPartnerRelationship(
  db: PartnerRelationshipReader,
  memberOneId: string,
  memberTwoId: string,
) {
  const pair = canonicalPartnerPair(memberOneId, memberTwoId);
  const relationship = await db.memberPartnerLink.findUnique({
    where: { memberAId_memberBId: pair },
    select: { id: true },
  });
  return Boolean(relationship);
}

/**
 * Candidate-side filter excluding direct parentage in both orientations and
 * both parent columns. Nullable scalar checks are written explicitly so SQL's
 * three-valued logic cannot hide otherwise eligible rows (INV-LIFE-041).
 */
export function notDirectParentWithMemberWhere(
  memberId: string,
): Prisma.MemberWhereInput[] {
  return [
    { OR: [{ parentMemberId: null }, { parentMemberId: { not: memberId } }] },
    {
      OR: [
        { secondaryParentId: null },
        { secondaryParentId: { not: memberId } },
      ],
    },
    { dependents: { none: { id: memberId } } },
    { secondaryDependents: { none: { id: memberId } } },
  ];
}

/** Candidate-side filter excluding a partner row in either canonical role. */
export function notPartnerWithMemberWhere(
  memberId: string,
): Prisma.MemberWhereInput[] {
  return [
    { partnerLinksAsMemberA: { none: { memberBId: memberId } } },
    { partnerLinksAsMemberB: { none: { memberAId: memberId } } },
  ];
}

export function isMemberParentPartnerExclusionViolation(error: unknown) {
  const text = collectPrismaErrorText(error);
  return (
    text.includes(MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT) ||
    text.includes(MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE)
  );
}

type MergeTopologyReader = Pick<Prisma.TransactionClient, "member">;

export type MemberMergePartnerTopologyLink = {
  memberAId: string;
  memberBId: string;
};

export type MemberMergeExclusivityTopology = {
  participantIds: string[];
  conflictingPairCount: number;
};

function pairKey(memberOneId: string, memberTwoId: string) {
  const pair = canonicalPartnerPair(memberOneId, memberTwoId);
  return `${pair.memberAId}\u0000${pair.memberBId}`;
}

/**
 * Derive the parent/partner portion of a member merge's final topology. Only
 * edges incident to master or duplicate can change: inbound parent pointers
 * and partner endpoints move from duplicate to master, while the duplicate's
 * own outbound parent pointers are discarded. The returned participant set is
 * also the complete partner-lock set the merge must acquire before re-reading.
 */
export async function loadMemberMergeExclusivityTopology(
  db: MergeTopologyReader,
  masterId: string,
  duplicateId: string,
  currentPartnerLinks: readonly MemberMergePartnerTopologyLink[],
  projectedPartnerLinks: readonly MemberMergePartnerTopologyLink[],
): Promise<MemberMergeExclusivityTopology> {
  const members = await db.member.findMany({
    where: {
      OR: [
        { id: { in: [masterId, duplicateId] } },
        { parentMemberId: { in: [masterId, duplicateId] } },
        { secondaryParentId: { in: [masterId, duplicateId] } },
      ],
    },
    select: DIRECT_PARENT_MEMBER_SELECT,
  });

  const participants = new Set<string>([masterId, duplicateId]);
  const finalId = (memberId: string) =>
    memberId === duplicateId ? masterId : memberId;
  const parentPairs = new Set<string>();
  for (const member of members) {
    participants.add(member.id);
    if (member.parentMemberId) participants.add(member.parentMemberId);
    if (member.secondaryParentId) participants.add(member.secondaryParentId);
    // The duplicate row is deleted; its own outbound parent pointers do not
    // move onto the master (the established master-wins merge rule).
    if (member.id === duplicateId) continue;
    const childId = finalId(member.id);
    for (const parentIdBefore of [
      member.parentMemberId,
      member.secondaryParentId,
    ]) {
      if (!parentIdBefore) continue;
      const parentId = finalId(parentIdBefore);
      if (parentId !== childId) parentPairs.add(pairKey(childId, parentId));
    }
  }

  // Every current endpoint participates in the lock set even when the merge
  // planner will discard its link. That prevents a discarded row from hiding
  // a participant-set drift while ensuring only links that survive the same
  // authoritative PartnerLinkPlan can conflict with the projected parentage.
  for (const link of currentPartnerLinks) {
    participants.add(link.memberAId);
    participants.add(link.memberBId);
  }

  const partnerPairs = new Set<string>();
  for (const link of projectedPartnerLinks) {
    partnerPairs.add(pairKey(link.memberAId, link.memberBId));
  }

  let conflictingPairCount = 0;
  for (const pair of parentPairs) {
    if (partnerPairs.has(pair)) conflictingPairCount += 1;
  }

  return {
    participantIds: [...participants].sort(compareMemberIds),
    conflictingPairCount,
  };
}
