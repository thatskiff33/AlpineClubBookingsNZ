/**
 * ALP-653 (`INV-MCP-005`): an AI app connection signs in through `auth()` with
 * the internal principal header, and the rules that end a browser session end
 * the connection too.
 *
 * `auth()` is the real one, with the real session refresh behind it; only the
 * database reads and the request headers are doubles. `next-auth` does not
 * load under Vitest, so it is replaced by a stub whose `auth` records whether
 * the cookie path was reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockMemberFindUnique,
  mockSettingsFindUnique,
  mockGrantFindUnique,
  mockLoadEffectiveModuleFlags,
  mockCookieAuth,
  requestHeaders,
  TEST_SECRET,
} = vi.hoisted(() => ({
  mockMemberFindUnique: vi.fn(),
  mockSettingsFindUnique: vi.fn(),
  mockGrantFindUnique: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockCookieAuth: vi.fn(),
  requestHeaders: new Map<string, string>(),
  // Built at run time so no secret-shaped literal sits in the file (.gitleaks.toml).
  TEST_SECRET: "s".repeat(40),
}));

vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: mockCookieAuth,
    signIn: vi.fn(),
    signOut: vi.fn(),
    unstable_update: vi.fn(),
  }),
  CredentialsSignin: class extends Error {},
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));

vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: { findUnique: honourSelect(mockMemberFindUnique, "Member") },
      loginSecuritySetting: {
        findUnique: honourSelect(mockSettingsFindUnique, "LoginSecuritySetting"),
      },
      mcpGrant: { findUnique: mockGrantFindUnique },
    },
  };
});

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => TEST_SECRET),
  requireAuthSecret: vi.fn(() => TEST_SECRET),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
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

import { auth } from "@/lib/auth";
import {
  MCP_PRINCIPAL_HEADER,
  MCP_PRINCIPAL_TTL_SECONDS,
  issueMcpPrincipal,
  verifyMcpPrincipal,
} from "@/lib/mcp/principal";

const HOUR_MS = 60 * 60 * 1000;

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    role: "USER",
    canLogin: true,
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "USER" }],
    email: "ada@example.test",
    deletedAt: null,
    passwordHash: "hash",
    forcePasswordChange: false,
    emailVerified: true,
    passwordChangedAt: null,
    sessionsRevokedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    postLoginLanding: null,
    webAuthnCredentials: [],
    ...overrides,
  };
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    memberId: "member-1",
    scope: "READ",
    status: "ACTIVE",
    sessionIssuedAt: new Date(Date.now() - HOUR_MS),
    twoFactorVerified: false,
    client: { id: "client-1", name: "Claude" },
    member: { email: "ada@example.test", firstName: "Ada", lastName: "Lovelace" },
    ...overrides,
  };
}

function presentPrincipal(value: string) {
  requestHeaders.set(MCP_PRINCIPAL_HEADER, value);
}

beforeEach(() => {
  requestHeaders.clear();
  mockMemberFindUnique.mockResolvedValue(memberRow());
  mockSettingsFindUnique.mockResolvedValue(null);
  mockGrantFindUnique.mockResolvedValue(grantRow());
  mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
  mockCookieAuth.mockResolvedValue(null);
});

describe("the principal header value", () => {
  it("names the connection it was signed for until it expires", () => {
    const now = Date.now();
    const { value } = issueMcpPrincipal("grant-1", now);

    expect(verifyMcpPrincipal(value, now)).toBe("grant-1");
    expect(verifyMcpPrincipal(value, now + (MCP_PRINCIPAL_TTL_SECONDS - 1) * 1000)).toBe("grant-1");
    expect(verifyMcpPrincipal(value, now + MCP_PRINCIPAL_TTL_SECONDS * 1000)).toBeNull();
  });

  it("refuses a value whose payload was swapped for another connection", () => {
    const now = Date.now();
    const [, signature] = issueMcpPrincipal("grant-1", now).value.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ g: "grant-2", exp: Math.floor(now / 1000) + 30 }),
    ).toString("base64url");

    expect(verifyMcpPrincipal(`${forgedPayload}.${signature}`, now)).toBeNull();
  });

  it("refuses a copied value once the call it was issued for has ended", () => {
    const now = Date.now();
    const first = issueMcpPrincipal("grant-1", now);
    const second = issueMcpPrincipal("grant-1", now);
    expect(first.value).not.toBe(second.value);

    first.release();

    expect(verifyMcpPrincipal(first.value, now)).toBeNull();
    // Another call for the same connection, still in flight, is untouched.
    expect(verifyMcpPrincipal(second.value, now)).toBe("grant-1");
  });

  it.each(["", "abc", "a.b.c", ".", "e30."])("refuses the malformed value %j", (value) => {
    expect(verifyMcpPrincipal(value, Date.now())).toBeNull();
  });
});

describe("auth() for a request carrying the principal header", () => {
  it("signs in as the connection's member with the member's current roles", async () => {
    mockMemberFindUnique.mockResolvedValue(
      memberRow({ accessRoles: [{ role: "USER" }, { role: "ADMIN" }] }),
    );
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    const session = await auth();

    expect(session?.user).toMatchObject({
      id: "member-1",
      email: "ada@example.test",
      name: "Ada Lovelace",
      canLogin: true,
      accessRoles: ["USER", "ADMIN"],
    });
    expect(mockGrantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "grant-1" } }),
    );
  });

  it("never carries a fresh sign-in proof", async () => {
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    const session = await auth();

    expect(session?.user.id).toBe("member-1");
    expect(session?.user.lastAuthenticatedAt).toBeUndefined();
  });

  it("carries the approving sign-in's two-factor result, not a new one", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockMemberFindUnique.mockResolvedValue(
      memberRow({ twoFactorEnabled: true, twoFactorMethod: "TOTP" }),
    );

    mockGrantFindUnique.mockResolvedValue(grantRow({ twoFactorVerified: false }));
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);
    expect((await auth())?.user.twoFactorVerified).toBe(false);

    mockGrantFindUnique.mockResolvedValue(grantRow({ twoFactorVerified: true }));
    expect((await auth())?.user.twoFactorVerified).toBe(true);
  });

  it.each(["REVOKED", "EXPIRED"])("is signed out once the connection is %s", async (status) => {
    mockGrantFindUnique.mockResolvedValue(grantRow({ status }));
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    expect(await auth()).toBeNull();
  });

  it("is signed out when the connection no longer exists", async () => {
    mockGrantFindUnique.mockResolvedValue(null);
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    expect(await auth()).toBeNull();
  });

  it("is signed out once the approving sign-in reaches the club's maximum session age", async () => {
    mockSettingsFindUnique.mockResolvedValue({ sessionMaxAgeHours: 8 });
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    mockGrantFindUnique.mockResolvedValue(
      grantRow({ sessionIssuedAt: new Date(Date.now() - 8 * HOUR_MS + 1000) }),
    );
    expect((await auth())?.user.id).toBe("member-1");

    mockGrantFindUnique.mockResolvedValue(
      grantRow({ sessionIssuedAt: new Date(Date.now() - 8 * HOUR_MS) }),
    );
    expect(await auth()).toBeNull();
  });

  it("is signed out when the member's login is switched off", async () => {
    mockMemberFindUnique.mockResolvedValue(memberRow({ canLogin: false }));
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    expect(await auth()).toBeNull();
  });

  it("is signed out when the member changed their password after approving", async () => {
    mockMemberFindUnique.mockResolvedValue(
      memberRow({ passwordChangedAt: new Date(Date.now() - 60_000) }),
    );
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    expect(await auth()).toBeNull();
  });

  it("is signed out when the member row is gone", async () => {
    mockMemberFindUnique.mockResolvedValue(null);
    presentPrincipal(issueMcpPrincipal("grant-1", Date.now()).value);

    expect(await auth()).toBeNull();
  });

  it("never falls back to the cookie when the header does not verify", async () => {
    mockCookieAuth.mockResolvedValue({ user: { id: "cookie-member" } });
    presentPrincipal("not-a-principal");

    expect(await auth()).toBeNull();
    expect(mockCookieAuth).not.toHaveBeenCalled();
    expect(mockGrantFindUnique).not.toHaveBeenCalled();
  });
});

describe("auth() without the principal header", () => {
  it("reads the cookie session exactly as before", async () => {
    mockCookieAuth.mockResolvedValue({ user: { id: "cookie-member" } });

    expect(await auth()).toEqual({ user: { id: "cookie-member" } });
    expect(mockGrantFindUnique).not.toHaveBeenCalled();
  });
});
