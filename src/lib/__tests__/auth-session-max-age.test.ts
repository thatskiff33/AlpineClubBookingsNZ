/**
 * #4611 (INV-AUTH-007): every signed-in session ends a fixed time after sign-in,
 * however active it is.
 *
 * Driven through the route handler `auth.ts` exports (`handlers.GET` on
 * `/api/auth/session`, the refresh the browser makes) with the real
 * `@auth/core` and real JWT encryption, on the frozen clock, exactly as
 * `auth-session-idle-expiry.test.ts` drives the idle window. That matters here
 * because each refresh re-encodes the token with a fresh `iat`: a cap measured
 * from `iat` would never end a session refreshed every hour, and only an
 * end-to-end run shows it.
 *
 * `next-auth` itself does not load under Vitest, so it is replaced by the few
 * lines of it this path uses (see the idle-expiry suite). Everything that
 * decides the cap — the `jwt` callback, the settings read, the JWT encode — is
 * the real code.
 */
import { NextRequest } from "next/server";
import { encode, decode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";

const {
  mockFindUnique,
  mockSettingsFindUnique,
  mockLoadEffectiveModuleFlags,
  mockConsumeTwoFactorSessionChallenge,
  TEST_SECRET,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockSettingsFindUnique: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockConsumeTwoFactorSessionChallenge: vi.fn(),
  TEST_SECRET: "test-secret-for-4611-session-max-age",
}));

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

