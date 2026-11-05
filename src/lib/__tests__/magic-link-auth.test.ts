import { beforeEach, describe, expect, it, vi } from "vitest";

// Verify-side of email magic-link sign-in (#2034): the second Credentials
// provider (id "magic-link"). It must replicate every password-login gate,
// claim the token single-use race-safely, refuse forced-password-change
// members, and NEVER set twoFactorVerified (so 2FA members stay challenged by
// the unchanged jwt callback).
const {
  mockTokenFindUnique,
  mockTokenUpdateMany,
  mockMemberFindFirst,
  mockMemberUpdate,
  mockLoadEffectiveModuleFlags,
  mockConsumeTwoFactorSessionChallenge,
  mockNextAuth,
} = vi.hoisted(() => ({
  mockTokenFindUnique: vi.fn(),
  mockTokenUpdateMany: vi.fn(),
  mockMemberFindFirst: vi.fn(),
  mockMemberUpdate: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockConsumeTwoFactorSessionChallenge: vi.fn(),
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
    unstable_update: vi.fn(),
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn(), findFirst: mockMemberFindFirst, update: mockMemberUpdate },
    magicLinkToken: {
      findUnique: mockTokenFindUnique,
      updateMany: mockTokenUpdateMany,
    },
    // #4611: the maximum session age is read on every refresh; no row, so the
    // 7-day default applies.
    loginSecuritySetting: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => config),
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
  consumeTwoFactorSessionChallenge: mockConsumeTwoFactorSessionChallenge,
}));

import { authConfig } from "@/lib/auth";

const VALID_TOKEN = "a".repeat(64); // matches the 64-hex action-token format

type Authorizer = {
  authorize: (credentials: Record<string, unknown>) => Promise<unknown>;
};

function magicLinkProvider(): Authorizer {
  // providers[0] is the password Credentials provider; providers[1] is
  // magic-link (assert its id so a reorder does not silently mistarget).
  const provider = authConfig.providers[1] as unknown as Authorizer & {
    id: string;
  };
  expect(provider.id).toBe("magic-link");
  return provider;
}

const verifiedMember = {
  id: "member-1",
  email: "member@example.com",
  firstName: "Member",
  lastName: "User",
  role: "MEMBER",
  active: true,
  canLogin: true,
  forcePasswordChange: false,
  emailVerified: true,
  twoFactorEnabled: false,
  twoFactorMethod: null,
};

function freshTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "token-1",
    memberId: "member-1",
    used: false,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenUpdateMany.mockResolvedValue({ count: 1 });
  mockMemberUpdate.mockResolvedValue({ id: "member-1" });
  // Module on by default so the verify-side kill-switch does not short-circuit
  // the gate/parity tests below.
  mockLoadEffectiveModuleFlags.mockResolvedValue({
    magicLink: true,
    twoFactor: false,
  });
  mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
});

describe("magic-link verify provider", () => {
  it("signs in a valid link and returns the password-provider user shape", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue(verifiedMember);

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });

    expect(user).toEqual({
      id: "member-1",
      email: "member@example.com",
      name: "Member User",
      role: "MEMBER",
      forcePasswordChange: false,
      isEmailVerified: true,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });
    // Must NOT carry twoFactorVerified — the jwt callback owns 2FA state.
    expect(user).not.toHaveProperty("twoFactorVerified");
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it("refuses a valid, unexpired token when the module is disabled (verify-side kill-switch)", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      magicLink: false,
      twoFactor: false,
    });
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue(verifiedMember);

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });

    expect(user).toBeNull();
    // Checked before any token I/O so a disabled module cannot burn the link:
    // no lookup, no claim, no member load.
    expect(mockTokenFindUnique).not.toHaveBeenCalled();
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
  });

  it("redeems the same unexpired token once the module is re-enabled (link not burned by a disable)", async () => {
    // Module on (the default): the token the disable test refused still works.
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue(verifiedMember);

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });

    expect(user).toMatchObject({ id: "member-1", email: "member@example.com" });
    expect(mockTokenUpdateMany).toHaveBeenCalled();
  });

  it("claims the token single-use with a conditional updateMany (race-safe)", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue(verifiedMember);

    await magicLinkProvider().authorize({ token: VALID_TOKEN });

    expect(mockTokenUpdateMany).toHaveBeenCalledWith({
      where: { id: "token-1", used: false },
      data: { used: true },
    });
  });

  it("returns null when the conditional claim loses the race (count !== 1)", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockTokenUpdateMany.mockResolvedValue({ count: 0 });

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });

    expect(user).toBeNull();
    // Never loads or mutates the member once the claim is lost.
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-64-hex) token before any DB call", async () => {
    const user = await magicLinkProvider().authorize({ token: "too-short" });
    expect(user).toBeNull();
    expect(mockTokenFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing token row", async () => {
    mockTokenFindUnique.mockResolvedValue(null);
    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });
    expect(user).toBeNull();
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an already-used token", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow({ used: true }));
    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });
    expect(user).toBeNull();
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    mockTokenFindUnique.mockResolvedValue(
      freshTokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });
    expect(user).toBeNull();
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an archived (inactive) member even with a valid, claimed token", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue({ ...verifiedMember, active: false });

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });
    expect(user).toBeNull();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a dependent / non-login member (canLogin gate on the lookup)", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    // The lookup filters canLogin:true, so a dependent returns null.
    mockMemberFindFirst.mockResolvedValue(null);

    const user = await magicLinkProvider().authorize({ token: VALID_TOKEN });
    expect(user).toBeNull();
    expect(mockMemberFindFirst).toHaveBeenCalledWith({
      where: { id: "member-1", canLogin: true },
    });
  });

  it("throws EMAIL_NOT_VERIFIED for an unverified member (never a verification bypass)", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue({
      ...verifiedMember,
      emailVerified: false,
    });

    await expect(
      magicLinkProvider().authorize({ token: VALID_TOKEN }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("refuses a forcePasswordChange member with the reset-pointer code", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue({
      ...verifiedMember,
      forcePasswordChange: true,
    });

    await expect(
      magicLinkProvider().authorize({ token: VALID_TOKEN }),
    ).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    // The token was already claimed, so the link cannot be replayed.
    expect(mockTokenUpdateMany).toHaveBeenCalled();
  });

  it("returns a 2FA-enrolled member's shape unchanged, leaving 2FA to the jwt callback", async () => {
    mockTokenFindUnique.mockResolvedValue(freshTokenRow());
    mockMemberFindFirst.mockResolvedValue({
      ...verifiedMember,
      twoFactorEnabled: true,
      twoFactorMethod: "TOTP",
    });

    const user = (await magicLinkProvider().authorize({
      token: VALID_TOKEN,
    })) as Record<string, unknown>;

    expect(user.twoFactorEnabled).toBe(true);
    expect(user.twoFactorMethod).toBe("TOTP");
    // Still no twoFactorVerified — the member will be challenged on /login/verify.
    expect(user).not.toHaveProperty("twoFactorVerified");
  });
});
