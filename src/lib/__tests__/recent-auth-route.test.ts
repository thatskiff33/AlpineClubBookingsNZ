/**
 * #4616 (INV-AUTH-008): the step-up route, `/api/auth/reauth`.
 *
 * The two-factor lockout here is the REAL one (`recordTwoFactorFailure`,
 * `getActiveTwoFactorLockout`, `clearTwoFactorLockout` from `two-factor.ts`)
 * over an in-memory member row, so a failed app code is shown to count towards
 * the same five-failure, fifteen-minute lockout sign-in uses. Only the TOTP
 * arithmetic itself (`verifyStoredTotpCode`) and the password budget's store
 * (`login-throttle.ts`, its own subject in `login-throttle-auth.test.ts`) are
 * doubles.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  applyRateLimit: vi.fn(),
  updateSession: vi.fn(),
  createSessionReauthChallenge: vi.fn(),
  verifyStoredTotpCode: vi.fn(),
  claimPasswordAttempt: vi.fn(),
  clearPasswordAttempts: vi.fn(),
  compare: vi.fn(),
  member: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: { twoFactorVerify: { id: "two-factor-verify" } },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  updateSession: mocks.updateSession,
}));

vi.mock("@/lib/session-reauth-challenge", () => ({
  createSessionReauthChallenge: mocks.createSessionReauthChallenge,
}));

vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({ name: "Test Club", bookingsName: "Test Club - Bookings" }),
}));

// One member row, read through its `select` and written by the lockout code.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
        if (!mocks.member) return null;
        return Object.fromEntries(
          Object.keys(select).map((field) => [field, mocks.member?.[field] ?? null]),
        );
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        mocks.member = { ...mocks.member, ...data };
        return mocks.member;
      }),
    },
  },
}));

vi.mock("@/lib/two-factor", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/two-factor")),
  verifyStoredTotpCode: mocks.verifyStoredTotpCode,
}));

vi.mock("@/lib/login-throttle", () => ({
  claimPasswordAttempt: mocks.claimPasswordAttempt,
  clearPasswordAttempts: mocks.clearPasswordAttempts,
}));

vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));

import { GET, POST } from "@/app/api/auth/reauth/route";
import { TWO_FACTOR_MAX_FAILED_ATTEMPTS } from "@/lib/two-factor";

const OFFICER_EMAIL = "Treasurer@Example.test";

function memberRow(factor: "app" | "email" | "none") {
  return {
    id: "officer-1",
    email: OFFICER_EMAIL,
    passwordHash: "stored-bcrypt-hash",
    twoFactorEnabled: factor !== "none",
    twoFactorMethod: factor === "app" ? "TOTP" : factor === "email" ? "EMAIL" : null,
    totpSecret: factor === "app" ? "v1:iv:tag:ciphertext" : null,
    twoFactorFailedAttempts: 0,
    twoFactorLockedUntil: null,
  };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/auth/reauth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function expectNothingMinted() {
  expect(mocks.createSessionReauthChallenge).not.toHaveBeenCalled();
  expect(mocks.updateSession).not.toHaveBeenCalled();
}

describe("POST /api/auth/reauth (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.member = memberRow("app");
    mocks.applyRateLimit.mockResolvedValue(null);
    mocks.requireActiveSession.mockResolvedValue({
      ok: true,
      session: { user: { id: "officer-1" } },
    });
    mocks.createSessionReauthChallenge.mockResolvedValue("minted-reauth-token");
    // The jwt callback consumed the token and moved the stamp to now.
    mocks.updateSession.mockImplementation(async () => ({
      user: { id: "officer-1", lastAuthenticatedAt: Date.now() },
    }));
    mocks.verifyStoredTotpCode.mockResolvedValue(false);
    mocks.claimPasswordAttempt.mockResolvedValue({ allowed: true });
    mocks.clearPasswordAttempts.mockResolvedValue(undefined);
    mocks.compare.mockResolvedValue(false);
  });

  it("refreshes the session after a right app code, through a minted challenge", async () => {
    mocks.verifyStoredTotpCode.mockResolvedValue(true);

    const response = await POST(post({ method: "TOTP", code: "123456" }));

    expect(response.status).toBe(200);
    expect(mocks.verifyStoredTotpCode).toHaveBeenCalledWith("officer-1", "123456");
    expect(mocks.createSessionReauthChallenge).toHaveBeenCalledWith("officer-1");
    expect(mocks.updateSession).toHaveBeenCalledWith({
      user: { reauthChallengeToken: "minted-reauth-token" },
    });
  });

  it.each([
    ["an emailed code", { method: "EMAIL", code: "123456" }],
    ["a recovery code", { method: "RECOVERY", code: "ABCD-EFGH-IJKL" }],
  ])("refuses %s for step-up, checking and counting nothing", async (_label, body) => {
    for (const factor of ["app", "email", "none"] as const) {
      mocks.member = memberRow(factor);
      const response = await POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expect(mocks.claimPasswordAttempt).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.member?.twoFactorFailedAttempts).toBe(0);
    expectNothingMinted();
  });

  it("refuses the password, unchecked and uncounted, while the person has an app", async () => {
    mocks.compare.mockResolvedValue(true);

    const response = await POST(post({ method: "PASSWORD", password: "right-password" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Use your authenticator app to confirm it's you.",
      code: "STEP_UP_METHOD_NOT_ALLOWED",
      methods: ["TOTP"],
    });
    expect(mocks.claimPasswordAttempt).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expectNothingMinted();
  });

  it("asks a person whose only factor is an emailed code for their password, not a code", async () => {
    mocks.member = memberRow("email");
    mocks.verifyStoredTotpCode.mockResolvedValue(true);

    const asCode = await POST(post({ method: "TOTP", code: "123456" }));
    expect(asCode.status).toBe(409);
    expect(await asCode.json()).toMatchObject({
      error: "Use your password to confirm it's you.",
      methods: ["PASSWORD"],
    });
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();

    mocks.compare.mockResolvedValue(true);
    const asPassword = await POST(post({ method: "PASSWORD", password: "right-password" }));
    expect(asPassword.status).toBe(200);
  });

  it("refuses step-up outright for an app enrolment missing its secret, never falling back to the password", async () => {
    mocks.member = { ...memberRow("app"), totpSecret: null };
    mocks.compare.mockResolvedValue(true);
    mocks.verifyStoredTotpCode.mockResolvedValue(true);

    for (const body of [
      { method: "PASSWORD", password: "right-password" },
      { method: "TOTP", code: "123456" },
    ]) {
      const response = await POST(post(body));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "STEP_UP_UNAVAILABLE", methods: [] });
    }
    expect(mocks.claimPasswordAttempt).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expect(mocks.member?.twoFactorFailedAttempts).toBe(0);
    expectNothingMinted();
  });

  it("counts every wrong app code towards the two-factor lockout, then refuses before checking", async () => {
    for (let attempt = 1; attempt < TWO_FACTOR_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const response = await POST(post({ method: "TOTP", code: "000000" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid code", lockedUntil: null });
      expect(mocks.member?.twoFactorFailedAttempts).toBe(attempt);
    }

    const locking = await POST(post({ method: "TOTP", code: "000000" }));
    expect(locking.status).toBe(400);
    const lockedUntil = (await locking.json()).lockedUntil as string;
    expect(new Date(lockedUntil).getTime()).toBe(Date.now() + 15 * 60 * 1000);

    // Locked: even the right code is not read, and nothing more is counted.
    mocks.verifyStoredTotpCode.mockClear();
    mocks.verifyStoredTotpCode.mockResolvedValue(true);
    const refused = await POST(post({ method: "TOTP", code: "123456" }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ lockedUntil });
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expectNothingMinted();
  });

  it("shares the lockout with sign-in: a member already locked at sign-in cannot step up", async () => {
    mocks.member = {
      ...memberRow("app"),
      twoFactorLockedUntil: new Date(Date.now() + 60 * 1000),
    };
    mocks.verifyStoredTotpCode.mockResolvedValue(true);

    const response = await POST(post({ method: "TOTP", code: "123456" }));

    expect(response.status).toBe(429);
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expectNothingMinted();
  });

  it("clears the failure count after a right app code, as a sign-in verification does", async () => {
    mocks.member = { ...memberRow("app"), twoFactorFailedAttempts: 3 };
    mocks.verifyStoredTotpCode.mockResolvedValue(true);

    expect((await POST(post({ method: "TOTP", code: "123456" }))).status).toBe(200);
    expect(mocks.member?.twoFactorFailedAttempts).toBe(0);
    expect(mocks.member?.twoFactorLockedUntil).toBeNull();
  });

  it("claims a password against the shared password budget on the stored email before comparing it", async () => {
    mocks.member = memberRow("none");

    const wrong = await POST(post({ method: "PASSWORD", password: "wrong" }));
    expect(wrong.status).toBe(400);
    expect(mocks.claimPasswordAttempt).toHaveBeenCalledWith(OFFICER_EMAIL);
    expect(mocks.claimPasswordAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.compare.mock.invocationCallOrder[0],
    );
    expect(mocks.compare).toHaveBeenCalledWith("wrong", "stored-bcrypt-hash");
    expect(mocks.clearPasswordAttempts).not.toHaveBeenCalled();
    expectNothingMinted();

    mocks.compare.mockResolvedValue(true);
    const right = await POST(post({ method: "PASSWORD", password: "right-password" }));
    expect(right.status).toBe(200);
    expect(mocks.clearPasswordAttempts).toHaveBeenCalledWith(OFFICER_EMAIL);
  });

  it("refuses a password while the account's budget is waiting, without comparing it", async () => {
    mocks.member = memberRow("none");
    mocks.claimPasswordAttempt.mockResolvedValue({ allowed: false });
    mocks.compare.mockResolvedValue(true);

    const response = await POST(post({ method: "PASSWORD", password: "right-password" }));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "LOGIN_THROTTLED" });
    expect(mocks.compare).not.toHaveBeenCalled();
    expectNothingMinted();
  });

  it("answers 500, not success, when the session did not come back refreshed", async () => {
    mocks.verifyStoredTotpCode.mockResolvedValue(true);
    mocks.updateSession.mockResolvedValue({ user: { id: "officer-1" } });

    const response = await POST(post({ method: "TOTP", code: "123456" }));

    expect(response.status).toBe(500);
  });

  it("passes the session guard's refusal through untouched", async () => {
    const refusal = NextResponse.json({ error: "Two-factor verification required" }, { status: 403 });
    mocks.requireActiveSession.mockResolvedValue({ ok: false, response: refusal });

    expect(await POST(post({ method: "TOTP", code: "123456" }))).toBe(refusal);
    expect(mocks.verifyStoredTotpCode).not.toHaveBeenCalled();
    expectNothingMinted();
  });

  it("is rate limited per address before the session is read", async () => {
    const limited = new Response("{}", { status: 429 });
    mocks.applyRateLimit.mockResolvedValue(limited);

    expect(await POST(post({ method: "TOTP", code: "123456" }))).toBe(limited);
    expect(mocks.requireActiveSession).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/reauth (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSession.mockResolvedValue({
      ok: true,
      session: { user: { id: "officer-1" } },
    });
  });

  it.each([
    ["app", ["TOTP"]],
    ["email", ["PASSWORD"]],
    ["none", ["PASSWORD"]],
  ] as const)("offers a member with factor %s %j", async (factor, methods) => {
    mocks.member = memberRow(factor);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ methods });
  });

  it("offers no method, and says why, for an app enrolment missing its secret", async () => {
    mocks.member = { ...memberRow("app"), totpSecret: null };
    const response = await GET();
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "STEP_UP_UNAVAILABLE", methods: [] });
  });
});
