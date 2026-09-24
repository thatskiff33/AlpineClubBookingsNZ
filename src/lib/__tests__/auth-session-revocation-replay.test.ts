import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A session that started before a member's login was switched off stays ended
 * after login is switched back on, however its cookie is replayed (#3603,
 * owner decision D1 on PR #3608).
 *
 * The session cookies are REAL Auth.js encrypted JWTs (`encode`/`decode` from
 * `next-auth/jwt`), and each request runs the app's own `authConfig` jwt and
 * session callbacks in the order the Auth.js session endpoint runs them:
 * decrypt the presented cookie, refresh it through `jwt`, project it through
 * `session`, and encrypt the refreshed token as the re-issued cookie. The
 * `next-auth` Next.js wrapper is stubbed because it cannot load outside Next.
 * The refusal must hold for the ORIGINAL cookie, not only for the one the
 * endpoint re-issues: a client keeps whatever copy it likes, so any refusal that
 * lives only inside the token is a refusal the client can undo. The revocation
 * time lives on the member row, which is what the database trigger stamps when
 * login goes from on to off; that trigger is proved against PostgreSQL by
 * `prisma/migration-verification/20261009010000_add_member_sessions_revoked_at.ts`.
 */

const { mockFindUnique, SECRET, COOKIE } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  SECRET: "test-secret-for-the-session-replay-proof-3603",
  COOKIE: "authjs.session-token",
}));

vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});
vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => SECRET),
  getAuthTrustHost: vi.fn(() => true),
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ twoFactor: false }),
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
vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return {
    default: vi.fn(() => ({
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: vi.fn(),
      unstable_update: vi.fn(),
    })),
    CredentialsSignin,
  };
});
vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => ({ id: "credentials", type: "credentials", ...config })),
}));
vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((config) => ({ id: "google", type: "oidc", ...config })),
}));

import { decode, encode } from "next-auth/jwt";
import { authConfig } from "@/lib/auth";

function memberRow(canLogin: boolean, sessionsRevokedAt: Date | null) {
  return {
    role: "ADMIN",
    canLogin,
    email: "admin@example.org",
    deletedAt: null,
    passwordHash: "not-a-real-hash",
    accessRoles: [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }],
    forcePasswordChange: false,
    emailVerified: true,
    passwordChangedAt: null,
    sessionsRevokedAt,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    postLoginLanding: null,
  };
}

async function sessionCookie(sessionIssuedAt: number) {
  return encode({
    token: {
      id: "admin-1",
      role: "ADMIN",
      accessRoles: ["ADMIN"],
      sessionIssuedAt,
      sessionInvalidated: false,
    },
    secret: SECRET,
    salt: COOKIE,
  });
}

type SessionUser = {
  sessionInvalidated?: boolean;
  accessRoles?: string[];
  canLogin?: boolean;
};

/**
 * One GET /api/auth/session carrying `cookie`, as the Auth.js session endpoint
 * serves it: the session it returns, and the cookie it re-issues.
 */
async function readSession(cookie: string) {
  const token = await decode({ token: cookie, secret: SECRET, salt: COOKIE });
  if (!token) return { user: null, reissued: null };
  const refreshed = await authConfig.callbacks.jwt?.({ token } as never);
  if (!refreshed) return { user: null, reissued: null };
  const session = await authConfig.callbacks.session?.({
    session: { user: {}, expires: "2099-01-01T00:00:00.000Z" },
    token: refreshed,
  } as never);
  const reissued = await encode({ token: refreshed, secret: SECRET, salt: COOKIE });
  return {
    user: ((session as { user?: SessionUser } | undefined)?.user ?? null) as SessionUser | null,
    reissued,
  };
}

describe("a session from before a login switch-off stays ended (#3603, D1)", () => {
  beforeEach(() => mockFindUnique.mockReset());

  it("refuses the original cookie and the re-issued one after login is switched back on", async () => {
    const issuedAt = Date.now() - 10 * 60_000;
    const original = await sessionCookie(issuedAt);
    const switchedOffAt = new Date(issuedAt + 60_000);

    // Live before the switch-off: the control that this cookie is a working one.
    mockFindUnique.mockResolvedValue(memberRow(true, null));
    const before = await readSession(original);
    expect(before.user?.sessionInvalidated).toBe(false);
    expect(before.user?.accessRoles).toEqual(["ADMIN"]);

    // Login switched off: the database stamps the revocation time.
    mockFindUnique.mockResolvedValue(memberRow(false, switchedOffAt));
    const disabled = await readSession(original);
    expect(disabled.user?.sessionInvalidated).toBe(true);
    expect(disabled.user?.accessRoles).toEqual([]);

    // Login switched back on. The revocation time stays on the row.
    mockFindUnique.mockResolvedValue(memberRow(true, switchedOffAt));
    const replayed = await readSession(original);
    expect(replayed.user?.sessionInvalidated).toBe(true);
    expect(disabled.reissued).not.toBeNull();
    const reissued = await readSession(disabled.reissued!);
    expect(reissued.user?.sessionInvalidated).toBe(true);
  });

  it("keeps a session that began after login was switched back on", async () => {
    const switchedOffAt = new Date(Date.now() - 10 * 60_000);
    const fresh = await sessionCookie(switchedOffAt.getTime() + 60_000);

    mockFindUnique.mockResolvedValue(memberRow(true, switchedOffAt));
    const session = await readSession(fresh);

    expect(session.user?.sessionInvalidated).toBe(false);
    expect(session.user?.accessRoles).toEqual(["ADMIN"]);
    expect(session.user?.canLogin).toBe(true);
  });
});
