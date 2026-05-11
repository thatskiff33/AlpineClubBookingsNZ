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
      findUnique: vi.fn(),
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
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
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
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
  sendJoinRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendChildRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendChildRequestRejectedEmail: vi.fn().mockResolvedValue(undefined),
}));
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

function completeMember(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.id ?? "member-1");
  return {
    id,
    firstName: "Test",
    lastName: "Member",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    role: "MEMBER",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "1234567",
    dateOfBirth: new Date("1990-01-01"),
    streetAddressLine1: "1 Main St",
    streetAddressLine2: null,
    streetCity: "Tokoroa",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main St",
    postalAddressLine2: null,
    postalCity: "Tokoroa",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
    profileCompletedAt: new Date("2026-01-01"),
    detailsConfirmedAt: new Date("2026-01-01"),
    detailsConfirmedByMemberId: id,
    onboardingConfirmedAt: new Date("2026-01-01"),
    familyGroupMemberships: [],
    ...overrides,
  };
}

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
              member: { id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", ageTier: "ADULT", active: true, canLogin: true },
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
        { id: "m1", firstName: "John", lastName: "Smith", active: true, canLogin: true },
        { id: "m2", firstName: "Jane", lastName: "Smith", active: true, canLogin: true },
      ] as any);

      const createdGroup = {
        id: "fg-new",
        name: "Smith Family",
        memberships: [
          { member: { id: "m1", firstName: "John", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" },
          { member: { id: "m2", firstName: "Jane", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" },
        ],
      };
      mockedPrisma.$transaction.mockImplementation(async () => createdGroup);

      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Smith Family", memberIds: ["m1", "m2"] }));
      expect(res.status).toBe(201);
    });

    it("accepts all member types including youth and children", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.member.findMany.mockResolvedValue([
        { id: "m1", firstName: "Child", lastName: "Smith", active: true },
      ] as any);

      const createdGroup = {
        id: "fg-new",
        name: "Test",
        memberships: [
          { member: { id: "m1", firstName: "Child", lastName: "Smith", email: "parent@test.com", ageTier: "CHILD" }, role: "MEMBER" },
        ],
      };
      mockedPrisma.$transaction.mockImplementation(async () => createdGroup);

      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Test", memberIds: ["m1"] }));
      expect(res.status).toBe(201);
    });

    it("allows members who are already in another group (multi-group support)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // Members can now belong to multiple groups — no restriction on existing group membership
      mockedPrisma.member.findMany.mockResolvedValue([
        { id: "m1", firstName: "John", lastName: "Smith", active: true, canLogin: true },
      ] as any);

      const createdGroup = {
        id: "fg-new",
        name: "New Group",
        memberships: [{ member: { id: "m1", firstName: "John", lastName: "Smith", email: "j@t.com", ageTier: "ADULT" }, role: "MEMBER" }],
      };
      mockedPrisma.$transaction.mockImplementation(async () => createdGroup);

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
      mockedPrisma.$transaction.mockImplementation(async () => {
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
  });

  it("returns 401 for unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns only self when not in any family group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      ageTier: "ADULT",
      familyGroupMemberships: [],
    } as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.familyMembers).toHaveLength(1);
    expect(body.familyMembers[0].relationship).toBe("self");
    expect(body.familyGroupId).toBeNull();
  });

  it("returns self + all family group members (adults as partner, children as dependent)", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      ageTier: "ADULT",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
      ],
    } as any);

    // All group members (including children/youth)
    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      { member: { id: "member-2", firstName: "Jane", lastName: "Smith", ageTier: "ADULT" } },
      { member: { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" } },
      { member: { id: "youth-1", firstName: "Liam", lastName: "Smith", ageTier: "YOUTH" } },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.familyMembers).toHaveLength(4);
    expect(body.familyMembers[0].relationship).toBe("self");
    expect(body.familyMembers[1].relationship).toBe("partner");
    expect(body.familyMembers[2].relationship).toBe("dependent");
    expect(body.familyMembers[3].relationship).toBe("dependent");
    expect(body.familyGroupName).toBe("Smith Family");
  });

  it("marks admin and lodge family accounts as exempt from member confirmation", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue(completeMember({
      id: "member-1",
      firstName: "Support",
      lastName: "Member",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Admin Family" } },
      ],
    }) as any);

    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: completeMember({
          id: "admin-2",
          firstName: "Admin",
          lastName: "User",
          role: "ADMIN",
          canLogin: true,
          detailsConfirmedAt: null,
          detailsConfirmedByMemberId: null,
          onboardingConfirmedAt: null,
          familyGroupMemberships: [
            { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Admin Family" } },
          ],
        }),
      },
      {
        member: completeMember({
          id: "lodge-1",
          firstName: "Lodge",
          lastName: "User",
          role: "LODGE",
          canLogin: true,
          detailsConfirmedAt: null,
          detailsConfirmedByMemberId: null,
          onboardingConfirmedAt: null,
          familyGroupMemberships: [
            { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Admin Family" } },
          ],
        }),
      },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    const body = await res.json();
    const admin = body.familyMembers.find((member: any) => member.id === "admin-2");
    const lodge = body.familyMembers.find((member: any) => member.id === "lodge-1");

    expect(res.status).toBe(200);
    for (const account of [admin, lodge]) {
      expect(account.confirmationMode).toBe("not_allowed");
      expect(account.profileStatus.confirmationMode).toBe("not_allowed");
      expect(account.needsOwnLoginConfirmation).toBe(false);
      expect(account.action).toBeNull();
      expect(account.canBeBooked).toBe(false);
    }
  });

  it("deduplicates members across multiple family groups", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Dad",
      lastName: "Smith",
      ageTier: "ADULT",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
        { familyGroupId: "fg2", familyGroup: { id: "fg2", name: "Jones Family" } },
      ],
    } as any);

    // Members from both groups — child-1 appears in both
    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      { member: { id: "member-2", firstName: "Jane", lastName: "Smith", ageTier: "ADULT" } },
      { member: { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" } },
      { member: { id: "child-1", firstName: "Emma", lastName: "Smith", ageTier: "CHILD" } },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    const body = await res.json();
    // Self + Jane + Emma (deduplicated)
    expect(body.familyMembers).toHaveLength(3);
    const emmas = body.familyMembers.filter((m: any) => m.id === "child-1");
    expect(emmas).toHaveLength(1);
  });

  it("keeps a multi-group member bookable when a pending removal only affects one shared group", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue(completeMember({
      id: "member-1",
      firstName: "Dad",
      lastName: "Smith",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
        { familyGroupId: "fg2", familyGroup: { id: "fg2", name: "Jones Family" } },
      ],
    }) as any);

    const child = completeMember({
      id: "child-1",
      firstName: "Emma",
      lastName: "Smith",
      ageTier: "CHILD",
      canLogin: false,
      detailsConfirmedByMemberId: "member-1",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
        { familyGroupId: "fg2", familyGroup: { id: "fg2", name: "Jones Family" } },
      ],
    });
    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      { member: child },
      { member: child },
    ] as any);
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        id: "remove-req-1",
        type: "REMOVAL_REQUEST",
        status: "PENDING",
        familyGroupId: "fg1",
        requesterId: "member-1",
        invitedMemberId: null,
        linkedMemberId: null,
        subjectMemberId: "child-1",
      },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    const body = await res.json();
    const emma = body.familyMembers.find((member: any) => member.id === "child-1");

    expect(res.status).toBe(200);
    expect(emma.canBeBooked).toBe(true);
    expect(emma.pendingRequestStatus).toBeNull();
    expect(emma.familyGroupIds).toEqual(["fg1", "fg2"]);
    expect(emma.bookableFamilyGroupIds).toEqual(["fg2"]);
    expect(emma.pendingRequestFamilyGroupIds).toEqual(["fg1"]);
    expect(emma.pendingRequests).toEqual([
      {
        id: "remove-req-1",
        type: "REMOVAL_REQUEST",
        status: "PENDING",
        familyGroupId: "fg1",
      },
    ]);
  });

  it("blocks a member when every shared membership has a pending removal request", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue(completeMember({
      id: "member-1",
      firstName: "Dad",
      lastName: "Smith",
      familyGroupMemberships: [
        { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
      ],
    }) as any);

    mockedPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: completeMember({
          id: "child-1",
          firstName: "Emma",
          lastName: "Smith",
          ageTier: "CHILD",
          canLogin: false,
          detailsConfirmedByMemberId: "member-1",
          familyGroupMemberships: [
            { familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } },
          ],
        }),
      },
    ] as any);
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        id: "remove-req-1",
        type: "REMOVAL_REQUEST",
        status: "PENDING",
        familyGroupId: "fg1",
        requesterId: "member-1",
        invitedMemberId: null,
        linkedMemberId: null,
        subjectMemberId: "child-1",
      },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    const body = await res.json();
    const emma = body.familyMembers.find((member: any) => member.id === "child-1");

    expect(res.status).toBe(200);
    expect(emma.canBeBooked).toBe(false);
    expect(emma.pendingRequestStatus).toBe("PENDING");
    expect(emma.pendingRequestType).toBe("REMOVAL_REQUEST");
    expect(emma.bookableFamilyGroupIds).toEqual([]);
    expect(emma.pendingRequestFamilyGroupIds).toEqual(["fg1"]);
  });
});

