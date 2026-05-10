import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: {
    forgotPassword: { id: "forgot-password", limit: 5, windowSeconds: 3600 },
    resetPassword: { id: "reset-password", limit: 5, windowSeconds: 3600 },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-password") },
}));

import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";
import { hashActionToken } from "@/lib/action-tokens";
import { SELF_SERVICE_PASSWORD_RESET_TTL_MS } from "@/lib/password-reset";

const mockedFindMember = vi.mocked(prisma.member.findFirst);
const mockedMemberUpdate = vi.mocked(prisma.member.update);
const mockedDeleteTokens = vi.mocked(prisma.passwordResetToken.deleteMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedFindToken = vi.mocked(prisma.passwordResetToken.findUnique);
const mockedUpdateToken = vi.mocked(prisma.passwordResetToken.update);
const mockedCreateAuditLog = vi.mocked(prisma.auditLog.create);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedSendPasswordResetEmail = vi.mocked(sendPasswordResetEmail);

describe("password reset routes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));
    vi.clearAllMocks();
    mockedDeleteTokens.mockResolvedValue({ count: 1 } as never);
    mockedCreateToken.mockResolvedValue({ id: "tok1" } as never);
    mockedMemberUpdate.mockResolvedValue({ id: "member-1" } as never);
    mockedUpdateToken.mockResolvedValue({ id: "tok1" } as never);
    mockedCreateAuditLog.mockResolvedValue({ id: "audit-1" } as never);
    mockedTransaction.mockResolvedValue([] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 1 hour expiry for self-service forgot password links", async () => {
    mockedFindMember.mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      active: true,
    } as never);

    const req = new NextRequest("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });

    const res = await forgotPassword(req);

    expect(res.status).toBe(200);
    expect(mockedCreateToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-1",
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() + SELF_SERVICE_PASSWORD_RESET_TTL_MS),
      }),
    });
    expect(mockedSendPasswordResetEmail).toHaveBeenCalledWith(
      "member@example.com",
      expect.any(String)
    );
  });

  it("records passwordChangedAt and clears forcePasswordChange when a reset is completed", async () => {
    mockedFindToken.mockResolvedValue({
      id: "tok1",
      memberId: "member-1",
      used: false,
      expiresAt: new Date(Date.now() + SELF_SERVICE_PASSWORD_RESET_TTL_MS),
      member: { id: "member-1" },
    } as never);

    const req = new NextRequest("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "reset-token", password: "123456789012" }),
    });

    const res = await resetPassword(req);

    expect(res.status).toBe(200);
    expect(mockedFindToken).toHaveBeenCalledWith({
      where: { tokenHash: hashActionToken("reset-token") },
      include: { member: true },
    });
    expect(mockedMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: {
        passwordHash: "hashed-password",
        forcePasswordChange: false,
        passwordChangedAt: expect.any(Date),
      },
    });
    expect(mockedUpdateToken).toHaveBeenCalledWith({
      where: { id: "tok1" },
      data: { used: true },
    });
    expect(mockedCreateAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.password_reset.completed",
        actorMemberId: "member-1",
        subjectMemberId: "member-1",
        category: "security",
        severity: "critical",
        metadata: {
          method: "reset_token",
        },
      }),
    });
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
  });
});
