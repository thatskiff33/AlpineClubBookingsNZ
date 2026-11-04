import { beforeEach, describe, expect, it, vi } from "vitest";

// Google OAuth wiring in authConfig (#2035): the signIn callback gates + routes
// every Google round-trip (login vs profile-initiated link), applies the fresh
// module kill-switch, refuses unlinked/ineligible members with friendly redirects,
// and NEVER provisions. The provider profile() delegates to the sub-only resolver.
const {
  mockResolveGoogleProfile,
  mockReadGoogleLinkIntent,
  mockReadGoogleVerifyIntent,
  mockLinkGoogleAccount,
  mockLoadEffectiveModuleFlags,
  mockGetGoogleOAuthConfig,
  mockRecordGoogleVerified,
  mockMemberUpdate,
  mockNextAuthAuth,
  mockNextAuth,
} = vi.hoisted(() => {
  // nextAuth.auth() — what the module-local auth() wrapper delegates to; the
  // signIn link + verify branches read the CURRENT session through it.
  const mockNextAuthAuth = vi.fn();
  return {
    mockResolveGoogleProfile: vi.fn(),
    mockReadGoogleLinkIntent: vi.fn(),
    mockReadGoogleVerifyIntent: vi.fn(),
    mockLinkGoogleAccount: vi.fn(),
    mockLoadEffectiveModuleFlags: vi.fn(),
    mockGetGoogleOAuthConfig: vi.fn(),
    mockRecordGoogleVerified: vi.fn(),
    mockMemberUpdate: vi.fn(),
    mockNextAuthAuth,
    mockNextAuth: vi.fn(() => ({
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: mockNextAuthAuth,
      unstable_update: vi.fn(),
    })),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: mockMemberUpdate,
    },
  },
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  requireAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => config),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((config) => ({ id: "google", type: "oidc", ...config })),
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true) },
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return { default: mockNextAuth, CredentialsSignin };
});

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));

vi.mock("@/lib/two-factor", () => ({
  consumeTwoFactorSessionChallenge: vi.fn(),
}));

vi.mock("@/lib/google-oauth", () => ({
  resolveGoogleProfile: mockResolveGoogleProfile,
  readGoogleLinkIntent: mockReadGoogleLinkIntent,
  readGoogleVerifyIntent: mockReadGoogleVerifyIntent,
  linkGoogleAccount: mockLinkGoogleAccount,
}));

vi.mock("@/lib/google-config", () => ({
  getGoogleOAuthConfig: mockGetGoogleOAuthConfig,
  recordGoogleVerified: mockRecordGoogleVerified,
}));

import { authConfig, buildRequestAuthConfig } from "@/lib/auth";

type SignIn = (params: {
  user?: unknown;
  account?: unknown;
  profile?: unknown;
}) => Promise<boolean | string>;

const signIn = authConfig.callbacks!.signIn as unknown as SignIn;

const googleAccount = { provider: "google" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: true });
  mockReadGoogleLinkIntent.mockResolvedValue(null);
  // Default: no verify round-trip in progress (login/link cases). Verify cases
  // override this.
  mockReadGoogleVerifyIntent.mockResolvedValue(null);
  mockMemberUpdate.mockResolvedValue({});
  // Default: the current session belongs to the member the intent names (the
  // legitimate link flow). Negative cases override this.
  mockNextAuthAuth.mockResolvedValue({ user: { id: "member-1" } });
});

describe("authConfig Google provider wiring", () => {
  it("registers Google as providers[2] with a profile() delegating to the resolver", async () => {
    const provider = authConfig.providers[2] as unknown as {
      id: string;
      profile: (p: unknown) => Promise<unknown>;
    };
    expect(provider.id).toBe("google");

    mockResolveGoogleProfile.mockResolvedValue({ id: "member-1", googleLoginStatus: "ok" });
    const result = await provider.profile({ sub: "s", email: "e" });
    expect(mockResolveGoogleProfile).toHaveBeenCalledWith({ sub: "s", email: "e" });
    expect(result).toEqual({ id: "member-1", googleLoginStatus: "ok" });
  });
});

