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

import { authConfig, buildRequestAuthConfig, handlers } from "@/lib/auth";
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

/**
 * The accounts this suite signs in, by their stored access-role rows. Only
 * `kiosk` and `lodge-route-kiosk` are the lodge kiosk account by the app's own
 * classification (`isLodgeKioskAccount`); the officers and the custom-role
 * holder merely also hold the `LODGE` checkbox, which must not buy them 30
 * days. `lodge-route-kiosk` is the shape `POST /api/admin/lodge` creates:
 * legacy `role: "LODGE"` and no access-role rows.
 */
const ACCOUNT_ROWS = {
  kiosk: [{ role: "LODGE" }],
  "lodge-route-kiosk": [],
  ordinary: [{ role: "USER" }],
  "admin-lodge": [{ role: "USER" }, { role: "ADMIN" }, { role: "LODGE" }],
  "bookings-officer-lodge": [
    { role: "USER" },
    { role: "ADMIN_BOOKINGS" },
    { role: "LODGE" },
  ],
  "custom-role-lodge": [
    { role: "USER" },
    {
      role: null,
      roleDefinitionId: "role-def-hut-warden",
      roleDefinition: {
        id: "role-def-hut-warden",
        key: "hut-warden",
        systemRole: null,
        label: "Hut warden",
        lodgeLevel: "EDIT",
      },
    },
    { role: "LODGE" },
  ],
} as const;
type Account = keyof typeof ACCOUNT_ROWS;
const KIOSK_ACCOUNTS: ReadonlySet<Account> = new Set([
  "kiosk",
  "lodge-route-kiosk",
]);