describe("PUT /api/members/family/[memberId]/details", () => {
  beforeEach(() => vi.clearAllMocks());

  const completeAdult = {
    id: "adult-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@test.com",
    active: true,
    canLogin: true,
    role: "MEMBER",
    ageTier: "ADULT",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "1234567",
    dateOfBirth: new Date("1990-01-01"),
    streetAddressLine1: "1 Main St",
    streetAddressLine2: null,
    streetCity: "Tokoroa",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main St",
    postalAddressLine2: null,
    postalCity: "Tokoroa",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
    profileCompletedAt: new Date(),
    detailsConfirmedAt: new Date(),
    detailsConfirmedByMemberId: "adult-1",
    onboardingConfirmedAt: new Date(),
    familyGroupMemberships: [{ familyGroupId: "fg1" }],
  };

  it("allows an adult in the same family group to confirm non-login member details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "adult-1", role: "MEMBER" } } as any);
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce(completeAdult as any)
      .mockResolvedValueOnce({
        ...completeAdult,
        id: "child-1",
        firstName: "Sam",
        lastName: "Smith",
        canLogin: false,
        ageTier: "CHILD",
        detailsConfirmedAt: null,
        detailsConfirmedByMemberId: null,
      } as any);
    mockedPrisma.member.update.mockResolvedValue({
      ...completeAdult,
      id: "child-1",
      firstName: "Sam",
      lastName: "Smith",
      canLogin: false,
      ageTier: "CHILD",
      dateOfBirth: new Date("2018-01-01"),
      detailsConfirmedByMemberId: "adult-1",
    } as any);

    const { PUT } = await import("@/app/api/members/family/[memberId]/details/route");
    const res = await PUT(
      makeReq("/api/members/family/child-1/details", "PUT", {
        firstName: "Sam",
        lastName: "Smith",
        dateOfBirth: "2018-01-01",
        inheritContactFromSelf: true,
      }),
      { params: Promise.resolve({ memberId: "child-1" }) }
    );

    expect(res.status).toBe(200);
    expect(mockedPrisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "child-1" },
      data: expect.objectContaining({
        phoneCountryCode: "64",
        streetAddressLine1: "1 Main St",
        detailsConfirmedByMemberId: "adult-1",
      }),
    }));
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

  it("rejects if requester cannot login (e.g. child/youth)", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Child",
      lastName: "Smith",
      canLogin: false,
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
      canLogin: true,
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
      canLogin: true,
      active: true,
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findFirst.mockResolvedValue({
      id: "member-2",
      firstName: "Jane",
      lastName: "Smith",
      familyGroupMemberships: [{ familyGroupId: "fg1", familyGroup: { id: "fg1", name: "Smith Family" } }],
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
      canLogin: true,
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

describe("Family change request endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a same-email adult request", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      email: "dad@test.com",
      firstName: "Dad",
      lastName: "Smith",
      active: true,
      ageTier: "ADULT",
      canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "fg1" }],
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.familyGroupJoinRequest.create.mockResolvedValue({ id: "adult-req-1" } as any);
    mockedPrisma.familyGroup.findUnique.mockResolvedValue({ name: "Smith Family" } as any);

    const { POST } = await import("@/app/api/members/family/request-adult/route");
    const res = await POST(makeReq("/api/members/family/request-adult", "POST", {
      familyGroupId: "fg1",
      firstName: "Mum",
      lastName: "Smith",
      dateOfBirth: "1991-01-01",
    }));

    expect(res.status).toBe(201);
    expect(mockedPrisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ADULT_REQUEST",
        requestedFirstName: "Mum",
        requestedLastName: "Smith",
        requestedEmail: "dad@test.com",
      }),
    });
  });

  it("creates a family member removal request", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Dad",
      lastName: "Smith",
      active: true,
      ageTier: "ADULT",
      canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "fg1" }],
    } as any);
    mockedPrisma.familyGroupMember.findUnique.mockResolvedValue({
      member: { id: "wrong-1", firstName: "Wrong", lastName: "Person", active: true },
      familyGroup: { id: "fg1", name: "Smith Family" },
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.familyGroupJoinRequest.create.mockResolvedValue({ id: "remove-req-1" } as any);

    const { POST } = await import("@/app/api/members/family/request-removal/route");
    const res = await POST(makeReq("/api/members/family/request-removal", "POST", {
      familyGroupId: "fg1",
      memberId: "wrong-1",
      notes: "Not in our family",
    }));

    expect(res.status).toBe(201);
    expect(mockedPrisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "REMOVAL_REQUEST",
        subjectMemberId: "wrong-1",
        requestNotes: "Not in our family",
      }),
    });
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

    it("returns child requests with suggested member matches", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
        {
          id: "req-child-1",
          type: "CHILD_REQUEST",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          childFirstName: "Sam",
          childLastName: "Smith",
          childDateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
          requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
          familyGroupId: "fg1",
          familyGroup: {
            id: "fg1",
            name: "Smith Family",
            memberships: [
              { member: { id: "parent-1", firstName: "Alice", lastName: "Smith" } },
            ],
          },
        },
      ] as any);
      mockedPrisma.member.findMany.mockResolvedValue([
        {
          id: "child-1",
          firstName: "Sam",
          lastName: "Smith",
          email: "sam@test.com",
          ageTier: "CHILD",
          active: true,
          dateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
          familyGroupMemberships: [],
        },
      ] as any);

      const { GET } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await GET();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].type).toBe("CHILD_REQUEST");
      expect(body.requests[0].childFirstName).toBe("Sam");
      expect(body.requests[0].matchingMembers).toEqual([
        expect.objectContaining({
          id: "child-1",
          firstName: "Sam",
          ageTier: "CHILD",
          alreadyInGroup: false,
        }),
      ]);
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
      mockedPrisma.$transaction.mockImplementation(async () => undefined);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(makeReq("/api/admin/family-groups/requests", "PUT", { requestId: "req-1", action: "approve" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe("approve");
    });

    it("requires linkedMemberId when approving a child request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-1",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-1",
          action: "approve",
        })
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/select the member record/i);
    });

    it("approves an infant/child/youth request and links the selected member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-1",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "child-1",
        active: true,
        ageTier: "INFANT",
      } as any);

      const txUpsert = vi.fn();
      const txUpdate = vi.fn();
      mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
        callback({
          familyGroupMember: { upsert: txUpsert },
          familyGroupJoinRequest: { update: txUpdate },
        })
      );

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-1",
          action: "approve",
          linkedMemberId: "child-1",
        })
      );

      expect(res.status).toBe(200);
      expect(txUpsert).toHaveBeenCalledWith({
        where: {
          familyGroupId_memberId: {
            familyGroupId: "fg1",
            memberId: "child-1",
          },
        },
        create: {
          familyGroupId: "fg1",
          memberId: "child-1",
          role: "MEMBER",
        },
        update: {},
      });
      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: "req-child-1" },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedBy: "admin-1",
          linkedMemberId: "child-1",
        }),
      });
    });

    it("rejects approving a child request with an adult member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-1",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "adult-1",
        active: true,
        ageTier: "ADULT",
      } as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-1",
          action: "approve",
          linkedMemberId: "adult-1",
        })
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/infant, child, or youth/i);
    });

    it("approves a removal request by deleting only the requested family group membership", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "remove-req-1",
        familyGroupId: "fg1",
        requesterId: "member-1",
        subjectMemberId: "child-1",
        status: "PENDING",
        type: "REMOVAL_REQUEST",
        requester: { id: "member-1", firstName: "Dad", lastName: "Smith", email: "dad@test.com" },
        familyGroup: { id: "fg1", name: "Smith Family" },
        subjectMember: { id: "child-1", firstName: "Emma", lastName: "Smith" },
      } as any);

      const txDeleteMany = vi.fn();
      const txUpdate = vi.fn();
      mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
        callback({
          familyGroupMember: { deleteMany: txDeleteMany },
          familyGroupJoinRequest: { update: txUpdate },
        })
      );

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "remove-req-1",
          action: "approve",
        })
      );

      expect(res.status).toBe(200);
      expect(txDeleteMany).toHaveBeenCalledWith({
        where: {
          familyGroupId: "fg1",
          memberId: "child-1",
        },
      });
      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: "remove-req-1" },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedBy: "admin-1",
        }),
      });
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
