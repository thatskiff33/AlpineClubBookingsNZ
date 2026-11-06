import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Policy enforcement + hints endpoint for the configurable password policy
// (#2033). Covers both user-chosen-password routes (reset + change) under a
// non-default policy, the absent-row regression pin, and the public hints API.

const mocks = vi.hoisted(() => {
  const loginSecurityFindUnique = vi.fn();
  const memberFindUnique = vi.fn();
  const prisma = {
    loginSecuritySetting: { findUnique: loginSecurityFindUnique },
    member: { findUnique: memberFindUnique, update: vi.fn() },
    passwordResetToken: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockResolvedValue([]);
  return {
    prisma,
    loginSecurityFindUnique,
    memberFindUnique,
    auth: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    applyRateLimit: vi.fn().mockResolvedValue(null),
    bcryptCompare: vi.fn(),
    bcryptHash: vi.fn().mockResolvedValue("hashed"),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/login-throttle", () => ({
  claimPasswordAttempt: vi.fn().mockResolvedValue({ allowed: true }),
  clearPasswordAttempts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: { resetPassword: { id: "reset", limit: 5, windowSeconds: 3600 } },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("bcryptjs", () => ({
  default: { compare: mocks.bcryptCompare, hash: mocks.bcryptHash },
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => ({ data: value }),
  getAuditRequestContext: () => ({}),
}));
// action-tokens is imported by the reset route; keep its real format check but
// avoid any heavy chain — the real module is pure, so import it as-is.

import { POST as resetPassword } from "@/app/api/auth/reset-password/route";
import { POST as changePassword } from "@/app/api/auth/change-password/route";
import { GET as passwordPolicy } from "@/app/api/auth/password-policy/route";

import { PASSWORD_BCRYPT_COST } from "@/lib/password-hashing";
import {
  BREACHED_PASSWORD_CODE,
  BREACHED_PASSWORD_MESSAGE,
} from "@/lib/breached-password";
import { stubBreachedPasswordService } from "@/lib/__tests__/helpers/breached-password-service";

const validToken = "a".repeat(64);

function resetReq(password: string) {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: validToken, password }),
  }) as never;
}

function changeReq(newPassword: string) {
  return new Request("http://localhost/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "old-password", newPassword }),
  }) as never;
}

const STRICT_POLICY = {
  minPasswordLength: 16,
  requireUppercase: true,
  requireLowercase: false,
  requireDigit: true,
  requireSymbol: false,
  magicLinkTtlMinutes: 15,
  updatedAt: new Date("2026-07-18T00:00:00.000Z"),
  updatedByMemberId: "admin-1",
};

