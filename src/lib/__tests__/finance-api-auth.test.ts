import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockAuth } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockAuth: vi.fn(),
}));

// Fixtures are projected through the loader's own `select` (#3603), so a field
// it stops selecting stops reaching the checks, as with the real client.
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique),
      },
    },
  };
});

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

import {
  requireFinanceManagerApiAccess,
  requireFinanceViewerApiAccess,
} from "@/lib/finance-api-auth";

function financeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "member@example.com",
    firstName: "Test",
    lastName: "Member",
    role: "USER",
    accessRoles: [] as Array<{ role: string }>,
    canLogin: true,
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    ...overrides,
  };
}

// Behavioral matrix for the /api/finance guard pair (issue #1132). Finance
// access derives from the merged finance area level of the admin permission
// matrix: any role granting finance view/edit (seeded Finance Viewer and
// Treasurer, Full Admin, custom definitions) passes, and roles with no
// finance level in their matrix are rejected.
describe("finance API guards", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
  });

  it("rejects anonymous callers with 401", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await requireFinanceViewerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects sessions whose member row no longer exists with 401", async () => {
    mockAuth.mockResolvedValue({ user: { id: "ghost" } });
    mockFindUnique.mockResolvedValue(null);

    const result = await requireFinanceViewerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects deactivated finance members with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ active: false, accessRoles: [{ role: "FINANCE_ADMIN" }] }),
    );

    const result = await requireFinanceViewerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Account is deactivated",
      });
    }
  });

  it("rejects plain members with no finance role with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ accessRoles: [{ role: "USER" }] }),
    );

    const result = await requireFinanceViewerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Finance viewer access required",
      });
    }
  });

  it("allows a full admin as matrix-derived finance manager", async () => {
    // Finance access derives from the merged finance area level, so the
    // full-edit ADMIN matrix includes it (intentional widening).
    mockAuth.mockResolvedValue({ user: { id: "admin-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ role: "ADMIN", accessRoles: [{ role: "ADMIN" }] }),
    );

    const viewer = await requireFinanceViewerApiAccess();
    const manager = await requireFinanceManagerApiAccess();

    expect(viewer.ok).toBe(true);
    expect(manager.ok).toBe(true);
  });

  it("rejects roles whose matrix has no finance access", async () => {
    mockAuth.mockResolvedValue({ user: { id: "content-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ role: "USER", accessRoles: [{ role: "ADMIN_CONTENT" }] }),
    );

    const viewer = await requireFinanceViewerApiAccess();
    const manager = await requireFinanceManagerApiAccess();

    expect(viewer.ok).toBe(false);
    expect(manager.ok).toBe(false);
    if (!viewer.ok) expect(viewer.response.status).toBe(403);
    if (!manager.ok) expect(manager.response.status).toBe(403);
  });

  it("allows finance viewers on the viewer guard but not the manager guard", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ accessRoles: [{ role: "FINANCE_USER" }] }),
    );

    const viewer = await requireFinanceViewerApiAccess();
    const manager = await requireFinanceManagerApiAccess();

    expect(viewer.ok).toBe(true);
    expect(manager.ok).toBe(false);
    if (!manager.ok) {
      expect(manager.response.status).toBe(403);
      await expect(manager.response.json()).resolves.toEqual({
        error: "Finance manager access required",
      });
    }
  });

  it("allows treasurers on both guards", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ accessRoles: [{ role: "FINANCE_ADMIN" }] }),
    );

    const viewer = await requireFinanceViewerApiAccess();
    const manager = await requireFinanceManagerApiAccess();

    expect(viewer.ok).toBe(true);
    expect(manager.ok).toBe(true);
    if (manager.ok) expect(manager.member.id).toBe("member-1");
  });

  // #3603: a member whose login is switched off holds no finance access, whatever
  // rows it still stores. "allows treasurers on both guards" above is the
  // same fixture with login enabled.
  it("refuses a login-disabled treasurer on both guards", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ canLogin: false, accessRoles: [{ role: "FINANCE_ADMIN" }] }),
    );

    const viewer = await requireFinanceViewerApiAccess();
    const manager = await requireFinanceManagerApiAccess();

    expect(viewer.ok).toBe(false);
    expect(manager.ok).toBe(false);
    if (!viewer.ok) {
      expect(viewer.response.status).toBe(403);
      await expect(viewer.response.json()).resolves.toEqual({
        error: "Finance viewer access required",
      });
    }
    if (!manager.ok) expect(manager.response.status).toBe(403);
  });

  it("refuses a login-disabled Full Admin on both guards", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({ canLogin: false, accessRoles: [{ role: "ADMIN" }] }),
    );

    expect((await requireFinanceViewerApiAccess()).ok).toBe(false);
    expect((await requireFinanceManagerApiAccess()).ok).toBe(false);

    mockFindUnique.mockResolvedValue(
      financeMember({ canLogin: true, accessRoles: [{ role: "ADMIN" }] }),
    );
    expect((await requireFinanceViewerApiAccess()).ok).toBe(true);
    expect((await requireFinanceManagerApiAccess()).ok).toBe(true);
  });

  it("rejects finance members who must change their password with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue(
      financeMember({
        forcePasswordChange: true,
        accessRoles: [{ role: "FINANCE_ADMIN" }],
      }),
    );

    const result = await requireFinanceManagerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Password change required",
      });
    }
  });

  it("rejects unverified sessions when two-factor is required", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "member-1",
        twoFactorRequired: true,
        twoFactorVerified: false,
      },
    });
    mockFindUnique.mockResolvedValue(
      financeMember({
        twoFactorEnabled: true,
        accessRoles: [{ role: "FINANCE_ADMIN" }],
      }),
    );

    const result = await requireFinanceManagerApiAccess();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Two-factor verification required",
      });
    }
  });
});
