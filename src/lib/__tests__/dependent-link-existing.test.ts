import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/admin/members/[id]/dependents/link/route";
import {
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";
import {
  DEPENDENT_PARENT_LINK_ERRORS,
  dependentLinkBlockers,
} from "@/lib/dependent-link-eligibility";
import { NO_INHERITABLE_EMAIL_SOURCE_MESSAGE } from "@/lib/member-parent-links";
import { MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE } from "@/lib/member-parent-partner-exclusivity";

type MockAccessRole = { role: string | null; roleDefinitionId?: string | null; roleDefinition?: unknown };

type MockMember = {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  // NOT_APPLICABLE is the age-EXEMPT tier (#1440, #2106), carried by
  // organisation accounts AND by age-exempt people — both of which #2282's
  // parent-side rule has to tell apart, so both appear in fixtures here.
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT" | "NOT_APPLICABLE";
  active: boolean;
  archivedAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
  canLogin: boolean;
  role: string;
  financeAccessLevel: string;
  accessRoles: MockAccessRole[];
  familyGroupMemberships: Array<{ familyGroupId: string }>;
  partnerLinksAsMemberA: Array<{ memberBId: string }>;
  partnerLinksAsMemberB: Array<{ memberAId: string }>;
};

/**
 * #2255: the fixture members no longer carry `dependents` /
 * `secondaryDependents` arrays. Downward edges are derived from the two parent
 * COLUMNS by the `findMany` stub below, so a fixture cannot claim a child it is
 * not actually the parent of — which is the only way a depth fixture could pass
 * while proving nothing.
 */

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
// A Membership Officer: admin-portal access but not a Full Admin.
const officerSession = { user: { id: "officer-1", role: "USER", accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] } } as any;
const adminAccessRoles: MockAccessRole[] = [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }];

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/members/parent-1/dependents/link", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeParent(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "parent-1",
    firstName: "Parent",
    lastName: "Member",
    email: "parent@example.com",
    ageTier: "ADULT",
    active: true,
    archivedAt: null,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    inheritEmailChoiceId: null,
    canLogin: true,
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [],
    familyGroupMemberships: [{ familyGroupId: "fg-1" }, { familyGroupId: "fg-2" }],
    partnerLinksAsMemberA: [],
    partnerLinksAsMemberB: [],
    ...overrides,
  };
}

function makeMember(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "target-1",
    firstName: "Target",
    lastName: "Member",
    email: "target@example.com",
    ageTier: "CHILD",
    active: true,
    archivedAt: null,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    inheritEmailChoiceId: null,
    canLogin: true,
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [],
    familyGroupMemberships: [],
    partnerLinksAsMemberA: [],
    partnerLinksAsMemberB: [],
    ...overrides,
  };
}

