/**
 * #2424 — a member may not learn the email address of a parent they share no
 * family group with.
 *
 * A parent link carries no shared-group requirement, so `GET /api/members/family`
 * could return the address of somebody outside the viewer's family entirely; and
 * since #2282 recorded parentage at any age, the reachable set includes
 * CHILDREN. Owner decision (2026-08-01): return a parent's email only where the
 * viewer shares a family group with that parent. Name and relationship still
 * show either way.
 *
 * The guard lives in `buildMemberFacingParentLinks`, on the server; these tests
 * assert on the ROUTE's JSON, so a client that merely stops rendering the field
 * cannot satisfy them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      // #2721: the family payload now also returns the VIEWER'S OWN recorded
      // dependants, read through `loadBookerDependants`. Empty here — these
      // cases are about a PARENT's address, and an own-dependant list does not
      // change what is disclosed about one.
      findMany: vi.fn().mockResolvedValue([]),
    },
    familyGroupMember: { findMany: vi.fn() },
    familyGroupJoinRequest: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi.fn(async () => ({ showOccupation: false })),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getMemberFamilyRoute } from "@/app/api/members/family/route";
import { buildParentLinks } from "@/lib/member-parent-links";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

const mockPrisma = prisma as unknown as {
  member: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  familyGroupMember: { findMany: ReturnType<typeof vi.fn> };
  familyGroupJoinRequest: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

/** A parent row as `FAMILY_MEMBER_PROFILE_SELECT` returns it. */
function parentRow(params: {
  id: string;
  firstName: string;
  email: string;
  ageTier?: string;
  groupIds?: string[];
}) {
  return {
    id: params.id,
    firstName: params.firstName,
    lastName: "Parent",
    email: params.email,
    ageTier: params.ageTier ?? "ADULT",
    active: true,
    canLogin: true,
    inheritEmailFromId: null,
    familyGroupMemberships: (params.groupIds ?? []).map((familyGroupId) => ({
      familyGroupId,
    })),
  };
}

function memberRow(params: {
  id: string;
  firstName: string;
  ageTier?: string;
  groupIds?: string[];
  canLogin?: boolean;
  parent?: ReturnType<typeof parentRow> | null;
  secondaryParent?: ReturnType<typeof parentRow> | null;
  detailsConfirmedByMemberId?: string | null;
  detailsConfirmedAt?: Date | null;
  detailsConfirmedBy?: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
}) {
  return {
    id: params.id,
    firstName: params.firstName,
    lastName: "Smith",
    ageTier: params.ageTier ?? "ADULT",
    active: true,
    canLogin: params.canLogin ?? true,
    role: "MEMBER",
    accessRoles: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    detailsConfirmedByMemberId: params.detailsConfirmedByMemberId ?? null,
    detailsConfirmedAt: params.detailsConfirmedAt ?? null,
    detailsConfirmedBy: params.detailsConfirmedBy ?? null,
    parent: params.parent ?? null,
    secondaryParent: params.secondaryParent ?? null,
    familyGroupMemberships: (params.groupIds ?? []).map((familyGroupId) => ({
      familyGroupId,
      familyGroup: { id: familyGroupId, name: `Group ${familyGroupId}` },
    })),
  };
}

type FamilyPayload = {
  familyMembers: Array<{
    id: string;
    parentLinks: Array<{
      id: string;
      firstName: string;
      lastName: string;
      parentLinkType: string;
      email?: string;
    }>;
  }>;
};

/**
 * The EXACT key sets the JSON may carry on each branch. Pinned as sorted key
 * arrays, not as "no `email` field": a builder that stopped whitelisting still
 * passes every field-by-field assertion while shipping the parent's whole row.
 */
const IN_GROUP_LINK_KEYS = [
  "active",
  "ageTier",
  "canLogin",
  "email",
  "firstName",
  "id",
  "inheritEmailFromId",
  "lastName",
  "parentLinkType",
];
/** No address AND no status for someone outside the viewer's family. */
const OUT_OF_GROUP_LINK_KEYS = [
  "firstName",
  "id",
  "inheritEmailFromId",
  "lastName",
  "parentLinkType",
];

