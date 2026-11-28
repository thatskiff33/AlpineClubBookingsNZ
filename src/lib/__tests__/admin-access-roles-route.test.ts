import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  definitionFindMany: vi.fn(),
  definitionFindUnique: vi.fn(),
  definitionFindFirst: vi.fn(),
  definitionCreate: vi.fn(),
  definitionUpdate: vi.fn(),
  definitionDelete: vi.fn(),
  memberAccessRoleFindMany: vi.fn(),
  memberAccessRoleCount: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessRoleDefinition: {
      findMany: mocks.definitionFindMany,
      findUnique: mocks.definitionFindUnique,
      findFirst: mocks.definitionFindFirst,
    },
    memberAccessRole: {
      findMany: mocks.memberAccessRoleFindMany,
      count: mocks.memberAccessRoleCount,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/access-roles/route";
import { DELETE, PATCH } from "@/app/api/admin/access-roles/[id]/route";

const fullAdminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] },
};
const scopedAdminSession = {
  user: {
    id: "scoped-1",
    role: "USER",
    accessRoles: ["ADMIN_MEMBERSHIP"],
  },
};

const treasurerDefinition = {
  id: "ardef_finance_admin",
  key: "treasurer",
  systemRole: "FINANCE_ADMIN",
  label: "Treasurer",
  description: "Can manage finance.",
  overviewLevel: "VIEW",
  bookingsLevel: "VIEW",
  membershipLevel: "VIEW",
  financeLevel: "EDIT",
  lodgeLevel: "NONE",
  contentLevel: "NONE",
  supportLevel: "VIEW",
  sortOrder: 60,
};

const validPermissions = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "edit",
  content: "none",
  support: "none",
};

function jsonRequest(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/admin/access-roles", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      accessRoleDefinition: {
        create: mocks.definitionCreate,
        update: mocks.definitionUpdate,
        delete: mocks.definitionDelete,
      },
      auditLog: { create: mocks.auditLogCreate },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(fullAdminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  installTransactionMock();
});

describe("GET /api/admin/access-roles", () => {
  it("returns serialized definitions with holder counts and picker options", async () => {
    mocks.definitionFindMany.mockResolvedValue([treasurerDefinition]);
    mocks.memberAccessRoleFindMany.mockResolvedValue([
      { memberId: "m1", role: "FINANCE_ADMIN", roleDefinitionId: null },
      {
        memberId: "m2",
        role: "FINANCE_ADMIN",
        roleDefinitionId: "ardef_finance_admin",
      },
      {
        memberId: "m2",
        role: null,
        roleDefinitionId: "ardef_finance_admin",
      },
    ]);

    const response = await GET(new Request("http://localhost/api/admin/access-roles"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.roles).toHaveLength(1);
    // m1 (enum-only row) and m2 counted once each.
    expect(body.roles[0].memberCount).toBe(2);
    expect(body.roles[0].permissions.finance).toBe("edit");
    const tokens = body.roleOptions.map(
      (option: { token: string }) => option.token,
    );
    expect(tokens).toContain("FINANCE_ADMIN");
    expect(tokens).toContain("USER");
  });
});

describe("POST /api/admin/access-roles", () => {
  it("rejects non-full-admin actors with 403 before any write", async () => {
    mocks.auth.mockResolvedValue(scopedAdminSession);

    const response = await POST(
      jsonRequest("POST", {
        label: "Hut Warden",
        permissions: validPermissions,
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates a definition with a unique key and a critical audit entry", async () => {
    mocks.definitionFindUnique.mockResolvedValue(null);
    mocks.definitionFindFirst.mockResolvedValue({ sortOrder: 60 });
    mocks.definitionCreate.mockResolvedValue({
      ...treasurerDefinition,
      id: "ardef_new",
      key: "hut-warden",
      systemRole: null,
      label: "Hut Warden",
      description: "",
      financeLevel: "NONE",
      lodgeLevel: "EDIT",
      overviewLevel: "NONE",
      bookingsLevel: "NONE",
      membershipLevel: "NONE",
      supportLevel: "NONE",
      sortOrder: 61,
    });

    const response = await POST(
      jsonRequest("POST", {
        label: "Hut Warden",
        permissions: validPermissions,
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.role.permissions.lodge).toBe("edit");
    expect(mocks.definitionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "hut-warden",
          lodgeLevel: "EDIT",
          sortOrder: 61,
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ACCESS_ROLE_DEFINITION_CREATED",
          severity: "critical",
        }),
      }),
    );
  });

  it("rejects invalid permission levels", async () => {
    const response = await POST(
      jsonRequest("POST", {
        label: "Broken",
        permissions: { ...validPermissions, lodge: "admin" },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/admin/access-roles/[id]", () => {
  it("rejects non-full-admin actors", async () => {
    mocks.auth.mockResolvedValue(scopedAdminSession);
    const response = await PATCH(
      jsonRequest("PATCH", { label: "Renamed" }),
      params("ardef_finance_admin"),
    );
    expect(response.status).toBe(403);
  });

  it("updates label and permissions with an audit trail", async () => {
    mocks.definitionFindUnique.mockResolvedValue(treasurerDefinition);
    mocks.definitionUpdate.mockResolvedValue({
      ...treasurerDefinition,
      label: "Finance Lead",
      financeLevel: "VIEW",
    });

    const response = await PATCH(
      jsonRequest("PATCH", {
        label: "Finance Lead",
        permissions: { ...validPermissions, lodge: "none", finance: "view" },
      }),
      params("ardef_finance_admin"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.role.label).toBe("Finance Lead");
    expect(mocks.definitionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          label: "Finance Lead",
          financeLevel: "VIEW",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ACCESS_ROLE_DEFINITION_UPDATED",
        }),
      }),
    );
  });

  it("404s for unknown definitions", async () => {
    mocks.definitionFindUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { label: "Ghost" }),
      params("ardef_ghost"),
    );
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/admin/access-roles/[id]", () => {
  it("blocks deletion while members hold the role, counting enum-only rows", async () => {
    mocks.definitionFindUnique.mockResolvedValue(treasurerDefinition);
    mocks.memberAccessRoleCount.mockResolvedValue(3);

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/access-roles/x", {
        method: "DELETE",
      }),
      params("ardef_finance_admin"),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.memberCount).toBe(3);
    expect(mocks.memberAccessRoleCount).toHaveBeenCalledWith({
      where: {
        OR: [
          { roleDefinitionId: "ardef_finance_admin" },
          { role: "FINANCE_ADMIN" },
        ],
      },
    });
    expect(mocks.definitionDelete).not.toHaveBeenCalled();
  });

  it("deletes unassigned roles and writes an audit entry", async () => {
    mocks.definitionFindUnique.mockResolvedValue({
      ...treasurerDefinition,
      id: "ardef_custom",
      systemRole: null,
    });
    mocks.memberAccessRoleCount.mockResolvedValue(0);
    mocks.definitionDelete.mockResolvedValue({});

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/access-roles/x", {
        method: "DELETE",
      }),
      params("ardef_custom"),
    );

    expect(response.status).toBe(200);
    expect(mocks.definitionDelete).toHaveBeenCalledWith({
      where: { id: "ardef_custom" },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ACCESS_ROLE_DEFINITION_DELETED",
        }),
      }),
    );
  });

  it("rejects non-full-admin actors", async () => {
    mocks.auth.mockResolvedValue(scopedAdminSession);
    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/access-roles/x", {
        method: "DELETE",
      }),
      params("ardef_custom"),
    );
    expect(response.status).toBe(403);
  });
});
