/**
 * #4938: the session, the module flags and the signed-in member's row are read
 * once per server-component render, not once per caller, and never across
 * renders.
 *
 * React's `cache()` is swapped for `requestScopedCache`, which keeps the RSC
 * contract (one memo per render, none outside one) — see that helper for why
 * the real client build cannot be used here. `nextAuth.auth()` is stood in for
 * by a function that runs the real jwt and session callbacks, so the reads
 * counted below are the ones the refresh really makes: the member security row,
 * the module-settings row and the login-security row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  loginSecuritySettingFindUnique: vi.fn(),
  rawAuth: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const { requestScopedCache } = await import(
    "@/lib/__tests__/helpers/request-cache-scope"
  );
  return {
    ...(await importOriginal<typeof import("react")>()),
    cache: requestScopedCache,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    clubModuleSettings: { findUnique: mocks.clubModuleSettingsFindUnique },
    loginSecuritySetting: { findUnique: mocks.loginSecuritySettingFindUnique },
  },
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return {
    default: vi.fn(() => ({
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: mocks.rawAuth,
      unstable_update: vi.fn(),
    })),
    CredentialsSignin,
  };
});

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => config),
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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

import { auth, authConfig } from "@/lib/auth";
import {
  loadEffectiveModuleFlags,
  loadEffectiveModuleFlagsStrict,
} from "@/lib/module-settings";
import { loadSignedInMember } from "@/lib/signed-in-member";
import { inRequestScope } from "@/lib/__tests__/helpers/request-cache-scope";

const MEMBER_ID = "member-1";

function liveMember(overrides: Record<string, unknown> = {}) {
  return {
    role: "MEMBER",
    canLogin: true,
    accessRoles: [{ role: "USER" }],
    forcePasswordChange: false,
    emailVerified: true,
    passwordChangedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    active: true,
    ...overrides,
  };
}

/** What NextAuth does for a server component: refresh the token, project it. */
async function refreshAndProject() {
  const token = await authConfig.callbacks.jwt?.({
    token: {
      id: MEMBER_ID,
      role: "MEMBER",
      forcePasswordChange: false,
      isEmailVerified: true,
      sessionIssuedAt: Date.now(),
    },
  } as never);
  return authConfig.callbacks.session?.({
    session: { user: {}, expires: "2026-07-02T00:00:00.000Z" },
    token,
  } as never);
}

/** A layout, a guard and a page, each asking for the session and the flags. */
async function renderThreeCallers() {
  const sessions = await Promise.all([auth(), auth(), auth()]);
  const flags = await Promise.all([
    loadEffectiveModuleFlags(),
    loadEffectiveModuleFlags(),
  ]);
  return { sessions, flags };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberFindUnique.mockResolvedValue(liveMember());
  mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
  mocks.loginSecuritySettingFindUnique.mockResolvedValue(null);
  mocks.rawAuth.mockImplementation(refreshAndProject);
});

describe("one session refresh per render (#4938)", () => {
  it("reads the member, module-settings and login-security rows once for every caller in a render", async () => {
    const { sessions } = await inRequestScope(renderThreeCallers);

    expect(sessions[0]?.user?.id).toBe(MEMBER_ID);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).toBe(sessions[0]);
    expect(mocks.rawAuth).toHaveBeenCalledTimes(1);
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
    // The refresh's own flags read and the two callers' reads are one read.
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.loginSecuritySettingFindUnique).toHaveBeenCalledTimes(1);
  });

  it("reads afresh in the next render, so a change reaches the next request (INV-AUTH-007)", async () => {
    const first = await inRequestScope(() => auth());
    expect(first?.user?.id).toBe(MEMBER_ID);

    // Between requests the member's login is switched off (#3603), which ends
    // the session at its next refresh.
    mocks.memberFindUnique.mockResolvedValue(liveMember({ canLogin: false }));
    const second = await inRequestScope(() => auth());

    expect(mocks.rawAuth).toHaveBeenCalledTimes(2);
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.loginSecuritySettingFindUnique).toHaveBeenCalledTimes(2);
    expect(second).toBeNull();
  });

  it("returns null to every caller in a render when the session is invalidated", async () => {
    // A password changed after the session was issued revokes it.
    mocks.memberFindUnique.mockResolvedValue(
      liveMember({ passwordChangedAt: new Date(Date.now() + 60_000) }),
    );

    const { sessions } = await inRequestScope(renderThreeCallers);

    expect(sessions).toEqual([null, null, null]);
    expect(mocks.rawAuth).toHaveBeenCalledTimes(1);
  });

  it("memoises nothing outside a render, as in a route handler or server action", async () => {
    await renderThreeCallers();

    expect(mocks.rawAuth).toHaveBeenCalledTimes(3);
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(3);
    expect(mocks.loginSecuritySettingFindUnique).toHaveBeenCalledTimes(3);
    // Three refreshes plus two direct callers.
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(5);
  });
});

describe("module flags per render (#4938)", () => {
  it("reads the module-settings row once for every caller in a render, and again in the next", async () => {
    await inRequestScope(() =>
      Promise.all([loadEffectiveModuleFlags(), loadEffectiveModuleFlags()]),
    );
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(1);

    await inRequestScope(() => loadEffectiveModuleFlags());
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(2);
  });

  it("leaves the strict loader un-memoised: evidence callers read fresh every time", async () => {
    await inRequestScope(async () => {
      await loadEffectiveModuleFlagsStrict();
      await loadEffectiveModuleFlagsStrict();
    });
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("the signed-in member's row per render (#4938)", () => {
  it("is read once for the layout and the page, and again in the next render", async () => {
    await inRequestScope(() =>
      Promise.all([loadSignedInMember(MEMBER_ID), loadSignedInMember(MEMBER_ID)]),
    );
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);

    await inRequestScope(() => loadSignedInMember(MEMBER_ID));
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(2);
  });

  it("selects the onboarding gate's fields and the dashboard's induction flag", async () => {
    await loadSignedInMember(MEMBER_ID);
    const { select } = mocks.memberFindUnique.mock.calls[0][0];

    const { MEMBER_ONBOARDING_GATE_SELECT } = await import(
      "@/lib/member-onboarding"
    );
    expect(select).toMatchObject(MEMBER_ONBOARDING_GATE_SELECT);
    expect(select.requiresInduction).toBe(true);
  });
});
