import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock modules before imports
vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    familyGroupMember: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    familyGroupJoinRequest: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: { id: "fgjr", limit: 3, windowSeconds: 3600 } },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma, true);

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "member-1", role: "MEMBER" } } as any;

// Helper to create a NextRequest
function makeReq(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

// =========================================================================
// Admin Family Groups API
// =========================================================================
describe("Admin Family Groups API", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /api/admin/family-groups", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const { GET } = await import("@/app/api/admin/family-groups/route");
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it("returns all family groups with members", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroup.findMany.mockResolvedValue([
        {
          id: "fg1",
          name: "Smith Family",
          createdAt: new Date(),
          updatedAt: new Date(),
          memberships: [
            {
              member: { id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", ageTier: "ADULT", active: true, parentMemberId: null },
              role: "MEMBER",
            },
          ],
          _count: { joinRequests: 0 },
        },
      ] as any);

      const { GET } = await import("@/app/api/admin/family-groups/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.familyGroups).toHaveLength(1);
      expect(body.familyGroups[0].name).toBe("Smith Family");
      expect(body.familyGroups[0].memberCount).toBe(1);
    });
  });

  describe("POST /api/admin/family-groups", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Test", memberIds: ["m1"] }));
      expect(res.status).toBe(401);
    });

    it("creates a family group and assigns members", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.member.findMany.mockResolvedValue([
        { id: "m1", firstName: "John", lastName: "Smith", active: true, parentMemberId: null },
        { id: "m2", firstName: "Jane", lastName: "Smith", active: true, parentMemberId: null },
      ] as any);

      const createdGroup = {
        id: "fg-new",
        name: "Smith Family",
        memberships: [
          { member: { id: "m1", firstName: "John", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" },
          { member: { id: "m2", firstName: "Jane", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" },
        ],
      };
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => createdGroup);

      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Smith Family", memberIds: ["m1", "m2"] }));
      expect(res.status).toBe(201);
    });

    it("rejects dependent members", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.member.findMany.mockResolvedValue([
        { id: "m1", firstName: "Child", lastName: "Smith", active: true, parentMemberId: "m2", familyGroupId: null },
      ] as any);

      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Test", memberIds: ["m1"] }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toContain("dependent");
    });

    it("allows members who are already in another group (multi-group support)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // Members can now belong to multiple groups — no restriction on existing group membership
      mockedPrisma.member.findMany.mockResolvedValue([
        { id: "m1", firstName: "John", lastName: "Smith", active: true, parentMemberId: null },
      ] as any);

      const createdGroup = {
        id: "fg-new",
        name: "New Group",
        memberships: [{ member: { id: "m1", firstName: "John", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" }],
      };
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => createdGroup);

      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "New Group", memberIds: ["m1"] }));
      // Should succeed — multi-group is now allowed
      expect(res.status).toBe(201);
    });
  });

  describe("DELETE /api/admin/family-groups/[id]", () => {
    it("deletes group and clears member links", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroup.findUnique.mockResolvedValue({ id: "fg1" } as any);
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => {
        return undefined;
      });

      const { DELETE } = await import("@/app/api/admin/family-groups/[id]/route");
      const res = await DELETE(
        makeReq("/api/admin/family-groups/fg1", "DELETE"),
        { params: Promise.resolve({ id: "fg1" }) }
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent group", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroup.findUnique.mockResolvedValue(null);

      const { DELETE } = await import("@/app/api/admin/family-groups/[id]/route");
      const res = await DELETE(
        makeReq("/api/admin/family-groups/nope", "DELETE"),
        { params: Promise.resolve({ id: "nope" }) }
      );
      expect(res.status).toBe(404);
    });
  });
});

