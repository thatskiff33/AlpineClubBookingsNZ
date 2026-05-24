import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    passwordResetToken: { create: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/email", () => ({
  sendAdminPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { sendAdminPasswordResetEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { POST } from "@/app/api/admin/members/send-password-reset/route";
import {
  ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS,
  DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW,
  getAdminPasswordResetExpiryDurationMs,
} from "@/lib/password-reset";

const mockedAuth = vi.mocked(auth);
const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedFindUnique = vi.mocked(prisma.member.findUnique);
const mockedDeleteTokens = vi.mocked(prisma.passwordResetToken.deleteMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedSendEmail = vi.mocked(sendAdminPasswordResetEmail);
const mockedLogAudit = vi.mocked(logAudit);

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/members/send-password-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Admin Send Password Reset API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));
    vi.clearAllMocks();
    mockedFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false } as any);
    mockedCreateToken.mockResolvedValue({ id: "tok1", token: "uuid", memberId: "m1", expiresAt: new Date(), used: false, createdAt: new Date() } as any);
    mockedDeleteTokens.mockResolvedValue({ count: 1 } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for empty memberIds array", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    const res = await POST(makeReq({ memberIds: [] }));
    expect(res.status).toBe(422);
  });

  it("returns 422 for more than 100 memberIds", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
    const res = await POST(makeReq({ memberIds: ids }));
    expect(res.status).toBe(422);
  });

  it("returns 400 for invalid JSON", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    const req = new NextRequest("http://localhost/api/admin/members/send-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("sends password reset email to a single member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockedFindMany.mockResolvedValue([
      { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    ] as any);

    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.expiryLabel).toBe("1 hour");

    // Verify token was created
    expect(mockedCreateToken).toHaveBeenCalledTimes(1);
    expect(mockedDeleteTokens).toHaveBeenCalledWith({
      where: { memberId: "m1" },
    });
    expect(mockedCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "m1",
          tokenHash: expect.any(String),
          expiresAt: new Date(
            Date.now() + getAdminPasswordResetExpiryDurationMs(DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW)
          ),
        }),
      })
    );

    // Verify email was sent
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendEmail).toHaveBeenCalledWith("alice@test.com", expect.any(String), "1 hour");

    // Verify audit log
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.password-reset-sent",
        memberId: "a1",
        targetId: "m1",
      })
    );
  });

  it.each(ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.filter((option) => option.value !== "1h"))(
    "supports the $label admin reset window",
    async (option) => {
      mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
      mockedFindMany.mockResolvedValue([
        { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
      ] as any);

      const res = await POST(makeReq({ memberIds: ["m1"], expiryWindow: option.value }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.expiryLabel).toBe(option.label);
      expect(mockedCreateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tokenHash: expect.any(String),
            expiresAt: new Date(Date.now() + getAdminPasswordResetExpiryDurationMs(option.value)),
          }),
        })
      );
      expect(mockedSendEmail).toHaveBeenCalledWith(
        "alice@test.com",
        expect.any(String),
        option.label
      );
    }
  );

  it("skips inactive and dependent members", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    // Only m1 is returned (active, primary) — m2 is filtered out by the query
    mockedFindMany.mockResolvedValue([
      { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    ] as any);

    const res = await POST(makeReq({ memberIds: ["m1", "m2"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(1);

    // Verify the DB query filtered correctly
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["m1", "m2"] },
          active: true,
          canLogin: true,
        },
      })
    );
  });

  it("returns sent 0 when no members found", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockedFindMany.mockResolvedValue([]);

    const res = await POST(makeReq({ memberIds: ["nonexistent"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("handles token creation failure gracefully", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockedFindMany.mockResolvedValue([
      { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    ] as any);
    mockedCreateToken.mockRejectedValue(new Error("DB error"));

    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(0);
  });
});

describe("Admin Password Reset Email Template", () => {
  it("produces distinct template from self-service reset", async () => {
    const { passwordResetTemplate, adminPasswordResetTemplate } = await import("@/lib/email-templates");

    const selfService = passwordResetTemplate("https://example.com/reset?token=abc");
    const adminInitiated = adminPasswordResetTemplate("https://example.com/reset?token=abc");

    // Both should contain the reset URL
    expect(selfService).toContain("https://example.com/reset?token=abc");
    expect(adminInitiated).toContain("https://example.com/reset?token=abc");

    // Admin template should mention administrator
    expect(adminInitiated).toContain("administrator");
    expect(selfService).not.toContain("administrator");

    // Both should contain "Reset Password" button text
    expect(selfService).toContain("Reset Password");
    expect(adminInitiated).toContain("Reset Password");
  });
});
