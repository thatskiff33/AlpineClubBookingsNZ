/**
 * Real-PostgreSQL proof of the Xero token store (#3806): the only refresh
 * lease is `XeroConnection.refreshInProgressUntil`, and the tokens live only
 * in the credential store. Connect and disconnect do not need a `XeroToken`
 * table.
 *
 * The unit suite (`xero-token-credential-store.test.ts`) proves the audit
 * contract against a stateful double. What a double cannot prove is what
 * PostgreSQL does with two writers at once:
 *
 *   - one of two simultaneous claims wins, and the other holds nothing;
 *   - the winner's lease is only that connection column;
 *   - a save loses when that lease was replaced, and writes neither the
 *     connection nor the store;
 *   - a release clears only its own lease.
 *
 * Ordinary Vitest runs skip the PostgreSQL cases. The file reuses the guarded,
 * disposable loopback PostgreSQL `concurrency-lock-races.realdb.test.ts`
 * provisions (#1881), which imports this file so CI reaches it. The safety
 * guard below always runs: never port 5432, never a non-loopback host, never
 * a shared database (`assertSafeXeroTokenRaceDbUrl`).
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-token-credential-store.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as raceDbUrl from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 20_000;
const TEMP_AUTH_SECRET = "race-3454-auth-secret-0123456789abcdefghijklmnop";

/** Keep the existing entry point; INV-SSOT-004 gives the safety policy one home. */
export function assertSafeXeroTokenRaceDbUrl(url: string): void {
  raceDbUrl.assertSafeRaceDbUrl(url, "Xero token store");
}

describe("Xero token race DB safety guard (#3454)", () => {
  it("propagates the canonical safety refusal (#4175, INV-SSOT-004)", () => {
    const url = "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881";
    const refusal = new Error("synthetic canonical safety refusal");
    const guard = vi.spyOn(raceDbUrl, "assertSafeRaceDbUrl").mockImplementationOnce(() => {
      throw refusal;
    });
    try {
      expect(() => assertSafeXeroTokenRaceDbUrl(url)).toThrow(refusal);
      expect(guard).toHaveBeenCalledExactlyOnceWith(url, "Xero token store");
    } finally {
      guard.mockRestore();
    }
  });

  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeXeroTokenRaceDbUrl("postgresql://u:p@127.0.0.1:55442/concurrency_race_1881"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.example.org:55442/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeXeroTokenRaceDbUrl(url)).toThrow();
  });
});

type CapturedAuthSecret = { value: string | undefined };

/** The actual setup boundary, exercised without importing or connecting to Prisma. */
function setUpXeroTokenRaceEnvironment(url: string): CapturedAuthSecret {
  assertSafeXeroTokenRaceDbUrl(url);
  process.env.DATABASE_URL = url;
  const savedAuthSecret = { value: process.env.AUTH_SECRET };
  // The token store refuses to encrypt under a weak secret; this one is a
  // throwaway for a throwaway database.
  process.env.AUTH_SECRET = TEMP_AUTH_SECRET;
  return savedAuthSecret;
}

