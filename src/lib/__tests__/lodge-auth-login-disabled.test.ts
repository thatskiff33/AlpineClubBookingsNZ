import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lodge kiosk gate re-reads the member to decide its tier, so it must hand
 * `canLogin` to the admin and lodge checks: a member whose login is switched
 * off holds no kiosk tier and cannot drive a kiosk preview (#3603). Every
 * refusal below is paired with the same fixture at `canLogin: true`, admitted.
 *
 * `requireActiveSessionUser` is stubbed to pass so these tests exercise the
 * gate's OWN member read; that guard's refusal is covered in
 * `session-guards.test.ts`. The member rows are projected through the gate's
 * real `select`, so a field it stops selecting stops reaching the checks.
 */

const { mockMemberFindUnique, mockAuth } = vi.hoisted(() => ({
  mockMemberFindUnique: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: { findUnique: honourSelect(mockMemberFindUnique, "Member") },
      hutLeaderAssignment: { count: vi.fn().mockResolvedValue(0) },
      booking: { count: vi.fn().mockResolvedValue(0) },
    },
  };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/lodge-pin-session", () => ({
  getActiveLodgePinSessionForRequest: vi.fn().mockResolvedValue(null),
}));

import { checkLodgeAuth } from "@/lib/lodge-auth";

const DATE = "2026-07-01";

type Row = {
  id: string;
  email: string;
  canLogin: boolean;
  accessRoles: Array<{ role: string }>;
};

function admin(canLogin: boolean): Row {
  return { id: "admin-1", email: "admin@example.org", canLogin, accessRoles: [{ role: "ADMIN" }] };
}

function kiosk(canLogin: boolean): Row {
  return { id: "kiosk-1", email: "kiosk@example.org", canLogin, accessRoles: [{ role: "LODGE" }] };
}

function signIn(actor: Row, ...others: Row[]) {
  mockAuth.mockResolvedValue({ user: { id: actor.id } });
  const rows = [actor, ...others];
  mockMemberFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
  );
}

function previewRequest(target: string) {
  return new Request(
    `http://localhost/api/lodge/access?previewAccount=${encodeURIComponent(target)}`,
  );
}

beforeEach(() => {
  mockMemberFindUnique.mockReset();
  mockAuth.mockReset();
});

describe("checkLodgeAuth applies the login-disabled rule (#3603)", () => {
  it("gives a login-disabled Full Admin no kiosk tier", async () => {
    signIn(admin(false));
    const result = await checkLodgeAuth(DATE);
    expect(result.status).toBe(403);
    expect(result.tier).toBe("none");
  });

  it("gives the same Full Admin with login enabled the admin tier", async () => {
    signIn(admin(true));
    const result = await checkLodgeAuth(DATE);
    expect(result.error).toBeNull();
    expect(result.tier).toBe("admin");
  });

  it("gives a login-disabled kiosk account no kiosk tier", async () => {
    signIn(kiosk(false));
    const result = await checkLodgeAuth(DATE, {
      request: new Request("http://localhost/api/lodge/access"),
    });
    expect(result.status).toBe(403);
    expect(result.tier).toBe("none");
  });

  it("gives the same kiosk account with login enabled the lodge tier", async () => {
    signIn(kiosk(true));
    const result = await checkLodgeAuth(DATE, {
      request: new Request("http://localhost/api/lodge/access"),
    });
    expect(result.error).toBeNull();
    expect(result.tier).toBe("lodge");
  });

  it("does not let a login-disabled Full Admin drive a kiosk preview", async () => {
    signIn(admin(false), kiosk(true));
    const result = await checkLodgeAuth(DATE, {
      request: previewRequest("kiosk-1"),
      allowPreview: true,
    });
    expect(result.status).toBe(403);
    expect("preview" in result).toBe(false);
  });

  it("lets the same Full Admin with login enabled preview the kiosk", async () => {
    signIn(admin(true), kiosk(true));
    const result = await checkLodgeAuth(DATE, {
      request: previewRequest("kiosk-1"),
      allowPreview: true,
    });
    expect(result.error).toBeNull();
    expect(result.tier).toBe("lodge");
    expect("preview" in result && result.preview?.targetMemberId).toBe("kiosk-1");
  });

  it("finds no kiosk to preview when the target's login is disabled", async () => {
    signIn(admin(true), kiosk(false));
    const result = await checkLodgeAuth(DATE, {
      request: previewRequest("kiosk-1"),
      allowPreview: true,
    });
    expect(result.status).toBe(404);
    expect(result.error).toBe("Kiosk account not found");
  });
});
