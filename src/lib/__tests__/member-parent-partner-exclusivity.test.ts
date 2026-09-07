import { describe, expect, it, vi } from "vitest";

import {
  DIRECT_PARENT_MEMBER_SELECT,
  MEMBER_PARTNER_RELATIONSHIP_SELECT,
  MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
  directParentPairWhere,
  hasAnyPartnerRelationship,
  hasDirectParentRelationship,
  isMemberParentPartnerExclusionViolation,
  loadMemberMergeExclusivityTopology,
  memberHasPartnerRelationshipWith,
  membersAreDirectParentPair,
  notDirectParentWithMemberWhere,
  notPartnerWithMemberWhere,
} from "@/lib/member-parent-partner-exclusivity";
import { collectPrismaErrorText } from "@/lib/prisma-errors";

const unrelated = {
  id: "member-a",
  parentMemberId: null,
  secondaryParentId: null,
};

describe("direct parent/partner exclusivity predicates", () => {
  it.each([
    ["first member primary", { ...unrelated, parentMemberId: "member-b" }, { ...unrelated, id: "member-b" }],
    ["first member secondary", { ...unrelated, secondaryParentId: "member-b" }, { ...unrelated, id: "member-b" }],
    ["second member primary", unrelated, { ...unrelated, id: "member-b", parentMemberId: "member-a" }],
    ["second member secondary", unrelated, { ...unrelated, id: "member-b", secondaryParentId: "member-a" }],
  ])("recognises %s parentage", (_label, memberOne, memberTwo) => {
    expect(membersAreDirectParentPair(memberOne, memberTwo)).toBe(true);
  });

  it("does not mistake unrelated parent pointers for the candidate pair", () => {
    expect(
      membersAreDirectParentPair(
        { ...unrelated, parentMemberId: "member-c" },
        { ...unrelated, id: "member-b", secondaryParentId: "member-d" },
      ),
    ).toBe(false);
  });

  it("derives one orientation-independent query covering both parent columns", () => {
    expect(directParentPairWhere("member-b", "member-a")).toEqual({
      OR: [
        {
          id: "member-b",
          OR: [
            { parentMemberId: "member-a" },
            { secondaryParentId: "member-a" },
          ],
        },
        {
          id: "member-a",
          OR: [
            { parentMemberId: "member-b" },
            { secondaryParentId: "member-b" },
          ],
        },
      ],
    });
  });

  it("uses the shared query for the authoritative transaction-client read", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "member-a" });

    await expect(
      hasDirectParentRelationship(
        { member: { findFirst } } as never,
        "member-a",
        "member-b",
      ),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: directParentPairWhere("member-a", "member-b"),
      select: { id: true },
    });
  });

  it("looks up any-status partner rows by the one canonical pair key", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "partner-link" });

    await expect(
      hasAnyPartnerRelationship(
        { memberPartnerLink: { findUnique } } as never,
        "member-z",
        "member-a",
      ),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        memberAId_memberBId: {
          memberAId: "member-a",
          memberBId: "member-z",
        },
      },
      select: { id: true },
    });
    expect(JSON.stringify(findUnique.mock.calls[0]?.[0])).not.toContain("status");
  });

  it("pins both loaded-row partner orientations to one select and predicate", () => {
    expect(MEMBER_PARTNER_RELATIONSHIP_SELECT).toEqual({
      partnerLinksAsMemberA: { select: { memberBId: true } },
      partnerLinksAsMemberB: { select: { memberAId: true } },
    });
    expect(
      memberHasPartnerRelationshipWith(
        {
          partnerLinksAsMemberA: [{ memberBId: "member-b" }],
          partnerLinksAsMemberB: [],
        },
        "member-b",
      ),
    ).toBe(true);
    expect(
      memberHasPartnerRelationshipWith(
        {
          partnerLinksAsMemberA: [],
          partnerLinksAsMemberB: [{ memberAId: "member-b" }],
        },
        "member-b",
      ),
    ).toBe(true);
  });

  it("derives direct-parent and any-status-partner selector exclusions", () => {
    expect(notDirectParentWithMemberWhere("member-a")).toEqual([
      { OR: [{ parentMemberId: null }, { parentMemberId: { not: "member-a" } }] },
      {
        OR: [
          { secondaryParentId: null },
          { secondaryParentId: { not: "member-a" } },
        ],
      },
      { dependents: { none: { id: "member-a" } } },
      { secondaryDependents: { none: { id: "member-a" } } },
    ]);
    expect(notPartnerWithMemberWhere("member-a")).toEqual([
      { partnerLinksAsMemberA: { none: { memberBId: "member-a" } } },
      { partnerLinksAsMemberB: { none: { memberAId: "member-a" } } },
    ]);
  });
});

describe("Prisma exclusion-error decoding", () => {
  it("walks adapter cause/originalMessage shapes", () => {
    const error = {
      meta: {
        driverAdapterError: {
          cause: {
            originalMessage: MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
          },
        },
      },
    };

    expect(collectPrismaErrorText(error)).toContain(
      MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
    );
    expect(isMemberParentPartnerExclusionViolation(error)).toBe(true);
  });

  it("recognises the pinned constraint name in nested detail", () => {
    expect(
      isMemberParentPartnerExclusionViolation({
        cause: { detail: MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT },
      }),
    ).toBe(true);
  });

  it("is cycle-safe while retaining error text reached through cause", () => {
    const outer: Record<string, unknown> = { message: "outer wrapper" };
    const inner: Record<string, unknown> = {
      originalMessage: MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
      cause: outer,
    };
    outer.cause = inner;

    expect(collectPrismaErrorText(outer)).toBe(
      `outer wrapper\n${MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE}`,
    );
    expect(isMemberParentPartnerExclusionViolation(outer)).toBe(true);
  });

  it("does not inspect arbitrary request-shaped fields", () => {
    expect(
      isMemberParentPartnerExclusionViolation({
        payload: MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
      }),
    ).toBe(false);
  });
});

describe("member merge topology projection", () => {
  it("sorts every participant and detects overlap after duplicate endpoints move", async () => {
    const db = {
      member: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "child-z",
            parentMemberId: "duplicate",
            secondaryParentId: null,
          },
          {
            id: "master",
            parentMemberId: null,
            secondaryParentId: null,
          },
          {
            id: "duplicate",
            parentMemberId: "discarded-parent",
            secondaryParentId: null,
          },
        ]),
      },
    };
    const links = [{ memberAId: "child-z", memberBId: "master" }];

    await expect(
      loadMemberMergeExclusivityTopology(
        db as never,
        "master",
        "duplicate",
        links,
        links,
      ),
    ).resolves.toEqual({
      participantIds: [
        "child-z",
        "discarded-parent",
        "duplicate",
        "master",
      ],
      conflictingPairCount: 1,
    });
    expect(db.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: DIRECT_PARENT_MEMBER_SELECT }),
    );
  });
});
