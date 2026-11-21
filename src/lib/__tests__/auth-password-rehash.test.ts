/**
 * #5261: the stored-password cost upgrade as the REAL password provider drives
 * it. `@/lib/auth` is real; Prisma, the throttle and native hashing are
 * doubles, so these tests prove which branches write and which never do. The
 * write itself is `password-rehash.test.ts`; its race is
 * `password-rehash.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockCompare, mockHash, mockTopUp, mockClaim, OLDER_HASH, CURRENT_HASH } =
  vi.hoisted(() => {
    const OLDER_HASH = "$2b$12$older-cost-hash-for-tests-only-not-a-credential";
    const CURRENT_HASH = "$2b$13$current-cost-hash-for-tests-only-not-a-credential";
    return {
      OLDER_HASH,
      CURRENT_HASH,
      mockPrisma: {
        member: {
          findFirst: vi.fn(),
          findUnique: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      },
      mockCompare: vi.fn(async (password: string, hash: string) =>
        password === "right" && (hash === OLDER_HASH || hash === CURRENT_HASH),
      ),
      mockHash: vi.fn().mockResolvedValue("$2b$13$upgraded-hash"),
      mockTopUp: vi.fn().mockResolvedValue(undefined),
      mockClaim: vi.fn(),
    };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn((config) => config) }));
vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((config) => ({ id: "google", type: "oidc", ...config })),
}));
vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return {
    default: vi.fn(() => ({ handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn(), unstable_update: vi.fn() })),
    CredentialsSignin,
  };
});
vi.mock("@/lib/password-hashing", async (importOriginal) => {
  const { passwordHashingModuleMock } = await import("@/lib/__tests__/helpers/password-hashing-mock");
  return passwordHashingModuleMock(await importOriginal(), {
    verifyPassword: mockCompare,
    hashPassword: mockHash,
    burnPasswordCostShortfall: mockTopUp,
  });
});
vi.mock("@/lib/login-throttle", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/login-throttle")),
  claimPasswordAttempt: mockClaim,
  clearPasswordAttempts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/two-factor", () => ({ consumeTwoFactorSessionChallenge: vi.fn() }));
vi.mock("@/lib/google-oauth", () => ({
  resolveGoogleProfile: vi.fn(),
  readGoogleLinkIntent: vi.fn().mockResolvedValue(null),
  readGoogleVerifyIntent: vi.fn().mockResolvedValue(null),
  linkGoogleAccount: vi.fn(),
}));
vi.mock("@/lib/google-config", () => ({ getGoogleOAuthConfig: vi.fn(), recordGoogleVerified: vi.fn() }));

import { authConfig } from "@/lib/auth";
import { DUMMY_PASSWORD_HASH, UNUSABLE_PLACEHOLDER_PASSWORD_HASH } from "@/lib/password-hashing";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";

type Authorize = (credentials: Record<string, string>, request?: Request) => Promise<unknown>;
const passwordProvider = authConfig.providers[0] as unknown as { authorize: Authorize };

const EMAIL = "member@example.org";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: EMAIL,
    firstName: "Mere",
    lastName: "Ber",
    role: "MEMBER",
    active: true,
    canLogin: true,
    emailVerified: true,
    forcePasswordChange: false,
    passwordHash: OLDER_HASH,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    ...overrides,
  };
}

function signIn(password: string) {
  return passwordProvider.authorize(
    { email: EMAIL, password },
    new Request("http://localhost/api/auth/callback/credentials", { method: "POST" }),
  );
}

function expectNoPasswordWrite() {
  expect(mockHash).not.toHaveBeenCalled();
  expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
  for (const [args] of mockPrisma.member.update.mock.calls) {
    expect(args.data).not.toHaveProperty("passwordHash");
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue({ allowed: true });
  mockPrisma.member.findFirst.mockResolvedValue(member());
  mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
});

describe("stored password cost upgrade at sign-in (#5261)", () => {
  it("re-hashes an older-cost password once, guarded on the proved hash", async () => {
    await expect(signIn("right")).resolves.toMatchObject({ id: "member-1" });

    expect(mockHash).toHaveBeenCalledExactlyOnceWith("right");
    expect(mockPrisma.member.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "member-1", passwordHash: OLDER_HASH },
      data: { passwordHash: "$2b$13$upgraded-hash" },
    });
    expect(mockTopUp).not.toHaveBeenCalled();
  });

  it("does not re-hash a password already at the current cost", async () => {
    mockPrisma.member.findFirst.mockResolvedValue(member({ passwordHash: CURRENT_HASH }));
    await expect(signIn("right")).resolves.toMatchObject({ id: "member-1" });
    expectNoPasswordWrite();
  });

  it("still signs in when the upgrade cannot be saved", async () => {
    mockPrisma.member.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(signIn("right")).resolves.toMatchObject({ id: "member-1" });
  });

  it("tops a wrong password against an older hash up to the current cost, and writes nothing", async () => {
    await expect(signIn("wrong")).resolves.toBeNull();
    expect(mockTopUp).toHaveBeenCalledExactlyOnceWith("wrong", OLDER_HASH);
    expectNoPasswordWrite();
  });

  it("refuses a wrong password on a current-cost hash after one compare, and writes nothing", async () => {
    mockPrisma.member.findFirst.mockResolvedValue(member({ passwordHash: CURRENT_HASH }));
    await expect(signIn("wrong")).resolves.toBeNull();
    expect(mockCompare).toHaveBeenCalledExactlyOnceWith("wrong", CURRENT_HASH);
    // The real top-up spends nothing at the current cost: password-cost-top-up.test.ts.
    expect(mockTopUp).toHaveBeenCalledExactlyOnceWith("wrong", CURRENT_HASH);
    expectNoPasswordWrite();
  });

  it("refuses an account with no password set after one current-cost compare, and writes nothing", async () => {
    mockPrisma.member.findFirst.mockResolvedValue(
      member({ passwordHash: UNUSABLE_PLACEHOLDER_PASSWORD_HASH }),
    );
    await expect(signIn("right")).resolves.toBeNull();
    expect(mockCompare).toHaveBeenCalledExactlyOnceWith("right", UNUSABLE_PLACEHOLDER_PASSWORD_HASH);
    // The placeholder is at the current cost, so the real top-up spends nothing:
    // password-cost-top-up.test.ts.
    expect(mockTopUp).toHaveBeenCalledExactlyOnceWith("right", UNUSABLE_PLACEHOLDER_PASSWORD_HASH);
    expectNoPasswordWrite();
  });

  it("writes nothing for an unverified email address", async () => {
    mockPrisma.member.findFirst.mockResolvedValue(member({ emailVerified: false }));
    await expect(signIn("right")).rejects.toBeDefined();
    expectNoPasswordWrite();
  });

  it.each<[string, Record<string, unknown> | null]>([
    ["unknown", null],
    ["inactive", { active: false }],
    ["deleted", { deletedAt: new Date(FROZEN_TEST_CLOCK_BASE_ISO) }],
  ])("writes nothing for a %s account and spends only the dummy compare", async (_label, overrides) => {
    mockPrisma.member.findFirst.mockResolvedValue(overrides === null ? null : member(overrides));
    await expect(signIn("right")).resolves.toBeNull();
    expect(mockCompare).toHaveBeenCalledExactlyOnceWith("right", DUMMY_PASSWORD_HASH);
    expect(mockTopUp).not.toHaveBeenCalled();
    expectNoPasswordWrite();
  });

  it("writes nothing for a throttled account", async () => {
    mockClaim.mockResolvedValue({ allowed: false });
    await expect(signIn("right")).rejects.toBeDefined();
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled();
    expectNoPasswordWrite();
  });
});
