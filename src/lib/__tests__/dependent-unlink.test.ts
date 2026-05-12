import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { DELETE } from "@/app/api/admin/members/[id]/dependents/[dependentId]/route";

type MockMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT";
  active: boolean;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  canLogin: boolean;
};

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;

function makeRequest() {
  return new NextRequest("http://localhost/api/admin/members/parent-1/dependents/child-1", {
    method: "DELETE",
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
    secondaryParentId: null,
    inheritParentEmail: false,
    inheritEmailFromId: null,
    canLogin: true,
    ...overrides,
  };
}

function makeDependent(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "child-1",
    firstName: "Child",
    lastName: "Member",
    email: "child@example.com",
    ageTier: "CHILD",
    active: true,
    parentMemberId: "parent-1",
    secondaryParentId: null,
    inheritParentEmail: true,
    inheritEmailFromId: "parent-1",
    canLogin: false,
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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const member = membersById.get(where.id);
        if (!member) return null;
        return {
          ...member,
          parentMemberId: data.parent?.disconnect ? null : member.parentMemberId,
          secondaryParentId: data.secondaryParent?.disconnect ? null : member.secondaryParentId,
          inheritParentEmail: data.inheritParentEmail ?? member.inheritParentEmail,
          inheritEmailFromId: data.inheritEmailFrom?.disconnect
            ? null
            : member.inheritEmailFromId,
        };
      }),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
  };

  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx));

  return tx;
}

async function unlinkDependent(parentId = "parent-1", dependentId = "child-1") {
  return DELETE(makeRequest(), {
    params: Promise.resolve({ id: parentId, dependentId }),
  });
}

describe("DELETE /api/admin/members/[id]/dependents/[dependentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("removes the parent link and clears inherited email from that parent", async () => {
    const tx = setupTransaction([makeParent(), makeDependent()]);

    const res = await unlinkDependent();

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "child-1" },
        data: expect.objectContaining({
          parent: { disconnect: true },
          inheritParentEmail: false,
          inheritEmailFrom: { disconnect: true },
        }),
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "member.dependent.unlink",
          memberId: "admin-1",
          targetId: "child-1",
        }),
      })
    );
  });

  it("keeps manual email inheritance when unlinking the parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeDependent({
        inheritParentEmail: false,
        inheritEmailFromId: "manual-source",
      }),
    ]);

    const res = await unlinkDependent();

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          parent: { disconnect: true },
        },
      })
    );
  });

  it("rejects removing a link from the wrong parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeDependent({ parentMemberId: "other-parent" }),
    ]);

    const res = await unlinkDependent();

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not linked/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });
});
