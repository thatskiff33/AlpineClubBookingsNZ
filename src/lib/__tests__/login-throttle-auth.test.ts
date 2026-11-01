/**
 * #4609: the per-account throttle as the REAL password provider drives it.
 *
 * `@/lib/auth` and `@/lib/login-throttle` are real. Prisma is mocked with an
 * in-memory `LoginThrottle` double so the claim, the row and the clear run
 * through the production code; the race on real PostgreSQL is
 * `login-throttle.realdb.test.ts`. Each attempt arrives from a different
 * internet address to show the count belongs to the account, not the address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, mockPrisma, mockBcryptCompare, mockLoadEffectiveModuleFlags, REAL_HASH } =
  vi.hoisted(() => {
    type Row = { failureCount: number; lastFailureAt: Date };
    const rows = new Map<string, Row>();
    const loginThrottle = {
      createMany: vi.fn(async ({ data }: { data: Array<Row & { id: string }> }) => {
        let count = 0;
        for (const { id, ...row } of data) {
          if (!rows.has(id)) {
            rows.set(id, row);
            count += 1;
          }
        }
        return { count };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("No LoginThrottle found");
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        rows.set(where.id, { ...data });
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const had = rows.delete(where.id);
        return { count: had ? 1 : 0 };
      }),
    };
    const mockPrisma: Record<string, unknown> = {
      loginThrottle,
      member: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      magicLinkToken: { findUnique: vi.fn(), updateMany: vi.fn() },
      $executeRaw: vi.fn(async (_sql: TemplateStringsArray, id: string) =>
        rows.has(id) ? 1 : 0,
      ),
    };
    mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
    const REAL_HASH = "$2b$12$the-officer-real-hash-for-tests-only-not-a-credential";
    return {
      rows,
      mockPrisma,
      REAL_HASH,
      mockBcryptCompare: vi.fn(
        async (password: string, hash: string) => hash === REAL_HASH && password === "right",
      ),
      mockLoadEffectiveModuleFlags: vi.fn(),
    };
  });

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
vi.mock("bcryptjs", () => ({ default: { compare: mockBcryptCompare } }));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));
vi.mock("@/lib/two-factor", () => ({ consumeTwoFactorSessionChallenge: vi.fn() }));
vi.mock("@/lib/google-oauth", () => ({
  resolveGoogleProfile: vi.fn(),
  readGoogleLinkIntent: vi.fn().mockResolvedValue(null),
  readGoogleVerifyIntent: vi.fn().mockResolvedValue(null),
  linkGoogleAccount: vi.fn(),
}));
vi.mock("@/lib/google-config", () => ({
  getGoogleOAuthConfig: vi.fn(),
  recordGoogleVerified: vi.fn(),
}));

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import { authConfig } from "@/lib/auth";
import { loginAccountKey, resetLoginThrottleProcessState } from "@/lib/login-throttle";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";

type Authorize = (credentials: Record<string, string>, request?: Request) => Promise<unknown>;
const passwordProvider = authConfig.providers[0] as unknown as { authorize: Authorize };
const magicLinkProvider = authConfig.providers[1] as unknown as { authorize: Authorize };
const signInCallback = authConfig.callbacks!.signIn as unknown as (params: {
  user?: unknown;
  account?: unknown;
  profile?: unknown;
}) => Promise<boolean | string>;

const member = mockPrisma.member as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const magicLinkToken = mockPrisma.magicLinkToken as {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};

const T0 = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
const OFFICER_EMAIL = "treasurer@example.org";
const UNKNOWN_EMAIL = "nobody-here@example.org";

function officer(overrides: Record<string, unknown> = {}) {
  return {
    id: "officer-1",
    email: OFFICER_EMAIL,
    firstName: "Tess",
    lastName: "Urer",
    role: "MEMBER",
    active: true,
    canLogin: true,
    emailVerified: true,
    forcePasswordChange: false,
    passwordHash: REAL_HASH,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    ...overrides,
  };
}

let address = 0;
/** A request from a fresh internet address every time. */
function fromNewAddress(): Request {
  address += 1;
  return new Request("http://localhost/api/auth/callback/credentials", {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.${address}` },
  });
}

function attempt(email: string, password: string) {
  return passwordProvider.authorize({ email, password }, fromNewAddress());
}

async function expectThrottled(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: LOGIN_THROTTLED_CODE });
}

function advance(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

async function failFiveTimes(email: string) {
  for (let i = 0; i < 5; i += 1) await expect(attempt(email, "wrong")).resolves.toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(T0);
  rows.clear();
  resetLoginThrottleProcessState();
  member.findFirst.mockImplementation(async ({ where }: { where: { email?: string } }) =>
    where.email === OFFICER_EMAIL ? officer() : null,
  );
  mockLoadEffectiveModuleFlags.mockResolvedValue({ magicLink: true, googleLogin: true });
});

describe("per-account password throttle through authorize (#4609)", () => {
  it("throttles one account guessed from many addresses; the wait doubles to 15 minutes", async () => {
    await failFiveTimes(OFFICER_EMAIL);
    // The 6th, from a 7th address: refused without a password check.
    await expectThrottled(attempt(OFFICER_EMAIL, "wrong"));

    const waits: number[] = [];
    for (let n = 6; n <= 11; n += 1) {
      // Step the frozen clock one second at a time until the account admits
      // the next guess; the wait is the number of steps taken.
      let seconds = 0;
      let outcome: "throttled" | "refused" = "throttled";
      while (outcome === "throttled") {
        advance(1_000);
        seconds += 1;
        outcome = await attempt(OFFICER_EMAIL, "wrong").then(
          () => "refused" as const,
          (error: { code?: string }) => {
            expect(error.code).toBe(LOGIN_THROTTLED_CODE);
            return "throttled" as const;
          },
        );
      }
      waits.push(seconds);
    }
    // The wait each counted failure opened: after the 5th..10th.
    expect(waits).toEqual([30, 60, 120, 240, 480, 900]);
    expect(rows.get(loginAccountKey(OFFICER_EMAIL))?.failureCount).toBe(11);
    advance(899_000);
    await expectThrottled(attempt(OFFICER_EMAIL, "wrong"));
    advance(1_000);
    await expect(attempt(OFFICER_EMAIL, "wrong")).resolves.toBeNull();
  });

  it("answers a throttled real account and a throttled unknown email identically, with no Member read", async () => {
    await failFiveTimes(OFFICER_EMAIL);
    await failFiveTimes(UNKNOWN_EMAIL);
    vi.clearAllMocks();

    const outcomes: unknown[] = [];
    for (const email of [OFFICER_EMAIL, UNKNOWN_EMAIL]) {
      mockBcryptCompare.mockClear();
      const error = await attempt(email, "right").catch((caught: unknown) => caught);
      outcomes.push({
        name: (error as Error).constructor.name,
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      });
      // The dummy compare still runs, exactly once, and never the real hash.
      expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
      expect(mockBcryptCompare.mock.calls[0][1]).not.toBe(REAL_HASH);
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ code: LOGIN_THROTTLED_CODE });
    expect(member.findFirst).not.toHaveBeenCalled();
  });

  it("counts unknown emails exactly as real ones", async () => {
    await failFiveTimes(UNKNOWN_EMAIL);
    await expectThrottled(attempt(UNKNOWN_EMAIL, "wrong"));
  });

  it("counts letter-case variants against the one account", async () => {
    for (const email of ["Treasurer@example.org", "TREASURER@EXAMPLE.ORG", OFFICER_EMAIL]) {
      await expect(attempt(email, "wrong")).resolves.toBeNull();
    }
    await attempt("treasurer@Example.org", "wrong");
    await attempt("treasurer@example.ORG", "wrong");
    await expectThrottled(attempt("tReAsUrEr@example.org", "right"));
  });

  it("claims before any password compare", async () => {
    await expect(attempt(OFFICER_EMAIL, "right")).resolves.toMatchObject({ id: "officer-1" });
    const claim = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(claim).toBeLessThan(member.findFirst.mock.invocationCallOrder[0]);
    expect(claim).toBeLessThan(mockBcryptCompare.mock.invocationCallOrder[0]);
  });

  it("refuses the right password during the wait and leaves the count alone", async () => {
    await failFiveTimes(OFFICER_EMAIL);
    const before = rows.get(loginAccountKey(OFFICER_EMAIL));
    mockBcryptCompare.mockClear();

    await expectThrottled(attempt(OFFICER_EMAIL, "right"));

    expect(rows.get(loginAccountKey(OFFICER_EMAIL))).toEqual(before);
    expect(mockBcryptCompare.mock.calls.map((call) => call[1])).not.toContain(REAL_HASH);
  });

  it("signs in with the right password after the wait and clears the count", async () => {
    await failFiveTimes(OFFICER_EMAIL);
    advance(30_000);

    await expect(attempt(OFFICER_EMAIL, "right")).resolves.toMatchObject({ id: "officer-1" });
    expect(rows.has(loginAccountKey(OFFICER_EMAIL))).toBe(false);

    await expect(attempt(OFFICER_EMAIL, "wrong")).resolves.toBeNull();
    expect(rows.get(loginAccountKey(OFFICER_EMAIL))?.failureCount).toBe(1);
  });

  it("clears on the right password even when the email is unverified", async () => {
    member.findFirst.mockResolvedValue(officer({ emailVerified: false }));
    await attempt(OFFICER_EMAIL, "wrong");
    await expect(attempt(OFFICER_EMAIL, "right")).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(rows.has(loginAccountKey(OFFICER_EMAIL))).toBe(false);
  });

  it("leaves magic-link and Google sign-in working while the password path waits", async () => {
    await failFiveTimes(OFFICER_EMAIL);
    await expectThrottled(attempt(OFFICER_EMAIL, "wrong"));
    const transactionsBefore = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock.calls
      .length;

    magicLinkToken.findUnique.mockResolvedValue({
      id: "tok1",
      memberId: "officer-1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    magicLinkToken.updateMany.mockResolvedValue({ count: 1 });
    member.findFirst.mockResolvedValue(officer());
    await expect(
      magicLinkProvider.authorize({ token: "a".repeat(64) }, fromNewAddress()),
    ).resolves.toMatchObject({ id: "officer-1" });

    await expect(
      signInCallback({
        user: { id: "officer-1", googleLoginStatus: "ok" },
        account: { provider: "google" },
        profile: { sub: "google-sub" },
      }),
    ).resolves.toBe(true);

    // Neither path consulted the throttle.
    expect((mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      transactionsBefore,
    );
  });

  it("still signs in with the right password when the throttle store is down", async () => {
    (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("store down"),
    );
    await expect(attempt(OFFICER_EMAIL, "right")).resolves.toMatchObject({ id: "officer-1" });
  });
});
