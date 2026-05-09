import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/admin/members/[id]/dependents/link/route";

type MockMember = {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT";
  active: boolean;
  parentMemberId: string | null;
  inheritEmailFromId: string | null;
  canLogin: boolean;
  dependents: Array<{ id: string }>;
  familyGroupMemberships: Array<{ familyGroupId: string }>;
};

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;

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
    parentMemberId: null,
    inheritEmailFromId: null,
    canLogin: true,
    dependents: [],
    familyGroupMemberships: [{ familyGroupId: "fg-1" }, { familyGroupId: "fg-2" }],
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
    parentMemberId: null,
    inheritEmailFromId: null,
    canLogin: true,
    dependents: [],
    familyGroupMemberships: [],
    ...overrides,
  };
}

function setupTransaction(members: MockMember[]) {
  const membersById = new Map(members.map((member) => [member.id, member]));

  const tx = {
    member: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return membersById.get(where.id) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: { email: string; id: { not: string } } }) => {
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
          inheritEmailFromId: data.inheritEmailFrom?.connect?.id ?? member.inheritEmailFromId,
          canLogin: data.canLogin ?? member.canLogin,
        };
      }),
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

  it("rejects a target that already has a parent", async () => {
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

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/already linked/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects a target that already has dependants", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ dependents: [{ id: "child-1" }] }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/already has dependants/i);
    expect(tx.member.update).not.toHaveBeenCalled();
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
});