async function fetchFamily(): Promise<FamilyPayload> {
  const res = await getMemberFamilyRoute();
  expect(res.status).toBe(200);
  return (await res.json()) as FamilyPayload;
}

function parentLinksFor(payload: FamilyPayload, memberId: string) {
  const member = payload.familyMembers.find((entry) => entry.id === memberId);
  expect(member, `member ${memberId} missing from payload`).toBeDefined();
  return member!.parentLinks;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "viewer" } });
  mockPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
  mockPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
  mockPrisma.familyGroupMember.findMany.mockResolvedValue([]);
});

describe("GET /api/members/family — parent email visibility (#2424)", () => {
  it("omits the email of a parent the viewer shares no family group with", async () => {
    const outsider = parentRow({
      id: "outsider",
      firstName: "Outsider",
      email: "outsider@example.test",
      groupIds: ["g-other"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: outsider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links).toHaveLength(1);
    // Name and relationship still show — the address and the status fields go.
    expect(links[0]).toMatchObject({
      id: "outsider",
      firstName: "Outsider",
      lastName: "Parent",
      parentLinkType: "PRIMARY",
    });
    expect(Object.keys(links[0]).sort()).toEqual(OUT_OF_GROUP_LINK_KEYS);
    expect(links[0]).not.toHaveProperty("email");
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
    expect(JSON.stringify(links)).not.toContain("outsider@example.test");
  });

  it("returns the email of a parent the viewer shares a family group with", async () => {
    const insider = parentRow({
      id: "insider",
      firstName: "Insider",
      email: "insider@example.test",
      groupIds: ["g1"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: insider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links).toHaveLength(1);
    expect(links[0].email).toBe("insider@example.test");
    // The sharing branch is a whitelist too — it does not hand over the row.
    expect(Object.keys(links[0]).sort()).toEqual(IN_GROUP_LINK_KEYS);
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
  });

  it("drops the address of a MINOR parent outside the viewer's groups (#2282)", async () => {
    // Parentage is recorded at any age since #2282, so the addresses this
    // payload could reach stopped being other adults' and started including
    // children's.
    const minorOutsider = parentRow({
      id: "minor-outsider",
      firstName: "Teen",
      email: "teen@example.test",
      ageTier: "YOUTH",
      groupIds: ["g-other"],
    });
    const minorInsider = parentRow({
      id: "minor-insider",
      firstName: "Teenie",
      email: "teenie@example.test",
      ageTier: "YOUTH",
      groupIds: ["g1"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "grandchild",
          firstName: "Grandchild",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: minorOutsider,
          secondaryParent: minorInsider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "grandchild");

    expect(links.map((link) => link.id)).toEqual([
      "minor-outsider",
      "minor-insider",
    ]);
    expect(links[0]).not.toHaveProperty("email");
    // Nor does the payload say that this named stranger is a YOUTH.
    expect(links[0]).not.toHaveProperty("ageTier");
    expect(links[1].email).toBe("teenie@example.test");
    expect(JSON.stringify(links)).not.toContain("teen@example.test");
  });

  it("applies the same rule to the viewer's OWN parents", async () => {
    // The viewer is not exempt: a parent of theirs who is in none of their
    // groups is still somebody they have no family-group relationship with.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({
        id: "viewer",
        firstName: "Viewer",
        groupIds: ["g1"],
        parent: parentRow({
          id: "my-outsider",
          firstName: "Estranged",
          email: "estranged@example.test",
          groupIds: [],
        }),
        secondaryParent: parentRow({
          id: "my-insider",
          firstName: "Together",
          email: "together@example.test",
          groupIds: ["g1"],
        }),
      }),
    );

    const links = parentLinksFor(await fetchFamily(), "viewer");

    expect(links[0]).not.toHaveProperty("email");
    expect(links[1].email).toBe("together@example.test");
  });

  it("asks the database for each parent's family groups", async () => {
    // Without this in the SELECT the guard has nothing to decide on and would
    // deny every address — a mocked client cannot notice a missing field, so
    // the query shape is pinned directly.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );

    await fetchFamily();

    const selfSelect = mockPrisma.member.findUnique.mock.calls[0][0].select;
    const groupSelect =
      // #2520: the family-group read is narrowed with `select`, not `include`,
      // so it never projects the retired FamilyGroupMember.role column.
      mockPrisma.familyGroupMember.findMany.mock.calls[0][0].select.member
        .select;
    for (const select of [selfSelect, groupSelect]) {
      for (const parentKey of ["parent", "secondaryParent"] as const) {
        expect(select[parentKey].select.familyGroupMemberships).toEqual({
          select: { familyGroupId: true },
        });
      }
    }
  });

  it("shares a group through ANY of the viewer's groups, not just the first", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1", "g2"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: parentRow({
            id: "second-group-parent",
            firstName: "Second",
            email: "second@example.test",
            groupIds: ["g2"],
          }),
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links[0].email).toBe("second@example.test");
  });
});

