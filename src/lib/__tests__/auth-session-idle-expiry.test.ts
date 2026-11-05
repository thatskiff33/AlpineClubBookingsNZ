/**
 * #4612: the lodge kiosk account's session really does last 30 days without
 * use, and every other account's still lasts 8 hours.
 *
 * Driven through the route handler `auth.ts` exports (`handlers.GET` on
 * `/api/auth/session`, the refresh the kiosk page's `SessionProvider` makes)
 * with the real `@auth/core` and real JWT encryption, on the frozen clock. That
 * is the point: the removed line set a 30-day `exp` in the `jwt` callback and
 * Auth.js silently re-encoded it with the 8-hour default, so only an
 * end-to-end run shows the expiry that actually applies — both the re-issued
 * token's `exp` and the cookie's `Expires`.
 *
 * `next-auth` itself does not load under Vitest (its ESM imports `next/server`
 * without an extension), so it is replaced by the few lines of it this path
 * uses: a route handler that builds the per-request config from the request
 * and hands both to `@auth/core`'s `Auth`, under the `/api/auth` base path.
 * Everything that decides the expiry — `buildRequestAuthConfig`, the callbacks,
 * the JWT encode and the cookie — is the real code.
 */
import { NextRequest } from "next/server";
import { encode, decode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";

const { mockFindUnique, mockLoadEffectiveModuleFlags, TEST_SECRET } =
  vi.hoisted(() => ({
    mockFindUnique: vi.fn(),
    mockLoadEffectiveModuleFlags: vi.fn(),
    TEST_SECRET: "test-secret-for-4612-session-idle-expiry",
  }));

// next-auth's route-handler wrapper, reduced to what this path does with it.
// `@auth/core` is next-auth's own dependency, not the app's, so it is loaded
// from beside next-auth: the exact copy production runs.
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
        auth: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
        unstable_update: vi.fn(),
      };
    },
    CredentialsSignin,
  };
});

// The refresh's member read is projected through its real `select`.
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique, "Member"),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
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
  consumeTwoFactorSessionChallenge: vi.fn().mockResolvedValue(false),
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

import { buildRequestAuthConfig, handlers } from "@/lib/auth";
import {
  ACCOUNT_SESSION_IDLE_SECONDS,
  KIOSK_ACCOUNT_SESSION_IDLE_SECONDS,
  sessionIdleSecondsForClaims,
} from "@/lib/session-idle-expiry";

const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;
// jose accepts a token up to 15 s past `exp` (Auth.js's clockTolerance).
const PAST_TOLERANCE_S = 60;

const PLAIN_COOKIE = "authjs.session-token";
const SECURE_COOKIE = "__Secure-authjs.session-token";

function memberRow(accessRole: "LODGE" | "USER") {
  return {
    role: "MEMBER",
    canLogin: true,
    accessRoles: [{ role: accessRole }],
    email: `${accessRole.toLowerCase()}@example.test`,
    deletedAt: null,
    passwordHash: "hash",
    forcePasswordChange: false,
    emailVerified: true,
    passwordChangedAt: null,
    sessionsRevokedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    postLoginLanding: null,
  };
}

/** A session token as the jwt callback leaves it after a refresh. */
async function mintToken(
  accessRole: "LODGE" | "USER",
  cookieName = PLAIN_COOKIE,
): Promise<string> {
  return encode({
    token: {
      id: `member-${accessRole}`,
      role: "MEMBER",
      accessRoles: [accessRole],
      canLogin: true,
      sessionIssuedAt: Date.now(),
      sessionInvalidated: false,
    },
    secret: TEST_SECRET,
    salt: cookieName,
    // A minute is enough to reach the refresh; the refresh decides the rest.
    maxAge: 60,
  });
}

function sessionRequest(token: string, origin = "http://localhost:3000") {
  return new NextRequest(`${origin}/api/auth/session`, {
    headers: { cookie: `${PLAIN_COOKIE}=${token}` },
  });
}

