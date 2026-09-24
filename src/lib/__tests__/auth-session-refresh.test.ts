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

// The refresh's member read is projected through its real `select` (#3603), so
// a field the refresh stops selecting stops reaching the callback.
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique),
        findFirst: mockFindFirst,
        update: mockUpdate,
      },
    },
  };
});

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
        // #2620/#3542: the refresh invalidates a deleted account's session.
        // The canonical predicate needs the structural timestamp plus the
        // permanently reserved address for adopter-era rows. This also kills a
        // session minted BEFORE deletion, which would otherwise outlive it.
        email: true,
        deletedAt: true,
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
      // The token carried no canLogin, so the projection fails closed (#3603).
      canLogin: false,
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

  // ---------------------------------------------------------------------------
  // #3603: every sign-in provider requires `canLogin: true`, so a session whose
  // member has since had login switched off is ended on its next refresh, the
  // same kill switch as a deleted account (#2620). Until it is, the role claim
  // and the matrix are empty too. Each case is paired with the same member at
  // `canLogin: true`.
  // ---------------------------------------------------------------------------
  describe("a member whose login is switched off (#3603)", () => {
    function memberRow(canLogin: boolean) {
      return {
        role: "ADMIN",
        canLogin,
        accessRoles: [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }],
        forcePasswordChange: false,
        emailVerified: true,
        passwordChangedAt: null,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      };
    }

    async function refresh(token: Record<string, unknown> = {}) {
      return authConfig.callbacks.jwt?.({
        token: {
          id: "admin-1",
          role: "ADMIN",
          accessRoles: ["ADMIN"],
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionIssuedAt: Date.now(),
          ...token,
        },
      } as never);
    }

    it("invalidates the session and empties the role claim and matrix", async () => {
      mockFindUnique.mockResolvedValue(memberRow(false));

      const token = await refresh();

      expect(token?.sessionInvalidated).toBe(true);
      expect(token?.accessRoles).toEqual([]);
      expect(token?.canLogin).toBe(false);
      expect(token?.adminPermissionMatrix).toEqual(ALL_NONE_MATRIX);
    });

    it("keeps the session, roles and matrix of the same member with login enabled", async () => {
      mockFindUnique.mockResolvedValue(memberRow(true));

      const token = await refresh();

      expect(token?.sessionInvalidated).toBe(false);
      expect(token?.accessRoles).toEqual(["ADMIN"]);
      expect(token?.canLogin).toBe(true);
      expect(token?.adminPermissionMatrix).toEqual(
        Object.fromEntries(Object.keys(ALL_NONE_MATRIX).map((area) => [area, "edit"])),
      );
    });

    it("keeps an ended session ended when login is switched back on", async () => {
      mockFindUnique.mockResolvedValue(memberRow(false));
      const ended = await refresh();
      expect(ended?.sessionInvalidated).toBe(true);

      mockFindUnique.mockResolvedValue(memberRow(true));
      const later = await authConfig.callbacks.jwt?.({ token: ended } as never);

      expect(later?.sessionInvalidated).toBe(true);
    });

    it("gives a fresh sign-in a live session once login is enabled again", async () => {
      mockFindUnique.mockResolvedValue(memberRow(true));

      const token = await authConfig.callbacks.jwt?.({
        token: { sessionInvalidated: true },
        user: {
          id: "admin-1",
          role: "ADMIN",
          forcePasswordChange: false,
          isEmailVerified: true,
          twoFactorEnabled: false,
          twoFactorMethod: null,
        },
      } as never);

      expect(token?.sessionInvalidated).toBe(false);
    });

    it("projects canLogin onto session.user, so privilege checks over it apply the rule", async () => {
      mockFindUnique.mockResolvedValue(memberRow(true));
      const token = await refresh();

      const session = await authConfig.callbacks.session?.({
        session: { user: { id: "admin-1", email: "a@example.com", name: "A" } },
        token,
      } as never);

      expect(session?.user.canLogin).toBe(true);
      expect(hasAdminAccess(session!.user)).toBe(true);

      const disabled = await authConfig.callbacks.session?.({
        session: { user: { id: "admin-1", email: "a@example.com", name: "A" } },
        token: { ...token, canLogin: false },
      } as never);
      expect(disabled?.user.canLogin).toBe(false);
      expect(hasAdminAccess(disabled!.user)).toBe(false);
    });

    it("makes auth() return no session for the login-disabled member", async () => {
      mockFindUnique.mockResolvedValue(memberRow(false));
      const token = await refresh();
      const session = await authConfig.callbacks.session?.({
        session: { user: { id: "admin-1", email: "a@example.com", name: "A" } },
        token,
      } as never);
      mockRawAuth.mockResolvedValue(session);

      await expect(auth()).resolves.toBeNull();
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
