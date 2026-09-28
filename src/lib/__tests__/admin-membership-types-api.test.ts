import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  membershipTypeUpsert: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  membershipTypeFindUniqueOrThrow: vi.fn(),
  membershipTypeFindFirst: vi.fn(),
  membershipTypeCreate: vi.fn(),
  membershipTypeUpdate: vi.fn(),
  membershipTypeDelete: vi.fn(),
  membershipTypeAgeTierDeleteMany: vi.fn(),
  membershipTypeAgeTierCreateMany: vi.fn(),
  xeroContactGroupRuleDeleteMany: vi.fn(),
  xeroContactGroupRuleCreateMany: vi.fn(),
  seasonalMembershipAssignmentFindMany: vi.fn(),
  seasonalMembershipAssignmentUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipType: {
      upsert: mocks.membershipTypeUpsert,
      findMany: mocks.membershipTypeFindMany,
      findUnique: mocks.membershipTypeFindUnique,
      findUniqueOrThrow: mocks.membershipTypeFindUniqueOrThrow,
      findFirst: mocks.membershipTypeFindFirst,
      create: mocks.membershipTypeCreate,
      update: mocks.membershipTypeUpdate,
      delete: mocks.membershipTypeDelete,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    membershipTypeAgeTier: {
      deleteMany: mocks.membershipTypeAgeTierDeleteMany,
      createMany: mocks.membershipTypeAgeTierCreateMany,
    },
    xeroContactGroupRule: {
      deleteMany: mocks.xeroContactGroupRuleDeleteMany,
      createMany: mocks.xeroContactGroupRuleCreateMany,
    },
    member: {
      findMany: vi.fn(),
    },
    seasonalMembershipAssignment: {
      createMany: vi.fn(),
      findMany: mocks.seasonalMembershipAssignmentFindMany,
      updateMany: mocks.seasonalMembershipAssignmentUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  GET as getMembershipTypes,
  POST as createMembershipType,
} from "@/app/api/admin/membership-types/route";
import {
  DELETE as deleteMembershipType,
  PATCH as updateMembershipType,
} from "@/app/api/admin/membership-types/[id]/route";
import { POST as mergeMembershipType } from "@/app/api/admin/membership-types/[id]/merge/route";
import { POST as reorderMembershipTypes } from "@/app/api/admin/membership-types/reorder/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

function membershipType(overrides: Record<string, unknown> = {}) {
  return {
    id: "type-1",
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    allowedAgeTiers: [
      { ageTier: "INFANT" },
      { ageTier: "CHILD" },
      { ageTier: "YOUTH" },
      { ageTier: "ADULT" },
    ],
    xeroContactGroupRules: [],
    _count: { assignments: 2 },
    ...overrides,
  };
}

function request(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req-1",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("Admin membership types API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.membershipTypeUpsert.mockResolvedValue({});
    mocks.membershipTypeFindMany.mockResolvedValue([membershipType()]);
    mocks.membershipTypeFindUnique.mockResolvedValue(null);
    // findFirst serves both the duplicate-name guard (where.name) and the
    // next-sortOrder lookup; default to "no duplicate" for name queries.
    mocks.membershipTypeFindFirst.mockImplementation(async (args) =>
      args?.where?.name ? null : { sortOrder: 3 },
    );
    mocks.membershipTypeCreate.mockImplementation(async ({ data }) =>
      membershipType({
        id: "type-custom",
        key: data.key,
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        isBuiltIn: false,
        bookingBehavior: data.bookingBehavior,
        subscriptionBehavior: data.subscriptionBehavior,
        sortOrder: data.sortOrder,
        _count: { assignments: 0 },
      }),
    );
    mocks.membershipTypeUpdate.mockImplementation(async ({ data }) =>
      membershipType({
        ...data,
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );
    mocks.membershipTypeDelete.mockResolvedValue({});
    mocks.membershipTypeFindUniqueOrThrow.mockImplementation(async ({ where }) =>
      membershipType({
        id: where.id,
        key: where.id === "type-custom" ? "SOCIAL_MEMBER" : "FULL",
        name: where.id === "type-custom" ? "Social member" : "Full",
        isBuiltIn: where.id !== "type-custom",
        _count: { assignments: 0 },
        allowedAgeTiers: [{ ageTier: "ADULT" }],
        xeroContactGroupRules: [
          {
            id: "rule-managed-adult",
            ageTiers: ["ADULT"],
            mode: "MANAGED",
            groupId: "group-adult-social",
            groupName: "Adult Social",
            isActive: true,
            sortOrder: 0,
          },
        ],
      }),
    );
    mocks.membershipTypeAgeTierDeleteMany.mockResolvedValue({ count: 0 });
    mocks.membershipTypeAgeTierCreateMany.mockResolvedValue({ count: 1 });
    mocks.xeroContactGroupRuleDeleteMany.mockResolvedValue({ count: 0 });
    mocks.xeroContactGroupRuleCreateMany.mockResolvedValue({ count: 1 });
    mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([]);
    mocks.seasonalMembershipAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        membershipType: {
          create: mocks.membershipTypeCreate,
          update: mocks.membershipTypeUpdate,
          delete: mocks.membershipTypeDelete,
          findUniqueOrThrow: mocks.membershipTypeFindUniqueOrThrow,
        },
        membershipTypeAgeTier: {
          deleteMany: mocks.membershipTypeAgeTierDeleteMany,
          createMany: mocks.membershipTypeAgeTierCreateMany,
        },
        xeroContactGroupRule: {
          deleteMany: mocks.xeroContactGroupRuleDeleteMany,
          createMany: mocks.xeroContactGroupRuleCreateMany,
        },
        seasonalMembershipAssignment: {
          updateMany: mocks.seasonalMembershipAssignmentUpdateMany,
          // #2106 (MAJOR-2): the PATCH re-reads offending assignees inside the
          // write transaction; reuse the same mock as the pre-tx read.
          findMany: mocks.seasonalMembershipAssignmentFindMany,
        },
        auditLog: {
          create: mocks.auditLogCreate,
        },
      }),
    );
  });

  it("prevents non-admin users from reading membership types", async () => {
    mocks.auth.mockResolvedValue(memberSession);

    const response = await getMembershipTypes();

    expect(response.status).toBe(403);
    expect(mocks.membershipTypeFindMany).not.toHaveBeenCalled();
  });

  it("returns membership types with assignment counts for admins", async () => {
    const response = await getMembershipTypes();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpsert).not.toHaveBeenCalled();
    expect(body.membershipTypes).toEqual([
      expect.objectContaining({
        id: "type-1",
          key: "FULL",
          assignmentCount: 2,
          allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
        }),
      ]);
  });

  it("rejects unknown fields so stable identifiers cannot be mutated", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        key: "MUTATED",
        name: "Social",
        bookingBehavior: "MEMBER_RATE",
        subscriptionBehavior: "REQUIRED",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.membershipTypeCreate).not.toHaveBeenCalled();
  });

  it("creates custom membership types and writes structured audit", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "Social member",
        description: "Social membership",
        bookingBehavior: "NON_MEMBER_RATE",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: ["ADULT"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.membershipType.key).toBe("SOCIAL_MEMBER");
    expect(mocks.membershipTypeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "SOCIAL_MEMBER",
          name: "Social member",
          isBuiltIn: false,
          bookingBehavior: "NON_MEMBER_RATE",
          subscriptionBehavior: "NOT_REQUIRED",
          sortOrder: 4,
        }),
      }),
    );
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [{ membershipTypeId: "type-custom", ageTier: "ADULT" }],
      skipDuplicates: true,
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_CREATED",
          actor: { memberId: "admin-1" },
          entity: { type: "MembershipType", id: "type-custom" },
        }),
      }),
    );
    expect(mocks.membershipTypeFindFirst).toHaveBeenCalledWith({
      where: { name: { equals: "Social member", mode: "insensitive" } },
      select: { id: true, name: true },
    });
  });

  it("creates a type with only N/A (no age) ticked (#2069)", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "School org",
        bookingBehavior: "NON_MEMBER_RATE",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: ["NOT_APPLICABLE"],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [{ membershipTypeId: "type-custom", ageTier: "NOT_APPLICABLE" }],
      skipDuplicates: true,
    });
  });

  it("defaults omitted allowedAgeTiers to the four age tiers, never N/A (#2069)", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "Defaulted",
        bookingBehavior: "MEMBER_RATE",
        subscriptionBehavior: "REQUIRED",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [
        { membershipTypeId: "type-custom", ageTier: "INFANT" },
        { membershipTypeId: "type-custom", ageTier: "CHILD" },
        { membershipTypeId: "type-custom", ageTier: "YOUTH" },
        { membershipTypeId: "type-custom", ageTier: "ADULT" },
      ],
      skipDuplicates: true,
    });
  });

  it("accepts BASED_ON_AGE_TIER end-to-end through zod into the create (#2041)", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "Age banded",
        bookingBehavior: "MEMBER_RATE",
        subscriptionBehavior: "BASED_ON_AGE_TIER",
        allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.membershipTypeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionBehavior: "BASED_ON_AGE_TIER",
        }),
      }),
    );
  });

  it("rejects creating a case-insensitive duplicate membership type name", async () => {
    mocks.membershipTypeFindFirst.mockResolvedValueOnce({
      id: "type-social",
      name: "Social",
    });

    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "SOCIAL",
        bookingBehavior: "NON_MEMBER_RATE",
        subscriptionBehavior: "NOT_REQUIRED",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      'A membership type named "Social" already exists.',
    );
    expect(mocks.membershipTypeFindFirst).toHaveBeenCalledWith({
      where: { name: { equals: "SOCIAL", mode: "insensitive" } },
      select: { id: true, name: true },
    });
    expect(mocks.membershipTypeCreate).not.toHaveBeenCalled();
  });

  it("archives and reactivates membership types through audited updates", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const archived = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { isActive: false },
        "PATCH",
      ),
      params("type-custom"),
    );

    expect(archived.status).toBe(200);
    expect(mocks.auditLogCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_ARCHIVED",
        }),
      }),
    );

    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        isActive: false,
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const reactivated = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { isActive: true },
        "PATCH",
      ),
      params("type-custom"),
    );

    expect(reactivated.status).toBe(200);
    expect(mocks.auditLogCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_REACTIVATED",
        }),
      }),
    );
  });

  it.each([
    ["FULL", "MEMBER_RATE", "NON_MEMBER_RATE"],
    ["NON_MEMBER", "NON_MEMBER_RATE", "MEMBER_RATE"],
  ] as const)("protects %s from archive and booking-rule changes", async (key, canonical, other) => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ key, bookingBehavior: canonical }),
    );
    for (const patch of [{ isActive: false }, { bookingBehavior: other }]) {
      const response = await updateMembershipType(
        request("http://localhost/api/admin/membership-types/type-1", patch, "PATCH"),
        params("type-1"),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("INV-LIFE-093");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.membershipTypeUpdate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["FULL", "MEMBER_RATE", "NON_MEMBER_RATE"],
    ["NON_MEMBER", "NON_MEMBER_RATE", "MEMBER_RATE"],
  ] as const)("allows %s reactivation and repair from old drift", async (key, canonical, wrong) => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ key, isActive: false, bookingBehavior: wrong }),
    );
    const response = await updateMembershipType(
      request("http://localhost/api/admin/membership-types/type-1", {
        isActive: true,
        bookingBehavior: canonical,
      }, "PATCH"),
      params("type-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: true, bookingBehavior: canonical }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("lets an already archived Full type save unrelated fields without rewriting stale protected values", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ isActive: false, bookingBehavior: "NON_MEMBER_RATE" }),
    );
    const response = await updateMembershipType(
      request("http://localhost/api/admin/membership-types/type-1", {
        description: "Updated description",
        isActive: false,
        bookingBehavior: "NON_MEMBER_RATE",
      }, "PATCH"),
      params("type-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: "Updated description" } }),
    );
  });

  it.each([
    ["FULL", "MEMBER_RATE"],
    ["NON_MEMBER", "NON_MEMBER_RATE"],
  ] as const)("accepts an unchanged %s full-draft save", async (key, bookingBehavior) => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ key, bookingBehavior }),
    );
    const response = await updateMembershipType(
      request("http://localhost/api/admin/membership-types/type-1", {
        description: "Updated description",
        isActive: true,
        bookingBehavior,
      }, "PATCH"),
      params("type-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: "Updated description" } }),
    );
  });

  it("keeps custom types' booking behavior editable", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ key: "SOCIAL_MEMBER", isBuiltIn: false }),
    );
    const response = await updateMembershipType(
      request("http://localhost/api/admin/membership-types/type-1", {
        bookingBehavior: "NON_MEMBER_RATE",
      }, "PATCH"),
      params("type-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bookingBehavior: "NON_MEMBER_RATE" } }),
    );
  });

  it("rejects identifier mutation on update payloads", async () => {
    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        { key: "MUTATED" },
        "PATCH",
      ),
      params("type-1"),
    );

    expect(response.status).toBe(400);
    expect(mocks.membershipTypeUpdate).not.toHaveBeenCalled();
  });

  it("rejects renaming a membership type to another type's name", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        name: "Social member",
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );
    mocks.membershipTypeFindFirst.mockResolvedValueOnce({
      id: "type-1",
      name: "Full",
    });

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { name: "full" },
        "PATCH",
      ),
      params("type-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('A membership type named "Full" already exists.');
    expect(mocks.membershipTypeFindFirst).toHaveBeenCalledWith({
      where: {
        id: { not: "type-custom" },
        name: { equals: "full", mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    expect(mocks.membershipTypeUpdate).not.toHaveBeenCalled();
  });

  it("allows renaming a membership type to a case variant of its own name", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        name: "Social member",
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { name: "SOCIAL MEMBER" },
        "PATCH",
      ),
      params("type-custom"),
    );

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeFindFirst).toHaveBeenCalledWith({
      where: {
        id: { not: "type-custom" },
        name: { equals: "SOCIAL MEMBER", mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "SOCIAL MEMBER" }),
      }),
    );
  });

  it("updates allowed age tiers", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-1",
        allowedAgeTiers: [{ ageTier: "ADULT" }],
      }),
    );

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        {
          allowedAgeTiers: ["YOUTH", "ADULT"],
        },
        "PATCH",
      ),
      params("type-1"),
    );

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeAgeTierDeleteMany).toHaveBeenCalledWith({
      where: { membershipTypeId: "type-1" },
    });
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [
        { membershipTypeId: "type-1", ageTier: "YOUTH" },
        { membershipTypeId: "type-1", ageTier: "ADULT" },
      ],
      skipDuplicates: true,
    });
  });

  it("updates allowed age tiers to N/A (no age) only", async () => {
    // #2106: age-exempt (N/A) config is only valid on NOT_REQUIRED types.
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-1",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: [{ ageTier: "ADULT" }],
      }),
    );

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        {
          allowedAgeTiers: ["NOT_APPLICABLE"],
        },
        "PATCH",
      ),
      params("type-1"),
    );

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [{ membershipTypeId: "type-1", ageTier: "NOT_APPLICABLE" }],
      skipDuplicates: true,
    });
  });

  it("blocks removing N/A (ALLOWED -> DISALLOWED) while a non-org N/A member is assigned (#2106)", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-1",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: [{ ageTier: "ADULT" }, { ageTier: "NOT_APPLICABLE" }],
      }),
    );
    mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
      { member: { ageTier: "NOT_APPLICABLE", role: "USER", accessRoles: [] } },
    ]);

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        { allowedAgeTiers: ["ADULT"] },
        "PATCH",
      ),
      params("type-1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("N/A");
    expect(mocks.membershipTypeAgeTierCreateMany).not.toHaveBeenCalled();
  });

  it("allows removing N/A when the only N/A holder is an org member (global org force, #2106)", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-1",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: [{ ageTier: "ADULT" }, { ageTier: "NOT_APPLICABLE" }],
      }),
    );
    mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
      {
        member: {
          ageTier: "NOT_APPLICABLE",
          role: "SCHOOL",
          accessRoles: [{ role: "ORG" }],
        },
      },
    ]);

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        { allowedAgeTiers: ["ADULT"] },
        "PATCH",
      ),
      params("type-1"),
    );

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeAgeTierCreateMany).toHaveBeenCalledWith({
      data: [{ membershipTypeId: "type-1", ageTier: "ADULT" }],
      skipDuplicates: true,
    });
  });

  it("catches a race in the in-transaction re-check (MAJOR-2 TOCTOU) and 409s without writing", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-1",
        subscriptionBehavior: "NOT_REQUIRED",
        allowedAgeTiers: [{ ageTier: "ADULT" }, { ageTier: "NOT_APPLICABLE" }],
      }),
    );
    // Pre-tx read sees no offending assignees; a concurrent write then strands
    // an N/A member, which the in-tx re-read (second call) must catch.
    mocks.seasonalMembershipAssignmentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { member: { ageTier: "NOT_APPLICABLE", role: "USER", accessRoles: [] } },
      ]);

    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        { allowedAgeTiers: ["ADULT"] },
        "PATCH",
      ),
      params("type-1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("N/A");
    expect(mocks.membershipTypeAgeTierCreateMany).not.toHaveBeenCalled();
    expect(mocks.membershipTypeUpdate).not.toHaveBeenCalled();
  });

  it("reorders membership types and audits previous and new order", async () => {
    mocks.membershipTypeFindMany
      .mockResolvedValueOnce([
        membershipType({ id: "type-full", key: "FULL", sortOrder: 0 }),
        membershipType({ id: "type-life", key: "LIFE", sortOrder: 1 }),
      ])
      .mockResolvedValueOnce([
        membershipType({ id: "type-life", key: "LIFE", sortOrder: 0 }),
        membershipType({ id: "type-full", key: "FULL", sortOrder: 1 }),
      ]);

    const response = await reorderMembershipTypes(
      request("http://localhost/api/admin/membership-types/reorder", {
        orderedIds: ["type-life", "type-full"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.membershipTypes.map((type: { id: string }) => type.id)).toEqual([
      "type-life",
      "type-full",
    ]);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith({
      where: { id: "type-life" },
      data: { sortOrder: 0 },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPES_REORDERED",
        }),
      }),
    );
  });

  it("protects built-in membership types from deletion", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ id: "type-full", isBuiltIn: true }),
    );

    const response = await deleteMembershipType(
      new NextRequest("http://localhost/api/admin/membership-types/type-full", {
        method: "DELETE",
      }),
      params("type-full"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("Built-in");
    expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
  });

  it("deletes a zero-assignment custom membership type", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        name: "Social member",
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const response = await deleteMembershipType(
      new NextRequest(
        "http://localhost/api/admin/membership-types/type-custom",
        { method: "DELETE" },
      ),
      params("type-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.membershipTypeDelete).toHaveBeenCalledWith({
      where: { id: "type-custom" },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "MEMBERSHIP_TYPE_DELETED" }),
      }),
    );
  });

  it("blocks deleting a custom type that still has assignments (routes to merge)", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        name: "Social member",
        isBuiltIn: false,
        _count: { assignments: 4 },
      }),
    );

    const response = await deleteMembershipType(
      new NextRequest(
        "http://localhost/api/admin/membership-types/type-custom",
        { method: "DELETE" },
      ),
      params("type-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("seasonal assignments");
    expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
  });

  describe("merge", () => {
    function mockTypesById(byId: Record<string, unknown>) {
      mocks.membershipTypeFindUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) => byId[where.id] ?? null,
      );
    }

    const source = () =>
      membershipType({
        id: "type-source",
        key: "SOCIAL_MEMBER",
        name: "Social member",
        isBuiltIn: false,
        isActive: true,
        allowedAgeTiers: [{ ageTier: "ADULT" }],
        _count: { assignments: 3 },
      });

    const target = () =>
      membershipType({
        id: "type-target",
        key: "ASSOCIATE",
        name: "Associate",
        isBuiltIn: true,
        isActive: true,
        allowedAgeTiers: [{ ageTier: "ADULT" }],
        _count: { assignments: 5 },
      });

    it("reassigns every source assignment to the target then deletes the source", async () => {
      mockTypesById({ "type-source": source(), "type-target": target() });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        { id: "a1", memberId: "m1", seasonYear: 2026, member: { ageTier: "ADULT" } },
        { id: "a2", memberId: "m2", seasonYear: 2026, member: { ageTier: "ADULT" } },
        {
          id: "a3",
          memberId: "m3",
          seasonYear: 2025,
          // #2106: an ORG member's N/A is a global org force, so it merges onto
          // an ADULT-only target (which does not list N/A) without blocking.
          member: {
            ageTier: "NOT_APPLICABLE",
            role: "USER",
            accessRoles: [{ role: "ORG" }],
          },
        },
      ]);
      mocks.seasonalMembershipAssignmentUpdateMany.mockResolvedValue({
        count: 3,
      });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        reassignedCount: 3,
        sourceId: "type-source",
        targetId: "type-target",
      });
      expect(mocks.seasonalMembershipAssignmentUpdateMany).toHaveBeenCalledWith({
        where: { membershipTypeId: "type-source" },
        data: { membershipTypeId: "type-target" },
      });
      expect(mocks.membershipTypeDelete).toHaveBeenCalledWith({
        where: { id: "type-source" },
      });
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "MEMBERSHIP_TYPE_MERGED",
            metadata: expect.objectContaining({
              sourceId: "type-source",
              targetId: "type-target",
              reassignedCount: 3,
              reassignedAssignmentsTruncated: false,
              reassignedAssignments: [
                { assignmentId: "a1", memberId: "m1", seasonYear: 2026 },
                { assignmentId: "a2", memberId: "m2", seasonYear: 2026 },
                { assignmentId: "a3", memberId: "m3", seasonYear: 2025 },
              ],
            }),
          }),
        }),
      );
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "MEMBERSHIP_TYPE_DELETED",
          }),
        }),
      );
    });

    it("rolls back with no partial writes when the reassignment fails", async () => {
      mockTypesById({ "type-source": source(), "type-target": target() });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        { id: "a1", memberId: "m1", member: { ageTier: "ADULT" } },
      ]);
      mocks.seasonalMembershipAssignmentUpdateMany.mockRejectedValue(
        new Error("db exploded"),
      );

      await expect(
        mergeMembershipType(
          request(
            "http://localhost/api/admin/membership-types/type-source/merge",
            { targetId: "type-target" },
          ),
          params("type-source"),
        ),
      ).rejects.toThrow("db exploded");

      // All-or-nothing: the delete and audits never ran.
      expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
      expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    });

    it("rejects a built-in source", async () => {
      mockTypesById({
        "type-source": source(),
        "type-target": target(),
        "type-full": membershipType({ id: "type-full", isBuiltIn: true }),
      });

      const response = await mergeMembershipType(
        request("http://localhost/api/admin/membership-types/type-full/merge", {
          targetId: "type-target",
        }),
        params("type-full"),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("Built-in");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
    });

    it("rejects an archived target", async () => {
      mockTypesById({
        "type-source": source(),
        "type-target": membershipType({
          id: "type-target",
          isBuiltIn: false,
          isActive: false,
          allowedAgeTiers: [{ ageTier: "ADULT" }],
        }),
      });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("Archived");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
    });

    it("rejects merging a type into itself", async () => {
      mockTypesById({ "type-source": source() });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-source" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain("itself");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
    });

    it("blocks a merge when an affected member's age tier is not allowed by the target", async () => {
      mockTypesById({ "type-source": source(), "type-target": target() });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        { id: "a1", memberId: "m1", member: { ageTier: "ADULT" } },
        { id: "a2", memberId: "m2", member: { ageTier: "YOUTH" } },
      ]);

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("YOUTH");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
    });

    it("blocks real-age members from merging into an N/A-only target (#2069)", async () => {
      mockTypesById({
        "type-source": source(),
        "type-target": membershipType({
          id: "type-target",
          key: "SCHOOL_ORG",
          name: "School org",
          isBuiltIn: false,
          isActive: true,
          allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }],
        }),
      });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        { id: "a1", memberId: "m1", member: { ageTier: "ADULT" } },
      ]);

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("ADULT");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
    });

    it("lets N/A members merge into an N/A-only target (#2069)", async () => {
      mockTypesById({
        "type-source": source(),
        "type-target": membershipType({
          id: "type-target",
          key: "SCHOOL_ORG",
          name: "School org",
          isBuiltIn: false,
          isActive: true,
          allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }],
        }),
      });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        {
          id: "a1",
          memberId: "m1",
          seasonYear: 2026,
          member: { ageTier: "NOT_APPLICABLE" },
        },
      ]);
      mocks.seasonalMembershipAssignmentUpdateMany.mockResolvedValue({
        count: 1,
      });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );

      expect(response.status).toBe(200);
      expect(mocks.seasonalMembershipAssignmentUpdateMany).toHaveBeenCalledWith({
        where: { membershipTypeId: "type-source" },
        data: { membershipTypeId: "type-target" },
      });
      expect(mocks.membershipTypeDelete).toHaveBeenCalledWith({
        where: { id: "type-source" },
      });
    });

    it("blocks a NON-ORG N/A member from merging into a target that does not allow N/A (#2106)", async () => {
      mockTypesById({ "type-source": source(), "type-target": target() });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        {
          id: "a1",
          memberId: "m1",
          seasonYear: 2026,
          member: {
            ageTier: "NOT_APPLICABLE",
            role: "USER",
            accessRoles: [],
          },
        },
      ]);

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("N/A");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
    });

    it("lets an ORG N/A member merge into a target that does not allow N/A (global org force, #2106)", async () => {
      mockTypesById({ "type-source": source(), "type-target": target() });
      mocks.seasonalMembershipAssignmentFindMany.mockResolvedValue([
        {
          id: "a1",
          memberId: "m1",
          seasonYear: 2026,
          member: {
            ageTier: "NOT_APPLICABLE",
            role: "SCHOOL",
            accessRoles: [{ role: "ORG" }],
          },
        },
      ]);
      mocks.seasonalMembershipAssignmentUpdateMany.mockResolvedValue({
        count: 1,
      });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-target" },
        ),
        params("type-source"),
      );

      expect(response.status).toBe(200);
      expect(mocks.seasonalMembershipAssignmentUpdateMany).toHaveBeenCalledWith({
        where: { membershipTypeId: "type-source" },
        data: { membershipTypeId: "type-target" },
      });
      expect(mocks.membershipTypeDelete).toHaveBeenCalledWith({
        where: { id: "type-source" },
      });
    });

    it("returns 404 when the target does not exist", async () => {
      mockTypesById({ "type-source": source() });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-source/merge",
          { targetId: "type-missing" },
        ),
        params("type-source"),
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain("Target");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
    });

    it("returns 404 when the source does not exist", async () => {
      mockTypesById({ "type-target": target() });

      const response = await mergeMembershipType(
        request(
          "http://localhost/api/admin/membership-types/type-missing/merge",
          { targetId: "type-target" },
        ),
        params("type-missing"),
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain("Source");
      expect(mocks.seasonalMembershipAssignmentUpdateMany).not.toHaveBeenCalled();
    });
  });
});