function memberRow(account: Account) {
  return {
    role: account === "lodge-route-kiosk" ? "LODGE" : "USER",
    canLogin: true,
    financeAccessLevel: "NONE",
    accessRoles: ACCOUNT_ROWS[account],
    email: `${account}@example.test`,
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

/**
 * A session token as the jwt callback leaves it after a refresh: the role
 * claim is the account's `LODGE`-bearing rows, and `kioskAccount` is what the
 * callback stamps — or absent, for a token minted before the claim existed.
 */
async function mintToken(
  account: Account,
  {
    cookieName = PLAIN_COOKIE,
    kioskAccount = KIOSK_ACCOUNTS.has(account),
  }: { cookieName?: string; kioskAccount?: boolean | null } = {},
): Promise<string> {
  return encode({
    token: {
      id: `member-${account}`,
      role: "MEMBER",
      accessRoles: (ACCOUNT_ROWS[account] as ReadonlyArray<{ role: string | null }>)
        .map((row) => row.role)
        .filter((role) => role !== null),
      canLogin: true,
      ...(kioskAccount === null ? {} : { kioskAccount }),
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
    ["the lodge kiosk account", "kiosk", 30 * DAY_S],
    [
      "the kiosk as the lodge route creates it (role LODGE, no rows)",
      "lodge-route-kiosk",
      30 * DAY_S,
    ],
    ["an ordinary account", "ordinary", 8 * HOUR_S],
  ] as const)(
    "re-issues %s's session for its idle window: token exp and cookie Expires agree",
    async (_label, account, idleSeconds) => {
      mockFindUnique.mockResolvedValue(memberRow(account));
      const nowMs = Date.now();

      const { body, reissuedToken, cookieExpiresMs } = await refresh(
        await mintToken(account),
      );

      expect(body?.user?.id).toBe(`member-${account}`);
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
    ["the lodge kiosk account", "kiosk", 30 * DAY_S],
    ["an ordinary account", "ordinary", 8 * HOUR_S],
  ] as const)(
    "%s stays signed in just inside its idle window and is signed out just past it",
    async (_label, account, idleSeconds) => {
      mockFindUnique.mockResolvedValue(memberRow(account));
      const first = await refresh(await mintToken(account));
      expect(first.body?.user).toBeDefined();
      const issuedAtMs = Date.now();

      // Left alone almost the whole window: the session is still live, and the
      // refresh slides a fresh window from now.
      advanceSeconds(idleSeconds - PAST_TOLERANCE_S);
      expect(Date.now() - first.cookieExpiresMs!).toBeLessThan(0);
      const stillLive = await refresh(first.reissuedToken);
      expect(stillLive.body?.user?.id).toBe(`member-${account}`);

      // Left alone past the window since that refresh: signed out.
      vi.setSystemTime(new Date(issuedAtMs));
      advanceSeconds(idleSeconds + PAST_TOLERANCE_S);
      expect(Date.now()).toBeGreaterThan(first.cookieExpiresMs!);
      const expired = await refresh(first.reissuedToken);
      expect(expired.body).toBeNull();
    },
  );

  it.each([
    ["a Full Admin who also holds LODGE", "admin-lodge"],
    ["a Booking Officer who also holds LODGE", "bookings-officer-lodge"],
    ["a custom-role holder who also holds LODGE", "custom-role-lodge"],
  ] as const)(
    "keeps %s on the ordinary window, refresh after refresh: holding LODGE is not being the kiosk",
    async (_label, account) => {
      mockFindUnique.mockResolvedValue(memberRow(account));
      const nowMs = Date.now();

      // A token minted before the kioskAccount claim existed, so the first
      // refresh stamps it from the row and the second one reads it back.
      const first = await refresh(
        await mintToken(account, { kioskAccount: null }),
      );
      expect(first.body?.user?.id).toBe(`member-${account}`);
      const second = await refresh(first.reissuedToken);
      expect(second.body?.user?.id).toBe(`member-${account}`);

      const claims = await decode({
        token: second.reissuedToken,
        secret: TEST_SECRET,
        salt: PLAIN_COOKIE,
      });
      // The role claim still carries LODGE: only the classification differs.
      expect(claims?.accessRoles).toContain("LODGE");
      expect(claims?.kioskAccount).toBe(false);
      expect(claims?.exp).toBe(Math.floor(nowMs / 1000) + 8 * HOUR_S);
      expect(second.cookieExpiresMs).toBe(
        Math.floor(nowMs / 1000) * 1000 + 8 * HOUR_S * 1000,
      );
    },
  );

  it("gives a token minted before the kioskAccount claim the ordinary window once, then stamps it so the kiosk gets 30 days", async () => {
    mockFindUnique.mockResolvedValue(memberRow("kiosk"));
    const nowMs = Date.now();

    const first = await refresh(await mintToken("kiosk", { kioskAccount: null }));
    expect(first.body?.user?.id).toBe("member-kiosk");
    expect(first.cookieExpiresMs).toBe(
      Math.floor(nowMs / 1000) * 1000 + 8 * HOUR_S * 1000,
    );

    const second = await refresh(first.reissuedToken);
    expect(second.cookieExpiresMs).toBe(
      Math.floor(nowMs / 1000) * 1000 + 30 * DAY_S * 1000,
    );
  });

  it("re-issues 8 hours on the very first refresh after the kiosk gains a second role, whatever its stale claim says", async () => {
    // The tablet's token was stamped kioskAccount: true while the record was
    // the kiosk; since then an officer has given it Full Admin.
    const staleToken = await mintToken("kiosk", { kioskAccount: true });
    mockFindUnique.mockResolvedValue({
      ...memberRow("kiosk"),
      accessRoles: [{ role: "LODGE" }, { role: "ADMIN" }],
    });
    const nowMs = Date.now();

    const first = await refresh(staleToken);

    expect(first.body?.user?.id).toBe("member-kiosk");
    const claims = await decode({
      token: first.reissuedToken,
      secret: TEST_SECRET,
      salt: PLAIN_COOKIE,
    });
    expect(claims?.accessRoles).toContain("ADMIN");
    expect(claims?.kioskAccount).toBe(false);
    expect(claims?.exp).toBe(Math.floor(nowMs / 1000) + 8 * HOUR_S);
    expect(first.cookieExpiresMs).toBe(
      Math.floor(nowMs / 1000) * 1000 + 8 * HOUR_S * 1000,
    );
  });
});

describe("the jwt callback stamps kioskAccount from the member row (#4612)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    mockFindUnique.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
  });

  async function refreshedClaims(
    row: ReturnType<typeof memberRow> | null,
    staleClaim: boolean,
  ) {
    mockFindUnique.mockResolvedValue(row);
    return (await authConfig.callbacks.jwt({
      // A stale claim on the incoming token must never survive the refresh.
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
        kioskAccount: staleClaim,
      },
    } as never)) as Record<string, unknown>;
  }

  it.each([
    ["the kiosk account", true, memberRow("kiosk")],
    [
      "the kiosk as the lodge route creates it (role LODGE, no rows)",
      true,
      memberRow("lodge-route-kiosk"),
    ],
    ["an ordinary account", false, memberRow("ordinary")],
    ["a Full Admin with LODGE", false, memberRow("admin-lodge")],
    ["a Booking Officer with LODGE", false, memberRow("bookings-officer-lodge")],
    ["a custom-role holder with LODGE", false, memberRow("custom-role-lodge")],
    [
      "LODGE with a finance access level",
      false,
      { ...memberRow("kiosk"), financeAccessLevel: "VIEWER" },
    ],
    [
      "the kiosk with login switched off",
      false,
      { ...memberRow("kiosk"), canLogin: false },
    ],
  ] as const)("stamps %s as kioskAccount %s", async (_label, expected, row) => {
    expect((await refreshedClaims(row, !expected)).kioskAccount).toBe(expected);
  });

  it("clears the claim when no live member resolves", async () => {
    const claims = await refreshedClaims(null, true);
    expect(claims.kioskAccount).toBe(false);
    expect(claims.sessionInvalidated).toBe(true);
  });
});