describe("GET /api/members/family — delegated-edit provenance (#2284 S3)", () => {
  type ProvenancePayload = {
    familyMembers: Array<{
      id: string;
      detailsConfirmedBy: { name: string; at: string | null } | null;
    }>;
  };

  async function fetchProvenance(memberId: string) {
    const res = await getMemberFamilyRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvenancePayload;
    return body.familyMembers.find((entry) => entry.id === memberId)!
      .detailsConfirmedBy;
  }

  it("names who confirmed a non-login member's details on their behalf, and when", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          canLogin: false,
          detailsConfirmedByMemberId: "viewer",
          detailsConfirmedAt: new Date("2026-05-24T09:00:00.000Z"),
          detailsConfirmedBy: {
            id: "viewer",
            firstName: "Vera",
            lastName: "Viewer",
          },
        }),
      },
    ]);

    expect(await fetchProvenance("child")).toEqual({
      name: "Vera Viewer",
      at: "2026-05-24",
    });
  });

  it("shows nothing for a self-confirmed member (the self-confirmed sentinel)", async () => {
    // Mutation guard: detailsConfirmedByMemberId === the member's own id means
    // they vouched for themselves, so there is no delegate to attribute.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({
        id: "viewer",
        firstName: "Viewer",
        groupIds: ["g1"],
        detailsConfirmedByMemberId: "viewer",
        detailsConfirmedAt: new Date("2026-05-24T09:00:00.000Z"),
        detailsConfirmedBy: { id: "viewer", firstName: "Vera", lastName: "Viewer" },
      }),
    );

    expect(await fetchProvenance("viewer")).toBeNull();
  });

  it("shows nothing when no details confirmation is recorded", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );

    expect(await fetchProvenance("viewer")).toBeNull();
  });

  /**
   * #2839 (MAD-A14) — the confirmed-on day is the CLUB's calendar day.
   *
   * `Member.detailsConfirmedAt` is a `DateTime` stamped with `now`, so
   * truncating it to its UTC day showed the PREVIOUS day for roughly the first
   * half of every New Zealand day (`INV-DATE-019`). It reached that pattern one
   * indirection away from the spelling, through the local `toDateInputValue`
   * wrapper that the date-only fields still use correctly.
   *
   * **The instants are chosen so a wrong zone FAILS them.** A comfortable
   * mid-morning NZ time passes under any zone from about UTC+10 up and pins
   * nothing. Each case below is either the exact first instant of a club day
   * (which a shallower zone such as `Australia/Brisbane` gets wrong) or sits in
   * the extra hour NZDT has over NZST (which any fixed +12 zone gets wrong).
   */
  describe("shows the club's calendar day, not the UTC day (#2839)", () => {
    beforeEach(() => {
      expectClubTimeZonePremise();
    });

    /**
     * Run the route with a delegated confirmation stamped at `confirmedAt` and
     * return the WHOLE provenance object, so a caller can tell "no provenance
     * at all" apart from "provenance with no day".
     */
    async function provenanceFor(confirmedAt: Date) {
      mockPrisma.member.findUnique.mockResolvedValue(
        memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
      );
      mockPrisma.familyGroupMember.findMany.mockResolvedValue([
        {
          member: memberRow({
            id: "child",
            firstName: "Child",
            ageTier: "CHILD",
            groupIds: ["g1"],
            canLogin: false,
            detailsConfirmedByMemberId: "viewer",
            detailsConfirmedAt: confirmedAt,
            detailsConfirmedBy: {
              id: "viewer",
              firstName: "Vera",
              lastName: "Viewer",
            },
          }),
        },
      ]);
      return fetchProvenance("child");
    }

    /** The rendered day only, for the boundary cases below. */
    async function confirmedDayFor(confirmedAt: Date) {
      return (await provenanceFor(confirmedAt))?.at ?? null;
    }

    it("dates a confirmation made at midnight NZST to the club day, not the UTC day before", async () => {
      // 15 June 2026 is NZST (UTC+12). Midnight exactly, so `Australia/Brisbane`
      // (+10) and UTC itself both still read 14 June and fail this pair.
      const firstInstantOfClubDay = new Date("2026-06-14T12:00:00.000Z");
      const lastInstantOfPreviousClubDay = new Date("2026-06-14T11:59:59.999Z");

      // Records the premise: this instant's UTC day is the day BEFORE the club
      // day asserted below, which is exactly what the old truncation showed.
      // It is NOT a drift guard — the instant is a fixed literal and cannot
      // drift — but it pins the instant to the day named here, so editing one
      // without the other fails on this line rather than three lines down.
      expect(firstInstantOfClubDay.toISOString().slice(0, 10)).toBe("2026-06-14");

      expect(await confirmedDayFor(firstInstantOfClubDay)).toBe("2026-06-15");
      // The far side of the same boundary pins the offset at exactly +12, so a
      // deeper zone cannot satisfy both halves.
      expect(await confirmedDayFor(lastInstantOfPreviousClubDay)).toBe("2026-06-14");
    });

    it("dates a confirmation made at midnight NZDT to the club day, not the UTC day before", async () => {
      // 15 January 2026 is NZDT (UTC+13). This boundary is an hour earlier in
      // UTC than the NZST one above, so a fixed +12 zone with no daylight
      // saving reads 23:00 on the 14th and fails.
      const firstInstantOfClubDay = new Date("2026-01-14T11:00:00.000Z");
      const lastInstantOfPreviousClubDay = new Date("2026-01-14T10:59:59.999Z");

      // Records the premise, as above — not a drift guard.
      expect(firstInstantOfClubDay.toISOString().slice(0, 10)).toBe("2026-01-14");

      expect(await confirmedDayFor(firstInstantOfClubDay)).toBe("2026-01-15");
      expect(await confirmedDayFor(lastInstantOfPreviousClubDay)).toBe("2026-01-14");
    });

    it("dates a confirmation made just after midnight NZDT to the club day", async () => {
      // 00:30 on 15 January 2026 — the member-facing scenario from the issue,
      // at a strength a fixed +12 zone (23:30 on the 14th) still fails.
      const justAfterMidnightNzdt = new Date("2026-01-14T11:30:00.000Z");

      // Records the premise, as above — not a drift guard.
      expect(justAfterMidnightNzdt.toISOString().slice(0, 10)).toBe("2026-01-14");

      expect(await confirmedDayFor(justAfterMidnightNzdt)).toBe("2026-01-15");
    });

    it("still shows nothing when no confirmation instant was recorded", async () => {
      // The club-calendar derivation must not invent a day out of `null`. The
      // WHOLE provenance object is asserted, not just its day: `at: null` on a
      // provenance that still names the confirmer is the intent, and a bare
      // `toBeNull()` on the day would also pass if the line vanished entirely.
      expect(await provenanceFor(null as unknown as Date)).toEqual({
        name: "Vera Viewer",
        at: null,
      });
    });
  });

  it("asks the database for the confirmer's name (whitelist addition)", async () => {
    // A mocked client cannot notice a missing SELECT field, so the query shape
    // is pinned directly — the provenance line depends on this relation.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );

    await getMemberFamilyRoute();

    const selfSelect = mockPrisma.member.findUnique.mock.calls[0][0].select;
    const groupSelect =
      // #2520: the family-group read is narrowed with `select`, not `include`,
      // so it never projects the retired FamilyGroupMember.role column.
      mockPrisma.familyGroupMember.findMany.mock.calls[0][0].select.member
        .select;
    for (const select of [selfSelect, groupSelect]) {
      expect(select.detailsConfirmedBy).toEqual({
        select: { id: true, firstName: true, lastName: true },
      });
    }
  });
});