// =========================================================================
// Members Family API
// =========================================================================
describe("GET /api/members/family", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 for unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns self + dependents when no family group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce({
        id: "member-1",
        firstName: "John",
        lastName: "Smith",
        ageTier: "ADULT",
        parentMemberId: null,
        familyGroupMemberships: [], // no join table memberships
      } as any)
      // Fallback legacy check
      .mockResolvedValueOnce({ familyGroupId: null } as any);

    // Own dependents
    mockedPrisma.member.findMany.mockResolvedValueOnce([
      { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.familyMembers).toHaveLength(2);
    expect(body.familyMembers[0].relationship).toBe("self");
    expect(body.familyMembers[0].firstName).toBe("John");
    expect(body.familyMembers[1].relationship).toBe("dependent");
    expect(body.familyMembers[1].firstName).toBe("Emma");
    expect(body.familyGroupId).toBeNull();
  });

  it("returns self + partner + all dependents when in family group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      ageTier: "ADULT",
      parentMemberId: null,
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
      ],
    } as any);

    // Peers from join table
    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      { member: { id: "member-2", firstName: "Jane", lastName: "Smith", ageTier: "ADULT" } },
    ] as any);

    // Own dependents
    mockedPrisma.member.findMany
      .mockResolvedValueOnce([
        { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" },
      ] as any)
      // Peer dependents
      .mockResolvedValueOnce([
        { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" }, // duplicate
        { id: "child-2", firstName: "Liam", lastName: "Smith", ageTier: "YOUTH" },
      ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Self + partner + child-1 + child-2 (child-1 deduplicated)
    expect(body.familyMembers).toHaveLength(4);
    expect(body.familyMembers[0].relationship).toBe("self");
    expect(body.familyMembers[1].relationship).toBe("partner");
    expect(body.familyMembers[2].relationship).toBe("dependent");
    expect(body.familyMembers[3].relationship).toBe("dependent");
    expect(body.familyGroupName).toBe("Smith Family");
    // Check deduplication - child-1 should appear only once
    const childIds = body.familyMembers.filter((m: any) => m.id === "child-1");
    expect(childIds).toHaveLength(1);
  });

  it("split family: parent sees own children but not ex-partner", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    // Dad has no family group
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce({
        id: "member-1",
        firstName: "Dad",
        lastName: "Smith",
        ageTier: "ADULT",
        parentMemberId: null,
        familyGroupMemberships: [], // no groups
      } as any)
      // Fallback legacy check — also no group
      .mockResolvedValueOnce({ familyGroupId: null } as any);

    // Own dependents (children linked via parentMemberId or secondaryParentId)
    mockedPrisma.member.findMany.mockResolvedValueOnce([
      { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    const body = await res.json();
    // Dad sees self + his child, no ex-partner
    expect(body.familyMembers).toHaveLength(2);
    expect(body.familyMembers.map((m: any) => m.firstName)).toEqual(["Dad", "Emma"]);
  });
});

// =========================================================================
// Join Request Flow
// =========================================================================
describe("POST /api/members/family/request-join", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 for unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "test@test.com" }));
    expect(res.status).toBe(401);
  });

  it("rejects if requester is already in a group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      parentMemberId: null,
      familyGroupId: "existing-group",
      active: true,
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "jane@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("already in a family group");
  });

  it("rejects if requester is a dependent", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Child",
      lastName: "Smith",
      parentMemberId: "parent-1",
      familyGroupId: null,
      active: true,
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "jane@test.com" }));
    expect(res.status).toBe(403);
  });

  it("rejects if target member not found", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      parentMemberId: null,
      familyGroupId: null,
      active: true,
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findFirst.mockResolvedValue(null);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "nobody@test.com" }));
    expect(res.status).toBe(404);
  });

  it("creates join request for target with existing group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      parentMemberId: null,
      familyGroupId: null,
      active: true,
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findFirst.mockResolvedValue({
      id: "member-2",
      firstName: "Jane",
      lastName: "Smith",
      familyGroupId: "fg1",
    } as any);
    mockedPrisma.familyGroupJoinRequest.create.mockResolvedValue({
      id: "req-1",
      familyGroupId: "fg1",
      requesterId: "member-1",
      status: "PENDING",
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "jane@test.com" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestId).toBe("req-1");
  });

  it("rejects duplicate pending request", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      parentMemberId: null,
      familyGroupId: null,
      active: true,
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue({
      id: "existing-req",
      status: "PENDING",
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "jane@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("pending join request");
  });
});

// =========================================================================
// Admin Join Request Review
// =========================================================================
describe("Admin Family Group Join Requests", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /api/admin/family-groups/requests", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const { GET } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it("returns pending requests", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
        {
          id: "req-1",
          createdAt: new Date(),
          requester: { id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com" },
          familyGroup: { id: "fg1", name: "Smith Family", memberships: [] },
        },
      ] as any);

      const { GET } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.requests).toHaveLength(1);
      // Should have members array (flattened from memberships)
      expect(body.requests[0].familyGroup.members).toEqual([]);
    });
  });

  describe("PUT /api/admin/family-groups/requests", () => {
    it("approves a request and sets familyGroupId", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-1",
        familyGroupId: "fg1",
        requesterId: "m1",
        status: "PENDING",
        requester: { id: "m1", firstName: "John", lastName: "Smith", familyGroupId: null },
      } as any);
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => undefined);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(makeReq("/api/admin/family-groups/requests", "PUT", { requestId: "req-1", action: "approve" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe("approve");
    });

    it("rejects a request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-1",
        familyGroupId: "fg1",
        requesterId: "m1",
        status: "PENDING",
        requester: { id: "m1", firstName: "John", lastName: "Smith", familyGroupId: null },
      } as any);
      mockedPrisma.familyGroupJoinRequest.update.mockResolvedValue({} as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(makeReq("/api/admin/family-groups/requests", "PUT", { requestId: "req-1", action: "reject" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe("reject");
    });

    it("returns 404 for non-existent request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(null);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(makeReq("/api/admin/family-groups/requests", "PUT", { requestId: "nope", action: "approve" }));
      expect(res.status).toBe(404);
    });

    it("rejects already-reviewed request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-1",
        status: "APPROVED",
        requester: { id: "m1", familyGroupId: "fg1" },
      } as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(makeReq("/api/admin/family-groups/requests", "PUT", { requestId: "req-1", action: "approve" }));
      expect(res.status).toBe(422);
    });
  });
});
