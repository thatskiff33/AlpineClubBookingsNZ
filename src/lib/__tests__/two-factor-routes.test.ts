import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireTwoFactorApiSession: vi.fn(),
  markTwoFactorSessionVerified: vi.fn().mockResolvedValue(undefined),
  applyRateLimit: vi.fn().mockReturnValue(null),
  sendTwoFactorCodeEmail: vi.fn().mockResolvedValue(undefined),
  createTwoFactorEmailCode: vi.fn().mockResolvedValue({
    code: "123456",
    expiresAt: new Date("2026-07-02T10:10:00.000Z"),
  }),
  enrollTwoFactor: vi.fn().mockResolvedValue(["ABCD-EFGH-IJKL"]),
  recordTwoFactorFailure: vi.fn().mockResolvedValue(null),
  verifyTwoFactorEmailCode: vi.fn().mockResolvedValue(true),
  verifyStoredTotpCode: vi.fn().mockResolvedValue(true),
  consumeRecoveryCode: vi.fn().mockResolvedValue(true),
  verifyTotpCode: vi.fn().mockReturnValue(true),
  generateTotpEnrollment: vi.fn().mockReturnValue({
    secret: "BASE32SECRET",
    otpauthUrl: "otpauth://totp/test",
    issuer: "Test Club",
    label: "member@example.test",
  }),
}));

