/**
 * #4616 (INV-AUTH-008): the recent-authentication claim, end to end through
 * the route handler `auth.ts` exports, with the real `@auth/core`, real JWT
 * encryption and real CSRF checking, on the frozen clock — the harness
 * `auth-session-max-age.test.ts` uses, for the same reason: only a run through
 * the handler shows what a refresh, or a browser's `session.update()`, really
 * does to the token.
 *
 * What it proves:
 *  - sign-in stamps `lastAuthenticatedAt`; a refresh never moves it;
 *  - a fresh sign-in passes `requireRecentAuth`, and five minutes and one
 *    second later fails with the typed refusal;
 *  - a client's `session.update()` carrying the field is ignored;
 *  - only a consumed step-up challenge moves it, bound to the token's own
 *    member; a challenge the consume refuses (replayed, expired, another
 *    member's, made up) moves nothing;
 *  - a two-factor verification does not move it;
 *  - a token minted before #4616 is never back-filled.
 */
import { NextRequest } from "next/server";
import { decode, encode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";

const {
  mockFindUnique,
  mockLoadEffectiveModuleFlags,
  mockConsumeTwoFactorSessionChallenge,
  mockConsumeSessionReauthChallenge,
  mockRawAuth,
  TEST_SECRET,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockConsumeTwoFactorSessionChallenge: vi.fn(),
  mockConsumeSessionReauthChallenge: vi.fn(),
  mockRawAuth: vi.fn(),
  TEST_SECRET: "test-secret-for-4616-recent-auth",
}));

// `next-auth` itself does not load under Vitest; this is the few lines of it
// the handler path uses, over the real `@auth/core` (as in the #4611 suite).
// `auth` is the raw session read `requireRecentAuth` makes through `auth()`.
vi.mock("next-auth", async () => {
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const nextAuthDir = path.dirname(
    createRequire(import.meta.url).resolve("next-auth/package.json"),
  );
  const coreEntry = (file: string) =>
    pathToFileURL(path.join(nextAuthDir, "..", "@auth", "core", file)).href;
  const { Auth } = (await import(/* @vite-ignore */ coreEntry("index.js"))) as {
    Auth: (request: Request, config: unknown) => Promise<Response>;
  };
  const { CredentialsSignin } = (await import(
    /* @vite-ignore */ coreEntry("errors.js")
  )) as { CredentialsSignin: typeof Error };
  type ConfigFn = (request?: Request) => Promise<Record<string, unknown>>;
  return {
    default: (configFn: ConfigFn) => {
      const handler = async (request: Request) =>
        Auth(request, {
          ...(await configFn(request)),
          basePath: "/api/auth",
        } as never);
      return {
        handlers: { GET: handler, POST: handler },
        auth: mockRawAuth,
        signIn: vi.fn(),
        signOut: vi.fn(),
        unstable_update: vi.fn(),
      };
    },
    CredentialsSignin,
  };
});

vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique, "Member"),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      // No settings row: the 7-day maximum session age, far from these tests.
      loginSecuritySetting: { findUnique: vi.fn().mockResolvedValue(null) },
    },
  };
});

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => TEST_SECRET),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));

vi.mock("@/lib/two-factor", () => ({
  consumeTwoFactorSessionChallenge: mockConsumeTwoFactorSessionChallenge,
}));

vi.mock("@/lib/session-reauth-challenge", () => ({
  consumeSessionReauthChallenge: mockConsumeSessionReauthChallenge,
  createSessionReauthChallenge: vi.fn(),
}));

vi.mock("@/lib/google-config", () => ({
  getGoogleOAuthConfig: vi.fn().mockResolvedValue(null),
  recordGoogleVerified: vi.fn(),
}));

vi.mock("@/lib/google-oauth", () => ({
  resolveGoogleProfile: vi.fn(),
  readGoogleLinkIntent: vi.fn().mockResolvedValue(null),
  readGoogleVerifyIntent: vi.fn().mockResolvedValue(null),
  linkGoogleAccount: vi.fn(),
}));

import { authConfig, handlers } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import {
  RECENT_AUTH_REQUIRED_CODE,
  RECENT_AUTH_WINDOW_MS,
} from "@/lib/recent-auth-policy";

