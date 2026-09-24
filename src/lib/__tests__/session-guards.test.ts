import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { mockFindUnique, mockAuth, requestPath } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockAuth: vi.fn(),
  /** What `src/proxy.ts` stamped on the request, or null for "no header". */
  requestPath: { value: null as string | null },
}));

// The proxy writes the served path onto every request it runs on, and both
// guards read it back through `headers()`. Mocked so the module-gated branch can
// be driven; with `value: null` the header is absent, which is how the guards
// behave for a route the proxy does not run on.
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(requestPath.value ? { "x-pathname": requestPath.value } : {}),
}));

// Every fixture below is projected through the guard's own `select` (#3603), so
// a field the guard stops selecting stops reaching it — exactly as with the real
// client. Without this, a fixture carrying `canLogin` proved nothing about
// whether the guard ever asked for it.
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
  requireActiveSession,
  requireActiveSessionUser,
  requireAdmin,
} from "@/lib/session-guards";

describe("requireActiveSessionUser", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it("rejects deactivated sessions", async () => {
    mockFindUnique.mockResolvedValue({ active: false, forcePasswordChange: false });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
  });

  it("rejects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Password change required",
    });
  });

  it("allows the password change endpoint to opt out of the force-password block", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1", {
      allowForcePasswordChange: true,
    });

    expect(response).toBeNull();
  });

  it("rejects unverified sessions when two-factor is required", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: true,
    });

    const response = await requireActiveSessionUser("member-1", {
      sessionUser: {
        id: "member-1",
        twoFactorRequired: true,
        twoFactorVerified: false,
      },
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Two-factor verification required",
    });
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
  });

  it("allows routes to preserve a legacy non-admin envelope", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "MEMBER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "USER" }],
    });

    const result = await requireAdmin({
      forbiddenResponse: () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({ error: "Unauthorized" });
    }
  });

  it("returns the admin session after the active-session check passes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.user.id).toBe("admin-1");
    }
  });

  it("allows bundled admin roles when the requested admin area permits them", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "booking-office-1",
        role: "USER",
        accessRoles: [{ role: "ADMIN_BOOKINGS" }],
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN_BOOKINGS" }],
    });

    const result = await requireAdmin({
      permission: { area: "bookings", level: "edit" },
    });

    expect(result.ok).toBe(true);
  });

  it("blocks read-only admin roles from edit-level admin routes", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "readonly-admin-1",
        role: "USER",
        accessRoles: [{ role: "ADMIN_READONLY" }],
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN_READONLY" }],
    });

    const result = await requireAdmin({
      permission: { area: "bookings", level: "edit" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("rejects inactive admins through the active-session check", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Account is deactivated",
      });
    }
  });

  it("rejects admins who must change their password", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: true,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Password change required",
      });
    }
  });

  it("rejects admins who have not completed required two-factor verification", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "admin-1",
        role: "ADMIN",
        accessRoles: [{ role: "ADMIN" }],
        twoFactorRequired: true,
        twoFactorVerified: false,
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      twoFactorEnabled: true,
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Two-factor verification required",
      });
    }
  });
});

describe("requireActiveSession", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
  });

  it("rejects unauthenticated API callers with the member-route envelope", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await requireActiveSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: "Unauthorised",
      });
    }
  });

  it("returns the session after active-account checks pass", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false });

    const result = await requireActiveSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.user.id).toBe("member-1");
    }
  });
});

/**
 * The auth-failure oracle, closed on module-gated paths (#2404 re-review, owner
 * decision D1a, 1 Aug 2026).
 *
 * `src/proxy.ts` answers a gated path with a frozen `404 {"error":"Not found"}`
 * when the module is off. If the same path answered an anonymous caller `401`
 * when the module was ON, one unauthenticated request read the club's module
 * list: `401` means on, `404` means off. Both guards therefore send the gate's
 * own 404 for a MISSING SESSION on a gated path — and nothing else changes, so a
 * signed-in admin still gets the honest 403 that tells them what to fix.
 *
 * Driven through `getRequiredFeaturesForPath()` by way of the real request
 * header rather than through a list of paths copied into this file, so a module
 * added to `FEATURE_ROUTE_RULES` later is covered the day its prefix lands.
 */