vi.mock("@/lib/two-factor-api", () => ({
  requireTwoFactorApiSession: mocks.requireTwoFactorApiSession,
  markTwoFactorSessionVerified: mocks.markTwoFactorSessionVerified,
  passwordChangeRequiredResponse: vi.fn(() =>
    NextResponse.json({ error: "Password change required" }, { status: 403 }),
  ),
  twoFactorLockoutResponse: vi.fn((member: { twoFactorLockedUntil?: Date | null }) =>
    member.twoFactorLockedUntil &&
    member.twoFactorLockedUntil.getTime() > Date.now()
      ? NextResponse.json(
          {
            error: "Too many invalid two-factor attempts",
            lockedUntil: member.twoFactorLockedUntil.toISOString(),
          },
          { status: 429 },
        )
      : null,
  ),
  getTwoFactorStatusPayload: vi.fn((session, member) => ({
    required: session.user.twoFactorRequired,
    verified: session.user.twoFactorVerified,
    enrolled: member.twoFactorEnabled,
    method: member.twoFactorMethod,
    email: member.email,
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: { twoFactorVerify: { id: "two-factor-verify" } },
}));

vi.mock("@/lib/email", () => ({
  sendTwoFactorCodeEmail: mocks.sendTwoFactorCodeEmail,
}));

vi.mock("@/lib/two-factor", () => ({
  createTwoFactorEmailCode: mocks.createTwoFactorEmailCode,
  enrollTwoFactor: mocks.enrollTwoFactor,
  recordTwoFactorFailure: mocks.recordTwoFactorFailure,
  verifyTwoFactorEmailCode: mocks.verifyTwoFactorEmailCode,
  verifyStoredTotpCode: mocks.verifyStoredTotpCode,
  consumeRecoveryCode: mocks.consumeRecoveryCode,
  verifyTotpCode: mocks.verifyTotpCode,
  generateTotpEnrollment: mocks.generateTotpEnrollment,
}));

import { POST as sendEmailCode } from "@/app/api/auth/2fa/email/send/route";
import { POST as enrollEmail } from "@/app/api/auth/2fa/enroll/email/route";
import { POST as verifyCode } from "@/app/api/auth/2fa/verify/route";
import { GET as setupTotp } from "@/app/api/auth/2fa/totp/setup/route";

function sessionGuard(overrides?: {
  required?: boolean;
  verified?: boolean;
  enrolled?: boolean;
  method?: "TOTP" | "EMAIL" | null;
}) {
  return {
    ok: true as const,
    session: {
      user: {
        id: "member-1",
        twoFactorRequired: overrides?.required ?? true,
        twoFactorVerified: overrides?.verified ?? false,
      },
    },
    member: {
      id: "member-1",
      email: "member@example.test",
      firstName: "Member",
      lastName: "Example",
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: overrides?.enrolled ?? false,
      twoFactorMethod: overrides?.method ?? null,
      totpSecret: null,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
    },
  };
}

function request(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("two-factor auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireTwoFactorApiSession.mockResolvedValue(sessionGuard());
    mocks.applyRateLimit.mockReturnValue(null);
  });

  it("sends email OTP codes for email enrollment", async () => {
    const response = await sendEmailCode(request("/api/auth/2fa/email/send"));

    expect(response.status).toBe(200);
    expect(mocks.createTwoFactorEmailCode).toHaveBeenCalledWith("member-1");
    expect(mocks.sendTwoFactorCodeEmail).toHaveBeenCalledWith({
      email: "member@example.test",
      firstName: "Member",
      code: "123456",
      expiresAt: new Date("2026-07-02T10:10:00.000Z"),
    });
  });

  it("enrolls email 2FA and returns recovery codes", async () => {
    const response = await enrollEmail(
      request("/api/auth/2fa/enroll/email", { code: "123456" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      recoveryCodes: ["ABCD-EFGH-IJKL"],
    });
    expect(mocks.verifyTwoFactorEmailCode).toHaveBeenCalledWith(
      "member-1",
      "123456",
    );
    expect(mocks.enrollTwoFactor).toHaveBeenCalledWith({
      memberId: "member-1",
      method: "EMAIL",
      // #3454: the member is the actor of their own enrolment.
      actor: { kind: "member", memberId: "member-1" },
      request: expect.any(Object),
    });
    expect(mocks.markTwoFactorSessionVerified).toHaveBeenCalled();
  });

  it("verifies recovery codes for enrolled accounts", async () => {
    mocks.requireTwoFactorApiSession.mockResolvedValue(
      sessionGuard({ enrolled: true, method: "TOTP" }),
    );

    const response = await verifyCode(
      request("/api/auth/2fa/verify", {
        method: "RECOVERY",
        code: "ABCD-EFGH-IJKL",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeRecoveryCode).toHaveBeenCalledWith(
      "member-1",
      "ABCD-EFGH-IJKL",
    );
    expect(mocks.markTwoFactorSessionVerified).toHaveBeenCalled();
  });

  it("rejects mismatched enrolled methods", async () => {
    mocks.requireTwoFactorApiSession.mockResolvedValue(
      sessionGuard({ enrolled: true, method: "EMAIL" }),
    );

    const response = await verifyCode(
      request("/api/auth/2fa/verify", { method: "TOTP", code: "123456" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expect(mocks.recordTwoFactorFailure).toHaveBeenCalledWith("member-1");
    expect(mocks.markTwoFactorSessionVerified).not.toHaveBeenCalled();
  });

  it("blocks verification during a persistent lockout", async () => {
    mocks.requireTwoFactorApiSession.mockResolvedValue({
      ...sessionGuard({ enrolled: true, method: "EMAIL" }),
      member: {
        ...sessionGuard({ enrolled: true, method: "EMAIL" }).member,
        twoFactorLockedUntil: new Date(Date.now() + 60_000),
      },
    });

    const response = await verifyCode(
      request("/api/auth/2fa/verify", { method: "EMAIL", code: "123456" }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many invalid two-factor attempts",
      lockedUntil: expect.any(String),
    });
    expect(mocks.verifyTwoFactorEmailCode).not.toHaveBeenCalled();
  });

  it("does not run verification while rate limited", async () => {
    mocks.applyRateLimit.mockReturnValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );

    const response = await verifyCode(
      request("/api/auth/2fa/verify", {
        method: "RECOVERY",
        code: "ABCD-EFGH-IJKL",
      }),
    );

    expect(response.status).toBe(429);
    expect(mocks.consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it("returns TOTP setup for unenrolled required sessions", async () => {
    const response = await setupTotp();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      secret: "BASE32SECRET",
      otpauthUrl: "otpauth://totp/test",
      issuer: "Test Club",
      label: "member@example.test",
    });
  });
});
