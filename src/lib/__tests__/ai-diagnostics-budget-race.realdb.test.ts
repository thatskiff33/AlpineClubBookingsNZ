/**
 * Real-Postgres over-budget RACE regression for the AI Diagnostics monthly
 * budget reserve (AID-2, #2371; closes the #2532 carry-forward).
 *
 * `reserveDiagnosticsBudget` is a guarded spend claim: under a per-month advisory
 * lock it sweeps expired reservations, sums live reservations + settled spend,
 * and inserts a reservation ONLY if `settled + reserved + reserve <= budget`.
 * `decideReservation` is exhaustively unit/mutation-tested without a database and
 * the advisory-lock-first wiring is asserted in `ai-diagnostics-usage.test.ts`,
 * but the money-safety invariant that N GENUINELY CONCURRENT reservers can never
 * push spend over the budget can only be proven against a real PostgreSQL — an
 * in-process fake cannot reproduce `pg_advisory_xact_lock` mutual exclusion or a
 * READ COMMITTED snapshot. This suite drives the PRODUCTION function (not a
 * re-implementation) from two to five concurrent callers and asserts exactly the
 * budgeted number of reservations win and the live-reservation sum never exceeds
 * the budget.
 *
 * ## The proof is FORCED, not raced (#2532)
 *
 * The first test does not hope the interleaving happens. A third connection
 * takes the SAME per-month advisory lock and holds it open; the two reservers
 * are then started and the test waits on a BARRIER — `pg_locks` reporting both
 * of them blocked on exactly that advisory key AND (via `pg_stat_activity`) not
 * yet holding a transaction id, i.e. blocked BEFORE writing anything. Only then
 * is the holder released. No `setTimeout` stands in for the interleaving, so
 * the test neither flakes when CI is slow nor passes vacuously when it is fast.
 *
 * That barrier is what makes the suite a real regression gate. Three ways of
 * losing the protection were reproduced against a throwaway PostgreSQL (three
 * runs each, no flaky pass) before this was committed:
 *   - DELETE the `pg_advisory_xact_lock` line from `reserveDiagnosticsBudget`
 *     and the reservers never queue, so the barrier times out with a named
 *     diagnostic naming the lock and the invariant it protects.
 *   - MOVE it to after the budget reads and the barrier is satisfied (they do
 *     queue) but both reservers then win — 2 x 40c admitted against a 50c
 *     budget, caught by the one-winner assertion.
 *   - MOVE it to after the guarded insert and the reservers queue holding a
 *     transaction id, which the barrier's `backend_xid IS NULL` clause rejects
 *     with a diagnostic naming the write-before-lock ordering.
 *
 * ## What this file does NOT claim
 *
 * There is deliberately no "neither reserver has inserted a row yet" count
 * taken across a separate connection while the lock is held: under READ
 * COMMITTED an uncommitted insert made by a blocked reserver is invisible to
 * any other backend, so such a count is 0 whether the production code is
 * correct or not. The honest in-flight evidence is (a) the barrier's
 * `backend_xid IS NULL` clause, which is what actually distinguishes
 * lock-before-write from lock-after-write, and (b) the in-process settled flags
 * asserted below, which catch a reserver that returned early (e.g. fail-closed
 * `metering_unavailable`) while two unrelated sessions happened to be queued.
 *
 * Like `concurrency-lock-races.realdb.test.ts`, it is OFF by default and a no-op
 * in ordinary CI/local runs:
 *   - The race describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`; otherwise
 *     it is `describe.skip`, so `npm test` never needs a live database.
 *   - It reads ONLY `CONCURRENCY_RACE_DATABASE_URL` and requires a loopback host,
 *     port 55442+, and the dedicated `concurrency_race_1881` database marker.
 *   - Hosted CI runs it by importing this file from that guarded harness (see the
 *     import in `concurrency-lock-races.realdb.test.ts`), which supplies the
 *     dedicated localhost database with every migration already deployed.
 *
 * To run it directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   npx vitest run src/lib/__tests__/ai-diagnostics-budget-race.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * The first advisory-lock key `reserveDiagnosticsBudget` (and
 * `settleDiagnosticsRoundtrip`) hashes, per docs/CONCURRENCY_AND_LOCKING.md.
 * The second key is the billing month, so different months never contend.
 * Kept as a constant because the barrier below has to look for THIS key in
 * `pg_locks` — a lock taken on some other key would not serialise reservers.
 */
