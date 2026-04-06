import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: vi.fn() },
    passwordResetToken: { create: vi.fn() },
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

const mockedAuth = vi.mocked(auth);
const mockedFindMany = vi.mocked(prisma.member.findMany);
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
    vi.clearAllMocks();
    mockedCreateToken.mockResolvedValue({ id: "tok1", token: "uuid", memberId: "m1", expiresAt: new Date(), used: false, createdAt: new Date() } as any);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorised");
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

    // Verify token was created
    expect(mockedCreateToken).toHaveBeenCalledTimes(1);

    // Verify email was sent
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendEmail).toHaveBeenCalledWith("alice@test.com", expect.any(String));

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
          parentMemberId: null,
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
