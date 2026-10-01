import { beforeEach, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";

// two-factor.ts reads DB-first identity via the server-only sync accessor (E3
// #1929); neutralise the boundary guard and stub the accessor.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({
    name: "Test Club",
    bookingsName: "Test Club - Bookings",
  }),
}));

const mockPrisma = vi.hoisted(() => ({
  // Both shapes: an array of operations, and (#3454, enrolment) an interactive
  // callback, which is handed this same double as its transaction client.
  $transaction: vi.fn(
    async (operations: Array<Promise<unknown>> | ((tx: unknown) => Promise<unknown>)) =>
      typeof operations === "function"
        ? operations(mockPrisma)
        : Promise.all(operations),
  ),
  auditLog: {
    create: vi.fn().mockResolvedValue({ id: "audit-1" }),
  },
  twoFactorEmailCode: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: "email-code-1" }),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  twoFactorRecoveryCode: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 10 }),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  twoFactorSessionChallenge: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: "session-challenge-1" }),
  },
  member: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({ id: "member-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  consumeRecoveryCode,
  consumeTwoFactorSessionChallenge,
  createTwoFactorEmailCode,
  createTwoFactorSessionChallenge,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  enrollTwoFactor,
  generateTotpEnrollment,
  hashEmailOtpCode,
  hashRecoveryCode,
  hashTwoFactorCode,
  recordTwoFactorFailure,
  verifyTotpCode,
  verifyTwoFactorEmailCode,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
} from "@/lib/two-factor";

describe("two-factor helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-for-two-factor");
  });

  it("encrypts TOTP secrets at rest", () => {
    const encrypted = encryptTwoFactorSecret("BASE32SECRET");

    expect(encrypted).not.toContain("BASE32SECRET");
    expect(decryptTwoFactorSecret(encrypted)).toBe("BASE32SECRET");
  });

  it("verifies TOTP codes with a small skew window", () => {
    const setup = generateTotpEnrollment("member@example.test");
    const totp = new OTPAuth.TOTP({
      issuer: setup.issuer,
      label: setup.label,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });

    expect(verifyTotpCode(setup.secret, totp.generate())).toBe(true);
    expect(verifyTotpCode(setup.secret, "123")).toBe(false);
  });

  it("stores and verifies email OTP codes by HMAC hash", async () => {
    const issued = await createTwoFactorEmailCode("member-1");
    const createCall = mockPrisma.twoFactorEmailCode.create.mock.calls[0]?.[0];
    expect(createCall.data.codeHash).toBe(hashEmailOtpCode(issued.code));
    expect(createCall.data.codeHash).not.toBe(issued.code);

    mockPrisma.twoFactorEmailCode.findUnique.mockResolvedValue({
      id: "email-code-1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      verifyTwoFactorEmailCode("member-1", issued.code),
    ).resolves.toBe(true);
    expect(mockPrisma.twoFactorEmailCode.updateMany).toHaveBeenCalledWith({
      where: { id: "email-code-1", used: false },
      data: { used: true },
    });
  });

  it("rejects expired email OTP codes", async () => {
    mockPrisma.twoFactorEmailCode.findUnique.mockResolvedValue({
      id: "email-code-1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() - 1),
    });

    await expect(
      verifyTwoFactorEmailCode("member-1", "123456"),
    ).resolves.toBe(false);
  });

  it("consumes recovery codes once", async () => {
    const code = "ABCD-EFGH-IJKL";
    mockPrisma.twoFactorRecoveryCode.findUnique.mockResolvedValue({
      id: "recovery-1",
      memberId: "member-1",
      codeHash: hashRecoveryCode(code),
      usedAt: null,
    });

    await expect(consumeRecoveryCode("member-1", code)).resolves.toBe(true);
    expect(mockPrisma.twoFactorRecoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: "recovery-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });

    mockPrisma.twoFactorRecoveryCode.findUnique.mockResolvedValue({
      id: "recovery-1",
      memberId: "member-1",
      usedAt: new Date(),
    });
    await expect(consumeRecoveryCode("member-1", code)).resolves.toBe(false);
  });

  it("enrolls TOTP with encrypted secret and replacement recovery codes", async () => {
    const recoveryCodes = await enrollTwoFactor({
      memberId: "member-1",
      method: "TOTP",
      totpSecret: "BASE32SECRET",
      actor: { kind: "member", memberId: "member-1" },
    });

    expect(recoveryCodes).toHaveLength(10);
    // #3454: the enrolment records itself, on the same transaction client,
    // and the row holds no trace of the secret.
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockPrisma.auditLog.create.mock.calls[0]?.[0];
    expect(audit.data).toMatchObject({
      action: "security.two_factor.enrolled",
      category: "security",
      actorMemberId: "member-1",
      subjectMemberId: "member-1",
    });
    expect(JSON.stringify(audit)).not.toContain("BASE32SECRET");
    const updateCall = mockPrisma.member.update.mock.calls[0]?.[0];
    expect(updateCall.data.twoFactorEnabled).toBe(true);
    expect(updateCall.data.twoFactorMethod).toBe("TOTP");
    expect(updateCall.data.totpSecret).not.toBe("BASE32SECRET");
    expect(decryptTwoFactorSecret(updateCall.data.totpSecret)).toBe(
      "BASE32SECRET",
    );
    expect(mockPrisma.twoFactorRecoveryCode.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          memberId: "member-1",
          codeHash: expect.any(String),
        }),
      ]),
    });
  });

  it("stores session challenge tokens hashed with a short expiry", async () => {
    const token = await createTwoFactorSessionChallenge("member-1");

    const createCall =
      mockPrisma.twoFactorSessionChallenge.create.mock.calls[0]?.[0];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(createCall.data.memberId).toBe("member-1");
    expect(createCall.data.tokenHash).toBe(hashTwoFactorCode(token));
    expect(createCall.data.tokenHash).not.toBe(token);
    expect(createCall.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Housekeeping removes only expired rows so live challenges cannot race.
    expect(
      mockPrisma.twoFactorSessionChallenge.deleteMany,
    ).toHaveBeenCalledWith({
      where: { memberId: "member-1", expiresAt: { lte: expect.any(Date) } },
    });
  });

  it("consumes a session challenge token exactly once", async () => {
    mockPrisma.twoFactorSessionChallenge.deleteMany.mockResolvedValueOnce({
      count: 1,
    });
    await expect(
      consumeTwoFactorSessionChallenge("member-1", "raw-token"),
    ).resolves.toBe(true);
    expect(
      mockPrisma.twoFactorSessionChallenge.deleteMany,
    ).toHaveBeenCalledWith({
      where: {
        tokenHash: hashTwoFactorCode("raw-token"),
        memberId: "member-1",
        expiresAt: { gt: expect.any(Date) },
      },
    });

    mockPrisma.twoFactorSessionChallenge.deleteMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      consumeTwoFactorSessionChallenge("member-1", "raw-token"),
    ).resolves.toBe(false);
  });

  it("locks the member after repeated invalid two-factor attempts", async () => {
    mockPrisma.member.findUnique.mockResolvedValue({
      twoFactorFailedAttempts: TWO_FACTOR_MAX_FAILED_ATTEMPTS - 1,
    });

    const lockedUntil = await recordTwoFactorFailure("member-1");

    expect(lockedUntil).toBeInstanceOf(Date);
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: {
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: lockedUntil,
      },
    });
  });
});