const BUDGET_LOCK_NAME = "diagnostics-budget-reserve";

/**
 * How long the lock barrier waits for the reservers to queue before giving up
 * with its own named diagnostic — far more useful than Vitest's generic test
 * timeout, so it has to be the FIRST clock to expire on the failure path.
 *
 * Two clocks it must beat, with the arithmetic spelled out rather than assumed:
 *   - `reserveDiagnosticsBudget` calls `prisma.$transaction(fn)` with no options
 *     (`src/lib/ai-diagnostics-usage.ts`), so each reserver runs on Prisma's
 *     default 5s interactive-transaction timeout, and the time it spends blocked
 *     on `pg_advisory_xact_lock` counts against that 5s. At 2s the barrier
 *     leaves ~3s of headroom; at 4s it left under 1s, and a loaded runner could
 *     make both reservers die with P2028 → `metering_unavailable` and report the
 *     useless "0 winners" instead of naming the lock.
 *   - Vitest's own per-test timeout, which defaults to 5000ms because
 *     `vitest.config.mts` sets none. The race `describe` below therefore declares
 *     an explicit 20s timeout (the sibling harness does the same at
 *     `concurrency-lock-races.realdb.test.ts`), so the barrier's named
 *     diagnostic is never pre-empted by a generic "Test timed out in 5000ms".
 *
 * Measured with `process.hrtime.bigint()` via `realElapsedMs`, never
 * `Date.now()`: since #2481 every test file runs with `Date` frozen, so a
 * `Date.now()` deadline can never expire and the poller would spin until the
 * test was killed with no lock named.
 */
const LOCK_POLL_TIMEOUT_MS = 2_000;

/**
 * Ceiling for the forced-barrier test. Generous next to the 2s barrier so that
 * a slow runner never converts "the lock is gone" into "Test timed out in
 * 5000ms", but still bounded so a genuinely wedged lock fails the job.
 */
const RACE_TEST_TIMEOUT_MS = 20_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the shared race-harness database
 * marker — the same envelope as `assertSafeRaceDbUrl` in
 * `concurrency-lock-races.realdb.test.ts`, re-declared here so this file can be
 * run standalone without importing (and re-registering) that whole harness.
 */
export function assertSafeDiagnosticsRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Diagnostics budget race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run diagnostics budget race tests against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Diagnostics budget race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Diagnostics budget race DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

let prisma: typeof import("@/lib/prisma")["prisma"];
let reserveDiagnosticsBudget: typeof import("@/lib/ai-diagnostics-usage")["reserveDiagnosticsBudget"];
let diagnosticsUsageMonthKey: typeof import("@/lib/ai-diagnostics-usage")["diagnosticsUsageMonthKey"];
/**
 * Two SEPARATE single-connection clients, each on its own PostgreSQL backend
 * (the same idiom as `concurrency-lock-races.realdb.test.ts`):
 *
 * - `lockHolderClient` holds the per-month advisory lock open inside a real
 *   transaction, which is what pins the reservers in a known state.
 * - `observerClient` polls `pg_locks`. It is deliberately NOT the application
 *   singleton: the two blocked reservers are holding singleton pool
 *   connections, and the barrier must never be able to starve behind them.
 */
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

// A fixed, far-future instant keeps the whole suite in one isolated billing
// month ("2099-03") that no other harness or real data touches. Passing it as
// `now` also makes each reservation's `expiresAt` deterministic (now + TTL), so
// the reservations stay "live" for the aggregate check and the crash-safety
// sweep never reclaims one mid-test.
const RACE_NOW = new Date("2099-03-15T00:00:00.000Z");

describe("diagnostics budget race DB safety guard (#2532)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeDiagnosticsRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeDiagnosticsRaceDbUrl(url)).toThrow();
  });
});

