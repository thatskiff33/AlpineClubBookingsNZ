import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #5407: the resent verification email states the expiry the token row was
// written with (createEmailVerificationToken hands it back), never a second
// derivation from the TTL a moment later.

const h = vi.hoisted(() => ({
  applyRateLimit: vi.fn(),
  memberFindFirst: vi.fn(),
  createEmailVerificationToken: vi.fn(),
  sendVerificationEmail: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: h.applyRateLimit,
  rateLimiters: { resendVerification: { id: "resend-verification" } },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findFirst: h.memberFindFirst } },
}));
vi.mock("@/lib/verification-tokens", () => ({
  createEmailVerificationToken: h.createEmailVerificationToken,
}));
vi.mock("@/lib/email", () => ({ sendVerificationEmail: h.sendVerificationEmail }));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/auth/resend-verification/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.applyRateLimit.mockResolvedValue(null);
  h.memberFindFirst.mockResolvedValue({
    id: "member-1",
    email: "ana@example.com",
    firstName: "Ana",
    emailVerified: false,
  });
  h.sendVerificationEmail.mockResolvedValue(undefined);
});

describe("POST /api/auth/resend-verification", () => {
  it("emails the expiry the token was stored with, the same instant (#5407)", async () => {
    const stored = new Date("2026-07-03T00:00:00.000Z");
    h.createEmailVerificationToken.mockResolvedValue({ token: "raw-token", expiresAt: stored });

    const res = await POST(req({ email: "Ana@Example.com" }));

    expect(res.status).toBe(200);
    expect(h.createEmailVerificationToken).toHaveBeenCalledWith("member-1");
    expect(h.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const [to, firstName, token, emailed] = h.sendVerificationEmail.mock.calls[0] as unknown as [string, string, string, Date];
    expect([to, firstName, token]).toEqual(["ana@example.com", "Ana", "raw-token"]);
    // Identity, not equality: a recomputed instant would be equal on the frozen clock.
    expect(emailed).toBe(stored);
  });

  it("sends nothing to an already verified member", async () => {
    h.memberFindFirst.mockResolvedValue({ id: "member-1", email: "ana@example.com", firstName: "Ana", emailVerified: true });

    const res = await POST(req({ email: "ana@example.com" }));

    expect(res.status).toBe(200);
    expect(h.createEmailVerificationToken).not.toHaveBeenCalled();
    expect(h.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