describe("buildRequestAuthConfig sets session.maxAge from the request's session (#4612)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("NEXTAUTH_URL", undefined);
    // A kiosk claim is confirmed against the member row before 30 days.
    mockFindUnique.mockReset();
    mockFindUnique.mockResolvedValue(memberRow("kiosk"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the kiosk window for a kiosk session cookie whose member row is still the kiosk", async () => {
    const config = await buildRequestAuthConfig(
      sessionRequest(await mintToken("kiosk")),
    );
    expect(config.session?.maxAge).toBe(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  // The token below is minted on the frozen clock; these stamps land after it.
  const afterSessionBegan = new Date(frozenTestNow().getTime() + 1000);

  it.each([
    ["the row is gone", null],
    [
      "the row now has a second role",
      {
        ...memberRow("kiosk"),
        accessRoles: [{ role: "LODGE" }, { role: "ADMIN_BOOKINGS" }],
      },
    ],
    ["the row's login is off", { ...memberRow("kiosk"), canLogin: false }],
    [
      "login was switched off and on again since the session began",
      { ...memberRow("kiosk"), sessionsRevokedAt: afterSessionBegan },
    ],
    [
      "the password changed since the session began",
      { ...memberRow("kiosk"), passwordChangedAt: afterSessionBegan },
    ],
    [
      "the account was deleted",
      { ...memberRow("kiosk"), deletedAt: afterSessionBegan },
    ],
  ] as const)(
    "gives a kiosk claim the ordinary window when %s",
    async (_label, row) => {
      mockFindUnique.mockResolvedValue(row);
      const config = await buildRequestAuthConfig(
        sessionRequest(await mintToken("kiosk")),
      );
      expect(config.session?.maxAge).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    },
  );

  it("gives a kiosk claim the ordinary window when the member read fails", async () => {
    mockFindUnique.mockRejectedValue(new Error("connection reset"));
    const config = await buildRequestAuthConfig(
      sessionRequest(await mintToken("kiosk")),
    );
    expect(config.session?.maxAge).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("reads the member row only for a kiosk claim", async () => {
    await buildRequestAuthConfig(sessionRequest(await mintToken("ordinary")));
    await buildRequestAuthConfig(
      sessionRequest(await mintToken("kiosk", { kioskAccount: null })),
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
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

  it("gives every other Auth.js action the ordinary window, so a sign-in over the kiosk cookie is not a 30-day session", async () => {
    const kioskCookie = `${PLAIN_COOKIE}=${await mintToken("kiosk")}`;
    for (const path of [
      "/api/auth/callback/credentials",
      "/api/auth/callback/magic-link",
      "/api/auth/callback/google",
      "/api/auth/signin/google",
      "/api/auth/signout",
      "/api/auth/csrf",
      "/api/auth/session/extra",
      "/api/other/session",
    ]) {
      const request = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { cookie: kioskCookie },
      });
      expect(
        (await buildRequestAuthConfig(request)).session?.maxAge,
        path,
      ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    }
  });

  it("finds the session action under AUTH_URL's base path, as next-auth does", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000/auth");
    const kioskCookie = `${PLAIN_COOKIE}=${await mintToken("kiosk")}`;
    const at = (path: string) =>
      new NextRequest(`http://localhost:3000${path}`, {
        headers: { cookie: kioskCookie },
      });
    expect((await buildRequestAuthConfig(at("/auth/session"))).session?.maxAge).toBe(
      KIOSK_ACCOUNT_SESSION_IDLE_SECONDS,
    );
    expect(
      (await buildRequestAuthConfig(at("/api/auth/session"))).session?.maxAge,
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("ignores a kiosk token sent as a Bearer header, which Auth.js's session read never uses", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/session", {
      headers: {
        cookie: `${PLAIN_COOKIE}=${await mintToken("ordinary")}`,
        authorization: `Bearer ${await mintToken("kiosk")}`,
      },
    });
    expect((await buildRequestAuthConfig(request)).session?.maxAge).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
  });

  it("reads the __Secure- cookie over https, as Auth.js does, and only that one", async () => {
    const secureKiosk = await mintToken("kiosk", { cookieName: SECURE_COOKIE });
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
        cookie: `${SECURE_COOKIE}=${await mintToken("kiosk", { cookieName: SECURE_COOKIE })}`,
      },
    });
    expect((await buildRequestAuthConfig(request)).session?.maxAge).toBe(
      KIOSK_ACCOUNT_SESSION_IDLE_SECONDS,
    );
  });
});

describe("sessionIdleSecondsForClaims (#4612)", () => {
  it("is 30 days only for an explicit kioskAccount claim, 8 hours otherwise", () => {
    expect(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS).toBe(30 * DAY_S);
    expect(ACCOUNT_SESSION_IDLE_SECONDS).toBe(8 * HOUR_S);
    expect(
      sessionIdleSecondsForClaims({
        accessRoles: ["LODGE"],
        canLogin: true,
        kioskAccount: true,
      }),
    ).toBe(KIOSK_ACCOUNT_SESSION_IDLE_SECONDS);
    expect(
      sessionIdleSecondsForClaims({
        accessRoles: ["USER"],
        canLogin: true,
        kioskAccount: false,
      }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it.each([
    ["ADMIN+LODGE", ["ADMIN", "LODGE"]],
    ["ADMIN_BOOKINGS+LODGE", ["ADMIN_BOOKINGS", "LODGE"]],
    ["a custom role+LODGE", ["USER", "LODGE"]],
  ])(
    "is 8 hours for %s, whose role claim carries LODGE but whose kioskAccount is false",
    (_label, accessRoles) => {
      expect(
        sessionIdleSecondsForClaims({
          accessRoles,
          canLogin: true,
          kioskAccount: false,
        }),
      ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    },
  );

  it("is 8 hours for a token with LODGE but no kioskAccount claim (minted before it existed)", () => {
    expect(
      sessionIdleSecondsForClaims({ accessRoles: ["LODGE"], canLogin: true }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });

  it("falls to the ordinary window for an invalidated, non-boolean or absent claim", () => {
    expect(
      sessionIdleSecondsForClaims({
        accessRoles: ["LODGE"],
        canLogin: true,
        kioskAccount: true,
        sessionInvalidated: true,
      }),
    ).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
    expect(sessionIdleSecondsForClaims({ kioskAccount: "true" })).toBe(
      ACCOUNT_SESSION_IDLE_SECONDS,
    );
    expect(sessionIdleSecondsForClaims(null)).toBe(ACCOUNT_SESSION_IDLE_SECONDS);
  });
});
