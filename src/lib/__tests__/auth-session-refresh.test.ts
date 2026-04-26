import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindUnique,
  mockFindFirst,
  mockUpdate,
  mockNextAuth,
  mockRawAuth,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockRawAuth: vi.fn(),
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: mockRawAuth,
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

import { auth, authConfig } from "@/lib/auth";

describe("auth session refresh", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFindFirst.mockReset();
    mockUpdate.mockReset();
    mockRawAuth.mockReset();
  });

  it("refreshes a stale admin JWT role from the database", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
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
        forcePasswordChange: true,
        emailVerified: true,
        passwordChangedAt: true,
      },
    });
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: false,
      })
    );
  });

  it("marks the session invalid when the password changed after issuance", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: new Date("2026-04-26T10:00:00.000Z"),
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

  it("projects the refreshed token role into the session", async () => {
    const session = await authConfig.callbacks.session?.({
      session: {
        user: {
          id: "member-1",
          email: "admin@example.com",
          name: "Admin User",
          role: "ADMIN",
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionInvalidated: false,
        },
      },
      token: {
        id: "member-1",
        role: "MEMBER",
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
      forcePasswordChange: true,
      isEmailVerified: true,
      sessionInvalidated: true,
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
      passwordHash: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      forcePasswordChange: false,
      emailVerified: true,
    });
    mockUpdate.mockResolvedValue({ id: "member-1" });

    const credentialsProvider = authConfig.providers[0] as {
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
