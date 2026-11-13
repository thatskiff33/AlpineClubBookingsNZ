// #4988: POST /api/admin/members/import with the Membership Type and Family
// Key columns. The server matches the type itself against ACTIVE types, never
// overwrites an existing assignment, assigns through the hardened seasonal
// save path with source IMPORT, and groups created rows sharing a key into one
// family group through the admin family-group writer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: vi.fn() },
    membershipType: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    memberFieldsSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    passwordResetToken: { create: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn().mockReturnValue({}),
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

const mockPreview = vi.fn();
const mockSave = vi.fn();
vi.mock("@/lib/seasonal-membership-assignments", () => ({
  getSeasonalMembershipChangePreview: (...args: unknown[]) =>
    mockPreview(...args),
  saveSeasonalMembershipAssignment: (...args: unknown[]) => mockSave(...args),
}));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { ADMIN_FAMILY_GROUP_MAX_MEMBERS } from "@/lib/admin-family-group-create";

const adminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

const familyGroupsCreated: Array<{ name: string }> = [];
const familyMemberships: Array<{ familyGroupId: string; memberId: string }> =
  [];
let createdCount = 0;

function mockCreateTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
    fn({
      member: {
        create: vi.fn(async ({ data }: any) => {
          createdCount++;
          return {
            id: `new-${createdCount}`,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            canLogin: data.canLogin,
          };
        }),
      },
      memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      familyGroup: {
        create: vi.fn(async ({ data }: any) => {
          familyGroupsCreated.push(data);
          return { id: `fg-${familyGroupsCreated.length}` };
        }),
      },
      familyGroupMember: {
        createMany: vi.fn(async ({ data }: any) => {
          familyMemberships.push(...data);
          return { count: data.length };
        }),
      },
    }),
  );
}

function importRequest(rows: Array<Record<string, unknown>>) {
  return importMembers(
    new NextRequest("http://localhost/api/admin/members/import", {
      method: "POST",
      body: JSON.stringify({ rows, sendInvites: false }),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("#4988 member import: Membership Type and Family Key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    familyGroupsCreated.length = 0;
    familyMemberships.length = 0;
    createdCount = 0;
    mockRequireAdmin.mockResolvedValue(adminGuard);
    vi.mocked(prisma.member.findMany).mockResolvedValue([]);
    vi.mocked(prisma.membershipType.findMany).mockResolvedValue([
      { id: "type-full", name: "Full Member" },
      { id: "type-junior", name: "Junior" },
    ] as never);
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue(
      [],
    );
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: "Pacific/Auckland",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    } as never);
    mockPreview.mockResolvedValue({
      body: { preview: { previewToken: "token-1" } },
    });
    mockSave.mockResolvedValue({ body: { ok: true } });
    mockCreateTransaction();
  });

  it("assigns the matched active type through the seasonal save path", async () => {
    const res = await importRequest([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        membershipType: " full member ",
      },
    ]);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.membershipTypesAssigned).toBe(1);
    expect(vi.mocked(prisma.membershipType.findMany)).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "new-1",
        membershipTypeId: "type-full",
        adminMemberId: "actor1",
        previewToken: "token-1",
        source: "IMPORT",
        skipXeroContactGroupSync: true,
      }),
    );
  });

  it("blocks the whole import when a row names no active type", async () => {
    const res = await importRequest([
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      {
        firstName: "Bo",
        lastName: "Brown",
        email: "bo@example.com",
        membershipType: "Gold",
        sourceLineNumber: 3,
        sourceColumnLabels: { membershipType: "Category" },
      },
    ]);

    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toEqual([
      {
        row: 3,
        errors: [
          'Membership Type (column Category) "Gold" is not the name of an active membership type',
        ],
      },
    ]);
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("never overwrites an existing current-season assignment", async () => {
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue([
      { memberId: "new-1" },
    ] as never);
    const res = await importRequest([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        membershipType: "Junior",
      },
    ]);
    const data = await res.json();
    expect(data.membershipTypesAssigned).toBe(0);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("reports an assignment the save path refused, keeping the members", async () => {
    mockSave.mockResolvedValue({
      body: { error: "Age not allowed for this type" },
      init: { status: 422 },
    });
    const res = await importRequest([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        membershipType: "Junior",
        sourceLineNumber: 2,
      },
    ]);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.membershipTypesAssigned).toBe(0);
    expect(data.membershipTypeFailures).toEqual([
      {
        row: 2,
        email: "ada@example.com",
        error: "Age not allowed for this type",
      },
    ]);
  });

  it("does not assign a type to a member imported as cancelled", async () => {
    const res = await importRequest([
      {
        firstName: "Cora",
        lastName: "Cancelled",
        email: "cora@example.com",
        cancelledDate: "2020-06-30",
        membershipType: "Junior",
      },
    ]);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(data.rowNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          note: "Membership Type not applied because the member was imported as cancelled",
        }),
      ]),
    );
  });

  it("groups created rows sharing a key into one audited family group", async () => {
    const res = await importRequest([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        familyKey: "L1",
      },
      {
        firstName: "Byron",
        lastName: "Lovelace",
        email: "byron@example.com",
        familyKey: " l1 ",
      },
      { firstName: "Solo", lastName: "Sam", email: "sam@example.com" },
    ]);

    const data = await res.json();
    expect(data.created).toBe(3);
    expect(data.familyGroupsCreated).toBe(1);
    expect(familyGroupsCreated).toEqual([{ name: "Lovelace Family" }]);
    expect(familyMemberships).toEqual([
      { familyGroupId: "fg-1", memberId: "new-1" },
      { familyGroupId: "fg-1", memberId: "new-2" },
    ]);
    expect(vi.mocked(createAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATED",
        category: "family",
        entityId: "fg-1",
      }),
      expect.anything(),
    );
  });

  it("blocks every row of a key larger than a family group may hold", async () => {
    const rows = Array.from(
      { length: ADMIN_FAMILY_GROUP_MAX_MEMBERS + 1 },
      (_, index) => ({
        firstName: `P${index}`,
        lastName: "Big",
        email: `p${index}@example.com`,
        familyKey: "BIG",
      }),
    );
    const res = await importRequest(rows);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(ADMIN_FAMILY_GROUP_MAX_MEMBERS + 1);
    expect(data.errors[0].errors[0]).toContain(
      `a family group holds at most ${ADMIN_FAMILY_GROUP_MAX_MEMBERS} members`,
    );
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
  });

  it("leaves an existing member out of the family and says so", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: null,
        canLogin: true,
      },
    ] as never);
    const res = await importRequest([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        familyKey: "L1",
      },
      {
        firstName: "Byron",
        lastName: "Lovelace",
        email: "byron@example.com",
        familyKey: "L1",
      },
    ]);
    const data = await res.json();
    expect(data.skippedRows[0].reason).toContain(
      "its Membership Type and Family Key were not applied",
    );
    expect(familyMemberships).toEqual([
      { familyGroupId: "fg-1", memberId: "new-1" },
    ]);
  });

  it("reads no membership types when the file has no such column", async () => {
    await importRequest([
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    ]);
    expect(vi.mocked(prisma.membershipType.findMany)).not.toHaveBeenCalled();
    expect(familyGroupsCreated).toEqual([]);
  });
});