const SESSION_COOKIE = "authjs.session-token";
const CSRF_COOKIE = "authjs.csrf-token";
const MEMBER_ID = "member-officer";
const MINUTE_MS = 60 * 1000;

type SessionBody = {
  user?: {
    id?: string;
    lastAuthenticatedAt?: number;
    sessionIssuedAt?: number;
    sessionInvalidated?: boolean;
    twoFactorVerified?: boolean;
  };
} | null;

function memberRow({ twoFactorEnabled = false } = {}) {
  return {
    role: "USER",
    canLogin: true,
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "USER" }, { role: "ADMIN" }],
    email: "officer@example.test",
    deletedAt: null,
    passwordHash: "hash",
    forcePasswordChange: false,
    emailVerified: true,
    passwordChangedAt: null,
    sessionsRevokedAt: null,
    twoFactorEnabled,
    twoFactorMethod: twoFactorEnabled ? "TOTP" : null,
    postLoginLanding: null,
  };
}

const jwt = authConfig.callbacks.jwt as (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The token a completed sign-in leaves, from the real sign-in branch. */
async function signIn(): Promise<string> {
  const token = await jwt({
    token: {},
    user: {
      id: MEMBER_ID,
      role: "USER",
      forcePasswordChange: false,
      isEmailVerified: true,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    },
  });
  return encode({ token, secret: TEST_SECRET, salt: SESSION_COOKIE, maxAge: 60 * 60 });
}

async function readSession(response: Response) {
  const body = (await response.json()) as SessionBody;
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  const token = setCookie?.split(";")[0].slice(SESSION_COOKIE.length + 1) ?? "";
  const claims = token
    ? await decode({ token, secret: TEST_SECRET, salt: SESSION_COOKIE })
    : null;
  return { body, token, claims };
}

/** One `/api/auth/session` refresh, as the browser makes it. */
async function refresh(token: string) {
  return readSession(
    await handlers.GET(
      new NextRequest("http://localhost:3000/api/auth/session", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    ),
  );
}

/**
 * What a browser's `session.update(data)` sends: a CSRF-checked POST to
 * `/api/auth/session` — reachable by any signed-in client, with any payload.
 */
async function clientUpdate(token: string, data: unknown) {
  const csrfResponse = await handlers.GET(
    new NextRequest("http://localhost:3000/api/auth/csrf"),
  );
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
  const csrfCookie = csrfResponse.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))
    ?.split(";")[0];
  const response = await handlers.POST(
    new NextRequest("http://localhost:3000/api/auth/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${token}; ${csrfCookie}`,
      },
      body: JSON.stringify({ csrfToken, data }),
    }),
  );
  expect(response.status).toBe(200);
  return readSession(response);
}

/** `requireRecentAuth` answering for the session a refresh or update returned. */
async function recentAuthFor(body: SessionBody) {
  mockRawAuth.mockResolvedValue(body);
  const result = await requireRecentAuth();
  if (result.ok) return { ok: true as const };
  return {
    ok: false as const,
    status: result.response.status,
    body: (await result.response.json()) as { code?: string },
  };
}

