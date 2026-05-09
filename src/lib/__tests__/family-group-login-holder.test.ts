import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockTx, mockRequireActiveSessionUser } = vi.hoisted(() => {
  const mockTx = {
    familyGroup: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  const mockPrisma = {
    $transaction: vi.fn(),
  };

  return {
    mockPrisma,
    mockTx,
    mockRequireActiveSessionUser: vi.fn(async () => null),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { POST } from "@/app/api/admin/family-groups/[id]/login-holder/route";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;
const passwordDate = new Date("2026-05-01T00:00:00.000Z");

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/family-groups/group-1/login-holder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "shared@example.com",
    firstName: "Alice",
    lastName: "Smith",
    ageTier: "ADULT",
    active: true,
    canLogin: false,
    passwordHash: "hash",
    passwordChangedAt: passwordDate,
    lastLoginAt: null,
    inheritEmailFromId: "old-holder",
    inheritEmailFrom: { email: "shared@example.com" },
    ...overrides,
  };
}

function makeGroup(members: Array<ReturnType<typeof makeMember>>) {
  return {
    id: "group-1",
    memberships: members.map((member) => ({ member })),
  };
}

describe("POST /api/admin/family-groups/[id]/login-holder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(adminSession);
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) =>
      callback(mockTx)
    );
    mockTx.member.findUnique.mockResolvedValue({
      id: "new-holder",
      ageTier: "ADULT",
      parentMemberId: null,
      inheritEmailFromId: null,
    });
  });

  it("swaps login holder in a shared 2-adult cluster", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          firstName: "Old",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder", firstName: "New" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockTx.member.update).toHaveBeenCalledWith({
      where: { id: "old-holder" },
      data: {
        canLogin: false,
        email: "shared@example.com",
        inheritEmailFromId: "new-holder",
      },
    });
    expect(mockTx.member.update).toHaveBeenCalledWith({
      where: { id: "new-holder" },
      data: {
        canLogin: true,
        inheritEmailFromId: null,
        email: "shared@example.com",
      },
    });
  });

  it("rejects if the new holder is not ADULT", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
        makeMember({ id: "child-1", ageTier: "CHILD" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "child-1",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("rejects if the new holder is not in the family group", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "missing-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("rejects if the new holder has no password", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
        makeMember({ id: "new-holder", passwordHash: null, passwordChangedAt: null }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("cascades email inheritance across the shared-email cluster", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder" }),
        makeMember({
          id: "youth-1",
          ageTier: "YOUTH",
          passwordHash: null,
          passwordChangedAt: null,
        }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockTx.member.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-holder", "youth-1"] } },
      data: {
        canLogin: false,
        email: "shared@example.com",
        inheritEmailFromId: "new-holder",
      },
    });
  });

  it("writes audit logs for each touched member and records the session lag warning for the old holder", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder" }),
        makeMember({ id: "youth-1", ageTier: "YOUTH" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(3);
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "family-group.login-holder-swapped",
        memberId: "admin-1",
        targetId: "old-holder",
        details: expect.stringContaining("up to 8 hours"),
      }),
    });
  });
});