describe("password routes honour the configured login-security policy (#2033)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockResolvedValue([]);
    mocks.bcryptHash.mockResolvedValue("hashed");
    // reset route token lookup: a valid, unused, unexpired token.
    mocks.prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: "tok1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
      member: { id: "member-1" },
    });
    // change route: authenticated member with a matching current password.
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.memberFindUnique.mockResolvedValue({
      email: "member@example.org",
      passwordHash: "hash",
      forcePasswordChange: false,
    });
    mocks.bcryptCompare.mockResolvedValue(true);
    // #4610: the chosen-password writers screen against the breached-password
    // range service; tests never reach the real one.
    stubBreachedPasswordService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("with min 16 + uppercase + digit configured", () => {
    beforeEach(() => {
      mocks.loginSecurityFindUnique.mockResolvedValue(STRICT_POLICY);
    });

    it("reset-password rejects a password that violates the policy", async () => {
      const res = await resetPassword(resetReq("abcdefghijklmnop")); // 16 lower, no upper/digit
      expect(res.status).toBe(400);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("reset-password accepts a password that satisfies the policy", async () => {
      const res = await resetPassword(resetReq("Abcdefghijklmno1"));
      expect(res.status).toBe(200);
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.bcryptHash).toHaveBeenCalledWith("Abcdefghijklmno1", PASSWORD_BCRYPT_COST);
    });

    it("change-password rejects a policy-violating new password", async () => {
      const res = await changePassword(changeReq("abcdefghijklmnop"));
      expect(res.status).toBe(400);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("change-password accepts a policy-satisfying new password", async () => {
      const res = await changePassword(changeReq("Abcdefghijklmno1"));
      expect(res.status).toBe(200);
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.bcryptHash).toHaveBeenCalledWith("Abcdefghijklmno1", PASSWORD_BCRYPT_COST);
    });
  });

  describe("with no configured row (absent-row regression pin)", () => {
    beforeEach(() => {
      mocks.loginSecurityFindUnique.mockResolvedValue(null);
    });

    it("reset-password still accepts a 12-char password and rejects 11", async () => {
      expect((await resetPassword(resetReq("a".repeat(11)))).status).toBe(400);
      expect((await resetPassword(resetReq("a".repeat(12)))).status).toBe(200);
    });

    it("change-password still accepts a 12-char password and rejects 11", async () => {
      expect((await changePassword(changeReq("a".repeat(11)))).status).toBe(400);
      expect((await changePassword(changeReq("a".repeat(12)))).status).toBe(200);
    });

    it("rejects a password over the 128 hard maximum at both routes", async () => {
      expect((await resetPassword(resetReq("a".repeat(129)))).status).toBe(400);
      expect((await changePassword(changeReq("a".repeat(129)))).status).toBe(400);
    });
  });

  // #4610 (INV-AUTH-006): both routes screen the chosen password against the
  // breached-password range service before hashing it.
  describe("breached-password check", () => {
    const BREACHED = "correct horse battery staple";
    const CLEAN = "a quiet ridge at first light 4610";

    it("refuses a listed password at reset and change, with a plain message, and stores nothing", async () => {
      mocks.loginSecurityFindUnique.mockResolvedValue(null);
      stubBreachedPasswordService([BREACHED]);

      for (const res of [
        await resetPassword(resetReq(BREACHED)),
        await changePassword(changeReq(BREACHED)),
      ]) {
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: BREACHED_PASSWORD_MESSAGE,
          code: BREACHED_PASSWORD_CODE,
        });
      }
      expect(mocks.bcryptHash).not.toHaveBeenCalled();
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      // The reset token is left unused, so the person can try another password.
      expect(mocks.prisma.passwordResetToken.update).not.toHaveBeenCalled();
    });

    it("accepts an unlisted password at both routes", async () => {
      mocks.loginSecurityFindUnique.mockResolvedValue(null);
      const fetchMock = stubBreachedPasswordService([BREACHED]);
      expect((await resetPassword(resetReq(CLEAN))).status).toBe(200);
      expect((await changePassword(changeReq(CLEAN))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("makes no outbound request when the club has switched the check off", async () => {
      mocks.loginSecurityFindUnique.mockResolvedValue({ breachedPasswordCheck: false });
      const fetchMock = stubBreachedPasswordService([BREACHED]);
      expect((await resetPassword(resetReq(BREACHED))).status).toBe(200);
      expect((await changePassword(changeReq(BREACHED))).status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never calls the service for an invalid reset link", async () => {
      mocks.loginSecurityFindUnique.mockResolvedValue(null);
      mocks.prisma.passwordResetToken.findUnique.mockResolvedValue(null);
      const fetchMock = stubBreachedPasswordService([BREACHED]);
      expect((await resetPassword(resetReq(BREACHED))).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails open at both routes when the service is unreachable", async () => {
      mocks.loginSecurityFindUnique.mockResolvedValue(null);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      expect((await resetPassword(resetReq(BREACHED))).status).toBe(200);
      expect((await changePassword(changeReq(BREACHED))).status).toBe(200);
    });
  });
});

describe("public password-policy hints endpoint (#2033)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the active policy and human hints, without magicLinkTtlMinutes", async () => {
    mocks.loginSecurityFindUnique.mockResolvedValue(STRICT_POLICY);
    const res = await passwordPolicy();
    const body = await res.json();
    expect(body).toMatchObject({
      minPasswordLength: 16,
      maxPasswordLength: 128,
      requireUppercase: true,
      requireDigit: true,
      hints: expect.arrayContaining([
        "At least 16 characters",
        "An uppercase letter (A–Z)",
        "A number (0–9)",
      ]),
    });
    expect(body).not.toHaveProperty("magicLinkTtlMinutes");
  });

  it("falls back to the default policy when no row is configured", async () => {
    mocks.loginSecurityFindUnique.mockResolvedValue(null);
    const res = await passwordPolicy();
    const body = await res.json();
    expect(body.minPasswordLength).toBe(12);
    expect(body.hints).toEqual(["At least 12 characters"]);
  });
});
