import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({
    name: "Test Club",
    bookingsName: "Test Club - Bookings",
  }),
}));

const mockClaim = vi.hoisted(() => vi.fn());
const mockClear = vi.hoisted(() => vi.fn());
const mockCompare = vi.hoisted(() => vi.fn());

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  sessionReauthChallenge: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: "challenge-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  twoFactorEmailCode: {
    findFirst: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  twoFactorRecoveryCode: {
    findFirst: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  member: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({ id: "member-1" }),
  },
  webAuthnCredential: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/login-throttle", () => ({
  claimPasswordAttempt: mockClaim,
  clearPasswordAttempts: mockClear,
}));
vi.mock("bcryptjs", () => ({
  default: { compare: mockCompare },
}));

import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";
import {
  hashTwoFactorCode,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
  twoFactorCodeHashCandidates,
} from "@/lib/two-factor";
import {
  consumeSessionReauthChallenge,
  createSessionReauthChallenge,
  proveSessionReauth,
  type ReauthMember,
} from "@/lib/session-reauth";

function member(overrides: Partial<ReauthMember> = {}): ReauthMember {
  return {
    id: "member-1",
    email: "member@example.com",
    passwordHash: "stored-hash",
    active: true,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    totpSecret: null,
    twoFactorFailedAttempts: 0,
    twoFactorLockedUntil: null,
    ...overrides,
  };
}

const appMember = () =>
  member({
    twoFactorEnabled: true,
    twoFactorMethod: "TOTP",
    totpSecret: "stored-secret",
  });

describe("session reauthentication (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-for-reauth");
    mockPrisma.member.findUnique.mockReset();
    mockClaim.mockResolvedValue({ allowed: true });
    mockClear.mockResolvedValue(undefined);
    mockCompare.mockResolvedValue(false);
    mockPrisma.twoFactorEmailCode.findFirst.mockResolvedValue({
      id: "email-code-1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.twoFactorRecoveryCode.findFirst.mockResolvedValue({
      id: "recovery-1",
      memberId: "member-1",
      usedAt: null,
    });
    mockPrisma.sessionReauthChallenge.updateMany.mockResolvedValue({ count: 1 });
  });

  it("stores the challenge hashed, and claims it once", async () => {
    const token = await createSessionReauthChallenge("member-1");
    const created = mockPrisma.sessionReauthChallenge.create.mock.calls[0]?.[0];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.data.tokenHash).toBe(hashTwoFactorCode(token));
    expect(created.data.tokenHash).not.toBe(token);
    expect(created.data.memberId).toBe("member-1");

    await expect(consumeSessionReauthChallenge("member-1", token)).resolves.toBe(true);
    expect(mockPrisma.sessionReauthChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: { in: twoFactorCodeHashCandidates(token) },
        memberId: "member-1",
        expiresAt: { gt: expect.any(Date) },
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });

    mockPrisma.sessionReauthChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumeSessionReauthChallenge("member-1", token)).resolves.toBe(false);
  });

  it("refuses an emailed code that would otherwise verify", async () => {
    const result = await proveSessionReauth({
      member: member({ twoFactorEnabled: true, twoFactorMethod: "EMAIL" }),
      factor: "EMAIL",
      code: "123456",
    });

    expect(result.ok).toBe(false);
    expect(mockPrisma.twoFactorEmailCode.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.twoFactorEmailCode.findFirst).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith("member@example.com");
    expect(mockPrisma.sessionReauthChallenge.create).not.toHaveBeenCalled();
  });

  it("does not accept a recovery code", async () => {
    const result = await proveSessionReauth({
      member: appMember(),
      factor: "RECOVERY",
      code: "ABCD-EFGH",
    });

    expect(result.ok).toBe(false);
    expect(mockPrisma.twoFactorRecoveryCode.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.twoFactorRecoveryCode.findFirst).not.toHaveBeenCalled();
  });

  it("counts a wrong authenticator code toward the two-factor lockout", async () => {
    mockPrisma.member.findUnique
      .mockResolvedValueOnce({ totpSecret: null })
      .mockResolvedValueOnce({
        twoFactorFailedAttempts: TWO_FACTOR_MAX_FAILED_ATTEMPTS - 1,
      });

    const result = await proveSessionReauth({
      member: appMember(),
      factor: "TOTP",
      code: "000000",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: {
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: expect.any(Date),
      },
    });
  });

  it("counts a wrong password on the password throttle, and a right one mints a challenge", async () => {
    const wrong = await proveSessionReauth({
      member: member(),
      factor: "PASSWORD",
      password: "nope",
    });
    expect(wrong.ok).toBe(false);
    expect(mockClaim).toHaveBeenCalledWith("member@example.com");
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockPrisma.member.update).not.toHaveBeenCalled();

    mockCompare.mockResolvedValue(true);
    const right = await proveSessionReauth({
      member: member(),
      factor: "PASSWORD",
      password: "correct",
    });
    expect(right.ok).toBe(true);
    expect(mockClear).toHaveBeenCalledWith("member@example.com");
    expect(mockPrisma.sessionReauthChallenge.create).toHaveBeenCalled();
  });

  it("does not compare a password while the account is waiting", async () => {
    mockClaim.mockResolvedValue({ allowed: false });
    const result = await proveSessionReauth({
      member: member(),
      factor: "PASSWORD",
      password: "guess",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: LOGIN_THROTTLED_CODE,
    });
    expect(mockCompare).not.toHaveBeenCalled();
  });

  it("does not accept a password from someone who has an authenticator app", async () => {
    mockPrisma.member.findUnique.mockResolvedValue({ twoFactorFailedAttempts: 0 });
    const result = await proveSessionReauth({
      member: appMember(),
      factor: "PASSWORD",
      password: "correct",
    });
    expect(result.ok).toBe(false);
    expect(mockCompare).not.toHaveBeenCalled();
    expect(mockPrisma.member.update).toHaveBeenCalled();
  });
});
