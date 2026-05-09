import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  sendMemberSetupInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { POST } from "@/app/api/admin/members/send-setup-invite/route";
import { MEMBER_SETUP_INVITE_TTL_MS } from "@/lib/member-setup-invite";

const mockedAuth = vi.mocked(auth);
const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedFindUnique = vi.mocked(prisma.member.findUnique);
const mockedDeleteTokens = vi.mocked(prisma.passwordResetToken.deleteMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedSendEmail = vi.mocked(sendMemberSetupInviteEmail);
const mockedLogAudit = vi.mocked(logAudit);

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/members/send-setup-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Admin Send Setup Invite API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));
    vi.clearAllMocks();
    mockedFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false } as any);
    mockedCreateToken.mockResolvedValue({
      id: "tok1",
      token: "uuid",
      memberId: "m1",
      expiresAt: new Date(),
      used: false,
      createdAt: new Date(),
    } as any);
    mockedDeleteTokens.mockResolvedValue({ count: 1 } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await POST(makeReq({ memberIds: ["m1"] }));
    expect(res.status).toBe(401);
  });

  it("sends a setup invite email with a 7-day token window", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockedFindMany.mockResolvedValue([
      { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    ] as any);

    const res = await POST(makeReq({ memberIds: ["m1"] }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(0);

    expect(mockedDeleteTokens).toHaveBeenCalledWith({
      where: { memberId: "m1" },
    });
    expect(mockedCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "m1",
          tokenHash: expect.any(String),
          expiresAt: new Date(Date.now() + MEMBER_SETUP_INVITE_TTL_MS),
        }),
      })
    );
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice",
      expect.any(String)
    );
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.setup-invite-sent",
        memberId: "a1",
        targetId: "m1",
      })
    );
  });

  it("skips inactive and dependent members", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockedFindMany.mockResolvedValue([
      { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    ] as any);

    const res = await POST(makeReq({ memberIds: ["m1", "m2"] }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(1);
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["m1", "m2"] },
          active: true,
          ageTier: "ADULT",
          parentMemberId: null,
        },
      })
    );
  });
});

describe("Member Setup Invite Email Template", () => {
  it("uses account setup wording and a 7-day expiry", async () => {
    const { memberSetupInviteTemplate } = await import("@/lib/email-templates");

    const html = memberSetupInviteTemplate(
      "Alice",
      "https://example.com/reset?token=abc"
    );

    expect(html).toContain("Set Up Your Account");
    expect(html).toContain("Set Up My Password");
    expect(html).toContain("https://example.com/reset?token=abc");
    expect(html).toContain("7 days");
    expect(html).not.toContain("You requested a password reset");
  });
});