describe("GET /api/member/onboarding — parent email visibility (#2424)", () => {
  // The onboarding payload lists the same family members through the same
  // builder, so it carried the same exposure and takes the same rule.

  /**
   * A group-member row exactly as `MEMBER_ONBOARDING_FAMILY_SELECT` returns
   * it — no `familyGroupMemberships` and no `inheritEmailFrom` at this level,
   * because the onboarding select asks for neither. The viewer's own row adds
   * `familyGroupMemberships` below, which its own select does read.
   */
  function onboardingMember(params: {
    id: string;
    parent?: ReturnType<typeof parentRow> | null;
  }) {
    return {
      id: params.id,
      email: `${params.id}@example.test`,
      firstName: "Fam",
      lastName: "Smith",
      role: "MEMBER",
      accessRoles: [],
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      profileCompletedAt: null,
      detailsConfirmedAt: null,
      detailsConfirmedByMemberId: null,
      onboardingConfirmedAt: null,
      inheritEmailFromId: null,
      parent: params.parent ?? null,
      secondaryParent: null,
    };
  }

  it("omits the email of a parent outside the viewer's family groups", async () => {
    mockPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
    mockPrisma.member.findUnique.mockResolvedValue({
      ...onboardingMember({ id: "viewer" }),
      familyGroupMemberships: [
        {
          familyGroupId: "g1",
          familyGroup: {
            id: "g1",
            name: "Smith Family",
            memberships: [
              {
                role: "MEMBER",
                member: onboardingMember({
                  id: "child",
                  parent: parentRow({
                    id: "outsider",
                    firstName: "Outsider",
                    email: "outsider@example.test",
                    groupIds: ["g-other"],
                  }),
                }),
              },
              {
                role: "MEMBER",
                member: onboardingMember({
                  id: "sibling",
                  parent: parentRow({
                    id: "insider",
                    firstName: "Insider",
                    email: "insider@example.test",
                    groupIds: ["g1"],
                  }),
                }),
              },
            ],
          },
        },
      ],
    });

    const { GET } = await import("@/app/api/member/onboarding/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      familyGroups: Array<{
        members: Array<{ id: string; parentLinks: Array<{ email?: string }> }>;
      }>;
    };

    const members = body.familyGroups[0].members;
    const child = members.find((entry) => entry.id === "child")!;
    const sibling = members.find((entry) => entry.id === "sibling")!;

    expect(child.parentLinks[0]).not.toHaveProperty("email");
    expect(sibling.parentLinks[0].email).toBe("insider@example.test");
    expect(JSON.stringify(body)).not.toContain("outsider@example.test");

    // Both branches are whitelists here too, pinned as exact key sets.
    expect(Object.keys(child.parentLinks[0]).sort()).toEqual(
      OUT_OF_GROUP_LINK_KEYS,
    );
    expect(Object.keys(sibling.parentLinks[0]).sort()).toEqual(
      IN_GROUP_LINK_KEYS,
    );

    // The family-scoped select is what feeds the guard; a mocked client cannot
    // notice it missing, so the query shape is pinned directly.
    const nestedSelect =
      mockPrisma.member.findUnique.mock.calls[0][0].select
        .familyGroupMemberships.select.familyGroup.select.memberships.select
        .member.select;
    for (const parentKey of ["parent", "secondaryParent"] as const) {
      expect(nestedSelect[parentKey].select.familyGroupMemberships).toEqual({
        select: { familyGroupId: true },
      });
    }
  });
});

describe("admin parent links are unchanged (#2424)", () => {
  it("buildParentLinks still carries the email for admin surfaces", () => {
    // The admin member detail payload builds its parent links from
    // `buildParentLinks`, which is deliberately untouched: this change narrows
    // the MEMBER-facing payload only.
    const links = buildParentLinks({
      parent: {
        id: "p1",
        firstName: "Pat",
        lastName: "Parent",
        email: "pat@example.test",
      },
      secondaryParent: {
        id: "p2",
        firstName: "Sam",
        lastName: "Parent",
        email: "sam@example.test",
      },
    });

    expect(links.map((link) => link.email)).toEqual([
      "pat@example.test",
      "sam@example.test",
    ]);
  });
});
