/**
 * Real-PostgreSQL proof of the Xero token store's two fences (#3454).
 *
 * The unit suite (`xero-token-credential-store.test.ts`) proves the reconcile
 * and the audit contract against a stateful double. What a double cannot prove
 * is what PostgreSQL does with two writers at once, and that is what keeps a
 * rotating refresh token from being spent twice:
 *
 *   - two processes claiming the refresh lease AT THE SAME TIME — this code
 *     against itself, and this code against a deployed OLDER colour that
 *     claims the same `XeroToken` column with its own statement — let exactly
 *     one through, because the status-guarded `UPDATE` re-evaluates its
 *     predicate after the row lock;
 *   - a refresh whose store compare-and-set loses rolls the `XeroToken` mirror
 *     update back with it, in a real transaction.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it. `XeroToken` is a singleton
 * table nothing else in that harness uses; this file clears it and its own
 * `xero-oauth` credential row before and after.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-token-credential-store.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 20_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeXeroTokenRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Xero token race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run Xero token race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Xero token race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Xero token race proof DB name must contain 'concurrency_race_1881'.");
  }
}

describe("Xero token race DB safety guard (#3454)", () => {
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

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let store: typeof import("@/lib/xero-token-store");
let credentials: typeof import("@/lib/integration-credentials");
let StaleCredentialWriteError: (typeof import("@/lib/integration-credential-actor"))["StaleCredentialWriteError"];
let previousAuthSecret: string | undefined;

const ADMIN = { kind: "admin", memberId: "race-3454-admin" } as const;
const REFRESH_JOB = { kind: "system", actor: "xero-token-refresh" } as const;

(RUN ? describe : describe.skip)(
  "Xero token store — real PostgreSQL (#3454)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function clearTokens() {
      await prisma.xeroToken.deleteMany();
      await prisma.integrationCredential.deleteMany({
        where: { provider: store.XERO_OAUTH_TOKEN_PROVIDER },
      });
      credentials.resetIntegrationCredentialCacheForTests();
    }

    async function connect(tag: string) {
      await store.saveXeroTokens(
        {
          accessToken: `race-3454-access-${tag}`,
          refreshToken: `race-3454-refresh-${tag}`,
          expiresAt: new Date(Date.now() + 60_000),
          tenantId: "race-3454-tenant",
        },
        { actor: ADMIN },
      );
    }

    beforeAll(async () => {
      assertSafeXeroTokenRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      previousAuthSecret = process.env.AUTH_SECRET;
      // The token store refuses to encrypt under a weak secret; this one is a
      // throwaway for a throwaway database.
      process.env.AUTH_SECRET = "race-3454-auth-secret-0123456789abcdefghijklmnop";
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
      if (prisma) {
        await clearTokens();
        await prisma.auditLog.deleteMany({
          where: { entityId: `${store.XERO_OAUTH_TOKEN_PROVIDER}:${store.XERO_OAUTH_TOKEN_KEY}` },
        });
      }
      if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousAuthSecret;
    });

    it("lets exactly one of several simultaneous claims take the lease", async () => {
      await connect("c1");

      const claims = await Promise.all(
        Array.from({ length: 6 }, () => store.claimXeroTokenRefreshLease()),
      );

      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      // Every loser was handed the same live tokens to wait on.
      for (const claim of claims) {
        expect(claim.tokens?.refreshToken).toBe("race-3454-refresh-c1");
      }
    });

    it("lets exactly one through when an OLDER colour claims the same lease at the same time", async () => {
      await connect("c1");
      const now = new Date();
      const lease = new Date(now.getTime() + 120_000);

      // The previous release's claim, as the statement its Prisma client issues.
      const oldColourClaim = prisma.$executeRaw`
        UPDATE "XeroToken"
           SET "refreshInProgressUntil" = ${lease}
         WHERE "refreshInProgressUntil" IS NULL
            OR "refreshInProgressUntil" <= ${now}`;
      const [oldRows, ours] = await Promise.all([
        oldColourClaim,
        store.claimXeroTokenRefreshLease({ now }),
      ]);

      expect(Number(oldRows) + (ours.claimed ? 1 : 0)).toBe(1);
    });

    it("rolls the mirror back when the store's compare-and-set loses, in a real transaction", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      // A writer that bypassed the lease replaced the store copy.
      await credentials.withCredentialTransaction(
        [store.XERO_OAUTH_TOKEN_PROVIDER],
        (tx) =>
          credentials.setIntegrationCredentialInTransaction({
            tx,
            provider: store.XERO_OAUTH_TOKEN_PROVIDER,
            key: store.XERO_OAUTH_TOKEN_KEY,
            value: "{}",
            actor: ADMIN,
            expect: { expect: "any" },
          }),
      );
      const mirrorBefore = await prisma.xeroToken.findFirstOrThrow();

      await expect(
        store.saveXeroTokens(
          {
            accessToken: "race-3454-access-refreshed",
            refreshToken: "race-3454-refresh-refreshed",
            expiresAt: new Date(Date.now() + 1_800_000),
            tenantId: "race-3454-tenant",
          },
          {
            actor: REFRESH_JOB,
            lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
          },
        ),
      ).rejects.toBeInstanceOf(StaleCredentialWriteError);

      const mirrorAfter = await prisma.xeroToken.findFirstOrThrow();
      expect(mirrorAfter.accessToken).toBe(mirrorBefore.accessToken);
      expect(mirrorAfter.refreshToken).toBe(mirrorBefore.refreshToken);
      expect(mirrorAfter.refreshInProgressUntil?.getTime()).toBe(
        claim.leaseUntil.getTime(),
      );
    });

    it("lets one of two simultaneous refresh saves under the same lease land, never both", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      const save = (tag: string) =>
        store.saveXeroTokens(
          {
            accessToken: `race-3454-access-${tag}`,
            refreshToken: `race-3454-refresh-${tag}`,
            expiresAt: new Date(Date.now() + 1_800_000),
            tenantId: "race-3454-tenant",
          },
          {
            actor: REFRESH_JOB,
            lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
          },
        );

      const results = await Promise.allSettled([save("a"), save("b")]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await store.loadXeroTokens();
      const winner = results[0].status === "fulfilled" ? "a" : "b";
      expect(current?.refreshToken).toBe(`race-3454-refresh-${winner}`);
      // Mirror and store agree: the reconcile reads the store copy.
      expect(current?.storeVersion).not.toBeNull();
    });
  },
);