// Run only when explicitly enabled; otherwise this is a pure no-op that never
// imports Prisma or connects to a database.
(RUN ? describe : describe.skip)(
  "diagnostics budget over-budget race — real PostgreSQL (#2371 / #2532)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let month: string;

    async function clearMonth() {
      await prisma.diagnosticsBudgetReservation.deleteMany({ where: { month } });
      await prisma.diagnosticsUsageMonthly.deleteMany({ where: { month } });
    }

    async function setBudget(monthlyBudgetCents: number) {
      await prisma.diagnosticsSettings.upsert({
        where: { id: "default" },
        create: { id: "default", monthlyBudgetCents },
        update: { monthlyBudgetCents },
      });
    }

    /** Sum of the live (unexpired) reservations booked for the test month. */
    async function liveReservedCents(): Promise<number> {
      const agg = await prisma.diagnosticsBudgetReservation.aggregate({
        _sum: { reservedCents: true },
        where: { month, expiresAt: { gt: RACE_NOW } },
      });
      return agg._sum.reservedCents ?? 0;
    }

    /** Every reservation row for the test month, live or expired. */
    async function reservationRowCount(): Promise<number> {
      return prisma.diagnosticsBudgetReservation.count({ where: { month } });
    }

    /**
     * How many sessions are currently WAITING (granted = false) for the
     * per-month diagnostics budget advisory lock, split by whether they have
     * already written anything inside their transaction.
     *
     * `pg_advisory_xact_lock(int4, int4)` stores its two keys in `pg_locks` as
     * `classid`/`objid`, with `objsubid = 2` marking the two-key form. Those
     * columns are `oid` (unsigned) while `hashtext()` is a signed `int4` that is
     * routinely negative, so both sides are compared as UNSIGNED 32-bit
     * `bigint`s. Comparing them raw would silently match nothing and the barrier
     * would time out even with a perfectly correct lock.
     *
     * `pg_stat_activity.backend_xid` is the discriminating column and the reason
     * this barrier is not merely decorative. PostgreSQL assigns a transaction id
     * lazily, at a backend's FIRST heap write — so a reserver that took the lock
     * as its first statement (the correct order) is queued with `backend_xid IS
     * NULL`, while one that inserted its reservation and only then reached the
     * lock is queued holding a real xid. A cross-connection row count cannot see
     * that difference at all: under READ COMMITTED the uncommitted insert is
     * invisible to every other backend.
     */
    async function pendingBudgetLockWaiters(): Promise<{
      waiting: number;
      waitingBeforeAnyWrite: number;
    }> {
      const rows = await observerClient.$queryRaw<
        Array<{ waiting: number; waitingBeforeAnyWrite: number }>
      >`
        SELECT
          COUNT(*)::int AS "waiting",
          (COUNT(*) FILTER (WHERE a.backend_xid IS NULL))::int
            AS "waitingBeforeAnyWrite"
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.objsubid = 2
          AND l.granted = false
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid::bigint =
            ((hashtext(${BUDGET_LOCK_NAME})::bigint + 4294967296) % 4294967296)
          AND l.objid::bigint =
            ((hashtext(${month})::bigint + 4294967296) % 4294967296)
      `;
      return {
        waiting: rows[0]?.waiting ?? 0,
        waitingBeforeAnyWrite: rows[0]?.waitingBeforeAnyWrite ?? 0,
      };
    }

    /**
     * The BARRIER. Blocks until PostgreSQL itself reports `expected` sessions
     * queued on the per-month budget key HAVING WRITTEN NOTHING YET — the only
     * honest signal that the reservers really reached the lock first and really
     * could not proceed. Polling `pg_locks` is not "sleep-based racing": nothing
     * here stands in for the interleaving, the interleaving is held open by
     * `lockHolderClient` and this only detects when it is fully established.
     *
     * The two failure messages are deliberately different, because they name
     * different regressions: nobody queued means the lock is gone; queued but
     * already holding a transaction id means the lock was taken AFTER the
     * read-check-insert, which serialises nothing that matters.
     */
    async function waitForBudgetLockWaiters(expected: number): Promise<void> {
      const startedAt = process.hrtime.bigint();
      let seen = { waiting: 0, waitingBeforeAnyWrite: 0 };
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await pendingBudgetLockWaiters();
        if (seen.waitingBeforeAnyWrite >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const lockKey =
        `pg_advisory_xact_lock(hashtext('${BUDGET_LOCK_NAME}'), hashtext('${month}'))`;
      if (seen.waiting >= expected) {
        throw new Error(
          `${expected} reserver(s) queued on ${lockKey}, but ${seen.waiting - seen.waitingBeforeAnyWrite} ` +
            "of them already hold a transaction id — reserveDiagnosticsBudget writes " +
            "(sweeps or inserts) BEFORE taking the per-month budget lock, so the lock no " +
            "longer makes the read-check-insert atomic and concurrent reservers can " +
            "overspend the monthly budget (docs/CONCURRENCY_AND_LOCKING.md).",
        );
      }
      throw new Error(
        `Timed out waiting for ${expected} reserver(s) to queue on ${lockKey} — ` +
          `saw ${seen.waiting}. ` +
          "reserveDiagnosticsBudget no longer serialises on the per-month budget lock, " +
          "so concurrent reservers can read the same under-budget snapshot and overspend " +
          "the monthly budget (docs/CONCURRENCY_AND_LOCKING.md).",
      );
    }

    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing Prisma or the metering module,
      // then point the app singleton at it — mirroring the sibling harness so
      // the skipped suite is a true no-op when the dedicated URL is absent.
      assertSafeDiagnosticsRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ reserveDiagnosticsBudget, diagnosticsUsageMonthKey } = await import(
        "@/lib/ai-diagnostics-usage"
      ));
      // The same zone the reserver resolves (#3567 D6): the stored one, or the
      // seed while this scratch database records none.
      const { clubTimeZone } = await import("@/lib/club-time/server");
      month = diagnosticsUsageMonthKey(RACE_NOW, await clubTimeZone());

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([
          import("@prisma/client"),
          import("@/lib/prisma-adapter"),
        ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      lockHolderClient = createSeparateClient("race-2532-lock-holder");
      observerClient = createSeparateClient("race-2532-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await clearMonth();
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
      if (typeof prisma !== "undefined") {
        await prisma.diagnosticsBudgetReservation
          .deleteMany({ where: { month } })
          .catch(() => {});
        await prisma.diagnosticsUsageMonthly
          .deleteMany({ where: { month } })
          .catch(() => {});
        await prisma.diagnosticsSettings
          .deleteMany({ where: { id: "default" } })
          .catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
    }, 60_000);

    it("FORCES the overspend interleaving: two reservers queue on the per-month lock, neither can insert while it is held, and exactly one claims the budget", async () => {
      // 50c budget, two 40c reserves: either alone fits, both together do not.
      const reserveCents = 40;
      const budgetCents = 50;
      await setBudget(budgetCents);
      await clearMonth();

      const lockHeld = deferred();
      const releaseLock = deferred();

      // A THIRD connection takes the production lock's exact key and parks on
      // it. Reserve is now guaranteed to block, whatever the machine's timing.
      // Its transaction timeout stays BELOW this suite's per-test timeout so
      // that even a test killed by Vitest cannot leave the advisory key pinned
      // for the tests that follow.
      let holderError: unknown;
      const holder = lockHolderClient
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_NAME}), hashtext(${month}))`;
            lockHeld.resolve();
            await releaseLock.promise;
          },
          { maxWait: 5_000, timeout: 10_000 },
        )
        .catch((error: unknown) => {
          // Never leave the test parked on `lockHeld` if the holder itself
          // failed: unblock it and let the assertion below name the cause.
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) {
        throw new Error(
          `The lock-holder connection could not hold ${BUDGET_LOCK_NAME}/${month}: ${String(holderError)}`,
        );
      }

      // Start both reservers. Neither can get past its first statement. The
      // settled flags are the in-process half of the evidence: a reserver that
      // bailed out early (fail-closed `metering_unavailable`, say) while two
      // unrelated sessions happened to be queued would satisfy the pg_locks
      // barrier but not this.
      let aSettled = false;
      let bSettled = false;
      const reserveA = reserveDiagnosticsBudget({
        reserveCents,
        now: RACE_NOW,
      }).finally(() => {
        aSettled = true;
      });
      const reserveB = reserveDiagnosticsBudget({
        reserveCents,
        now: RACE_NOW,
      }).finally(() => {
        bSettled = true;
      });

      // Everything observed while the lock is held goes in a try/finally: if an
      // observation fails (which is EXACTLY what happens when the production
      // lock is removed) the holder must still be released, or its transaction
      // sits on the advisory key until its own 10s timeout and the three tests
      // below fail with unrelated P2028 → `metering_unavailable` noise instead
      // of this test's named diagnostic.
      let observationError: unknown;
      try {
        await waitForBudgetLockWaiters(2);
        expect(aSettled || bSettled).toBe(false);
      } catch (error) {
        observationError = error;
      } finally {
        releaseLock.resolve();
      }

      const [, a, b] = await Promise.all([holder, reserveA, reserveB]);
      if (observationError) throw observationError;
      if (holderError) {
        throw new Error(
          `The lock-holder connection dropped ${BUDGET_LOCK_NAME}/${month} early: ${String(holderError)}`,
        );
      }

      // A reserver that died on Prisma's 5s transaction timeout returns
      // `metering_unavailable`; surfacing that as itself beats letting it show
      // up as a miscounted winner tally with no mention of the timeout.
      for (const result of [a, b]) {
        expect(result.ok === false && result.reason).not.toBe(
          "metering_unavailable",
        );
      }

      // Released together, they serialise: the first inserts 40c, the second
      // re-reads it as a live reservation and is denied.
      expect([a, b].filter((result) => result.ok)).toHaveLength(1);
      const loser = [a, b].find((result) => !result.ok);
      expect(loser?.ok === false && loser.reason).toBe("over_budget");
      // Exactly one row was ever written for the month — the loser inserted
      // nothing, not even a row it later rolled back to under the budget.
      expect(await reservationRowCount()).toBe(1);
      expect(await liveReservedCents()).toBe(reserveCents);
    });

    it("admits exactly one of two concurrent reserves that individually fit but together exceed the budget", async () => {
      // Budget fits exactly ONE 40c reserve; two would be 80c > 50c. Under the
      // per-month advisory lock the two reservers serialise: the winner inserts
      // 40c, the loser re-reads it as a live reservation and is denied. Without
      // mutual exclusion both would read 0 live and BOTH insert — 80c reserved
      // against a 50c budget, the overspend this test forbids.
      const reserveCents = 40;
      await setBudget(50);

      for (let i = 0; i < 25; i += 1) {
        await clearMonth();
        const [a, b] = await Promise.all([
          reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
          reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
        ]);

        const winners = [a, b].filter((r) => r.ok).length;
        expect(winners).toBe(1);
        const loser = [a, b].find((r) => !r.ok);
        expect(loser?.ok === false && loser.reason).toBe("over_budget");
        // The DB never holds more reserved than one roundtrip's worth, i.e. the
        // budget is never overspent by the concurrent pair.
        expect(await liveReservedCents()).toBe(reserveCents);
      }
    });

    it("admits exactly floor(budget/reserve) of a concurrent burst and never overspends", async () => {
      // A 100c budget admits exactly two 40c reserves (80c <= 100c); a third
      // (120c) is denied. Five concurrent reservers race; exactly two win and
      // the live-reservation sum never exceeds the budget.
      const reserveCents = 40;
      const budgetCents = 100;
      const burst = 5;
      const expectedWinners = Math.floor(budgetCents / reserveCents); // 2
      await setBudget(budgetCents);

      for (let i = 0; i < 15; i += 1) {
        await clearMonth();
        const results = await Promise.all(
          Array.from({ length: burst }, () =>
            reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
          ),
        );

        const winners = results.filter((r) => r.ok).length;
        expect(winners).toBe(expectedWinners);
        const reserved = await liveReservedCents();
        expect(reserved).toBe(expectedWinners * reserveCents);
        expect(reserved).toBeLessThanOrEqual(budgetCents);
      }
    });

    it("denies every reserve when the budget is zero (hard-off)", async () => {
      await setBudget(0);
      await clearMonth();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          reserveDiagnosticsBudget({ reserveCents: 40, now: RACE_NOW }),
        ),
      );

      expect(results.every((r) => !r.ok)).toBe(true);
      for (const r of results) {
        expect(r.ok === false && r.reason).toBe("budget_not_set");
      }
      expect(await liveReservedCents()).toBe(0);
    });
  },
);
