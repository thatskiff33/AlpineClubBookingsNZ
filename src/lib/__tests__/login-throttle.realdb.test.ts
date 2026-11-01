/**
 * Real-PostgreSQL proof for the per-account password throttle's claim (#4609).
 *
 * `claimPasswordAttempt` ensures the account's `LoginThrottle` row, locks it,
 * reads it, decides and counts, in one transaction, BEFORE the password is
 * compared. The unit suites prove the order against a mock; only PostgreSQL can
 * prove that the row lock serialises real concurrent claims:
 *
 *   1. two failures racing on one account both count;
 *   2. a burst fired the moment a wait ends admits exactly one guess — the gap
 *      a bare upsert-increment after the password check would leave open;
 *   3. two first-ever claims on an account with no row yet both count;
 *   4. a row deleted (by a clear or the idle sweep) between the ensure and the
 *      lock is ensured and locked again, so the claim still counts in the store
 *      instead of falling back to per-process memory.
 *
 * ## The interleaving is FORCED, not raced
 *
 * A third connection holds the row (or its uncommitted insert) open; the claims
 * are started and the test waits on a BARRIER — `pg_stat_activity` reporting
 * the expected number of backends waiting on a lock while holding no
 * transaction id, i.e. blocked BEFORE writing anything. Only then is the holder
 * released. No `setTimeout` stands in for the interleaving.
 *
 * Probed against committed state: with the lock statement deleted from
 * `lockAccountRow` the claims block only at their update, already holding a
 * transaction id, so every forced case fails on the barrier's
 * write-before-lock diagnostic; with the re-ensure loop cut to one pass, case
 * 4 finds no row in the store.
 *
 * OFF by default, like every `*.realdb.test.ts`: it runs only with
 * `RUN_CONCURRENCY_RACE_TESTS=1` against `CONCURRENCY_RACE_DATABASE_URL`
 * (loopback, port 55442+, the `concurrency_race_1881` marker), and hosted CI
 * runs it through the import in `concurrency-lock-races.realdb.test.ts`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/login-throttle.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO, realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Login throttle (#4609)";

/** Beats Prisma's 5 s interactive-transaction default the claims run under. */
const BARRIER_TIMEOUT_MS = 2_000;
const RACE_TEST_TIMEOUT_MS = 20_000;
const T0 = new Date(FROZEN_TEST_CLOCK_BASE_ISO);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let prisma: typeof import("@/lib/prisma")["prisma"];
let throttle: typeof import("@/lib/login-throttle");
let logger: typeof import("@/lib/logger")["default"];
let holderClient: PrismaClient;
let observerClient: PrismaClient;
const keys: string[] = [];