/** One `/api/auth/session` refresh, as the browser makes it. */
async function refresh(token: string) {
  const response = await handlers.GET(sessionRequest(token));
  const body = (await response.json()) as { user?: { id?: string } } | null;
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${PLAIN_COOKIE}=`));
  const value = setCookie?.split(";")[0].slice(PLAIN_COOKIE.length + 1) ?? "";
  const expiresAttr = setCookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("expires="));
  return {
    body,
    reissuedToken: value,
    cookieExpiresMs: expiresAttr
      ? new Date(expiresAttr.slice("expires=".length)).getTime()
      : null,
  };
}

function advanceSeconds(seconds: number) {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

describe("session idle expiry, end to end through the Auth.js handler (#4612)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("NEXTAUTH_URL", undefined);
    mockFindUnique.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["the lodge kiosk account", "LODGE", 30 * DAY_S],
    ["an ordinary account", "USER", 8 * HOUR_S],
  ] as const)(
    "re-issues %s's session for its idle window: token exp and cookie Expires agree",
    async (_label, accessRole, idleSeconds) => {
      mockFindUnique.mockResolvedValue(memberRow(accessRole));
      const nowMs = Date.now();

      const { body, reissuedToken, cookieExpiresMs } = await refresh(
        await mintToken(accessRole),
      );

      expect(body?.user?.id).toBe(`member-${accessRole}`);
      const claims = await decode({
        token: reissuedToken,
        secret: TEST_SECRET,
        salt: PLAIN_COOKIE,
      });
      expect(claims?.exp).toBe(Math.floor(nowMs / 1000) + idleSeconds);
      // HTTP dates carry whole seconds.
      expect(cookieExpiresMs).toBe(
        Math.floor(nowMs / 1000) * 1000 + idleSeconds * 1000,
      );
    },
  );

  it.each([
    ["the lodge kiosk account", "LODGE", 30 * DAY_S],
    ["an ordinary account", "USER", 8 * HOUR_S],
  ] as const)(
    "%s stays signed in just inside its idle window and is signed out just past it",
    async (_label, accessRole, idleSeconds) => {
      mockFindUnique.mockResolvedValue(memberRow(accessRole));
      const first = await refresh(await mintToken(accessRole));
      expect(first.body?.user).toBeDefined();
      const issuedAtMs = Date.now();

      // Left alone almost the whole window: the session is still live, and the
      // refresh slides a fresh window from now.
      advanceSeconds(idleSeconds - PAST_TOLERANCE_S);
      expect(Date.now() - first.cookieExpiresMs!).toBeLessThan(0);
      const stillLive = await refresh(first.reissuedToken);
      expect(stillLive.body?.user?.id).toBe(`member-${accessRole}`);

      // Left alone past the window since that refresh: signed out.
      vi.setSystemTime(new Date(issuedAtMs));
      advanceSeconds(idleSeconds + PAST_TOLERANCE_S);
      expect(Date.now()).toBeGreaterThan(first.cookieExpiresMs!);
      const expired = await refresh(first.reissuedToken);
      expect(expired.body).toBeNull();
    },
  );
});

describe("buildRequestAuthConfig sets session.maxAge from the request's session (#4612)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("NEXTAUTH_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the kiosk window for a kiosk session cookie", async () => {
    const config = await buildRequestAuthConfig(
      sessionRequest(await mintToken("LODGE")),
    );
    expect(config.session?.maxAge).toBe(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("uses the ordinary window with no request, no cookie, or an unreadable cookie", async () => {
    expect((await buildRequestAuthConfig()).session?.maxAge).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
    expect(
      (
        await buildRequestAuthConfig(
          new NextRequest("http://localhost:3000/api/auth/session"),
        )
      ).session?.maxAge,
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    expect(
      (await buildRequestAuthConfig(sessionRequest("not-a-jwt"))).session
        ?.maxAge,
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("ignores a kiosk token sent as a Bearer header, which Auth.js's session read never uses", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/session", {
      headers: {
        cookie: `${PLAIN_COOKIE}=${await mintToken("USER")}`,
        authorization: `Bearer ${await mintToken("LODGE")}`,
      },
    });
    expect((await buildRequestAuthConfig(request)).session?.maxAge).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
  });

  it("reads the __Secure- cookie over https, as Auth.js does, and only that one", async () => {
    const secureKiosk = await mintToken("LODGE", SECURE_COOKIE);
    const https = new NextRequest("https://club.example/api/auth/session", {
      headers: { cookie: `${SECURE_COOKIE}=${secureKiosk}` },
    });
    expect((await buildRequestAuthConfig(https)).session?.maxAge).toBe(
      KIOSK_ACCOUNT_SESSION_IDLE_SECONDS,
    );

    // The same secure cookie on a plain-http request is not the cookie
    // Auth.js reads there, so it decides nothing.
    const http = new NextRequest("http://club.example/api/auth/session", {
      headers: { cookie: `${SECURE_COOKIE}=${secureKiosk}` },
    });
    expect((await buildRequestAuthConfig(http)).session?.maxAge).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
  });

  it("follows AUTH_URL's protocol when it is set, as next-auth's handlers do", async () => {
    vi.stubEnv("AUTH_URL", "https://club.example");
    const request = new NextRequest("http://internal:3000/api/auth/session", {
      headers: {
        cookie: `${SECURE_COOKIE}=${await mintToken("LODGE", SECURE_COOKIE)}`,
      },
    });
    expect((await buildRequestAuthConfig(request)).session?.maxAge).toBe(
      KIOSK_ACCOUNT_SESSION_IDLE_SECONDS,
    );
  });
});

describe("sessionIdleSecondsForClaims (#4612)", () => {
  it("is 30 days for the kiosk role and 8 hours otherwise", () => {
    expect(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS).toBe(30 * DAY_S);
    expect(ACCOUNT_SESSION_IDLE_SECONDS).toBe(8 * HOUR_S);
    expect(
      sessionIdleSecondsForClaims({ accessRoles: ["LODGE"], canLogin: true }),
    ).toBe(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS);
    expect(
      sessionIdleSecondsForClaims({ accessRoles: ["USER"], canLogin: true }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    expect(
      sessionIdleSecondsForClaims({ accessRoles: ["ADMIN"], canLogin: true }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("falls to the ordinary window for an invalidated, login-off or absent session", () => {
    expect(
      sessionIdleSecondsForClaims({
        accessRoles: ["LODGE"],
        canLogin: true,
        sessionInvalidated: true,
      }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    expect(
      sessionIdleSecondsForClaims({ accessRoles: ["LODGE"], canLogin: false }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    expect(sessionIdleSecondsForClaims({ accessRoles: ["LODGE"] })).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
    expect(sessionIdleSecondsForClaims(null)).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });
});
