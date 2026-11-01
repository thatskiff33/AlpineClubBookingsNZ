/**
 * #4609: the per-account throttle's store half — the claim under the row lock,
 * the clear, the account key and the per-process fallback — against a mocked
 * Prisma client. The race itself is proven on real PostgreSQL in
 * `login-throttle.realdb.test.ts`.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTx,
  mockLock,
  mockSetLockTimeout,
  mockPrisma,
  mockGetAuthSecret,
  mockLoggerError,
} = vi.hoisted(() => {
  const mockTx = {
    loginThrottle: {
      createMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };
  // The row-lock statement, split out of $executeRaw from the lock-timeout one.
  const mockLock = vi.fn();
  const mockSetLockTimeout = vi.fn();
  return {
    mockTx,
    mockLock,
    mockSetLockTimeout,
    mockPrisma: {
      $transaction: vi.fn(),
      loginThrottle: { deleteMany: vi.fn(), findUnique: vi.fn() },
    },
    mockGetAuthSecret: vi.fn<() => string | undefined>(() => "test-secret"),
    mockLoggerError: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/runtime-config", () => ({ getAuthSecret: mockGetAuthSecret }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() },
}));

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import {
  LOGIN_THROTTLE_DEGRADED_FREE_FAILURES,
  claimPasswordAttempt,
  clearPasswordAttempts,
  loginAccountKey,
  normaliseSignInEmail,
  resetLoginThrottleProcessState,
  sweepIdleLoginThrottleRows,
} from "@/lib/login-throttle";

const EMAIL = "Treasurer@Example.org";
const T0 = new Date(FROZEN_TEST_CLOCK_BASE_ISO);

/** Every argument any mock received, serialised, to prove what never leaks. */
function everythingPassedTo(...mocks: Array<ReturnType<typeof vi.fn>>): string {
  return JSON.stringify(mocks.flatMap((mock) => mock.mock.calls));
}

function storeRow(failureCount: number, lastFailureAt = T0) {
  mockTx.loginThrottle.findUniqueOrThrow.mockResolvedValue({ failureCount, lastFailureAt });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(T0);
  resetLoginThrottleProcessState();
  mockGetAuthSecret.mockReturnValue("test-secret");
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  mockTx.loginThrottle.createMany.mockResolvedValue({ count: 0 });
  mockTx.$executeRaw.mockImplementation(
    (sql: TemplateStringsArray, ...values: unknown[]) =>
      sql.join("?").includes("set_config")
        ? mockSetLockTimeout(sql, ...values)
        : mockLock(sql, ...values),
  );
  mockSetLockTimeout.mockResolvedValue(1);
  mockLock.mockResolvedValue(1);
  mockPrisma.loginThrottle.findUnique.mockResolvedValue(null);
  mockTx.loginThrottle.update.mockResolvedValue({});
  mockPrisma.loginThrottle.deleteMany.mockResolvedValue({ count: 1 });
  storeRow(0);
});

describe("account key (#4609)", () => {
  it("is a 64-hex HMAC that never holds the address or its unkeyed digest", () => {
    const key = loginAccountKey(EMAIL);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const lower = EMAIL.toLowerCase();
    expect(key).not.toContain(lower);
    for (const plain of [EMAIL, lower, `login-throttle:v1:${lower}`]) {
      expect(key).not.toBe(createHash("sha256").update(plain).digest("hex"));
    }
  });

  it("changes when the auth secret changes", () => {
    const before = loginAccountKey(EMAIL);
    mockGetAuthSecret.mockReturnValue("another-secret");
    expect(loginAccountKey(EMAIL)).not.toBe(before);
  });

  it("gives one key for every letter-case variant, the lookup's own normaliser", () => {
    expect(normaliseSignInEmail(EMAIL)).toBe("treasurer@example.org");
    expect(loginAccountKey("TREASURER@EXAMPLE.ORG")).toBe(loginAccountKey(EMAIL));
    expect(loginAccountKey("treasurer@example.org")).toBe(loginAccountKey(EMAIL));
  });
});