function setupTransaction(members: MockMember[]) {
  const membersById = new Map(members.map((member) => [member.id, member]));

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    member: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return membersById.get(where.id) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: any }) => {
        // Last-admin guard query (ACTIVE_FULL_ADMIN_WHERE): active + login +
        // ADMIN access-role row, optionally scoped to one id or excluding a set.
        if (where.accessRoles) {
          return members.filter((member) => {
            if (!member.active || !member.canLogin) return false;
            const holdsAdmin = member.accessRoles.some((r) => r.role === "ADMIN");
            if (!holdsAdmin) return false;
            if (typeof where.id === "string") return member.id === where.id;
            if (where.id?.notIn) return !where.id.notIn.includes(member.id);
            return true;
          }).length;
        }
        // Shared-email orphan check.
        return members.filter((member) => member.email === where.email && member.id !== where.id.not).length;
      }),
      findFirst: vi.fn(async ({ where }: { where: { email: string; id: { not: string }; canLogin: boolean } }) => {
        return members.find(
          (member) =>
            member.email === where.email &&
            member.id !== where.id.not &&
            member.canLogin === where.canLogin
        ) ?? null;
      }),
      // #2255: the two query shapes the family-link walks issue — "these ids"
      // (walking up, and re-reading a level for email resolution) and "children
      // of these ids" (walking down). Implemented from the parent COLUMNS, so
      // the fixtures' downward edges cannot disagree with their upward ones.
      findMany: vi.fn(async ({ where }: { where: any }) => {
        if (where?.id?.in) {
          const wanted = new Set<string>(where.id.in);
          return members.filter((member) => wanted.has(member.id));
        }
        if (where?.OR) {
          const parentIds = new Set<string>(
            where.OR.flatMap((clause: any) => [
              ...(clause.parentMemberId?.in ?? []),
              ...(clause.secondaryParentId?.in ?? []),
            ])
          );
          return members.filter(
            (member) =>
              (member.parentMemberId && parentIds.has(member.parentMemberId)) ||
              (member.secondaryParentId && parentIds.has(member.secondaryParentId))
          );
        }
        throw new Error(
          `unexpected member.findMany shape: ${JSON.stringify(where)}`
        );
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const member = membersById.get(where.id);
        if (!member) return null;
        return {
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          ageTier: member.ageTier,
          parentMemberId: data.parent?.connect?.id ?? member.parentMemberId,
          secondaryParentId: data.secondaryParent?.connect?.id ?? member.secondaryParentId,
          inheritEmailFromId: data.inheritEmailFrom?.connect?.id ?? member.inheritEmailFromId,
          inheritEmailChoiceId:
            data.inheritEmailChoice?.connect?.id ?? member.inheritEmailChoiceId,
          canLogin: data.canLogin ?? member.canLogin,
        };
      }),
    },
    memberPartnerLink: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    familyGroupMember: {
      upsert: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
  };

  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx));

  return tx;
}

/** A root parent and a childless candidate: the ordinary case. */
const NO_ANCESTORS_NO_DEPENDANTS = {
  parentAncestorIds: [] as string[],
  parentAncestorGenerations: 0,
  candidateDescendantGenerations: 0,
};

async function linkDependent(body: Record<string, unknown>, parentId = "parent-1") {
  return POST(makeRequest(body), { params: Promise.resolve({ id: parentId }) });
}