(RUN ? describe : describe.skip)(
  "login throttle claim — real PostgreSQL (#4609)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let emailSeq = 0;
    /** A fresh account per test, so tests never share a row. */
    function freshAccount(): { email: string; key: string } {
      emailSeq += 1;
      const email = `race-4609-${emailSeq}@example.org`;
      const key = throttle.loginAccountKey(email);
      keys.push(key);
      return { email, key };
    }

    async function lockWaiters(): Promise<{ waiting: number; beforeAnyWrite: number }> {
      const rows = await observerClient.$queryRaw<
        Array<{ waiting: number; beforeAnyWrite: number }>
      >`
        SELECT
          COUNT(*)::int AS "waiting",
          (COUNT(*) FILTER (WHERE backend_xid IS NULL))::int AS "beforeAnyWrite"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()
      `;
      return { waiting: rows[0]?.waiting ?? 0, beforeAnyWrite: rows[0]?.beforeAnyWrite ?? 0 };
    }

    /**
     * Waits until `expected` claims are blocked. `requireNoWrite` demands they
     * hold no transaction id yet — blocked on the lock before counting.
     */
    async function waitForBlockedClaims(expected: number, requireNoWrite: boolean) {
      const startedAt = process.hrtime.bigint();
      let seen = { waiting: 0, beforeAnyWrite: 0 };
      while (realElapsedMs(startedAt) < BARRIER_TIMEOUT_MS) {
        seen = await lockWaiters();
        if ((requireNoWrite ? seen.beforeAnyWrite : seen.waiting) >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (seen.waiting >= expected) {
        throw new Error(
          `${expected} claim(s) blocked, but ${seen.waiting - seen.beforeAnyWrite} already hold a ` +
            "transaction id: claimPasswordAttempt writes BEFORE it locks the LoginThrottle " +
            "row, so the lock no longer serialises the read-decide-count (INV-AUTH, " +
            "docs/CONCURRENCY_AND_LOCKING.md).",
        );
      }
      throw new Error(
        `Timed out waiting for ${expected} claim(s) to block on the LoginThrottle row — saw ` +
          `${seen.waiting}. claimPasswordAttempt no longer locks the row before deciding, so ` +
          "parallel guesses can all pass one check (INV-AUTH, docs/CONCURRENCY_AND_LOCKING.md).",
      );
    }

    /**
     * Holds the account's row on its own connection until released: locked
     * with the claims' own statement, or (no row yet) inserted uncommitted.
     * `onRelease` runs inside the holder's transaction before it commits.
     */
    function holdRow(
      key: string,
      mode: "lock" | "insert",
      onRelease?: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>,
    ) {
      const held = deferred();
      const release = deferred();
      const done = holderClient.$transaction(
        async (tx) => {
          if (mode === "lock") {
            await tx.$executeRaw`SELECT 1 FROM "LoginThrottle" WHERE "id" = ${key} FOR UPDATE`;
          } else {
            await tx.loginThrottle.create({
              data: { id: key, failureCount: 0, lastFailureAt: T0 },
            });
          }
          held.resolve();
          await release.promise;
          if (onRelease) await onRelease(tx);
        },
        { timeout: 15_000 },
      );
      return { held: held.promise, release: release.resolve, done };
    }

    async function row(key: string) {
      return prisma.loginThrottle.findUnique({ where: { id: key } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      process.env.AUTH_SECRET ??= "login-throttle-race-secret";
      ({ prisma } = await import("@/lib/prisma"));
      throttle = await import("@/lib/login-throttle");
      ({ default: logger } = await import("@/lib/logger"));

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = separate("race-4609-holder");
      observerClient = separate("race-4609-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    }, 60_000);

    beforeEach(() => {
      throttle.resetLoginThrottleProcessState();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (typeof prisma !== "undefined") {
        await prisma.loginThrottle.deleteMany({ where: { id: { in: keys } } }).catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
      throttle?.resetLoginThrottleProcessState();
      await Promise.all(
        [holderClient, observerClient].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
    }, 60_000);

    it("two failures racing on one account both count", async () => {
      const { email, key } = freshAccount();
      await prisma.loginThrottle.create({
        data: { id: key, failureCount: 0, lastFailureAt: T0 },
      });
      const holder = holdRow(key, "lock");
      await holder.held;

      const claims = [throttle.claimPasswordAttempt(email), throttle.claimPasswordAttempt(email)];
      try {
        await waitForBlockedClaims(2, true);
      } finally {
        holder.release();
        await holder.done;
      }

      expect(await Promise.all(claims)).toEqual([{ allowed: true }, { allowed: true }]);
      expect((await row(key))?.failureCount).toBe(2);
    });

    it("a burst at the end of a wait admits exactly one guess", async () => {
      const { email, key } = freshAccount();
      // Five counted failures, the last 31 s ago: the 30 s wait has just ended.
      await prisma.loginThrottle.create({
        data: { id: key, failureCount: 5, lastFailureAt: new Date(T0.getTime() - 31_000) },
      });
      const holder = holdRow(key, "lock");
      await holder.held;

      const claims = [throttle.claimPasswordAttempt(email), throttle.claimPasswordAttempt(email)];
      try {
        await waitForBlockedClaims(2, true);
      } finally {
        holder.release();
        await holder.done;
      }

      const outcomes = await Promise.all(claims);
      expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(1);
      expect(await row(key)).toEqual({ id: key, failureCount: 6, lastFailureAt: T0 });
    });

    it("two first-ever claims on an account with no row both count", async () => {
      const { email, key } = freshAccount();
      // An uncommitted insert of the row: both claims' ensure step waits on it.
      const holder = holdRow(key, "insert");
      await holder.held;

      const claims = [throttle.claimPasswordAttempt(email), throttle.claimPasswordAttempt(email)];
      try {
        await waitForBlockedClaims(2, false);
      } finally {
        holder.release();
        await holder.done;
      }

      expect(await Promise.all(claims)).toEqual([{ allowed: true }, { allowed: true }]);
      expect((await row(key))?.failureCount).toBe(2);
    });

    it("re-ensures a row deleted between the ensure and the lock, and still counts in the store", async () => {
      const { email, key } = freshAccount();
      await prisma.loginThrottle.create({
        data: { id: key, failureCount: 3, lastFailureAt: T0 },
      });
      const errors = vi.spyOn(logger, "error");
      // The holder locks the row, then deletes it — as a clear would — and
      // commits while the claim is blocked between its ensure and its lock.
      const holder = holdRow(key, "lock", (tx) =>
        tx.loginThrottle.deleteMany({ where: { id: key } }),
      );
      await holder.held;

      const claim = throttle.claimPasswordAttempt(email);
      try {
        await waitForBlockedClaims(1, true);
      } finally {
        holder.release();
        await holder.done;
      }

      await expect(claim).resolves.toEqual({ allowed: true });
      // Counted afresh in PostgreSQL, not in the per-process fallback.
      expect(await row(key)).toEqual({ id: key, failureCount: 1, lastFailureAt: T0 });
      expect(errors).not.toHaveBeenCalled();
    });
  },
);
