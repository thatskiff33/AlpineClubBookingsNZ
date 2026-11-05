import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Enumeration-safe magic-link request endpoint (#2034), mirroring
// forgot-password: always {success:true}, and an email is sent ONLY for an
// active + verified + login-capable member while the module is enabled.
const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  applyRateLimit: vi.fn(),
  checkAccountRequestLimit: vi.fn(),
  sendMagicLinkEmail: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  loadLoginSecuritySettings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: h.findFirst },
    magicLinkToken: { deleteMany: h.deleteMany, create: h.create },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: h.applyRateLimit,
  rateLimiters: {
    magicLinkRequest: { id: "magic-link-request" },
    magicLinkRequestAccount: { id: "magic-link-request-account" },
  },
}));
// The per-account limit's own behaviour is proven against the real limiter in
// `account-request-limit-routes.test.ts` (#4613); here it allows by default.
vi.mock("@/lib/account-request-limit", () => ({
  checkAccountRequestLimit: h.checkAccountRequestLimit,
}));
vi.mock("@/lib/email", () => ({ sendMagicLinkEmail: h.sendMagicLinkEmail }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/login-security-settings", () => ({
  loadLoginSecuritySettings: h.loadLoginSecuritySettings,
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/auth/magic-link/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/auth/magic-link", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const activeVerifiedMember = {
  id: "member-1",
  email: "member@example.com",
  active: true,
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.applyRateLimit.mockResolvedValue(null);
  h.checkAccountRequestLimit.mockResolvedValue({ success: true });
  h.deleteMany.mockResolvedValue({ count: 0 });
  h.create.mockResolvedValue({ id: "token-1" });
  h.sendMagicLinkEmail.mockResolvedValue(undefined);
  h.loadEffectiveModuleFlags.mockResolvedValue({ magicLink: true });
  // Default policy: 15-minute TTL (an unconfigured club).
  h.loadLoginSecuritySettings.mockResolvedValue({
    policy: { magicLinkTtlMinutes: 15 },
  });
});

async function expectSilentNoOp(body: unknown) {
  const res = await POST(req(body));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ success: true });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMagicLinkEmail).not.toHaveBeenCalled();
}

describe("POST /api/auth/magic-link — enumeration safety", () => {
  it("unknown email → success, zero emails", async () => {
    h.findFirst.mockResolvedValue(null);
    await expectSilentNoOp({ email: "nobody@example.com" });
  });

  it("canLogin:false email → success, zero emails (filtered out by the query)", async () => {
    // The route queries { canLogin: true }, so a dependent/non-login member is
    // never returned. Assert the query carried the canLogin gate.
    h.findFirst.mockResolvedValue(null);
    await expectSilentNoOp({ email: "dependent@example.com" });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { email: "dependent@example.com", canLogin: true },
    });
  });

  it("archived (inactive) member → success, zero emails", async () => {
    h.findFirst.mockResolvedValue({ ...activeVerifiedMember, active: false });
    await expectSilentNoOp({ email: "member@example.com" });
  });

  it("unverified member → success, zero emails (never a verification bypass)", async () => {
    h.findFirst.mockResolvedValue({
      ...activeVerifiedMember,
      emailVerified: false,
    });
    await expectSilentNoOp({ email: "member@example.com" });
  });

  it("module OFF → success, zero emails even for a valid member", async () => {
    h.loadEffectiveModuleFlags.mockResolvedValue({ magicLink: false });
    h.findFirst.mockResolvedValue(activeVerifiedMember);
    await expectSilentNoOp({ email: "member@example.com" });
  });

  it("lowercases the email before lookup", async () => {
    h.findFirst.mockResolvedValue(null);
    await POST(req({ email: "Mixed@Example.COM" }));
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { email: "mixed@example.com", canLogin: true },
    });
  });
});

describe("POST /api/auth/magic-link — happy path", () => {
  it("active + verified member with module on → mints a token and sends", async () => {
    h.findFirst.mockResolvedValue(activeVerifiedMember);

    const res = await POST(req({ email: "member@example.com" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    // Existing tokens invalidated, one fresh token created.
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    const createArg = h.create.mock.calls[0][0];
    expect(createArg.data.memberId).toBe("member-1");
    expect(typeof createArg.data.tokenHash).toBe("string");
    expect(createArg.data.expiresAt).toBeInstanceOf(Date);
    // Default 15-minute TTL (an unconfigured club).
    const ttlMs = createArg.data.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);

    // A raw token (not the hash) is emailed to the member.
    expect(h.sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    const [emailArg, tokenArg] = h.sendMagicLinkEmail.mock.calls[0];
    expect(emailArg).toBe("member@example.com");
    expect(tokenArg).not.toBe(createArg.data.tokenHash);
  });

  it("honours the club-configured link expiry from LoginSecuritySetting", async () => {
    h.findFirst.mockResolvedValue(activeVerifiedMember);
    h.loadLoginSecuritySettings.mockResolvedValue({
      policy: { magicLinkTtlMinutes: 30 },
    });

    await POST(req({ email: "member@example.com" }));

    const createArg = h.create.mock.calls[0][0];
    const ttlMs = createArg.data.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });

  it("re-clamps an out-of-range persisted expiry to the supported bound", async () => {
    h.findFirst.mockResolvedValue(activeVerifiedMember);
    // A stray value past the 60-minute ceiling must not widen the link lifetime.
    h.loadLoginSecuritySettings.mockResolvedValue({
      policy: { magicLinkTtlMinutes: 9999 },
    });

    await POST(req({ email: "member@example.com" }));

    const createArg = h.create.mock.calls[0][0];
    const ttlMs = createArg.data.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });
});

describe("POST /api/auth/magic-link — guards", () => {
  it("rate-limited request short-circuits before any lookup", async () => {
    h.applyRateLimit.mockResolvedValue(
      new Response(null, { status: 429 }),
    );
    const res = await POST(req({ email: "member@example.com" }));
    expect(res.status).toBe(429);
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it("an account over its per-account limit gets the accepted answer, before any lookup (#4613)", async () => {
    h.checkAccountRequestLimit.mockResolvedValue({ success: false });
    h.findFirst.mockResolvedValue(activeVerifiedMember);
    await expectSilentNoOp({ email: "Member@Example.com" });
    expect(h.checkAccountRequestLimit).toHaveBeenCalledWith(
      { id: "magic-link-request-account" },
      "Member@Example.com",
    );
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it("invalid email → 400 validation error", async () => {
    const res = await POST(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});