describe("buildRequestAuthConfig — per-request provider list (#2087)", () => {
  function providerIds(providers: unknown[]): unknown[] {
    return providers.map((p) => (p as { id?: unknown }).id);
  }

  it("OMITS Google when the resolver returns null (unconfigured)", async () => {
    mockGetGoogleOAuthConfig.mockResolvedValue(null);
    const config = await buildRequestAuthConfig();
    expect(config.providers).toHaveLength(2);
    expect(providerIds(config.providers)).not.toContain("google");
  });

  it("APPENDS the Google provider when credentials resolve", async () => {
    mockGetGoogleOAuthConfig.mockResolvedValue({
      clientId: "cid",
      clientSecret: "csecret",
    });
    const config = await buildRequestAuthConfig();
    expect(config.providers).toHaveLength(3);
    const google = config.providers[2] as unknown as {
      id: string;
      clientId?: string;
    };
    expect(google.id).toBe("google");
    expect(google.clientId).toBe("cid");
  });

  it("FAILS OPEN: a throwing resolver still yields the base providers (no throw)", async () => {
    // The acceptance test (#2087): credentials/magic-link sign-in must survive a
    // DB/decrypt failure in the shared config — the config resolves, Google is
    // simply absent, and nothing throws.
    mockGetGoogleOAuthConfig.mockRejectedValue(new Error("db down"));
    const config = await buildRequestAuthConfig();
    expect(config.providers).toHaveLength(2);
    expect(providerIds(config.providers)).not.toContain("google");
    // Pin the SURVIVORS by identity, not just count: the magic-link Credentials
    // provider (and the un-ided password Credentials provider) must both remain,
    // so an identity-based base-provider derivation can never drop one.
    expect(providerIds(config.providers)).toContain("magic-link");
    expect(config.callbacks).toBe(authConfig.callbacks);
  });

  it("derives the base providers by IDENTITY, not position (regression #2087)", async () => {
    // A positional slice(0, 2) would silently drop magic-link if any provider
    // were ever inserted before Google. The identity filter (drop the `google`
    // provider) keeps every non-Google provider regardless of order.
    mockGetGoogleOAuthConfig.mockResolvedValue(null);
    const config = await buildRequestAuthConfig();
    const ids = providerIds(config.providers);
    expect(ids).not.toContain("google");
    expect(ids).toContain("magic-link");
  });
});

describe("signIn callback — non-Google", () => {
  it("allows credentials/magic-link untouched", async () => {
    expect(await signIn({ account: { provider: "credentials" } })).toBe(true);
    expect(await signIn({ account: { provider: "magic-link" } })).toBe(true);
    expect(mockLoadEffectiveModuleFlags).not.toHaveBeenCalled();
  });
});

describe("signIn callback — module kill-switch", () => {
  it("refuses a Google LOGIN when the module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    const result = await signIn({
      user: { id: "member-1", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_disabled");
    // Even a fully-eligible linked member is refused → no session, no login bump.
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a LINK round-trip when the module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    const result = await signIn({
      account: googleAccount,
      profile: { sub: "s", email_verified: true },
    });
    expect(result).toBe("/profile?googleError=disabled#security");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });
});

