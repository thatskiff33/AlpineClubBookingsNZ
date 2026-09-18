import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindUnique,
  mockFindFirst,
  mockUpdate,
  mockNextAuth,
  mockRawAuth,
  mockLoadEffectiveModuleFlags,
  mockConsumeTwoFactorSessionChallenge,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockRawAuth: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockConsumeTwoFactorSessionChallenge: vi.fn(),
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: mockRawAuth,
    unstable_update: vi.fn(),
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
      findFirst: mockFindFirst,
      update: mockUpdate,
    },
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
  default: {
    compare: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }

  return {
    default: mockNextAuth,
    CredentialsSignin,
  };
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

// #2087: auth.ts now resolves the Google provider from the C1 store. The jwt
// callback under test never touches Google, so stub the resolver modules to keep
// this suite isolated from the credential store.
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
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { hasAdminAccess } from "@/lib/access-roles";

const ALL_NONE_MATRIX = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "none",
  content: "none",
  support: "none",
};

describe("auth session refresh", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFindFirst.mockReset();
    mockUpdate.mockReset();
    mockRawAuth.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    mockConsumeTwoFactorSessionChallenge.mockReset();
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
  });

  it("refreshes a stale admin JWT role from the database", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "ADMIN",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
    } as never);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: {
        role: true,
        canLogin: true,
        // Joined definitions (#1367) so the refresh can compute the merged
        // admin-permission matrix over definition-backed roles.
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        // #2620: the refresh invalidates a deleted account's session, and the
        // deleted-account predicate keys on both anonymisation markers — the
        // reserved email domain and the placeholder password hash — so both
        // come back with the row. This is what also kills a session minted
        // BEFORE the deletion, which would otherwise outlive it.
        //
        // Selecting `passwordHash` here is a marker comparison, not a
        // credential use: it is compared against the literal placeholder and
        // never verified against an input. The alternative — a dedicated
        // deleted flag on the row — would avoid reading it at all and is worth
        // considering if this select grows any further.
        email: true,
        passwordHash: true,
        forcePasswordChange: true,
        emailVerified: true,
        passwordChangedAt: true,
        twoFactorEnabled: true,
        twoFactorMethod: true,
        postLoginLanding: true,
      },
    });
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        id: "member-1",
        role: "MEMBER",
        accessRoles: ["USER"],
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: false,
      })
    );
  });

  it("marks the session invalid when the password changed after issuance", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: new Date("2026-04-26T10:00:00.000Z"),
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: new Date("2026-04-26T09:00:00.000Z").getTime(),
      },
    } as never);

    expect(refreshedToken).toEqual(
      expect.objectContaining({
        sessionInvalidated: true,
      })
    );
  });

  it("invalidates a session whose token id resolves to NO live member (dangling id, #2229)", async () => {
    // The dashboard <-> /login white-flash loop breaker: a token id that matches
    // no member row (deleted member, or a fallback-user substitution) must mark
    // the session invalidated so the shared auth() helper nulls it EVERYWHERE —
    // including /login, which then renders the form instead of bouncing back.
    mockFindUnique.mockResolvedValue(null);

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "dangling-uuid",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
    } as never);

    expect(refreshedToken).toEqual(
      expect.objectContaining({
        sessionInvalidated: true,
      }),
    );
  });

  it("propagates a transient DB error from the refresh rather than invalidating a live session (#2229)", async () => {
    // Only a genuinely absent row (null) invalidates. A connection blip THROWS
    // from loadSessionMemberSecurity — it must propagate (existing behaviour),
    // never be mistaken for a dangling id and silently log the member out.
    mockFindUnique.mockRejectedValue(new Error("connection reset"));

    await expect(
      authConfig.callbacks.jwt?.({
        token: {
          id: "member-1",
          role: "MEMBER",
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionIssuedAt: Date.now(),
        },
      } as never),
    ).rejects.toThrow("connection reset");
  });

  it("does not trust a password-only JWT when two-factor is later enabled", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "TOTP",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
        twoFactorVerified: true,
      },
    } as never);

    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "TOTP",
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("ignores a forged session update that claims twoFactorVerified without a challenge token", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    // The exact payload an attacker can POST to /api/auth/session.
    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: { user: { twoFactorVerified: true } },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).not.toHaveBeenCalled();
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "EMAIL",
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );

    // A forged update must not seed verification into later refreshes either.
    const subsequentToken = await authConfig.callbacks.jwt?.({
      token: { ...(refreshedToken as object) },
    } as never);

    expect(subsequentToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("ignores a session update whose challenge token is invalid or already consumed", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: {
        user: { twoFactorVerified: true, twoFactorChallengeToken: "guessed" },
      },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).toHaveBeenCalledWith(
      "member-1",
      "guessed",
    );
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("verifies the session when the update carries a valid server-minted challenge token", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(true);
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: {
        user: {
          twoFactorVerified: true,
          twoFactorChallengeToken: "server-minted-token",
        },
      },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).toHaveBeenCalledWith(
      "member-1",
      "server-minted-token",
    );
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "EMAIL",
        twoFactorVerified: true,
        twoFactorVerifiedByChallenge: true,
      }),
    );

    // Verification persists across later refreshes of the same session.
    const subsequentToken = await authConfig.callbacks.jwt?.({
      token: { ...(refreshedToken as object) },
    } as never);

    expect(subsequentToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: true,
        twoFactorVerifiedByChallenge: true,
      }),
    );
  });

  it("projects the refreshed token role into the session", async () => {
    const session = await authConfig.callbacks.session?.({
      session: {
        user: {
          id: "member-1",
          email: "admin@example.com",
          name: "Admin User",
          role: "ADMIN",
          accessRoles: ["ADMIN"],
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionInvalidated: false,
        },
      },
      token: {
        id: "member-1",
        role: "MEMBER",
        accessRoles: ["USER"],
        forcePasswordChange: true,
        isEmailVerified: true,
        sessionInvalidated: true,
      },
    } as never);

    expect(session?.user).toEqual({
      id: "member-1",
      email: "admin@example.com",
      name: "Admin User",
      role: "MEMBER",
      accessRoles: ["USER"],
      // The token carried no matrix, so the projection fails closed (#1367).
      adminPermissionMatrix: ALL_NONE_MATRIX,
      forcePasswordChange: true,
      isEmailVerified: true,
      sessionInvalidated: true,
      twoFactorRequired: false,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
      postLoginLanding: null,
    });
  });

  it("projects sessionIssuedAt into the session for auth-bounce diagnostics (#1669)", async () => {
    const session = await authConfig.callbacks.session?.({
      session: {
        user: {
          id: "member-1",
          email: "member@example.com",
          name: "Member User",
          role: "MEMBER",
          accessRoles: ["USER"],
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionInvalidated: false,
        },
      },
      token: {
        id: "member-1",
        role: "MEMBER",
        accessRoles: ["USER"],
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: false,
        sessionIssuedAt: 1_723_456_789_000,
      },
    } as never);

    expect(session?.user.sessionIssuedAt).toBe(1_723_456_789_000);
  });

  // ---------------------------------------------------------------------------
  // #1367 (F14): definition-backed custom access roles must reach every
  // session.user-based admin check. The enum-only accessRoles claim drops them
  // (role: null), so the jwt callback embeds the merged admin-permission
  // matrix computed from the DB-joined member, and the session projects it.
  // ---------------------------------------------------------------------------
  describe("definition-backed custom roles in the session (#1367)", () => {
    const customBookingOfficerRow = {
      role: null,
      roleDefinitionId: "def-custom-bookings",
      roleDefinition: {
        id: "def-custom-bookings",
        key: "custom-booking-officer",
        systemRole: null,
        label: "Custom Booking Officer",
        description: "Club-defined booking role",
        overviewLevel: "NONE",
        bookingsLevel: "EDIT",
        membershipLevel: "NONE",
        financeLevel: "NONE",
        lodgeLevel: "NONE",
        contentLevel: "NONE",
        supportLevel: "NONE",
        sortOrder: 10,
      },
    };

    it("embeds the custom role's matrix in the token even though the enum claim drops it", async () => {
      mockFindUnique.mockResolvedValue({
        role: "USER",
        canLogin: true,
        accessRoles: [customBookingOfficerRow],
        forcePasswordChange: false,
        emailVerified: true,
        passwordChangedAt: null,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });

      const token = await authConfig.callbacks.jwt?.({
        token: {
          id: "member-custom",
          role: "USER",
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionIssuedAt: Date.now(),
        },
      } as never);

      // The enum-only claim still drops the custom role (documented)...
      expect(token?.accessRoles).toEqual([]);
      // ...but the matrix carries its definition levels.
      expect(token?.adminPermissionMatrix).toEqual({
        ...ALL_NONE_MATRIX,
        bookings: "edit",
      });
    });

    it("passes the #1289/#1313 session.user gates exactly as a seeded Booking Officer does", async () => {
      mockFindUnique.mockResolvedValue({
        role: "USER",
        canLogin: true,
        accessRoles: [customBookingOfficerRow],
        forcePasswordChange: false,
        emailVerified: true,
        passwordChangedAt: null,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });

      const token = await authConfig.callbacks.jwt?.({
        token: {
          id: "member-custom",
          role: "USER",
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionIssuedAt: Date.now(),
        },
      } as never);

      const session = await authConfig.callbacks.session?.({
        session: {
          user: {
            id: "member-custom",
            email: "custom@example.com",
            name: "Custom Officer",
          },
        },
        token,
      } as never);

      // The exact predicates the booking detail page (#1289) and the widened
      // member-facing booking APIs (#1313) evaluate on session.user:
      expect(
        hasAdminAreaAccess(session!.user, { area: "bookings", level: "view" }),
      ).toBe(true);
      expect(
        hasAdminAreaAccess(session!.user, { area: "bookings", level: "edit" }),
      ).toBe(true);
      // Not a Full Admin: separation-of-duties gates stay closed.
      expect(hasAdminAccess(session!.user)).toBe(false);
      // No leakage into other areas.
      expect(
        hasAdminAreaAccess(session!.user, { area: "finance", level: "view" }),
      ).toBe(false);
    });

    it("keeps a plain member's matrix all-none end to end", async () => {
      mockFindUnique.mockResolvedValue({
        role: "USER",
        canLogin: true,
        accessRoles: [{ role: "USER", roleDefinitionId: null, roleDefinition: null }],
        forcePasswordChange: false,
        emailVerified: true,
        passwordChangedAt: null,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });

      const token = await authConfig.callbacks.jwt?.({
        token: {
          id: "member-plain",
          role: "USER",
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionIssuedAt: Date.now(),
        },
      } as never);

      expect(token?.adminPermissionMatrix).toEqual(ALL_NONE_MATRIX);

      const session = await authConfig.callbacks.session?.({
        session: {
          user: { id: "member-plain", email: "m@example.com", name: "M" },
        },
        token,
      } as never);
      expect(
        hasAdminAreaAccess(session!.user, { area: "bookings", level: "view" }),
      ).toBe(false);
    });
  });

  it("returns null when the shared auth helper sees an invalidated session", async () => {
    mockRawAuth.mockResolvedValue({
      user: {
        id: "member-1",
        email: "member@example.com",
        name: "Member User",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: true,
      },
    });

    await expect(auth()).resolves.toBeNull();
  });

  it("records lastLoginAt on a successful credentials sign-in", async () => {
    mockFindFirst.mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      firstName: "Member",
      lastName: "User",
      role: "MEMBER",
      active: true,
      canLogin: true,
      // Test fixture: a static bcrypt hash used as mock member data; not a real credential.
      passwordHash: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      forcePasswordChange: false,
      emailVerified: true,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });
    mockUpdate.mockResolvedValue({ id: "member-1" });

    const credentialsProvider = authConfig.providers[0] as unknown as {
      authorize: (credentials: Record<string, string>) => Promise<unknown>;
    };

    const user = await credentialsProvider.authorize({
      email: "member@example.com",
      password: "password",
    });

    expect(user).toEqual(
      expect.objectContaining({
        id: "member-1",
        email: "member@example.com",
        role: "MEMBER",
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
  });
});