describe("the anonymous reply on a module-gated path (#2404)", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
    mockAuth.mockResolvedValue(null);
    requestPath.value = null;
  });

  const gatedPaths = [
    "/api/admin/lockers/abc",
    "/api/admin/xero/chart-of-accounts",
    "/api/chores/token-1",
    "/api/calendar/events",
    // The query string the proxy appends is part of the header value, so the
    // pathname has to be split back off before the rules are consulted.
    "/api/admin/bed-allocation/rooms?lodgeId=lodge-1",
  ];

  const ungatedPaths = [
    "/api/admin/members",
    "/api/admin/page-content",
    "/api/bookings",
  ];

  it.each(gatedPaths)(
    "answers %s with the module gate's own 404, not a 401",
    async (path) => {
      requestPath.value = path;

      for (const guard of [requireAdmin, requireActiveSession]) {
        const result = await guard();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(404);
          await expect(result.response.json()).resolves.toEqual({
            error: "Not found",
          });
        }
      }
    },
  );

  it.each(ungatedPaths)("leaves %s answering 401 exactly as before", async (path) => {
    requestPath.value = path;

    const admin = await requireAdmin();
    const member = await requireActiveSession();

    expect(admin.ok).toBe(false);
    expect(member.ok).toBe(false);
    if (!admin.ok) {
      expect(admin.response.status).toBe(401);
      await expect(admin.response.json()).resolves.toEqual({
        error: "Unauthorized",
      });
    }
    if (!member.ok) {
      expect(member.response.status).toBe(401);
      await expect(member.response.json()).resolves.toEqual({
        error: "Unauthorised",
      });
    }
  });

  it("fails open to 401 when the proxy stamped no path at all", async () => {
    // A wrong 404 on an ungated route would hide a real sign-in problem from a
    // real member, so an unreadable header must not be treated as "gated".
    requestPath.value = null;

    const result = await requireActiveSession();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("still lets a route choose its own unauthenticated reply", async () => {
    // A login redirect or a deliberate 403 is a contract someone chose; the
    // gate must not silently overwrite it.
    requestPath.value = "/api/admin/xero/callback";

    const result = await requireAdmin({
      unauthenticatedResponse: () =>
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("does not touch a SIGNED-IN caller's 403 on a gated path", async () => {
    // The narrowness is the point: only the anonymous case is hidden. An admin
    // who is signed in but lacks the permission must still be told so.
    requestPath.value = "/api/admin/lockers/abc";
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Forbidden",
      });
    }
  });
});

/**
 * A member whose login is switched off holds no access (#3603). `requireAdmin`
 * re-reads the member on every call, so it must hand `canLogin` to the checks
 * that clear on it; `requireActiveSessionUser` refuses the member outright.
 * Each refusal is paired with the same fixture at `canLogin: true`, admitted,
 * so the refusal is caused by the flag and nothing else.
 */
describe("a login-disabled member is refused by every gate form (#3603)", () => {
  const FULL_ADMIN_ROWS = [{ role: "ADMIN" }];
  // A club-defined role: no enum value, every area at edit through the joined
  // definition. Never a Full Admin, so `permission: false` refuses it either way.
  const CUSTOM_ROLE_ROWS = [
    {
      role: null,
      roleDefinitionId: "def-custom",
      roleDefinition: {
        id: "def-custom",
        overviewLevel: "EDIT",
        bookingsLevel: "EDIT",
        membershipLevel: "EDIT",
        financeLevel: "EDIT",
        lodgeLevel: "EDIT",
        contentLevel: "EDIT",
        supportLevel: "EDIT",
      },
    },
  ];

  function stageAdmin(accessRoles: unknown[], canLogin: boolean) {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"], canLogin: true },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      canLogin,
      forcePasswordChange: false,
      twoFactorEnabled: false,
      accessRoles,
    });
  }

  const gateForms = [
    {
      name: "permission: false (Full Admin only)",
      run: () => requireAdmin({ permission: false }),
    },
    {
      name: "an explicit area",
      run: () => requireAdmin({ permission: { area: "bookings", level: "edit" } }),
    },
    {
      name: "a path-inferred area",
      run: () => {
        requestPath.value = "/api/admin/bookings";
        return requireAdmin();
      },
    },
    {
      name: '"any-admin"',
      run: () => requireAdmin({ permission: "any-admin" }),
    },
  ] as const;

  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
    requestPath.value = null;
  });

  it.each(gateForms)("refuses a login-disabled Full Admin on $name", async ({ run }) => {
    stageAdmin(FULL_ADMIN_ROWS, false);
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it.each(gateForms)("admits the same Full Admin with login enabled on $name", async ({ run }) => {
    stageAdmin(FULL_ADMIN_ROWS, true);
    const result = await run();
    expect(result.ok).toBe(true);
  });

  it.each(gateForms)("refuses a login-disabled custom-role admin on $name", async ({ run }) => {
    stageAdmin(CUSTOM_ROLE_ROWS, false);
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it.each(gateForms.filter(({ name }) => !name.startsWith("permission: false")))(
    "admits the same custom-role admin with login enabled on $name",
    async ({ run }) => {
      stageAdmin(CUSTOM_ROLE_ROWS, true);
      const result = await run();
      expect(result.ok).toBe(true);
    },
  );

  it("selects canLogin in the member re-read", async () => {
    stageAdmin(FULL_ADMIN_ROWS, true);
    await requireAdmin();
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ canLogin: true }),
      }),
    );
  });

  it("hands downstream checks the DB-read roles, login flag and matrix", async () => {
    stageAdmin(FULL_ADMIN_ROWS, true);
    const result = await requireAdmin();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.user.accessRoles).toEqual(["ADMIN"]);
      expect(result.session.user.canLogin).toBe(true);
      expect(result.session.user.adminPermissionMatrix?.membership).toBe("edit");
    }
  });

  it("refuses a login-disabled member at the active-session check", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      canLogin: false,
      forcePasswordChange: false,
    });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Sign-in is disabled for this account",
    });
  });

  it("admits the same member with login enabled at the active-session check", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      canLogin: true,
      forcePasswordChange: false,
    });

    await expect(requireActiveSessionUser("member-1")).resolves.toBeNull();
  });

  it("refuses a login-disabled member through requireActiveSession", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "member-1", role: "USER", accessRoles: ["USER"], canLogin: true },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      canLogin: false,
      forcePasswordChange: false,
    });

    const result = await requireActiveSession();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});