describe("claimPasswordAttempt (#4609)", () => {
  it("ensures, locks, reads and counts, in that order, inside one transaction", async () => {
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });

    const key = loginAccountKey(EMAIL);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.loginThrottle.createMany).toHaveBeenCalledWith({
      data: [{ id: key, failureCount: 0, lastFailureAt: T0 }],
      skipDuplicates: true,
    });
    expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({ maxWait: 1_000, timeout: 3_000 });
    const [timeoutSql, ...timeoutValues] = mockSetLockTimeout.mock.calls[0];
    expect((timeoutSql as TemplateStringsArray).join("?")).toBe(
      "SELECT set_config('lock_timeout', ?, true)",
    );
    expect(timeoutValues).toEqual(["1000"]);
    const [lockSql, ...lockValues] = mockLock.mock.calls[0];
    expect((lockSql as TemplateStringsArray).join("?")).toBe(
      'SELECT 1 FROM "LoginThrottle" WHERE "id" = ? FOR UPDATE',
    );
    expect(lockValues).toEqual([key]);
    expect(mockTx.loginThrottle.update).toHaveBeenCalledWith({
      where: { id: key },
      data: { failureCount: 1, lastFailureAt: T0 },
    });
    const order = [
      mockPrisma.loginThrottle.findUnique,
      mockSetLockTimeout,
      mockTx.loginThrottle.createMany,
      mockLock,
      mockTx.loginThrottle.findUniqueOrThrow,
      mockTx.loginThrottle.update,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("refuses a waiting account under the lock and writes nothing", async () => {
    storeRow(5, new Date(T0.getTime() - 1000));
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    expect(mockTx.loginThrottle.update).not.toHaveBeenCalled();
  });

  it("refuses an account already waiting from the unlocked read, without queuing on the row", async () => {
    mockPrisma.loginThrottle.findUnique.mockResolvedValue({
      failureCount: 5,
      lastFailureAt: new Date(T0.getTime() - 1000),
    });
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers a row held past the lock timeout as waiting: uncounted, no fallback, no store-failure log", async () => {
    mockLock.mockRejectedValue(
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    }
    expect(mockTx.loginThrottle.update).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
    // The per-process fallback was never consulted: once the row frees, the
    // store decides as usual.
    mockLock.mockResolvedValue(1);
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });
  });

  it("stamps the attempt with the instant the row was held, not when the claim started", async () => {
    const heldAt = new Date(T0.getTime() + 2_500);
    mockLock.mockImplementation(async () => {
      vi.setSystemTime(heldAt);
      return 1;
    });
    storeRow(3, new Date(T0.getTime() + 2_000));
    await claimPasswordAttempt(EMAIL);
    expect(mockTx.loginThrottle.update).toHaveBeenCalledWith({
      where: { id: loginAccountKey(EMAIL) },
      data: { failureCount: 4, lastFailureAt: heldAt },
    });
  });

  it("never passes the address to the store", async () => {
    await claimPasswordAttempt(EMAIL);
    await clearPasswordAttempts(EMAIL);
    const seen = everythingPassedTo(
      mockPrisma.loginThrottle.findUnique,
      mockTx.loginThrottle.createMany,
      mockTx.$executeRaw,
      mockTx.loginThrottle.findUniqueOrThrow,
      mockTx.loginThrottle.update,
      mockPrisma.loginThrottle.deleteMany,
    ).toLowerCase();
    expect(seen).not.toContain("treasurer@example.org");
  });

  it("re-ensures and re-locks once when the row vanished between ensure and lock", async () => {
    mockLock.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });

    expect(mockTx.loginThrottle.createMany).toHaveBeenCalledTimes(2);
    expect(mockLock).toHaveBeenCalledTimes(2);
    expect(mockTx.loginThrottle.update).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("gives up as a store failure only when the row is lost twice", async () => {
    mockLock.mockResolvedValue(0);

    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });

    expect(mockLock).toHaveBeenCalledTimes(2);
    expect(mockTx.loginThrottle.update).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

describe("store-failure fallback (#4609, #1142)", () => {
  beforeEach(() => {
    mockPrisma.$transaction.mockRejectedValue(new Error("connection refused"));
  });

  it("runs at the divided budget of one and never throws", async () => {
    expect(LOGIN_THROTTLE_DEGRADED_FREE_FAILURES).toBe(1);
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    vi.setSystemTime(new Date(T0.getTime() + 30_000));
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });
  });

  it("counts case variants as one account", async () => {
    await claimPasswordAttempt(EMAIL);
    await expect(claimPasswordAttempt(EMAIL.toUpperCase())).resolves.toEqual({
      allowed: false,
    });
  });

  it("logs at most once a minute, naming neither the address nor the key", async () => {
    await claimPasswordAttempt(EMAIL);
    await claimPasswordAttempt("someone@example.org");
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await claimPasswordAttempt(EMAIL);
    expect(mockLoggerError).toHaveBeenCalledTimes(2);

    const logged = everythingPassedTo(mockLoggerError).toLowerCase();
    expect(logged).not.toContain("example.org");
    expect(logged).not.toContain(loginAccountKey(EMAIL));
  });

  it("falls back without touching the store when no auth secret is set", async () => {
    mockGetAuthSecret.mockReturnValue(undefined);
    mockPrisma.$transaction.mockClear();
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("clearPasswordAttempts (#4609)", () => {
  it("deletes the account's row by key", async () => {
    await clearPasswordAttempts(EMAIL);
    expect(mockPrisma.loginThrottle.deleteMany).toHaveBeenCalledWith({
      where: { id: loginAccountKey(EMAIL) },
    });
  });

  it("also forgets the fallback count", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("down"));
    await claimPasswordAttempt(EMAIL);
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: false });
    await clearPasswordAttempts(EMAIL);
    await expect(claimPasswordAttempt(EMAIL)).resolves.toEqual({ allowed: true });
  });

  it("swallows a failed delete", async () => {
    mockPrisma.loginThrottle.deleteMany.mockRejectedValue(new Error("down"));
    await expect(clearPasswordAttempts(EMAIL)).resolves.toBeUndefined();
  });
});

describe("sweepIdleLoginThrottleRows (#4609 review)", () => {
  it("deletes only rows idle for an hour or more and reports how many", async () => {
    mockPrisma.loginThrottle.deleteMany.mockResolvedValue({ count: 3 });
    await expect(sweepIdleLoginThrottleRows()).resolves.toBe(3);
    expect(mockPrisma.loginThrottle.deleteMany).toHaveBeenCalledWith({
      where: { lastFailureAt: { lt: new Date(T0.getTime() - 3_600_000) } },
    });
  });
});