/** Also exercised without PostgreSQL, so cleanup failures cannot hide a secret leak. */
async function tearDownXeroTokenRaceSuite(
  savedAuthSecret: CapturedAuthSecret | undefined,
  cleanup: { tokens: () => Promise<unknown>; audit: () => Promise<unknown> } | undefined,
): Promise<void> {
  try {
    if (cleanup) {
      await cleanup.tokens();
      await cleanup.audit();
    }
  } finally {
    if (savedAuthSecret) {
      if (savedAuthSecret.value === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuthSecret.value;
    }
  }
}

describe("Xero token race setup and teardown restore AUTH_SECRET (#4164, #4174)", () => {
  let originalAuthSecret: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalAuthSecret = process.env.AUTH_SECRET;
    originalDatabaseUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  describe.each([undefined, "previous", ""])("previous secret %j", (previousSecret) => {
    beforeEach(() => {
      if (previousSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousSecret;
    });

    it.each(["", "postgresql://u:p@db.example.org:55442/concurrency_race_1881"])(
      "preserves the secret when setup rejects URL %j (#4174)",
      async (url) => {
        let savedAuthSecret: CapturedAuthSecret | undefined;
        expect(() => {
          savedAuthSecret = setUpXeroTokenRaceEnvironment(url);
        }).toThrow();
        expect(process.env.DATABASE_URL).toBe(originalDatabaseUrl);

        await tearDownXeroTokenRaceSuite(savedAuthSecret, undefined);

        expect(process.env.AUTH_SECRET).toBe(previousSecret);
        expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
      },
    );
    it.each(["tokens", "audit"] as const)(
      "restores after %s cleanup rejects and preserves its error",
      async (failingStep) => {
        const savedAuthSecret = setUpXeroTokenRaceEnvironment(
          "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881",
        );
        expect(process.env.AUTH_SECRET).toBe(TEMP_AUTH_SECRET);
        const error = new Error(`${failingStep} cleanup failed`);
        const cleanup = {
          tokens: vi.fn(async () => {}),
          audit: vi.fn(async () => {}),
        };
        cleanup[failingStep].mockRejectedValueOnce(error);

        await expect(tearDownXeroTokenRaceSuite(savedAuthSecret, cleanup)).rejects.toBe(error);

        expect(process.env.AUTH_SECRET).toBe(previousSecret);
        expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
        expect(cleanup.tokens).toHaveBeenCalledOnce();
        expect(cleanup.audit).toHaveBeenCalledTimes(failingStep === "tokens" ? 0 : 1);
      },
    );

    it("restores after successful cleanup", async () => {
      const savedAuthSecret = setUpXeroTokenRaceEnvironment(
        "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881",
      );
      expect(process.env.AUTH_SECRET).toBe(TEMP_AUTH_SECRET);
      const cleanup = {
        tokens: vi.fn(async () => {}),
        audit: vi.fn(async () => {}),
      };

      await tearDownXeroTokenRaceSuite(savedAuthSecret, cleanup);

      expect(process.env.AUTH_SECRET).toBe(previousSecret);
      expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
      expect(cleanup.tokens).toHaveBeenCalledOnce();
      expect(cleanup.audit).toHaveBeenCalledOnce();
    });
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let store: typeof import("@/lib/xero-token-store");
let credentials: typeof import("@/lib/integration-credentials");
let StaleCredentialWriteError: (typeof import("@/lib/integration-credential-actor"))["StaleCredentialWriteError"];
let previousAuthSecret: CapturedAuthSecret | undefined;

const ADMIN = { kind: "admin", memberId: "race-3454-admin" } as const;
const REFRESH_JOB = { kind: "system", actor: "xero-token-refresh" } as const;
const TENANT = "race-3806-tenant";

(RUN ? describe : describe.skip)(
  "Xero token store — real PostgreSQL (#3806)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function clearTokens() {
      await prisma.xeroConnection.deleteMany();
      await prisma.integrationCredential.deleteMany({
        where: { provider: { in: [store.XERO_OAUTH_TOKEN_PROVIDER, "xero"] } },
      });
      credentials.resetIntegrationCredentialCacheForTests();
    }

    function tokens(tag: string, expiresInMs = 60_000) {
      return {
        accessToken: `race-3806-access-${tag}`,
        refreshToken: `race-3806-refresh-${tag}`,
        expiresAt: new Date(Date.now() + expiresInMs),
        tenantId: TENANT,
      };
    }

    async function connect(tag: string) {
      await store.saveXeroTokens(tokens(tag), { actor: ADMIN });
    }

    async function connectionLease(): Promise<Date | null> {
      const connection = await prisma.xeroConnection.findUnique({
        where: { id: "default" },
        select: { refreshInProgressUntil: true },
      });
      return connection?.refreshInProgressUntil ?? null;
    }

    async function storeRow() {
      return prisma.integrationCredential.findUnique({
        where: {
          provider_key: {
            provider: store.XERO_OAUTH_TOKEN_PROVIDER,
            key: store.XERO_OAUTH_TOKEN_KEY,
          },
        },
      });
    }

    beforeAll(async () => {
      previousAuthSecret = setUpXeroTokenRaceEnvironment(RACE_DB_URL);
      ({ prisma } = await import("@/lib/prisma"));
      store = await import("@/lib/xero-token-store");
      credentials = await import("@/lib/integration-credentials");
      ({ StaleCredentialWriteError } = await import("@/lib/integration-credential-actor"));
      await clearTokens();
    });

    beforeEach(async () => {
      await clearTokens();
    });

    afterAll(async () => {
      await tearDownXeroTokenRaceSuite(
        previousAuthSecret,
        prisma
          ? {
              tokens: clearTokens,
              audit: () =>
                prisma.auditLog.deleteMany({
                  where: {
                    entityId: {
                      in: [
                        `${store.XERO_OAUTH_TOKEN_PROVIDER}:${store.XERO_OAUTH_TOKEN_KEY}`,
                        "xero:token_key",
                      ],
                    },
                  },
                }),
            }
          : undefined,
      );
    });

    it("lets exactly one of two simultaneous claims win, and the other holds nothing", async () => {
      await connect("c1");

      const claims = await Promise.all([
        store.claimXeroTokenRefreshLease(),
        store.claimXeroTokenRefreshLease(),
      ]);

      const winners = claims.filter((claim) => claim.claimed);
      expect(winners).toHaveLength(1);
      const loser = claims.find((claim) => !claim.claimed);
      expect(loser?.tokens?.refreshToken).toBe("race-3806-refresh-c1");
      const lease = await connectionLease();
      expect(lease?.getTime()).toBe(winners[0]!.leaseUntil.getTime());
    });

    it("a save loses when that lease was replaced and writes neither the connection nor the store", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      const replacedUntil = new Date(claim.leaseUntil.getTime() + 60_000);
      await prisma.xeroConnection.update({
        where: { id: "default" },
        data: { refreshInProgressUntil: replacedUntil },
      });
      const connectionBefore = await prisma.xeroConnection.findFirstOrThrow();
      const storedBefore = await storeRow();

      await expect(
        store.saveXeroTokens(tokens("refreshed", 1_800_000), {
          actor: REFRESH_JOB,
          lease: claim.lease,
        }),
      ).rejects.toThrow(/lease expired/);

      expect(await prisma.xeroConnection.findFirstOrThrow()).toEqual(connectionBefore);
      expect(await storeRow()).toEqual(storedBefore);
    });

    it("rolls the connection back when the store's compare-and-set loses", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      await credentials.withCredentialTransaction([store.XERO_OAUTH_TOKEN_PROVIDER], (tx) =>
        credentials.setIntegrationCredentialInTransaction({
          tx,
          provider: store.XERO_OAUTH_TOKEN_PROVIDER,
          key: store.XERO_OAUTH_TOKEN_KEY,
          value: "{}",
          actor: ADMIN,
          expect: { expect: "any" },
        }),
      );
      const connectionBefore = await prisma.xeroConnection.findFirstOrThrow();
      const storedBefore = await storeRow();

      await expect(
        store.saveXeroTokens(tokens("refreshed", 1_800_000), {
          actor: REFRESH_JOB,
          lease: claim.lease,
        }),
      ).rejects.toBeInstanceOf(StaleCredentialWriteError);

      expect(await prisma.xeroConnection.findFirstOrThrow()).toEqual(connectionBefore);
      expect(await storeRow()).toEqual(storedBefore);
      expect((await connectionLease())?.getTime()).toBe(claim.leaseUntil.getTime());
    });

    it("release clears only its own lease", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      await store.releaseXeroTokenRefreshLease(claim.lease);
      expect(await connectionLease()).toBeNull();

      const again = await store.claimXeroTokenRefreshLease();
      if (!again.claimed) throw new Error("expected the lease");
      const newer = new Date(again.leaseUntil.getTime() + 60_000);
      await prisma.xeroConnection.update({
        where: { id: "default" },
        data: { refreshInProgressUntil: newer },
      });
      await store.releaseXeroTokenRefreshLease(again.lease);
      expect((await connectionLease())?.getTime()).toBe(newer.getTime());
    });

    it("connect and disconnect do not need a XeroToken table", async () => {
      const present = await prisma.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'XeroToken'
        ) AS "exists"`;
      expect(present[0]?.exists).toBe(false);

      await connect("c1");
      expect(await prisma.xeroConnection.count()).toBe(1);
      expect(await storeRow()).not.toBeNull();

      await store.deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });
      expect(await prisma.xeroConnection.count()).toBe(0);
      expect(await storeRow()).toBeNull();
    });
  },
);
