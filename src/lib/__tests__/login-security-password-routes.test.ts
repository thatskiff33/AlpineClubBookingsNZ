import { beforeEach, describe, expect, it, vi } from "vitest";

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
