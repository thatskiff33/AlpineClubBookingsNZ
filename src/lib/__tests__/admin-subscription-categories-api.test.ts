import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  subscriptionCategoryFindMany: vi.fn(),
  subscriptionCategoryFindUnique: vi.fn(),
  subscriptionCategoryFindFirst: vi.fn(),
  subscriptionCategoryCreate: vi.fn(),
  subscriptionCategoryUpdate: vi.fn(),
  subscriptionCategoryDelete: vi.fn(),
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
    subscriptionCategory: {
      findMany: mocks.subscriptionCategoryFindMany,
      findUnique: mocks.subscriptionCategoryFindUnique,
      findFirst: mocks.subscriptionCategoryFindFirst,
      create: mocks.subscriptionCategoryCreate,
      update: mocks.subscriptionCategoryUpdate,
      delete: mocks.subscriptionCategoryDelete,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  GET as getSubscriptionCategories,
  POST as createSubscriptionCategory,
} from "@/app/api/admin/subscription-categories/route";
import {
  DELETE as deleteSubscriptionCategory,
  PATCH as updateSubscriptionCategory,
} from "@/app/api/admin/subscription-categories/[id]/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

function subscriptionCategory(overrides: Record<string, unknown> = {}) {
  return {
    id: "cat-1",
    key: "INDIVIDUAL",
    name: "Individual",
    description: null,
    isActive: true,
    isBuiltIn: true,
    sortOrder: 0,
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    _count: { assignments: 0, fees: 0 },
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

describe("Admin subscription categories API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.subscriptionCategoryFindMany.mockResolvedValue([subscriptionCategory()]);
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(null);
    mocks.subscriptionCategoryFindFirst.mockImplementation(async (args) =>
      args?.where?.name ? null : { sortOrder: 3 },
    );
    mocks.subscriptionCategoryCreate.mockImplementation(async ({ data }) =>
      subscriptionCategory({
        id: "cat-custom",
        key: data.key,
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        isBuiltIn: false,
        sortOrder: data.sortOrder,
        _count: { assignments: 0, fees: 0 },
      }),
    );
    mocks.subscriptionCategoryUpdate.mockImplementation(async ({ data }) =>
      subscriptionCategory({ ...data, isBuiltIn: false, _count: { assignments: 0, fees: 0 } }),
    );
    mocks.subscriptionCategoryDelete.mockResolvedValue({});
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        subscriptionCategory: {
          create: mocks.subscriptionCategoryCreate,
          update: mocks.subscriptionCategoryUpdate,
          delete: mocks.subscriptionCategoryDelete,
        },
        auditLog: { create: mocks.auditLogCreate },
      }),
    );
  });

  it("prevents non-admin users from reading subscription categories", async () => {
    mocks.auth.mockResolvedValue(memberSession);

    const response = await getSubscriptionCategories();

    expect(response.status).toBe(403);
    expect(mocks.subscriptionCategoryFindMany).not.toHaveBeenCalled();
  });

  it("returns subscription categories with assignment/fee counts for admins", async () => {
    const response = await getSubscriptionCategories();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriptionCategories).toEqual([
      expect.objectContaining({ id: "cat-1", key: "INDIVIDUAL", assignmentCount: 0, feeCount: 0 }),
    ]);
  });

  it("rejects unknown fields so stable identifiers cannot be mutated", async () => {
    const response = await createSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories", {
        key: "MUTATED",
        name: "Couple",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.subscriptionCategoryCreate).not.toHaveBeenCalled();
  });

  it("creates custom subscription categories and writes structured audit", async () => {
    const response = await createSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories", {
        name: "Couple",
        description: "Two partners sharing one flat subscription fee.",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.subscriptionCategory.key).toBe("COUPLE");
    expect(mocks.subscriptionCategoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "COUPLE",
          name: "Couple",
          isBuiltIn: false,
          sortOrder: 4,
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "SUBSCRIPTION_CATEGORY_CREATED" }),
      }),
    );
  });

  it("rejects a duplicate case-insensitive name on create", async () => {
    mocks.subscriptionCategoryFindFirst.mockImplementation(async (args) =>
      args?.where?.name ? subscriptionCategory({ id: "cat-existing", name: "Couple" }) : { sortOrder: 3 },
    );

    const response = await createSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories", { name: "couple" }),
    );

    expect(response.status).toBe(409);
    expect(mocks.subscriptionCategoryCreate).not.toHaveBeenCalled();
  });

  it("updates a custom subscription category", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(
      subscriptionCategory({ id: "cat-custom", isBuiltIn: false }),
    );

    const response = await updateSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-custom", { name: "Couple (updated)" }, "PATCH"),
      params("cat-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriptionCategory.name).toBe("Couple (updated)");
  });

  it("blocks archiving the built-in Individual category", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(subscriptionCategory());

    const response = await updateSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-1", { isActive: false }, "PATCH"),
      params("cat-1"),
    );

    expect(response.status).toBe(409);
    expect(mocks.subscriptionCategoryUpdate).not.toHaveBeenCalled();
  });

  it("protects the built-in Individual category from deletion", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(subscriptionCategory());

    const response = await deleteSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-1", null, "DELETE"),
      params("cat-1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("built-in");
    expect(mocks.subscriptionCategoryDelete).not.toHaveBeenCalled();
  });

  it("deletes a zero-assignment custom subscription category", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(
      subscriptionCategory({ id: "cat-custom", isBuiltIn: false }),
    );

    const response = await deleteSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-custom", null, "DELETE"),
      params("cat-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.subscriptionCategoryDelete).toHaveBeenCalledWith({ where: { id: "cat-custom" } });
  });

  it("blocks deleting a category that still has member assignments", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(
      subscriptionCategory({ id: "cat-custom", isBuiltIn: false, _count: { assignments: 2, fees: 0 } }),
    );

    const response = await deleteSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-custom", null, "DELETE"),
      params("cat-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("member assignments");
    expect(mocks.subscriptionCategoryDelete).not.toHaveBeenCalled();
  });

  it("blocks deleting a category that still has fee history", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(
      subscriptionCategory({ id: "cat-custom", isBuiltIn: false, _count: { assignments: 0, fees: 1 } }),
    );

    const response = await deleteSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/cat-custom", null, "DELETE"),
      params("cat-custom"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("fee history");
    expect(mocks.subscriptionCategoryDelete).not.toHaveBeenCalled();
  });

  it("404s on an unknown id for update and delete", async () => {
    mocks.subscriptionCategoryFindUnique.mockResolvedValue(null);

    const patchResponse = await updateSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/missing", { name: "X" }, "PATCH"),
      params("missing"),
    );
    const deleteResponse = await deleteSubscriptionCategory(
      request("http://localhost/api/admin/subscription-categories/missing", null, "DELETE"),
      params("missing"),
    );

    expect(patchResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
  });
});