describe("POST /api/admin/members/[id]/dependents/link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("links a child with default side effects", async () => {
    const tx = setupTransaction([makeParent(), makeMember({ ageTier: "CHILD" })]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: ["fg-1", "fg-2"],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1" },
        data: expect.objectContaining({
          parent: { connect: { id: "parent-1" } },
          inheritParentEmail: true,
          inheritEmailFrom: { connect: { id: "parent-1" } },
          canLogin: false,
        }),
      })
    );
    expect(tx.familyGroupMember.upsert).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "member.dependent.link",
          memberId: "admin-1",
          targetId: "target-1",
        }),
      })
    );
  });

  it("links an adult with all side effects off", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ ageTier: "ADULT", canLogin: true, inheritEmailFromId: "existing-source" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { parent: { connect: { id: "parent-1" } } },
      })
    );
    expect(tx.familyGroupMember.upsert).not.toHaveBeenCalled();
  });

  it("links a target that already has one parent as a second parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ parentMemberId: "other-parent" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1" },
        data: expect.objectContaining({
          secondaryParent: { connect: { id: "parent-1" } },
          inheritParentEmail: true,
          inheritEmailFrom: { connect: { id: "parent-1" } },
        }),
      })
    );
  });

  it("rejects a target that already has two parents", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ parentMemberId: "other-parent", secondaryParentId: "second-parent" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/two parents/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  /**
   * #2255 (D9) replaces the assertion that used to live here.
   *
   * It read: "rejects a target that already has dependants" — the
   * two-generation cap. That rule is gone by owner decision, so the test goes
   * with it rather than being patched to keep passing: a test that disagrees
   * with the required behaviour is the thing that changes, and the reasoning is
   * recorded here so nobody restores the old assertion by reflex.
   *
   * Worth recording alongside it: the rule it pinned was never the rule the
   * docs claimed. It refused ATTACHING a member who already had dependants, but
   * said nothing about the parent's own ancestors, so a chain could be grown
   * downwards a leaf at a time without any refusal at all. What replaces it is
   * symmetric, and therefore actually a cap.
   */
  describe("four-generation cap (#2255, D9)", () => {
    it("links a target who has dependants of their own, if the chain fits", async () => {
      // parent-1 is a root, target-1 heads one generation: the result is three
      // generations. Refused outright before #2255; the whole point of D9.
      const tx = setupTransaction([
        makeParent(),
        makeMember(),
        makeMember({ id: "grandchild-1", parentMemberId: "target-1" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalled();
    });

    it("links a fourth generation", async () => {
      const tx = setupTransaction([
        makeParent({ parentMemberId: "grandparent-1" }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT", parentMemberId: "great-1" }),
        makeMember({ id: "great-1", ageTier: "ADULT" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalled();
    });

    it("refuses a fifth generation, naming the cap", async () => {
      const tx = setupTransaction([
        // parent-1 already sits three links below great-1.
        makeParent({ parentMemberId: "grandparent-1" }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT", parentMemberId: "great-1" }),
        makeMember({ id: "great-1", ageTier: "ADULT", parentMemberId: "great-great-1" }),
        makeMember({ id: "great-great-1", ageTier: "ADULT" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses a link that JOINS two chains past the cap", async () => {
      // Neither side breaches the cap alone — the parent has two generations
      // above, the target one below — but the join makes five. This is the case
      // the old guard could not see, and the reason "build it from the middle
      // outwards" used to slip through.
      const tx = setupTransaction([
        makeParent({ parentMemberId: "grandparent-1" }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT", parentMemberId: "great-1" }),
        makeMember({ id: "great-1", ageTier: "ADULT" }),
        makeMember(),
        makeMember({ id: "grandchild-1", parentMemberId: "target-1" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("counts depth through SECOND parent links exactly like first ones", async () => {
      // Same five generations, every edge in the second-parent slot. A depth
      // walk that only read `parentMemberId` would see a lone root and accept.
      const tx = setupTransaction([
        makeParent({ secondaryParentId: "grandparent-1" }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT", secondaryParentId: "great-1" }),
        makeMember({ id: "great-1", ageTier: "ADULT", secondaryParentId: "great-great-1" }),
        makeMember({ id: "great-great-1", ageTier: "ADULT" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });
  });

  /**
   * Cycles were previously unreachable by accident: every ancestor of the parent
   * necessarily has a dependant, so the two-generation guard excluded the whole
   * ancestor set before the ancestry walk could matter. With that cover gone the
   * walk is the ONLY thing standing between an admin and a family loop, so it is
   * exercised at every depth, on both parent columns, and from both directions
   * the chain could have been assembled in.
   */
  describe("cycle prevention at depth (#2255)", () => {
    const chainOfFour = () => [
      makeParent({ id: "gen-4", ageTier: "ADULT", parentMemberId: "gen-3" }),
      makeMember({ id: "gen-3", ageTier: "ADULT", parentMemberId: "gen-2" }),
      makeMember({ id: "gen-2", ageTier: "ADULT", parentMemberId: "gen-1" }),
      makeMember({ id: "gen-1", ageTier: "ADULT" }),
    ];

    for (const [parentId, ancestorId] of [
      ["gen-2", "gen-1"],
      ["gen-3", "gen-2"],
      ["gen-3", "gen-1"],
      ["gen-4", "gen-3"],
      ["gen-4", "gen-2"],
      ["gen-4", "gen-1"],
    ]) {
      it(`refuses linking ${ancestorId} under its descendant ${parentId}`, async () => {
        const tx = setupTransaction(chainOfFour());

        const res = await linkDependent(
          {
            memberId: ancestorId,
            inheritEmail: false,
            disableLogin: false,
            addToFamilyGroupIds: [],
          },
          parentId
        );

        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatch(/ancestor/i);
        expect(tx.member.update).not.toHaveBeenCalled();
      });
    }

    it("refuses a loop built entirely from SECOND parent links", async () => {
      const tx = setupTransaction([
        makeParent({ id: "gen-3", ageTier: "ADULT", secondaryParentId: "gen-2" }),
        makeMember({ id: "gen-2", ageTier: "ADULT", secondaryParentId: "gen-1" }),
        makeMember({ id: "gen-1", ageTier: "ADULT" }),
      ]);

      const res = await linkDependent(
        {
          memberId: "gen-1",
          inheritEmail: false,
          disableLogin: false,
          addToFamilyGroupIds: [],
        },
        "gen-3"
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/ancestor/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses a loop through a MIXED chain of first and second parent links", async () => {
      // gen-1 -> gen-2 through the first slot, gen-2 -> gen-3 through the
      // second. A walk that gave up at the first missing `parentMemberId` would
      // stop at gen-2 and accept the loop.
      const tx = setupTransaction([
        makeParent({ id: "gen-3", ageTier: "ADULT", secondaryParentId: "gen-2" }),
        makeMember({ id: "gen-2", ageTier: "ADULT", parentMemberId: "gen-1" }),
        makeMember({ id: "gen-1", ageTier: "ADULT" }),
      ]);

      const res = await linkDependent(
        {
          memberId: "gen-1",
          inheritEmail: false,
          disableLogin: false,
          addToFamilyGroupIds: [],
        },
        "gen-3"
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/ancestor/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses the same loop when the chain was built from the middle outwards", async () => {
      // The stored graph is identical whichever link was created first — which
      // is the point. This fixture is the b->c-then-a->b assembly order, and it
      // must be refused at exactly the same place as the top-down one above.
      const tx = setupTransaction([
        makeParent({ id: "c", ageTier: "ADULT", parentMemberId: "b" }),
        makeMember({ id: "b", ageTier: "ADULT", parentMemberId: "a" }),
        makeMember({ id: "a", ageTier: "ADULT" }),
      ]);

      const res = await linkDependent(
        {
          memberId: "a",
          inheritEmail: false,
          disableLogin: false,
          addToFamilyGroupIds: [],
        },
        "c"
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/ancestor/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });
  });

  it("rejects disabling login when it would orphan a shared-email cluster", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ email: "shared@example.com", canLogin: true }),
      makeMember({
        id: "shared-dependent",
        email: "shared@example.com",
        canLogin: false,
      }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/only login holder/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects linking the parent's parent as a dependant", async () => {
    const tx = setupTransaction([
      makeParent({ parentMemberId: "grandparent-1" }),
      makeMember({
        id: "grandparent-1",
        email: "grandparent@example.com",
        ageTier: "ADULT",
        canLogin: true,
      }),
    ]);

    const res = await linkDependent({
      memberId: "grandparent-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/ancestor/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects family groups that the parent does not belong to", async () => {
    const tx = setupTransaction([
      makeParent({ familyGroupMemberships: [{ familyGroupId: "fg-1" }] }),
      makeMember(),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: ["fg-2"],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/family groups the parent belongs to/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  // #2254: the route's row-level guards and the admin candidate SEARCH
  // (`dependentLinkEligibleFor` in admin-members-service) are one predicate.
  // These cases pin the route half; the SQL half — including the NULL
  // semantics that made the search hide valid members — is pinned against real
  // generated SQL in dependent-link-eligibility.test.ts.
  describe("shared eligibility predicate (#2254)", () => {
    it("rejects an archived target", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({ archivedAt: new Date("2026-01-01T00:00:00.000Z") }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/archived/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("rejects a target already linked to this parent", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({ parentMemberId: "parent-1" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/already linked to that parent/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("rejects a target already linked to this parent as the second parent", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({ parentMemberId: "other-parent", secondaryParentId: "parent-1" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/already linked to that parent/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it.each([
      {
        orientation: "candidate is member A",
        partnerShape: {
          partnerLinksAsMemberA: [{ memberBId: "parent-1" }],
        },
      },
      {
        orientation: "candidate is member B",
        partnerShape: {
          partnerLinksAsMemberB: [{ memberAId: "parent-1" }],
        },
      },
    ])(
      "rejects an existing partner before every parent/email/family side effect ($orientation)",
      async ({ partnerShape }) => {
        const tx = setupTransaction([
          makeParent(),
          makeMember(partnerShape),
        ]);

        const res = await linkDependent({
          memberId: "target-1",
          inheritEmail: true,
          disableLogin: true,
          addToFamilyGroupIds: ["fg-1"],
        });

        expect(res.status).toBe(422);
        expect((await res.json()).error).toBe(
          MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE,
        );
        expect(tx.member.update).not.toHaveBeenCalled();
        expect(tx.familyGroupMember.upsert).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();

        const lockTexts = tx.$executeRaw.mock.calls.map((call) =>
          call.flat().join(" "),
        );
        expect(lockTexts).toHaveLength(4);
        expect(lockTexts.slice(0, 2).every((text) =>
          text.includes("member-lifecycle:"),
        )).toBe(true);
        expect(lockTexts.slice(2).every((text) =>
          text.includes("member-partner-link:"),
        )).toBe(true);
      },
    );

    it("rejects the parent as their own dependant", async () => {
      const tx = setupTransaction([makeParent()]);

      const res = await linkDependent({
        memberId: "parent-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/their own dependant/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    // The deliberate #2254 decision: the write route rejects an archived
    // target but NOT an inactive one, so the candidate search must keep
    // offering inactive members (the dialog badges them "Inactive"). If this
    // ever starts failing, the search's `active` filter has to change with it.
    it("accepts an inactive target", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({ active: false }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalled();
    });

    it("accepts every shape the shared predicate clears, and no other", async () => {
      // #2255: each case now carries the extra members that give the target its
      // DEPTH, because depth is a graph fact rather than a column — and the
      // expectation is derived from the same predicate the route uses, fed the
      // same graph facts, so the two cannot be made to agree by accident.
      const cases: Array<{
        shape: Partial<MockMember>;
        extras?: MockMember[];
        graph: Parameters<typeof dependentLinkBlockers>[2];
      }> = [
        { shape: {}, graph: NO_ANCESTORS_NO_DEPENDANTS },
        { shape: { active: false }, graph: NO_ANCESTORS_NO_DEPENDANTS },
        { shape: { parentMemberId: "other-parent" }, graph: NO_ANCESTORS_NO_DEPENDANTS },
        { shape: { secondaryParentId: "other-parent" }, graph: NO_ANCESTORS_NO_DEPENDANTS },
        {
          shape: { parentMemberId: "other-parent", secondaryParentId: "another-parent" },
          graph: NO_ANCESTORS_NO_DEPENDANTS,
        },
        {
          shape: {},
          extras: [makeMember({ id: "grandchild-1", parentMemberId: "target-1" })],
          graph: { ...NO_ANCESTORS_NO_DEPENDANTS, candidateDescendantGenerations: 1 },
        },
        {
          shape: {},
          extras: [makeMember({ id: "grandchild-2", secondaryParentId: "target-1" })],
          graph: { ...NO_ANCESTORS_NO_DEPENDANTS, candidateDescendantGenerations: 1 },
        },
        {
          shape: {},
          extras: [
            makeMember({ id: "grandchild-3", parentMemberId: "target-1" }),
            makeMember({ id: "great-grandchild-3", parentMemberId: "grandchild-3" }),
            makeMember({ id: "great-great-3", parentMemberId: "great-grandchild-3" }),
          ],
          graph: { ...NO_ANCESTORS_NO_DEPENDANTS, candidateDescendantGenerations: 3 },
        },
        {
          shape: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
          graph: NO_ANCESTORS_NO_DEPENDANTS,
        },
        { shape: { parentMemberId: "parent-1" }, graph: NO_ANCESTORS_NO_DEPENDANTS },
      ];

      for (const { shape, extras = [], graph } of cases) {
        vi.clearAllMocks();
        vi.mocked(auth).mockResolvedValue(adminSession);
        const target = makeMember(shape);
        setupTransaction([makeParent(), target, ...extras]);

        const res = await linkDependent({
          memberId: "target-1",
          inheritEmail: false,
          disableLogin: false,
          addToFamilyGroupIds: [],
        });

        const label = JSON.stringify({ shape, extras: extras.map((m) => m.id) });
        expect({
          label,
          accepted: res.status === 200,
        }).toEqual({
          label,
          accepted: dependentLinkBlockers("parent-1", target, graph).length === 0,
        });
      }
    });
  });

  /**
   * #2255 (D9): where a dependant's club email actually goes.
   *
   * Resolution walks UP from the chosen parent to the nearest ancestor who can
   * receive mail, and stores that TERMINAL member — never the middleman — so
   * every reader keeps its single `inheritEmailFrom` join. "Can receive mail"
   * means adult, not archived, and not a walk-in placeholder address.
   */
  /**
   * #2716 REPLACED THIS BLOCK. It was "transitive email inheritance (#2255)" and
   * it pinned a walk up the family tree: past a middle generation with no
   * address, past a second one up to the cap, nearest-first, primary edge
   * winning a tie. The owner narrowed all of that to the direct parent, so what
   * those cases described is now the behaviour this block proves ABSENT.
   *
   * The pointer and the CHOICE are asserted together on every write, because a
   * write that recorded only the pointer would leave a member whose inheritance
   * could never be restored once the parent's address was removed.
   */
  describe("direct-parent email inheritance (#2716)", () => {
    const placeholder = "walk-in-abc@no-email.invalid";

    it("uses the direct parent when they have a real address", async () => {
      const tx = setupTransaction([makeParent(), makeMember()]);

      await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inheritEmailFrom: { connect: { id: "parent-1" } },
            inheritEmailChoice: { connect: { id: "parent-1" } },
          }),
        })
      );
    });

    it("refuses when the parent themselves inherits, rather than storing their source", async () => {
      // This used to store the grandparent, on the reasoning that stored
      // inheritance must stay flat. One hop makes the question different: a
      // parent who inherits is not a mailbox at all, and their `email` column is
      // a stale copy of the address they inherit. So there is nothing to store.
      const tx = setupTransaction([
        makeParent({
          inheritEmailFromId: "grandparent-1",
          inheritEmailChoiceId: "grandparent-1",
        }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses rather than reaching past a middle generation with no address", async () => {
      // THE case the owner ruled on. The grandparent has a perfectly good
      // mailbox and is one hop further up; the answer is still no. A grandparent
      // who supplies an email for one grandchild does not thereby expect
      // notifications for a branch of the family they may have no involvement
      // with.
      const tx = setupTransaction([
        makeParent({ email: placeholder, parentMemberId: "grandparent-1" }),
        makeMember({
          id: "grandparent-1",
          ageTier: "ADULT",
          email: "grandparent@example.com",
        }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("names only the parent in the refusal, not an ancestor who cannot help", async () => {
      // The message used to offer "no parent OR ANCESTOR in this family has a
      // real email address", which described a walk that no longer happens and
      // would send an admin to record an address on somebody it changes nothing
      // for.
      setupTransaction([
        makeParent({ email: placeholder, parentMemberId: "grandparent-1" }),
        makeMember({ id: "grandparent-1", ageTier: "ADULT" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      const { error } = await res.json();
      expect(error).toMatch(/This parent has no email address/i);
      expect(error).not.toMatch(/ancestor/i);
    });

    it("refuses a non-adult parent rather than looking past them", async () => {
      // #2282 records that parentage may be stated at any age; being the club's
      // contact of record for someone else is a responsibility function and
      // stays adult-gated. Under one hop the consequence is a refusal rather
      // than a longer walk.
      const tx = setupTransaction([
        makeParent({ ageTier: "YOUTH", parentMemberId: "great-1" }),
        makeMember({ id: "great-1", ageTier: "ADULT", email: "great@example.com" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses the link rather than silently storing no inheritance", async () => {
      // The admin asked for the child's mail to reach a parent. Quietly leaving
      // it on the child's own address is how a family stops hearing from the
      // club without anyone noticing, so this is a 422.
      const tx = setupTransaction([
        makeParent({ email: placeholder }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/no email address the club can send to/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses a pre-existing family loop before email resolution is reached", async () => {
      // Data predating the cap could contain a loop. On THIS route the depth
      // walk sees it first and refuses, so email resolution never runs.
      const tx = setupTransaction([
        makeParent({ email: placeholder, parentMemberId: "loop-a" }),
        makeMember({
          id: "loop-a",
          ageTier: "ADULT",
          email: "walk-in-loop@no-email.invalid",
          parentMemberId: "parent-1",
        }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(tx.member.update).not.toHaveBeenCalled();
    });
  });

  /**
   * #2282: WHO MAY BE RECORDED AS A PARENT, versus who may take responsibility.
   *
   * The owner decision is that parentage is a FACT and is recordable at any age
   * — a 16 or 17 year old can genuinely be a parent, and the club previously had
   * to leave the child apparently parentless or hang them off a grandparent.
   * What did NOT move is the responsibility side: the contact of record for the
   * child's mail is still an adult, and this route proves it by resolving PAST
   * the young parent.
   *
   * Mutation probes, three, failing differently on purpose:
   *  - restore `parent.ageTier !== "ADULT"` to the route's guard and
   *    "records a YOUTH member as a parent" fails;
   *  - drop `!parent.active` and "refuses an inactive parent" fails;
   *  - drop `parent.archivedAt` and "refuses an archived parent" fails.
   * A fourth lives on the adult gate itself: delete `ageTier === "ADULT"` from
   * `isUsableEmailSource` and "refuses rather than routing the child's mail past
   * the young parent" fails, because the link is accepted with the 16-year-old
   * as the source.
   */
  describe("young parents (#2282)", () => {
    it("records a YOUTH member as a parent", async () => {
      const tx = setupTransaction([
        makeParent({ ageTier: "YOUTH" }),
        makeMember({ ageTier: "INFANT" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "target-1" },
          data: expect.objectContaining({
            parent: { connect: { id: "parent-1" } },
          }),
        })
      );
    });

    it("records a CHILD member as a parent too — no age floor was added", async () => {
      // Not a realistic club record on its own, but the point of the decision is
      // that the system stores the family as stated rather than second-guessing
      // it, and a quietly re-introduced floor at (say) 13 would be exactly the
      // same bug in a smaller size.
      const tx = setupTransaction([
        makeParent({ ageTier: "CHILD" }),
        makeMember({ ageTier: "INFANT" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalled();
    });

    it("refuses rather than routing the child's mail past the young parent (#2716)", async () => {
      // This case USED to succeed, landing on the grandparent. #2716 removed
      // that route: a grandparent who supplies an email for one grandchild does
      // not thereby expect notifications for a branch of the family they may
      // have no involvement with. So the responsibility gate still holds — a
      // 16-year-old is not made the club's contact of record — but the remedy is
      // now to record an address for the young parent rather than to reach past
      // them, and the refusal says exactly that.
      const tx = setupTransaction([
        makeParent({
          ageTier: "YOUTH",
          email: "teen-parent@example.com",
          parentMemberId: "grandparent-1",
        }),
        makeMember({
          id: "grandparent-1",
          ageTier: "ADULT",
          email: "gran@example.com",
        }),
        makeMember({ ageTier: "INFANT" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(
        /no email address the club can send to/i
      );
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses rather than making the young parent the contact of record", async () => {
      // No adult above them: the email-inheritance gate holds and the link is
      // refused outright. Storing the minor's own address, or silently storing
      // no inheritance, are both the failure this refusal exists to prevent.
      const tx = setupTransaction([
        makeParent({ ageTier: "YOUTH", email: "teen-parent@example.com" }),
        makeMember({ ageTier: "INFANT" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(NO_INHERITABLE_EMAIL_SOURCE_MESSAGE);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses a young parent named EXPLICITLY as the notification recipient", async () => {
      // The picker offers the linked parents by name, so an admin can name the
      // 16-year-old directly. That selection resolves through the same rule as
      // the default, and under #2716 the rule answers "this parent or nobody" —
      // so naming the minor is refused rather than quietly redirected to the
      // grandparent, which is a member the admin did not choose.
      const tx = setupTransaction([
        makeParent({
          ageTier: "YOUTH",
          email: "teen-parent@example.com",
          parentMemberId: "grandparent-1",
        }),
        makeMember({
          id: "grandparent-1",
          ageTier: "ADULT",
          email: "gran@example.com",
        }),
        makeMember({ ageTier: "INFANT" }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: true,
        inheritEmailFromId: "parent-1",
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses an inactive parent, naming the way out", async () => {
      const tx = setupTransaction([
        makeParent({ active: false }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(
        DEPENDENT_PARENT_LINK_ERRORS.INACTIVE
      );
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses an archived parent, and says ARCHIVED rather than INACTIVE", async () => {
      // Archiving also clears `active`, so an order-blind check would tell the
      // admin to "reactivate" a member whose actual problem is that they are
      // archived — and reactivating an archived record is not the way out.
      const tx = setupTransaction([
        makeParent({ active: false, archivedAt: new Date("2026-01-01") }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(
        DEPENDENT_PARENT_LINK_ERRORS.ARCHIVED
      );
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    /**
     * #2282 review. Dropping the ADULT clause dropped the only thing keeping
     * organisation and school accounts out of the parent side: `NOT_APPLICABLE`
     * is forced on them, and nothing downstream refuses them — the notification
     * picker's "use their own email" option makes the link succeed without ever
     * touching the adult-gated email source. So a child could be stored as a
     * school's child. The owner's decision was about AGE, and an organisation is
     * not an age.
     */
    it("refuses an ORGANISATION parent, by role and not by age tier", async () => {
      const tx = setupTransaction([
        makeParent({
          role: "SCHOOL",
          ageTier: "NOT_APPLICABLE",
          accessRoles: [{ role: "ORG", roleDefinitionId: null }],
        }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(
        DEPENDENT_PARENT_LINK_ERRORS.ORGANISATION
      );
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("still ACCEPTS an age-exempt human parent on the same tier", async () => {
      // The half a tier-based exclusion would get wrong. `NOT_APPLICABLE` is
      // the age-EXEMPT tier (#1440, #2106) and real people carry it — an admin
      // on an age-exempt membership type, say. They are ordinary members and
      // may be recorded as a parent like anyone else.
      const tx = setupTransaction([
        makeParent({ ageTier: "NOT_APPLICABLE" }),
        makeMember(),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalled();
    });
  });

  describe("admin-account guards (#1604/#1622)", () => {
    it("blocks a Membership Officer from de-logging an admin-holding account", async () => {
      vi.mocked(auth).mockResolvedValue(officerSession);
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "adminuser@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(PRIVILEGED_TARGET_GUARD_MESSAGE);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("blocks de-logging the last active Full Admin", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "lastadmin@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(LAST_FULL_ADMIN_GUARD_MESSAGE);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("allows de-logging a Full Admin target when another active Full Admin survives", async () => {
      // Target IS a Full Admin, so wouldRemoveLastFullAdmin does not
      // short-circuit — it counts survivors. The parent is a second active
      // Full Admin, so the end-state count is non-zero and the flip is allowed.
      const tx = setupTransaction([
        makeParent({ role: "ADMIN", accessRoles: adminAccessRoles }),
        makeMember({
          ageTier: "ADULT",
          email: "survivingadmintarget@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "target-1" },
          data: expect.objectContaining({ canLogin: false }),
        })
      );
    });

    it("leaves the disableLogin:false path unguarded (no de-login, admin target allowed)", async () => {
      vi.mocked(auth).mockResolvedValue(officerSession);
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "adminuser@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { parent: { connect: { id: "parent-1" } } },
        })
      );
    });
  });
});
