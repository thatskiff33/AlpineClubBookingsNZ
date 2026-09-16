import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock modules before imports
vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    familyGroup: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    familyGroupMember: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    familyGroupJoinRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  createStructuredAuditLog: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
  sendJoinRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendChildRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendChildRequestRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendFamilyGroupInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendGroupCreateApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendGroupCreateRejectedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: { id: "fgjr", limit: 3, windowSeconds: 3600 } },
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import {
  sendChildRequestApprovedEmail,
  sendChildRequestRejectedEmail,
} from "@/lib/email";
import { logAudit } from "@/lib/audit";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma, true);

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
const memberSession = { user: { id: "member-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any;

function completeMember(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.id ?? "member-1");
  return {
    id,
    firstName: "Test",
    lastName: "Member",
    ageTier: "ADULT",
    xeroContactId: null,
    active: true,
    canLogin: true,
    role: "USER",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "1234567",
    dateOfBirth: new Date("1990-01-01"),
    streetAddressLine1: "1 Main St",
    streetAddressLine2: null,
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main St",
    postalAddressLine2: null,
    postalCity: "Example",
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockImplementation(async (options) =>
      (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
        options,
      )
    );
  });

  describe("GET /api/admin/family-groups", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const { GET } = await import("@/app/api/admin/family-groups/route");
      const res = await GET();
      expect(res.status).toBe(403);
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

    it("counts a pending GROUP_CREATE toward the group's pending badge (#1681)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // A memberless group awaiting GROUP_CREATE approval: no memberships,
      // but one pending reviewed-type request — must NOT look like an inert
      // ghost group with no pending badge.
      mockedPrisma.familyGroup.findMany.mockResolvedValue([
        {
          id: "fg-pending-create",
          name: "Pending Family",
          createdAt: new Date(),
          updatedAt: new Date(),
          memberships: [],
          _count: { joinRequests: 1 },
        },
      ] as any);

      const { GET } = await import("@/app/api/admin/family-groups/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.familyGroups[0].memberCount).toBe(0);
      expect(body.familyGroups[0].pendingRequests).toBe(1);

      // The pending count filter includes every admin-reviewed request type,
      // GROUP_CREATE included (shared REVIEWED_REQUEST_TYPES list).
      expect(mockedPrisma.familyGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            _count: {
              select: {
                joinRequests: {
                  where: {
                    status: "PENDING",
                    type: {
                      in: [
                        "JOIN_REQUEST",
                        "CHILD_REQUEST",
                        "ADULT_REQUEST",
                        "REMOVAL_REQUEST",
                        "GROUP_CREATE",
                      ],
                    },
                  },
                },
              },
            },
          }),
        })
      );
    });
  });

  describe("POST /api/admin/family-groups", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const { POST } = await import("@/app/api/admin/family-groups/route");
      const res = await POST(makeReq("/api/admin/family-groups", "POST", { name: "Test", memberIds: ["m1"] }));
      expect(res.status).toBe(403);
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
    // Requester-scoped pending GROUP_CREATE lookup (#1681) — none by default.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null as any);
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
    expect(body.myPendingCreateRequest).toBeNull();
  });

  it("surfaces myPendingCreateRequest for a group-less requester (#1681)", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      ageTier: "ADULT",
      familyGroupMemberships: [],
    } as any);
    // Requester-scoped pending GROUP_CREATE — the target group is memberless,
    // so the group-scoped pending query cannot see it.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue({
      id: "req-gc",
      familyGroupId: "fg-pending",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      familyGroup: { id: "fg-pending", name: "Smith Family" },
      invitedMember: {
        id: "partner-1",
        firstName: "Pat",
        lastName: "Smith",
        email: "pat@test.com",
      },
    } as any);
    mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      { id: "req-c1", childFirstName: "Sam", childLastName: "Smith" },
    ] as any);

    const { GET } = await import("@/app/api/members/family/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // The memberless group never appears as a membership.
    expect(body.familyGroupId).toBeNull();
    expect(body.familyGroupIds).toEqual([]);
    expect(body.familyMembers).toHaveLength(1);

    expect(body.myPendingCreateRequest).toMatchObject({
      id: "req-gc",
      familyGroupId: "fg-pending",
      groupName: "Smith Family",
      partner: {
        id: "partner-1",
        firstName: "Pat",
        lastName: "Smith",
        email: "pat@test.com",
      },
      pendingChildRequests: [
        { id: "req-c1", firstName: "Sam", lastName: "Smith" },
      ],
    });
    expect(mockedPrisma.familyGroupJoinRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          requesterId: "member-1",
          type: "GROUP_CREATE",
          status: "PENDING",
        },
      })
    );
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
          accessRoles: [{ role: "ADMIN" }],
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
          accessRoles: [{ role: "LODGE" }],
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
  beforeEach(() => {
    vi.clearAllMocks();
    // #2821: the delegated-details route now runs its member write and the
    // email-inheritance re-resolution in ONE interactive transaction, so the
    // age-tier change and the re-resolution commit together or not at all. The
    // double therefore has to run the callback and hand it a client — a bare
    // `vi.fn()` resolves to `undefined`, which surfaced as the route reading
    // `.id` off nothing. Individual tests may still override this.
    mockedPrisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === "function" ? arg(mockedPrisma) : Promise.all(arg),
    );
  });

  const completeAdult = {
    id: "adult-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@test.com",
    active: true,
    canLogin: true,
    role: "USER",
    ageTier: "ADULT",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "1234567",
    dateOfBirth: new Date("1990-01-01"),
    streetAddressLine1: "1 Main St",
    streetAddressLine2: null,
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main St",
    postalAddressLine2: null,
    postalCity: "Example",
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
    mockedAuth.mockResolvedValue({ user: { id: "adult-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce(completeAdult as any)
      .mockResolvedValueOnce({
        ...completeAdult,
        id: "child-1",
        firstName: "Sam",
        lastName: "Smith",
        canLogin: false,
        ageTier: "CHILD",
        xeroContactId: "xc-child",
        phoneCountryCode: null,
        phoneAreaCode: null,
        phoneNumber: null,
        streetAddressLine1: null,
        streetAddressLine2: null,
        streetCity: null,
        streetRegion: null,
        streetPostalCode: null,
        streetCountry: null,
        postalAddressLine1: null,
        postalAddressLine2: null,
        postalCity: null,
        postalRegion: null,
        postalPostalCode: null,
        postalCountry: null,
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
      xeroContactId: "xc-child",
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
    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc-child",
      expect.objectContaining({
        phoneCountryCode: "64",
        streetAddressLine1: "1 Main St",
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "child-1",
        createdByMemberId: "adult-1",
        preserveXeroName: true,
      })
    );
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  // Owner-boundary regressions (issue #812): an adult must not be able to
  // confirm details for a member they have no shared family group with, for a
  // member who owns their own login, and a non-adult/non-login requester must
  // not be able to act at all. None of these may mutate the target member.
  it("rejects confirming details for a member outside the requester's family groups", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "adult-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce(completeAdult as any)
      .mockResolvedValueOnce({
        ...completeAdult,
        id: "stranger-child",
        canLogin: false,
        ageTier: "CHILD",
        familyGroupMemberships: [{ familyGroupId: "other-group" }],
      } as any);

    const { PUT } = await import("@/app/api/members/family/[memberId]/details/route");
    const res = await PUT(
      makeReq("/api/members/family/stranger-child/details", "PUT", {
        firstName: "Sam",
        lastName: "Other",
        dateOfBirth: "2018-01-01",
        inheritContactFromSelf: true,
      }),
      { params: Promise.resolve({ memberId: "stranger-child" }) }
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "You can only confirm details for members in your family group",
    });
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  it("rejects confirming details for a member who owns their own login", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "adult-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique
      .mockResolvedValueOnce(completeAdult as any)
      .mockResolvedValueOnce({
        ...completeAdult,
        id: "adult-2",
        canLogin: true,
        ageTier: "ADULT",
        familyGroupMemberships: [{ familyGroupId: "fg1" }],
      } as any);

    const { PUT } = await import("@/app/api/members/family/[memberId]/details/route");
    const res = await PUT(
      makeReq("/api/members/family/adult-2/details", "PUT", {
        firstName: "Other",
        lastName: "Adult",
        dateOfBirth: "1991-01-01",
        inheritContactFromSelf: true,
      }),
      { params: Promise.resolve({ memberId: "adult-2" }) }
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "Members with their own login must sign in and confirm their own details",
    });
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  /**
   * #2282: the same refusal, for the case that issue creates. A 16-year-old can
   * now be RECORDED as the parent of the member whose details are being
   * confirmed — and that changes nothing here. Confirming another member's
   * details is a responsibility function gated on active + login + ADULT +
   * shared family group, and it never consulted the parent link, so recording
   * one grants no part of it.
   *
   * Mutation probe: delete `requester.ageTier !== "ADULT"` from the details
   * route's guard and this test 200s instead of 403ing. The sibling test below
   * covers the same clause for a youth who is NOT the target's parent, so the
   * two together separate "age is checked" from "the parent link is ignored".
   */
  it("rejects a YOUNG PARENT confirming their own child's details (#2282)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "youth-parent-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique.mockResolvedValueOnce({
      ...completeAdult,
      id: "youth-parent-1",
      ageTier: "YOUTH",
      canLogin: true,
      active: true,
      // The link #2282 now permits. It buys nothing on this path.
      dependents: [{ id: "baby-1" }],
      familyGroupMemberships: [{ familyGroupId: "fg1" }],
    } as any);

    const { PUT } = await import("@/app/api/members/family/[memberId]/details/route");
    const res = await PUT(
      makeReq("/api/members/family/baby-1/details", "PUT", {
        firstName: "Baby",
        lastName: "Smith",
        dateOfBirth: "2025-01-01",
        inheritContactFromSelf: true,
      }),
      { params: Promise.resolve({ memberId: "baby-1" }) }
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error:
        "Only active adult members with login accounts can confirm family member details",
    });
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
  });

  it("rejects a non-adult requester confirming another member's details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "youth-1", role: "USER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique.mockResolvedValueOnce({
      ...completeAdult,
      id: "youth-1",
      ageTier: "YOUTH",
      familyGroupMemberships: [{ familyGroupId: "fg1" }],
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

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error:
        "Only active adult members with login accounts can confirm family member details",
    });
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
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

  it("seeds a group-less target with no rank at all before they consent (#2284 S4, #2520)", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      email: "john@test.com",
      canLogin: true,
      active: true,
    } as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findFirst.mockResolvedValue({
      id: "member-2",
      firstName: "Jane",
      lastName: "Doe",
      familyGroupMemberships: [], // no existing group — one is materialised
    } as any);
    mockedPrisma.$transaction.mockImplementation((async (fn: any) =>
      fn(mockedPrisma)) as any);
    mockedPrisma.familyGroup.create.mockResolvedValue({ id: "new-group" } as any);
    mockedPrisma.familyGroupMember.create.mockResolvedValue({} as any);
    mockedPrisma.familyGroupJoinRequest.create.mockResolvedValue({
      id: "req-2",
      familyGroupId: "new-group",
    } as any);
    mockedPrisma.familyGroup.findUnique.mockResolvedValue({
      name: "Doe Family",
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(
      makeReq("/api/members/family/request-join", "POST", {
        targetEmail: "jane@test.com",
      })
    );
    expect(res.status).toBe(201);
    // The target never consented to this group. #2284 stopped seeding them
    // "ADMIN"; #2520 removed the column entirely, so the row now records
    // membership and nothing else. Exact shape, so a re-added rank reddens here.
    // `select` narrows the write's implicit RETURNING (#2130 house rule).
    expect(mockedPrisma.familyGroupMember.create).toHaveBeenCalledWith({
      data: { familyGroupId: "new-group", memberId: "member-2" },
      select: { id: true },
    });
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

  it("rejects a join request while a group creation request is pending (#1681)", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "John",
      lastName: "Smith",
      canLogin: true,
      active: true,
    } as any);
    // A member cannot both create and join a group at once — the pending
    // check now spans JOIN_REQUEST and GROUP_CREATE.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue({
      id: "req-gc",
      type: "GROUP_CREATE",
      status: "PENDING",
    } as any);

    const { POST } = await import("@/app/api/members/family/request-join/route");
    const res = await POST(makeReq("/api/members/family/request-join", "POST", { targetEmail: "jane@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pending family group creation request/i);
    expect(mockedPrisma.familyGroupJoinRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: ["JOIN_REQUEST", "GROUP_CREATE"] },
        }),
      })
    );
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    // Reviewed groups have at least one membership by default; the
    // memberless-group guard (GROUP_CREATE bundles, #1681) is covered in
    // admin-family-group-create-review.test.ts.
    mockedPrisma.familyGroupMember.count.mockResolvedValue(1);
  });

  describe("GET /api/admin/family-groups/requests", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      mockRequireAdmin.mockResolvedValueOnce({
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      });
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
          partnerLinksAsMemberA: [],
          partnerLinksAsMemberB: [],
        },
      ] as any);

      const { GET } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await GET();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].type).toBe("CHILD_REQUEST");
      expect(body.requests[0].childFirstName).toBe("Sam");
      expect(body.requests[0].requestedAgeTier).toBe("CHILD");
      expect(body.requests[0].requestedAgeTierLabel).toBe("Child (5-9)");
      expect(body.requests[0].canCreateMemberFromRequest).toBe(true);
      expect(body.requests[0].matchingMembers).toEqual([
        expect.objectContaining({
          id: "child-1",
          firstName: "Sam",
          ageTier: "CHILD",
          alreadyInGroup: false,
        }),
      ]);
    });

    it("marks legacy child requests without DOB as link-only", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([
        {
          id: "req-child-legacy",
          type: "CHILD_REQUEST",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          childFirstName: "Sam",
          childLastName: "Smith",
          childDateOfBirth: null,
          requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
          familyGroupId: "fg1",
          familyGroup: {
            id: "fg1",
            name: "Smith Family",
            memberships: [],
          },
        },
      ] as any);
      mockedPrisma.member.findMany.mockResolvedValue([] as any);

      const { GET } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await GET();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.requests[0].requestedAgeTier).toBeNull();
      expect(body.requests[0].requestedAgeTierLabel).toBeNull();
      expect(body.requests[0].canCreateMemberFromRequest).toBe(false);
    });
  });

  describe("PUT /api/admin/family-groups/requests", () => {
    it("returns 422 for invalid review input", async () => {
      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "",
          action: "approve",
        })
      );

      expect(res.status).toBe(422);
      expect(mockedPrisma.familyGroupJoinRequest.findUnique).not.toHaveBeenCalled();
    });

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
        requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true, ageTier: "ADULT", inheritEmailFromId: null },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "child-1",
        active: true,
        ageTier: "INFANT",
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        parent: null,
        secondaryParent: null,
        dependents: [],
        secondaryDependents: [],
      } as any);

      const txUpsert = vi.fn();
      const txUpdate = vi.fn();
      const txMemberUpdate = vi.fn();
      mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
        callback({
          // #1936 member-lifecycle advisory lock taken at the top of the
          // review transaction (pg_advisory_xact_lock via $executeRaw).
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          member: {
            // #2716: the notification mailbox is now resolved with ONE
            // `findUnique` on the chosen parent instead of a walk up the tree,
            // and `isUsableEmailSource` reads `inheritEmailChoiceId` as well as
            // `inheritEmailFromId` — a parent who has CHOSEN to inherit is not a
            // mailbox even while their pointer is momentarily NULL. The column
            // is part of `EMAIL_SOURCE_SELECT`, so a real row always carries it;
            // the fixture has to as well or the parent reads as unusable.
              findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === "child-1"
                  ? {
                      id: "child-1",
                      active: true,
                      ageTier: "INFANT",
                      canLogin: false,
                      archivedAt: null,
                      parentMemberId: null,
                      secondaryParentId: null,
                      inheritEmailFromId: null,
                      parent: null,
                      secondaryParent: null,
                    }
                  : {
                      id: "parent-1",
                      active: true,
                      ageTier: "ADULT",
                      email: "parent@test.com",
                      archivedAt: null,
                      parentMemberId: null,
                      secondaryParentId: null,
                      inheritEmailFromId: null,
                      inheritEmailChoiceId: null,
                    },
              ),
            // #2255: the approval still walks the family chain (depth cap +
            // cycle guard) through `member.findMany`. That walk is the LINK
            // depth cap, which #2716 left untouched.
            findMany: vi.fn().mockImplementation(async ({ where }: any) =>
              where?.id?.in
                ? where.id.in.map((id: string) => ({
                    id,
                    email: `${id}@test.com`,
                    ageTier: "ADULT",
                    archivedAt: null,
                    inheritEmailFromId: null,
                    parentMemberId: null,
                    secondaryParentId: null,
                  }))
                : []
            ),
            update: txMemberUpdate,
          },
            memberPartnerLink: { findUnique: vi.fn().mockResolvedValue(null) },
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
      expect(txMemberUpdate).toHaveBeenCalledWith({
        where: { id: "child-1" },
        data: expect.objectContaining({
          parent: { connect: { id: "parent-1" } },
          inheritParentEmail: true,
          inheritEmailFrom: { connect: { id: "parent-1" } },
          // #2716: every writer records WHO WAS CHOSEN beside the mailbox the
          // choice currently resolves to. Under one hop the two are the same
          // member here — the requester — but they are separate columns, and
          // pinning the choice is what proves the writer did not skip it.
          inheritEmailChoice: { connect: { id: "parent-1" } },
        }),
      });
      expect(txUpsert).toHaveBeenCalledWith({
        where: {
          familyGroupId_memberId: {
            familyGroupId: "fg1",
            memberId: "child-1",
          },
        },
        // #2520: membership only — the retired `role` is not written. `select`
        // narrows the write's implicit RETURNING (#2130 house rule).
        create: {
          familyGroupId: "fg1",
          memberId: "child-1",
        },
        update: {},
        select: { id: true },
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

    /**
     * #2255 (M10). The family-group reviewer is one of the writers that never
     * saw the previous rule, and nothing exercised its new gate: every fixture
     * in this file stubs the family-link walk to "no ancestors", so deleting
     * the guard left the suite green. These two build a requester who is
     * already three parent-links deep, on each of the reviewer's branches.
     */
    function deepRequesterTx(extra: Record<string, unknown> = {}) {
      // gggp -> ggp -> gp -> parent-1
      const parentsById: Record<string, string | null> = {
        "parent-1": "gp",
        gp: "ggp",
        ggp: "gggp",
        gggp: null,
      };
      const findMany = vi.fn(async ({ where }: any) => {
        if (where?.id?.in) {
          return where.id.in.map((id: string) => ({
            id,
            email: `${id}@test.com`,
            ageTier: "ADULT",
            archivedAt: null,
            inheritEmailFromId: null,
            parentMemberId: parentsById[id] ?? null,
            secondaryParentId: null,
          }));
        }
        // Walking DOWN from the child: no dependants of its own.
        return [];
      });
      mockedPrisma.member.findMany.mockImplementation(findMany as never);
      mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
        callback({
          $executeRaw: vi.fn().mockResolvedValue(undefined),
            member: {
              findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === "parent-1"
                  ? {
                      id: "parent-1",
                      active: true,
                      archivedAt: null,
                      ageTier: "ADULT",
                      inheritEmailFromId: null,
                    }
                  : {
                      id: "child-1",
                      active: true,
                      archivedAt: null,
                      ageTier: "INFANT",
                      canLogin: false,
                      parentMemberId: null,
                      secondaryParentId: null,
                      inheritEmailFromId: null,
                      parent: null,
                      secondaryParent: null,
                    },
              ),
              findMany,
              ...extra,
            },
            memberPartnerLink: { findUnique: vi.fn().mockResolvedValue(null) },
          familyGroupMember: { upsert: vi.fn() },
          familyGroupJoinRequest: { update: vi.fn() },
        })
      );
    }

    it("refuses linking a child under a requester who already fills the cap", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-1",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        requester: { id: "parent-1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true, ageTier: "ADULT", inheritEmailFromId: null },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "child-1",
        active: true,
        ageTier: "INFANT",
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        parent: null,
        secondaryParent: null,
      } as any);
      const txMemberUpdate = vi.fn();
      deepRequesterTx({ update: txMemberUpdate });

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-1",
          action: "approve",
          linkedMemberId: "child-1",
        })
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(txMemberUpdate).not.toHaveBeenCalled();
    });

    it("refuses CREATING a child under a requester who already fills the cap", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-create",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
        requester: {
          id: "parent-1",
          firstName: "Alice",
          lastName: "Smith",
          email: "Alice@Test.com",
          active: true,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          streetAddressLine1: null,
          streetAddressLine2: null,
          streetCity: null,
          streetRegion: null,
          streetPostalCode: null,
          streetCountry: null,
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
        },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      mockedPrisma.familyGroupMember.count.mockResolvedValue(1);
      // The create branch resolves and VALIDATES the child's mailbox before the
      // transaction opens, so the source has to read back as usable — otherwise
      // the approval fails on the email rule and never reaches the depth gate
      // this test is about.
      //
      // #2716 made that fixture gap bite: `inheritEmailChoiceId` joined
      // `EMAIL_SOURCE_SELECT`, and a row missing it reads as `undefined`, which
      // is not `null`, so Alice was judged to be inheriting and the approval
      // refused with NO_INHERITABLE_EMAIL_SOURCE_MESSAGE before it ever reached
      // the four-generation cap. The FIXTURE is what was wrong — this test's
      // subject is the depth cap, so the column is added here rather than the
      // expectation being moved to the inheritance message.
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "parent-1",
        ageTier: "ADULT",
        email: "alice@test.com",
        archivedAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      } as any);
      const txMemberCreate = vi.fn();
      deepRequesterTx({ create: txMemberCreate });

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-create",
          action: "approve",
          createNewMember: true,
        })
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/4 generations/i);
      expect(txMemberCreate).not.toHaveBeenCalled();
    });

    it("creates an eligible non-login dependant from a child request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-child-create",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
        requester: {
          id: "parent-1",
          firstName: "Alice",
          lastName: "Smith",
          email: "Alice@Test.com",
          active: true,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "1234567",
          streetAddressLine1: "1 Main St",
          streetAddressLine2: null,
          streetCity: "Example",
          streetRegion: "Waikato",
          streetPostalCode: "3420",
          streetCountry: "NZ",
          postalAddressLine1: "PO Box 1",
          postalAddressLine2: null,
          postalCity: "Example",
          postalRegion: "Waikato",
          postalPostalCode: "3420",
          postalCountry: "NZ",
        },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);
      // #2716: this ONE row is now the whole of the mailbox resolution — the
      // service reads the chosen parent with `EMAIL_SOURCE_SELECT` and asks
      // `isUsableEmailSource` about it, so the fixture must carry the address
      // and BOTH inheritance columns. It previously omitted `email` (the walk
      // read addresses out of `findMany`) and `inheritEmailChoiceId` (which did
      // not exist), and an absent column reads as `undefined`, not `null`.
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "parent-1",
        ageTier: "ADULT",
        active: true,
        email: "Alice@Test.com",
        archivedAt: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      } as any);

      // #2255 left this stub behind: the create branch used to resolve the
      // child's mailbox by WALKING UP from the requester through
      // `member.findMany` on the base client. #2716 retired the walk — the
      // requester is the child's direct parent, so she is either the mailbox or
      // there isn't one — and the stub survives only so the family-chain depth
      // and cycle reads have a shape to return.
      mockedPrisma.member.findMany.mockImplementation((async ({ where }: any) =>
        where?.id?.in?.includes("parent-1")
          ? [
              {
                id: "parent-1",
                email: "Alice@Test.com",
                ageTier: "ADULT",
                archivedAt: null,
                inheritEmailFromId: null,
                parentMemberId: null,
                secondaryParentId: null,
              },
            ]
          : []) as never
      );

      const txMemberCreate = vi.fn().mockResolvedValue({ id: "child-created" });
      const txUpsert = vi.fn();
      const txUpdate = vi.fn();
      mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
        callback({
          // #1936 member-lifecycle advisory lock ($executeRaw) — no
          // pre-existing member on the create path, but the call site exists.
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          member: {
            create: txMemberCreate,
            // #2255: the create branch checks the requester's own ancestry
            // against the four-generation cap before inserting the child.
            findMany: vi.fn().mockResolvedValue([]),
          },
          familyGroupMember: { upsert: txUpsert },
          familyGroupJoinRequest: { update: txUpdate },
        })
      );

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-child-create",
          action: "approve",
          createNewMember: true,
        })
      );

      expect(res.status).toBe(200);
      expect(txMemberCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: "alice@test.com",
          firstName: "Sam",
          lastName: "Smith",
          dateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
          ageTier: "CHILD",
          role: "USER",
          active: true,
          canLogin: false,
          parentMemberId: "parent-1",
          inheritParentEmail: true,
          inheritEmailFromId: "parent-1",
          // #2716: the create writes the CHOICE alongside the pointer. Both
          // name the requester, because one hop means the chosen parent IS the
          // mailbox or there is no mailbox at all.
          inheritEmailChoiceId: "parent-1",
          emailVerified: true,
          phoneCountryCode: "64",
          streetAddressLine1: "1 Main St",
          postalAddressLine1: "PO Box 1",
        }),
        select: { id: true },
      });
      expect(txUpsert).toHaveBeenCalledWith({
        where: {
          familyGroupId_memberId: {
            familyGroupId: "fg1",
            memberId: "child-created",
          },
        },
        // #2520: membership only — the retired `role` is not written. `select`
        // narrows the write's implicit RETURNING (#2130 house rule).
        create: {
          familyGroupId: "fg1",
          memberId: "child-created",
        },
        update: {},
        select: { id: true },
      });
      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: "req-child-create" },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedBy: "admin-1",
          linkedMemberId: "child-created",
        }),
      });
    });

    it("rejects create-new approval for a child request whose tier is not allowed", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-youth-create",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: new Date("2012-03-15T00:00:00.000Z"),
        requester: {
          id: "parent-1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          active: true,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
        },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-youth-create",
          action: "approve",
          createNewMember: true,
        })
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not configured/i);
      expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects create-new approval for legacy child requests without DOB", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
        id: "req-legacy-create",
        familyGroupId: "fg1",
        requesterId: "parent-1",
        status: "PENDING",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: null,
        requester: {
          id: "parent-1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          active: true,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
        },
        familyGroup: { id: "fg1", name: "Smith Family" },
      } as any);

      const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
      const res = await PUT(
        makeReq("/api/admin/family-groups/requests", "PUT", {
          requestId: "req-legacy-create",
          action: "approve",
          createNewMember: true,
        })
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/without DOB/i);
      expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
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
          // #1936 member-lifecycle advisory lock ($executeRaw) on the member
          // being removed.
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          familyGroupMember: { deleteMany: txDeleteMany },
          familyGroupJoinRequest: { update: txUpdate },
          // #1932 E6 billing-family removal sweep NULLs the removed member's
          // selection in the same transaction.
          member: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
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

    // #1789: admin per-decision member-email choice threaded through the route
    // into the CHILD_REQUEST decision sends.
    describe("notifyMember choice (#1789)", () => {
      function childRequestFindUnique() {
        mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
          id: "req-child-1",
          familyGroupId: "fg1",
          requesterId: "parent-1",
          status: "PENDING",
          type: "CHILD_REQUEST",
          childFirstName: "Sam",
          childLastName: "Smith",
          requester: {
            id: "parent-1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@test.com",
            active: true,
            ageTier: "ADULT",
            inheritEmailFromId: null,
          },
          familyGroup: { id: "fg1", name: "Smith Family" },
        } as any);
      }

      function mockChildApproveTransaction() {
        mockedPrisma.member.findUnique.mockResolvedValue({
          id: "child-1",
          active: true,
          ageTier: "INFANT",
          parentMemberId: null,
          secondaryParentId: null,
          inheritEmailFromId: null,
          parent: null,
          secondaryParent: null,
          dependents: [],
          secondaryDependents: [],
        } as any);
        const txUpdate = vi.fn();
        mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
          callback({
            // #1936 member-lifecycle advisory lock ($executeRaw) taken at the
            // top of the review transaction.
            $executeRaw: vi.fn().mockResolvedValue(undefined),
            member: {
              // #2716: one `findUnique` on the chosen parent decides the
              // mailbox, and the usable-source test reads BOTH inheritance
              // columns — see the sibling fixture above.
                findUnique: vi.fn(
                  async ({ where }: { where: { id: string } }) =>
                    where.id === "child-1"
                      ? {
                          id: "child-1",
                          active: true,
                          ageTier: "INFANT",
                          canLogin: false,
                          archivedAt: null,
                          parentMemberId: null,
                          secondaryParentId: null,
                          inheritEmailFromId: null,
                          parent: null,
                          secondaryParent: null,
                        }
                      : {
                          id: "parent-1",
                          active: true,
                          ageTier: "ADULT",
                          email: "parent@test.com",
                          archivedAt: null,
                          parentMemberId: null,
                          secondaryParentId: null,
                          inheritEmailFromId: null,
                          inheritEmailChoiceId: null,
                        },
                ),
              // #2255: family-chain depth/cycle walks (see the sibling fixture
              // above) — the LINK cap, which #2716 left unchanged.
              findMany: vi.fn().mockImplementation(async ({ where }: any) =>
                where?.id?.in
                  ? where.id.in.map((id: string) => ({
                      id,
                      email: `${id}@test.com`,
                      ageTier: "ADULT",
                      archivedAt: null,
                      inheritEmailFromId: null,
                      parentMemberId: null,
                      secondaryParentId: null,
                    }))
                  : []
              ),
              update: vi.fn(),
            },
              memberPartnerLink: {
                findUnique: vi.fn().mockResolvedValue(null),
              },
            familyGroupMember: { upsert: vi.fn() },
            familyGroupJoinRequest: { update: txUpdate },
          })
        );
        return { txUpdate };
      }

      it("rejects a non-boolean notifyMember at the route with 422 (existing parse)", async () => {
        mockedAuth.mockResolvedValue(adminSession);
        const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
        const res = await PUT(
          makeReq("/api/admin/family-groups/requests", "PUT", {
            requestId: "req-child-1",
            action: "approve",
            notifyMember: "false",
          })
        );
        expect(res.status).toBe(422);
        expect(mockedPrisma.familyGroupJoinRequest.findUnique).not.toHaveBeenCalled();
      });

      it("CHILD_REQUEST approve (default) emails the requester and records no notify field", async () => {
        mockedAuth.mockResolvedValue(adminSession);
        childRequestFindUnique();
        const { txUpdate } = mockChildApproveTransaction();

        const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
        const res = await PUT(
          makeReq("/api/admin/family-groups/requests", "PUT", {
            requestId: "req-child-1",
            action: "approve",
            linkedMemberId: "child-1",
          })
        );

        expect(res.status).toBe(200);
        expect(txUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "APPROVED" }),
          })
        );
        expect(sendChildRequestApprovedEmail).toHaveBeenCalledWith(
          "alice@test.com",
          "Alice",
          "Sam Smith",
          "Smith Family"
        );
        const approvedAudit = vi
          .mocked(logAudit)
          .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CHILD_REQUEST_APPROVED")?.[0];
        expect(approvedAudit?.metadata).not.toHaveProperty("notifyMember");
      });

      it("CHILD_REQUEST approve with notifyMember false suppresses the email, still links the member, and audits the choice", async () => {
        mockedAuth.mockResolvedValue(adminSession);
        childRequestFindUnique();
        const { txUpdate } = mockChildApproveTransaction();

        const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
        const res = await PUT(
          makeReq("/api/admin/family-groups/requests", "PUT", {
            requestId: "req-child-1",
            action: "approve",
            linkedMemberId: "child-1",
            notifyMember: false,
          })
        );

        expect(res.status).toBe(200);
        // Child link state change is still applied.
        expect(txUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "APPROVED", linkedMemberId: "child-1" }),
          })
        );
        expect(sendChildRequestApprovedEmail).not.toHaveBeenCalled();
        const approvedAudit = vi
          .mocked(logAudit)
          .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CHILD_REQUEST_APPROVED")?.[0];
        expect(approvedAudit?.metadata).toMatchObject({ notifyMember: false });
      });

      it("CHILD_REQUEST reject (default) emails the requester and records no notify field", async () => {
        mockedAuth.mockResolvedValue(adminSession);
        childRequestFindUnique();
        mockedPrisma.familyGroupJoinRequest.update.mockResolvedValue({} as any);

        const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
        const res = await PUT(
          makeReq("/api/admin/family-groups/requests", "PUT", {
            requestId: "req-child-1",
            action: "reject",
            rejectionReason: "Not eligible",
          })
        );

        expect(res.status).toBe(200);
        expect(sendChildRequestRejectedEmail).toHaveBeenCalledWith(
          "alice@test.com",
          "Alice",
          "Sam Smith",
          "Not eligible"
        );
        const rejectedAudit = vi
          .mocked(logAudit)
          .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CHILD_REQUEST_REJECTED")?.[0];
        expect(rejectedAudit?.metadata).not.toHaveProperty("notifyMember");
      });

      it("CHILD_REQUEST reject with notifyMember false suppresses the email, still rejects, and audits the choice", async () => {
        mockedAuth.mockResolvedValue(adminSession);
        childRequestFindUnique();
        mockedPrisma.familyGroupJoinRequest.update.mockResolvedValue({} as any);

        const { PUT } = await import("@/app/api/admin/family-groups/requests/route");
        const res = await PUT(
          makeReq("/api/admin/family-groups/requests", "PUT", {
            requestId: "req-child-1",
            action: "reject",
            notifyMember: false,
          })
        );

        expect(res.status).toBe(200);
        // Reject state change still applied.
        expect(mockedPrisma.familyGroupJoinRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "REJECTED" }),
          })
        );
        expect(sendChildRequestRejectedEmail).not.toHaveBeenCalled();
        const rejectedAudit = vi
          .mocked(logAudit)
          .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CHILD_REQUEST_REJECTED")?.[0];
        expect(rejectedAudit?.metadata).toMatchObject({ notifyMember: false });
      });
    });
  });
});