// Both reads are projected through their real `select`, so a column the
// refresh stops selecting stops reaching the callback.
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique, "Member"),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      loginSecuritySetting: {
        findUnique: honourSelect(mockSettingsFindUnique, "LoginSecuritySetting"),
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
  consumeTwoFactorSessionChallenge: mockConsumeTwoFactorSessionChallenge,
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

const HOUR_MS = 60 * 60 * 1000;
const PLAIN_COOKIE = "authjs.session-token";

type Account = "ordinary" | "kiosk" | "officer";

const ACCESS_ROWS: Record<Account, Array<{ role: string }>> = {
  ordinary: [{ role: "USER" }],
  // The lodge kiosk account by the app's own classification (#4612).
  kiosk: [{ role: "LODGE" }],
  officer: [{ role: "USER" }, { role: "ADMIN" }],
};

function memberRow(account: Account) {
  return {
    role: "USER",
    canLogin: true,
    financeAccessLevel: "NONE",
    accessRoles: ACCESS_ROWS[account],
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

function setClubCapHours(hours: number | null) {
  mockSettingsFindUnique.mockResolvedValue(
    hours === null ? null : { sessionMaxAgeHours: hours },
  );
}

/**
 * The token a sign-in leaves: `sessionIssuedAt` stamped now, as the `jwt`
 * callback's sign-in branch stamps it. `sessionIssuedAt: null` mints a token
 * without the stamp.
 */
async function signedInToken(
  account: Account,
  { sessionIssuedAt = Date.now() }: { sessionIssuedAt?: number | null } = {},
): Promise<string> {
  return encode({
    token: {
      id: `member-${account}`,
      role: "USER",
      accessRoles: ACCESS_ROWS[account].map((row) => row.role),
      canLogin: true,
      kioskAccount: account === "kiosk",
      ...(sessionIssuedAt === null ? {} : { sessionIssuedAt }),
      sessionInvalidated: false,
    },
    secret: TEST_SECRET,
    salt: PLAIN_COOKIE,
    maxAge: 60,
  });
}

/** One `/api/auth/session` refresh, as the browser makes it. */
async function refresh(token: string) {
  const response = await handlers.GET(
    new NextRequest("http://localhost:3000/api/auth/session", {
      headers: { cookie: `${PLAIN_COOKIE}=${token}` },
    }),
  );
  const body = (await response.json()) as {
    user?: { id?: string; sessionInvalidated?: boolean; sessionIssuedAt?: number };
  } | null;
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${PLAIN_COOKIE}=`));
  const reissuedToken =
    setCookie?.split(";")[0].slice(PLAIN_COOKIE.length + 1) ?? "";
  const claims = reissuedToken
    ? await decode({ token: reissuedToken, secret: TEST_SECRET, salt: PLAIN_COOKIE })
    : null;
  return { body, reissuedToken, claims };
}

/**
 * Sign in and make the page's first refresh straight away, which re-issues the
 * cookie for the account's idle window (#4612); returns that token.
 */
async function signIn(account: Account): Promise<string> {
  const first = await refresh(await signedInToken(account));
  expect(isLive(first)).toBe(true);
  return first.reissuedToken;
}

/** Is this refresh's session live (what `auth()` would return non-null for)? */
function isLive(result: Awaited<ReturnType<typeof refresh>>): boolean {
  return (
    typeof result.body?.user?.id === "string" &&
    result.body.user.sessionInvalidated === false
  );
}

function advanceMs(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/**
 * Refresh the session every `stepHours` from sign-in, carrying each re-issued
 * token forward as the browser does, until it is no longer live. Returns the
 * session's age in hours at the first refresh that ended it, or `null` if it
 * was still live at `limitHours`.
 */
async function hoursUntilEnded(
  token: string,
  stepHours: number,
  limitHours: number,
): Promise<number | null> {
  let current = token;
  for (let age = stepHours; age <= limitHours; age += stepHours) {
    advanceMs(stepHours * HOUR_MS);
    const result = await refresh(current);
    if (!isLive(result)) return age;
    current = result.reissuedToken;
  }
  return null;
}

describe("the maximum session age, end to end through the Auth.js handler (#4611)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    vi.stubEnv("AUTH_URL", undefined);
    vi.stubEnv("NEXTAUTH_URL", undefined);
    mockFindUnique.mockReset();
    mockSettingsFindUnique.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    mockConsumeTwoFactorSessionChallenge.mockReset();
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ends a session refreshed every hour at the 7-day default, and the refresh an hour before is live", async () => {
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    setClubCapHours(null); // an unconfigured club: no settings row

    expect(await hoursUntilEnded(await signIn("ordinary"), 1, 24 * 8)).toBe(
      168,
    );
  });

  it.each([[8], [24], [720]])(
    "ends a session refreshed every hour at a configured %i-hour cap",
    async (capHours) => {
      mockFindUnique.mockResolvedValue(memberRow("officer"));
      setClubCapHours(capHours);

      expect(
        await hoursUntilEnded(await signIn("officer"), 1, capHours + 2),
      ).toBe(capHours);
    },
  );

  it("never moves sessionIssuedAt on a refresh, though iat moves every time", async () => {
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    setClubCapHours(24);
    const signedInAt = Date.now();

    let token = await signIn("ordinary");
    let lastIat = -1;
    for (let hour = 1; hour < 24; hour += 1) {
      advanceMs(HOUR_MS);
      const result = await refresh(token);
      expect(isLive(result)).toBe(true);
      expect(result.claims?.sessionIssuedAt).toBe(signedInAt);
      expect(result.body?.user?.sessionIssuedAt).toBe(signedInAt);
      expect(result.claims?.iat).toBeGreaterThan(lastIat);
      lastIat = result.claims?.iat as number;
      token = result.reissuedToken;
    }
  });

  it("applies a changed setting to an existing session on its next refresh", async () => {
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    setClubCapHours(168);
    let token = await signIn("ordinary");

    advanceMs(5 * HOUR_MS);
    const live = await refresh(token);
    expect(isLive(live)).toBe(true);
    token = live.reissuedToken;

    advanceMs(4 * HOUR_MS); // 9 hours since sign-in
    setClubCapHours(8);
    const ended = await refresh(token);
    expect(isLive(ended)).toBe(false);
    expect(ended.claims?.sessionInvalidated).toBe(true);

    // Raising it again does not revive the ended session.
    setClubCapHours(720);
    advanceMs(HOUR_MS);
    expect(isLive(await refresh(ended.reissuedToken))).toBe(false);
  });

  it("keeps the kiosk on its own 30 days under an 8-hour club cap, and ends it at 30 days", async () => {
    mockFindUnique.mockResolvedValue(memberRow("kiosk"));
    setClubCapHours(8);

    expect(await hoursUntilEnded(await signIn("kiosk"), 6, 24 * 31)).toBe(
      720,
    );
  });

  it("ends the kiosk at its own 30 days under the longest club cap too", async () => {
    mockFindUnique.mockResolvedValue(memberRow("kiosk"));
    setClubCapHours(720);
    expect(await hoursUntilEnded(await signIn("kiosk"), 6, 24 * 31)).toBe(
      720,
    );
  });

  it("puts an account that stops being the kiosk under the club cap on its next refresh", async () => {
    mockFindUnique.mockResolvedValue(memberRow("kiosk"));
    setClubCapHours(8);
    let token = await signIn("kiosk");

    advanceMs(12 * HOUR_MS);
    const live = await refresh(token);
    expect(isLive(live)).toBe(true);
    token = live.reissuedToken;

    // An officer gives the kiosk record a second role: it is no longer the
    // kiosk, so the club's 8 hours apply, counted from the original sign-in.
    mockFindUnique.mockResolvedValue({
      ...memberRow("kiosk"),
      accessRoles: [{ role: "LODGE" }, { role: "ADMIN" }],
    });
    advanceMs(HOUR_MS);
    expect(isLive(await refresh(token))).toBe(false);
  });

  it("treats a token without sessionIssuedAt as expired, and the back-filled stamp never revives it", async () => {
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    setClubCapHours(720);

    const first = await refresh(
      await signedInToken("ordinary", { sessionIssuedAt: null }),
    );
    expect(first.body?.user?.id).toBe("member-ordinary");
    expect(isLive(first)).toBe(false);
    expect(first.claims?.sessionInvalidated).toBe(true);

    advanceMs(HOUR_MS);
    expect(isLive(await refresh(first.reissuedToken))).toBe(false);
  });
});

describe("nothing in the jwt callback extends the maximum session age (#4611)", () => {
  beforeEach(() => {
    vi.setSystemTime(frozenTestNow());
    mockFindUnique.mockReset();
    mockSettingsFindUnique.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockConsumeTwoFactorSessionChallenge.mockReset();
  });

  const jwt = authConfig.callbacks.jwt as unknown as (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  it("a two-factor verification through the update trigger keeps the sign-in time and still ends at the cap", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue({
      ...memberRow("officer"),
      twoFactorEnabled: true,
      twoFactorMethod: "TOTP",
    });
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(true);
    setClubCapHours(8);
    const signedInAt = Date.now();

    const token = {
      id: "member-officer",
      sessionIssuedAt: signedInAt,
      sessionInvalidated: false,
      iat: Math.floor(signedInAt / 1000),
    };
    advanceMs(8 * HOUR_MS - 1);
    const verified = await jwt({
      token: { ...token },
      trigger: "update",
      session: { user: { twoFactorChallengeToken: "challenge" } },
    });
    expect(verified.twoFactorVerified).toBe(true);
    expect(verified.sessionIssuedAt).toBe(signedInAt);
    expect(verified.sessionInvalidated).toBe(false);

    advanceMs(1);
    const ended = await jwt({
      token: { ...verified, iat: Math.floor(Date.now() / 1000) },
      trigger: "update",
      session: { user: { twoFactorChallengeToken: "challenge-2" } },
    });
    expect(ended.sessionIssuedAt).toBe(signedInAt);
    expect(ended.sessionInvalidated).toBe(true);
  });

  it("a role change keeps the sign-in time", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    setClubCapHours(8);
    const signedInAt = Date.now();
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    advanceMs(7 * HOUR_MS);
    const before = await jwt({
      token: { id: "member-ordinary", sessionIssuedAt: signedInAt },
    });
    expect(before.sessionInvalidated).toBe(false);

    mockFindUnique.mockResolvedValue(memberRow("officer"));
    advanceMs(HOUR_MS);
    const after = await jwt({ token: { ...before } });
    expect(after.accessRoles).toContain("ADMIN");
    expect(after.sessionIssuedAt).toBe(signedInAt);
    expect(after.sessionInvalidated).toBe(true);
  });

  it("only a new sign-in starts a new clock", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    setClubCapHours(8);
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    advanceMs(30 * HOUR_MS);
    const signedIn = await jwt({
      // The old, expired token the browser still holds is replaced by the
      // sign-in's user.
      token: { sessionIssuedAt: frozenTestNow().getTime(), sessionInvalidated: true },
      user: {
        id: "member-ordinary",
        role: "USER",
        forcePasswordChange: false,
        isEmailVerified: true,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      },
    });
    expect(signedIn.sessionIssuedAt).toBe(Date.now());
    expect(signedIn.sessionInvalidated).toBe(false);
  });

  it("fails the refresh closed on a failed settings read, never extending the session", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    mockFindUnique.mockResolvedValue(memberRow("ordinary"));
    mockSettingsFindUnique.mockRejectedValue(new Error("connection reset"));
    await expect(
      jwt({ token: { id: "member-ordinary", sessionIssuedAt: Date.now() } }),
    ).rejects.toThrow("connection reset");
  });
});