describe("signIn callback — LOGIN path (sub-only)", () => {
  it("allows an eligible member and records the login timestamp", async () => {
    const result = await signIn({
      user: { id: "member-1", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe(true);
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it("refuses an unlinked account (email-match takeover regression) with a friendly redirect", async () => {
    const result = await signIn({
      user: { id: "google-oauth:s", googleLoginStatus: "unlinked" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_unlinked");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a forcePasswordChange member", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "password_change" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_password_change");
  });

  it("refuses an archived/dependent member with the generic refused message", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "refused" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_refused");
  });

  it("refuses when the profile carries no sub", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "failed" },
      account: googleAccount,
      profile: {},
    });
    expect(result).toBe("/login?error=google_failed");
  });

  it("refuses a 'failed' status (resolver fail-closed) with the couldn't-complete redirect (#2229)", async () => {
    // The resolver/profile() boundary failed closed to the sentinel WITH a sub
    // present, so this reaches the status switch (not the early no-sub guard).
    // It must map to google_failed, not the generic google_refused.
    const result = await signIn({
      user: { id: "google-oauth:s", googleLoginStatus: "failed" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_failed");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("REFUSES the sign-in when the lastLoginAt bump hits P2025 — a dangling session id (#2229)", async () => {
    // Production incident: the id we were about to mint a session for matched NO
    // member row (a fallback-user substitution). A P2025 on the login-timestamp
    // update is proof of that — refuse instead of minting a session /dashboard
    // could never resolve (which drove the /login <-> /dashboard white-flash loop).
    mockMemberUpdate.mockRejectedValue(
      Object.assign(new Error("Record to update not found."), { code: "P2025" }),
    );

    const result = await signIn({
      user: { id: "dangling-uuid", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });

    expect(result).toBe("/login?error=google_failed");
  });

  it("STILL allows the sign-in when the lastLoginAt bump hits a transient error (id is sound) (#2229)", async () => {
    // A generic/connection error is NOT proof of a dangling id — only the bump
    // failed. Keep the warn-and-allow behaviour so a DB blip never blocks a
    // legitimate Google login.
    mockMemberUpdate.mockRejectedValue(new Error("connection reset"));

    const result = await signIn({
      user: { id: "member-1", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });

    expect(result).toBe(true);
  });
});

describe("Google provider profile() — fail closed (#2229)", () => {
  it("returns the refusal sentinel and NEVER throws when the resolver throws", async () => {
    // The boundary to @auth/core must be belt-and-braces: a throw escaping
    // profile() lets @auth/core substitute a default user whose id matches no
    // member (the dangling-session incident). It must resolve to the "failed"
    // sentinel with a non-member id instead.
    const provider = authConfig.providers[2] as unknown as {
      profile: (p: unknown) => Promise<unknown>;
    };
    mockResolveGoogleProfile.mockRejectedValue(new Error("resolver exploded"));

    const result = (await provider.profile({
      sub: "s",
      email: "e@example.com",
    })) as { id: string; email: string | null; googleLoginStatus: string };

    expect(result).toEqual({
      id: "google-oauth:s",
      email: "e@example.com",
      googleLoginStatus: "failed",
    });
  });
});

describe("signIn callback — LINK path (profile-initiated)", () => {
  it("links when intent + verified email are present, returning a redirect (no session mint)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockLinkGoogleAccount.mockResolvedValue("googleLinked=1");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(mockLinkGoogleAccount).toHaveBeenCalledWith("member-1", "sub-1");
    expect(result).toBe("/profile?googleLinked=1#security");
    // A string return makes @auth/core redirect BEFORE minting a session.
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses linking when the Google email is not verified", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: false },
    });

    expect(result).toBe("/profile?googleError=unverified#security");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("surfaces a sub-already-linked-to-another-member refusal from the link write", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockLinkGoogleAccount.mockResolvedValue("googleError=already_linked");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(result).toBe("/profile?googleError=already_linked#security");
  });

  it("REFUSES a stale intent when a DIFFERENT member holds the session (shared-device takeover regression)", async () => {
    // Member V abandoned a link; within the TTL member W logs in via Google on
    // the same device. The intent still names V, but the session is W — must NOT
    // link V to W's sub, and must NOT mutate anything.
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-V" });
    mockNextAuthAuth.mockResolvedValue({ user: { id: "member-W" } });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-W", email_verified: true },
    });

    expect(result).toBe("/login?error=google_refused");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("REFUSES a stale intent when there is NO current session (falls through cleanly)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-V" });
    mockNextAuthAuth.mockResolvedValue(null);

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(result).toBe("/login?error=google_refused");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("links when the session matches the intent (legitimate flow, non-breaking)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockNextAuthAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockLinkGoogleAccount.mockResolvedValue("googleLinked=1");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(mockLinkGoogleAccount).toHaveBeenCalledWith("member-1", "sub-1");
    expect(result).toBe("/profile?googleLinked=1#security");
  });
});

describe("signIn callback — setup-wizard VERIFY path (#2087)", () => {
  const fullAdminSession = {
    user: { id: "admin-1", accessRoles: ["ADMIN"] },
  };

  it("records verification and redirects when a Full Admin completes the round-trip", async () => {
    mockReadGoogleVerifyIntent.mockResolvedValue({ memberId: "admin-1" });
    mockNextAuthAuth.mockResolvedValue(fullAdminSession);

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "admin-sub" },
    });

    expect(mockRecordGoogleVerified).toHaveBeenCalledTimes(1);
    expect(result).toBe("/admin/google/setup?googleVerified=1");
    // Never mints a session or links anything.
    expect(mockMemberUpdate).not.toHaveBeenCalled();
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("verifies even while the googleLogin module is still OFF (D2 unlock path)", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    mockReadGoogleVerifyIntent.mockResolvedValue({ memberId: "admin-1" });
    mockNextAuthAuth.mockResolvedValue(fullAdminSession);

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "admin-sub" },
    });

    // The module kill-switch does NOT block a verify — that is what unlocks it.
    expect(mockRecordGoogleVerified).toHaveBeenCalledTimes(1);
    expect(result).toBe("/admin/google/setup?googleVerified=1");
  });

  it("refuses to record when a DIFFERENT member holds the session (stale-cookie guard)", async () => {
    mockReadGoogleVerifyIntent.mockResolvedValue({ memberId: "admin-1" });
    mockNextAuthAuth.mockResolvedValue({
      user: { id: "someone-else", accessRoles: ["ADMIN"] },
    });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "s" },
    });

    expect(mockRecordGoogleVerified).not.toHaveBeenCalled();
    expect(result).toBe("/admin/google/setup?googleVerifyError=1");
  });

  it("refuses to record when the session is not a Full Admin", async () => {
    mockReadGoogleVerifyIntent.mockResolvedValue({ memberId: "admin-1" });
    mockNextAuthAuth.mockResolvedValue({
      user: { id: "admin-1", accessRoles: ["MEMBERSHIP"] },
    });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "s" },
    });

    expect(mockRecordGoogleVerified).not.toHaveBeenCalled();
    expect(result).toBe("/admin/google/setup?googleVerifyError=1");
  });

  it("refuses to record when there is no current session", async () => {
    mockReadGoogleVerifyIntent.mockResolvedValue({ memberId: "admin-1" });
    mockNextAuthAuth.mockResolvedValue(null);

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "s" },
    });

    expect(mockRecordGoogleVerified).not.toHaveBeenCalled();
    expect(result).toBe("/admin/google/setup?googleVerifyError=1");
  });
});