function advanceMs(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe("the recent-authentication claim, end to end (#4616)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("NEXTAUTH_URL", undefined);
    mockFindUnique.mockReset();
    mockFindUnique.mockResolvedValue(memberRow());
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    mockConsumeTwoFactorSessionChallenge.mockReset();
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
    mockConsumeSessionReauthChallenge.mockReset();
    mockConsumeSessionReauthChallenge.mockResolvedValue(false);
    mockRawAuth.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps the instant sign-in completes, beside sessionIssuedAt", async () => {
    const signedInAt = Date.now();
    const { body, claims } = await refresh(await signIn());

    expect(claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect(claims?.sessionIssuedAt).toBe(signedInAt);
    expect(body?.user?.lastAuthenticatedAt).toBe(signedInAt);
  });

  it("passes a fresh sign-in, still at five minutes, and refuses it five minutes and one second later", async () => {
    const signedInAt = Date.now();
    let token = await signIn();

    let result = await refresh(token);
    expect(await recentAuthFor(result.body)).toEqual({ ok: true });

    advanceMs(RECENT_AUTH_WINDOW_MS);
    token = result.token;
    result = await refresh(token);
    expect(result.claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect(await recentAuthFor(result.body)).toEqual({ ok: true });

    advanceMs(1000);
    result = await refresh(result.token);
    // The refresh kept the session live and the stamp where sign-in put it.
    expect(result.body?.user?.sessionInvalidated).toBe(false);
    expect(result.claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect(await recentAuthFor(result.body)).toEqual({
      ok: false,
      status: 403,
      body: expect.objectContaining({ code: RECENT_AUTH_REQUIRED_CODE }),
    });
  });

  it("ignores a client's session.update() that carries lastAuthenticatedAt", async () => {
    const signedInAt = Date.now();
    const token = await signIn();
    advanceMs(10 * MINUTE_MS);

    const forged = await clientUpdate(token, {
      user: { lastAuthenticatedAt: Date.now() },
      lastAuthenticatedAt: Date.now(),
    });

    expect(forged.claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect(forged.body?.user?.lastAuthenticatedAt).toBe(signedInAt);
    expect((await recentAuthFor(forged.body)).ok).toBe(false);
  });

  it("refreshes the stamp when the update carries a challenge the consume accepts, for the token's own member", async () => {
    const token = await signIn();
    advanceMs(10 * MINUTE_MS);
    mockConsumeSessionReauthChallenge.mockResolvedValue(true);

    const updated = await clientUpdate(token, {
      // An id in the payload is never what the challenge is checked against.
      user: { id: "member-someone-else", reauthChallengeToken: "server-minted-token" },
    });

    expect(mockConsumeSessionReauthChallenge).toHaveBeenCalledTimes(1);
    expect(mockConsumeSessionReauthChallenge).toHaveBeenCalledWith(
      MEMBER_ID,
      "server-minted-token",
    );
    expect(updated.claims?.lastAuthenticatedAt).toBe(Date.now());
    expect(updated.body?.user?.id).toBe(MEMBER_ID);
    expect(await recentAuthFor(updated.body)).toEqual({ ok: true });
  });

  it("moves nothing when the consume refuses the challenge (replayed, expired, another member's or made up)", async () => {
    const signedInAt = Date.now();
    const token = await signIn();
    advanceMs(10 * MINUTE_MS);
    mockConsumeSessionReauthChallenge.mockResolvedValue(false);

    const updated = await clientUpdate(token, {
      user: { reauthChallengeToken: "replayed-or-forged" },
    });

    expect(mockConsumeSessionReauthChallenge).toHaveBeenCalledWith(MEMBER_ID, "replayed-or-forged");
    expect(updated.claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect((await recentAuthFor(updated.body)).ok).toBe(false);
  });

  it("never consumes a challenge from a non-string payload", async () => {
    const token = await signIn();
    advanceMs(10 * MINUTE_MS);
    mockConsumeSessionReauthChallenge.mockResolvedValue(true);

    await clientUpdate(token, { user: { reauthChallengeToken: { $ne: "" } } });

    expect(mockConsumeSessionReauthChallenge).not.toHaveBeenCalled();
  });

  it("does not move the stamp on a two-factor verification, which also takes emailed and recovery codes", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue(memberRow({ twoFactorEnabled: true }));
    const signedInAt = Date.now();
    const token = await signIn();
    advanceMs(10 * MINUTE_MS);
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(true);

    const verified = await clientUpdate(token, {
      user: { twoFactorChallengeToken: "two-factor-token" },
    });

    expect(verified.body?.user?.twoFactorVerified).toBe(true);
    expect(verified.claims?.lastAuthenticatedAt).toBe(signedInAt);
    expect((await recentAuthFor(verified.body)).ok).toBe(false);
  });

  it("never back-fills a stamp on a token minted before #4616", async () => {
    const legacy = await encode({
      token: { id: MEMBER_ID, role: "USER", sessionIssuedAt: Date.now(), sessionInvalidated: false },
      secret: TEST_SECRET,
      salt: SESSION_COOKIE,
      maxAge: 60 * 60,
    });

    const { body, claims } = await refresh(legacy);

    expect(body?.user?.sessionInvalidated).toBe(false);
    expect(claims).not.toHaveProperty("lastAuthenticatedAt");
    expect(body?.user).not.toHaveProperty("lastAuthenticatedAt");
    expect((await recentAuthFor(body)).ok).toBe(false);
  });
});
