/**
 * Real-PostgreSQL race proofs for the unpriceable-edit review lifecycle
 * (#3032, epic #2797).
 *
 * Two properties this issue turns on cannot be proven with a mock, because both
 * are properties of PostgreSQL rather than of the code that calls it:
 *
 *  1. **One occurrence raises exactly ONE task.** The raise is a find-then-create
 *     under `pg_advisory_xact_lock(1)`. A `vi.fn()` cannot reproduce advisory-lock
 *     mutual exclusion, so a unit test that "proves" this proves only that the
 *     lock statement was SENT.
 *  2. **One task settles exactly ONCE.** The completion holds no advisory lock at
 *     all - deliberately, because serialising it would mean holding the global key
 *     across a Stripe round trip - so its whole single-flight guarantee is a
 *     status-guarded `updateMany` on `OPEN`. Whether that really excludes a
 *     concurrent completion is a question about row locks and READ COMMITTED
 *     re-evaluation, which only a real server answers.
 *
 * ## Both proofs are FORCED, not raced
 *
 * Neither test hopes the interleaving happens. A third connection holds the
 * contended lock open; the two contenders are started and the test waits on a
 * BARRIER - PostgreSQL itself reporting them queued - before the holder is
 * released. Nothing here uses `setTimeout` as a stand-in for the interleaving, so
 * these neither flake on a slow runner nor pass vacuously on a fast one.
 *
 * ## Envelope
 *
 * Identical to `concurrency-lock-races.realdb.test.ts`, and a true no-op without
 * it: the race describes run ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, and the
 * database must be loopback, on port 55442+, and named with the dedicated
 * `concurrency_race_1881` marker. Hosted CI reaches this file through the import
 * in that harness, which is the step `ci.yml` runs by name - the same way
 * `bed-allocation-removal-races` and `ai-diagnostics-budget-race` are wired, and
 * the reason no workflow change is needed to make these run.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   npx vitest run src/lib/__tests__/edit-financial-review-races.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import type { CalendarDate } from "@/lib/club-time";
import type { EditFinancialReviewOccurrence } from "@/lib/edit-financial-review-context";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/** Uniquely namespaced so this suite shares the scratch database with no clash. */
const MEMBER_ID = "race-3032-member";
const LODGE_ID = "race-3032-lodge";
const BOOKING_ID = "race-3032-booking";
const GUEST_ID = "race-3032-guest";
const MODIFICATION_ID = "race-3032-modification";

/**
 * Fixed stay dates. The frozen test clock pins "today" at 2026-07-01, so these
 * are permanently future and no calendar rollover can reach them.
 */
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/**
 * How long a barrier waits for the contenders to queue before giving up with a
 * NAMED diagnostic - far more useful than Vitest's generic timeout, so it has to
 * expire first. Measured with `process.hrtime.bigint()` via `realElapsedMs`,
 * never `Date.now()`: every test file runs with `Date` frozen, so a
 * `Date.now()` deadline can never expire and the poller would spin until killed.
 */
const LOCK_POLL_TIMEOUT_MS = 2_000;

/** Generous next to the 2s barriers, but still bounded. */
const RACE_TEST_TIMEOUT_MS = 20_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Guard: never run against a default or production PostgreSQL. The same envelope
 * as `assertSafeRaceDbUrl` in the sibling harness, re-declared here so this file
 * can be run standalone without importing (and re-registering) that whole suite.
 */
export function assertSafeEditReviewRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Edit financial review race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run edit financial review race tests against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Edit financial review race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Edit financial review race DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

describe("edit financial review race DB safety guard (#3032)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeEditReviewRaceDbUrl(
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
    expect(() => assertSafeEditReviewRaceDbUrl(url)).toThrow();
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let raiseEditFinancialReviewTask: (typeof import("@/lib/edit-financial-review"))["raiseEditFinancialReviewTask"];
let editFinancialReviewOccurrenceKey: (typeof import("@/lib/edit-financial-review"))["editFinancialReviewOccurrenceKey"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];

/**
 * Two SEPARATE single-connection clients, each on its own PostgreSQL backend.
 *
 * - `lockHolderClient` pins the contended lock open inside a real transaction,
 *   which is what holds the interleaving in a known state.
 * - `observerClient` polls `pg_locks`. Deliberately NOT the application
 *   singleton: the blocked contenders are holding singleton pool connections, so
 *   an observer sharing that pool could starve behind them and time the barrier
 *   out for a reason that has nothing to do with the code under test.
 */
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "unpriceable-edit review races — real PostgreSQL (#3032)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    function occurrence(): EditFinancialReviewOccurrence {
      return {
        bookingId: BOOKING_ID,
        bookingGuestId: GUEST_ID,
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: ["2026-08-01" as CalendarDate],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: null, nightPrices: [] },
      };
    }

    const raiseInput = () => ({
      occurrence: occurrence(),
      guestMemberId: MEMBER_ID,
      bookingCheckIn: "2026-08-01" as CalendarDate,
      bookingCheckOut: "2026-08-03" as CalendarDate,
      bookingModificationId: MODIFICATION_ID,
    });

    /**
     * Everything a completed review writes, in FK order.
     *
     * A completion does not only touch the task and the credit: it also records a
     * `BookingEvent` and an `AuditLog` row. `BookingEvent.booking` is
     * `onDelete: Restrict`, so a run that leaves those events behind cannot then
     * delete the booking, the lodge or the member — which is how this suite
     * previously leaked `race-3032-member` into the shared scratch database and
     * handed the induction baseline (#2361) a fifth "eligible" member.
     */
    async function clearReviewRunState() {
      await prisma.memberCredit.deleteMany({
        where: { sourceBookingModificationId: MODIFICATION_ID },
      });
      await prisma.manualRefundTask.deleteMany({
        where: { bookingId: BOOKING_ID },
      });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { memberId: MEMBER_ID },
            { actorMemberId: MEMBER_ID },
            { targetId: { in: [BOOKING_ID, MODIFICATION_ID] } },
          ],
        },
      });
    }

    /** Every fixture row this suite owns, deepest child first. */
    async function deleteReviewFixtures() {
      await clearReviewRunState();
      await prisma.bookingModification.deleteMany({
        where: { id: MODIFICATION_ID },
      });
      await prisma.bookingGuest.deleteMany({ where: { id: GUEST_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * How many backends are queued behind `blockerPid`, directly OR transitively.
     *
     * `pg_blocking_pids` reports a session's IMMEDIATE blockers only, and on a
     * contended ROW that is not the row's holder. PostgreSQL makes the second
     * waiter queue on the intermediate TUPLE lock held by the first waiter, so a
     * measured run of the double-completion case shows the holder blocking
     * completion A and completion A blocking completion B — B never names the
     * holder at all. Counting direct blockers would therefore see ONE contender
     * at the moment two are queued on the one row, and time the barrier out on a
     * proof that was in fact holding.
     *
     * So ask the question the barrier actually means: is the holder the ROOT of
     * this session's wait? `UNION` (never `UNION ALL`) makes a wait cycle
     * terminate instead of spinning.
     */
    async function blockedByHolder(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE waits AS (
          SELECT activity.pid AS waiter, blocker.pid AS blocker
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
        ),
        chain AS (
          SELECT waiter, blocker FROM waits
          UNION
          SELECT chain.waiter, waits.blocker
          FROM chain
          JOIN waits ON waits.waiter = chain.blocker
        )
        SELECT COUNT(DISTINCT waiter)::int AS "count"
        FROM chain
        WHERE blocker = ${blockerPid}::int
      `;
      return rows[0]?.count ?? 0;
    }

    async function waitForBlockedBy(
      blockerPid: number,
      expected: number,
      diagnostic: string,
    ): Promise<void> {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await blockedByHolder(blockerPid);
        if (seen >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for ${expected} session(s) to queue behind pid ${blockerPid} — saw ${seen}. ${diagnostic}`,
      );
    }

    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing Prisma, so the skipped suite is
      // a true no-op when the dedicated URL is absent.
      assertSafeEditReviewRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ raiseEditFinancialReviewTask, editFinancialReviewOccurrenceKey } =
        await import("@/lib/edit-financial-review"));
      ({ resolveManualRefundTask } = await import(
        "@/lib/manual-refund-task-resolution"
      ));

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
      lockHolderClient = createSeparateClient("race-3032-lock-holder");
      observerClient = createSeparateClient("race-3032-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await deleteReviewFixtures();

      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: "race-3032@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Review",
          lastName: "Member",
          role: "ADMIN",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Race 3032 Lodge", slug: "race-3032" },
      });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: 20000,
          finalPriceCents: 20000,
        },
      });
      await prisma.bookingGuest.create({
        data: {
          id: GUEST_ID,
          bookingId: BOOKING_ID,
          firstName: "Review",
          lastName: "Guest",
          ageTier: "ADULT",
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          priceCents: 20000,
        },
      });
      await prisma.bookingModification.create({
        data: {
          id: MODIFICATION_ID,
          bookingId: BOOKING_ID,
          memberId: MEMBER_ID,
          modificationType: "BATCH_MODIFY",
          previousData: {},
          newData: {},
        },
      });
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
      if (typeof prisma !== "undefined") {
        // Deliberately NOT swallowed. This scratch database is shared with every
        // other suite the #1881 harness imports, so a fixture this suite fails to
        // remove is not a tidiness problem — it is a false result somewhere else.
        // Swallowing the FK error here is exactly how `race-3032-member` survived
        // into the induction baseline (#2361) and made it count five eligible
        // members where four exist. A leak must fail THIS suite, here and loudly.
        try {
          await deleteReviewFixtures();
        } finally {
          await prisma.$disconnect().catch(() => {});
        }
      }
    }, 60_000);

    it("FORCES the duplicate-raise interleaving: two applies of ONE occurrence queue on lock(1) and produce exactly one task", async () => {
      await clearReviewRunState();

      const lockHeld = deferred();
      const releaseLock = deferred();
      let holderPid = 0;
      let holderError: unknown;

      // A third connection takes the production key — `pg_advisory_xact_lock(1)`,
      // the global settlement cohort — and parks on it. Both raisers are now
      // guaranteed to block, whatever the machine's timing.
      const holder = lockHolderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            lockHeld.resolve();
            await releaseLock.promise;
          },
          { maxWait: 5_000, timeout: 10_000 },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) {
        throw new Error(
          `The lock-holder connection could not hold lock(1): ${String(holderError)}`,
        );
      }

      // Each raiser mirrors a real caller: it opens its own transaction and takes
      // lock(1) FIRST, exactly as `modifyBookingBatch` does, then calls the
      // production raise inside it.
      const runRaise = () =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            return raiseEditFinancialReviewTask({ ...raiseInput(), store: tx });
          },
          { maxWait: 15_000, timeout: 15_000 },
        );

      const first = runRaise();
      const second = runRaise();

      await waitForBlockedBy(
        holderPid,
        2,
        "Neither apply queued on pg_advisory_xact_lock(1), so the raise's find-then-create is no longer serialised " +
          "and one unpriceable edit could raise TWO review tasks, each separately completable — the same adjustment " +
          "handed back twice (docs/CONCURRENCY_AND_LOCKING.md, INV-PAY-051).",
      );

      releaseLock.resolve();
      await holder;

      const results = await Promise.all([first, second]);

      // Exactly one INSERT, and the other call found it rather than writing a
      // second row or failing.
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter((result) => !result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
      expect(results[0].occurrenceKey).toBe(
        editFinancialReviewOccurrenceKey(occurrence()),
      );

      const rows = await prisma.manualRefundTask.findMany({
        where: { bookingId: BOOKING_ID },
        select: { id: true, amountCents: true, status: true },
      });
      expect(rows).toHaveLength(1);
      // The whole point of the feature: unknown, never a magic zero.
      expect(rows[0].amountCents).toBeNull();
      expect(rows[0].status).toBe("OPEN");
    });

    it("FORCES the double-completion interleaving: two admins closing ONE task queue on its row and exactly one credit is issued", async () => {
      await clearReviewRunState();

      const raised = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({ ...raiseInput(), store: tx });
      });

      const lockHeld = deferred();
      const releaseLock = deferred();
      let holderPid = 0;
      let holderError: unknown;

      // The completion path holds NO advisory lock — that is deliberate, and is
      // why the contended resource here is the task ROW rather than a key. A
      // third connection takes that row's lock and parks, so both completions
      // are guaranteed to reach their status-guarded claim and block on it.
      const holder = lockHolderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT id FROM "ManualRefundTask" WHERE id = ${raised.taskId} FOR UPDATE`;
            lockHeld.resolve();
            await releaseLock.promise;
          },
          { maxWait: 5_000, timeout: 10_000 },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) {
        throw new Error(
          `The lock-holder connection could not hold the task row: ${String(holderError)}`,
        );
      }

      const complete = () =>
        resolveManualRefundTask({
          taskId: raised.taskId,
          resolution: "completed",
          note: "Priced from the booking's own payment history.",
          actingMemberId: MEMBER_ID,
          confirmedAmountCents: 4500,
        });

      const settled = await Promise.allSettled([
        (async () => {
          const result = complete();
          await waitForBlockedBy(
            holderPid,
            2,
            "The two completions did not both queue on the task row, so the OPEN -> terminal transition is no longer a " +
              "status-guarded claim and two admins closing at once could each issue the adjustment (INV-PAY-051).",
          ).catch(async (error) => {
            releaseLock.resolve();
            await result.catch(() => {});
            throw error;
          });
          releaseLock.resolve();
          return result;
        })(),
        complete(),
      ]);
      await holder;

      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser is told the row moved under it, not handed a 500.
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
      });

      const task = await prisma.manualRefundTask.findUniqueOrThrow({
        where: { id: raised.taskId },
        select: { status: true, amountCents: true, raisedAmountCents: true },
      });
      expect(task.status).toBe("COMPLETED");
      expect(task.amountCents).toBe(4500);
      // Raised with no amount; the confirmed figure is the admin's, and the row
      // says so by itself.
      expect(task.raisedAmountCents).toBeNull();

      // ONE credit, at the confirmed amount — not two, and not 9000.
      const credits = await prisma.memberCredit.findMany({
        where: { sourceBookingModificationId: MODIFICATION_ID },
        select: { amountCents: true, memberId: true, type: true },
      });
      expect(credits).toHaveLength(1);
      expect(credits[0].amountCents).toBe(4500);
      expect(credits[0].memberId).toBe(MEMBER_ID);
      expect(credits[0].type).toBe("BOOKING_MODIFICATION_REFUND");
    });

    it("a replay of a COMPLETED occurrence reopens nothing and issues no second credit", async () => {
      // SELF-CONTAINED, deliberately. An earlier revision continued from the
      // previous case's committed state, which is one `-t` filter, one `.only`
      // or one shard boundary away from a false green - and a race proof that
      // can pass vacuously is worse than none. It builds its own COMPLETED
      // occurrence instead: a retry of the same structural edit after an admin
      // has already priced and closed it is exactly the replay that must not
      // produce a second adjustment.
      await clearReviewRunState();
      const priced = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({ ...raiseInput(), store: tx });
      });
      await resolveManualRefundTask({
        taskId: priced.taskId,
        resolution: "completed",
        note: "Priced from the booking's own payment history.",
        actingMemberId: MEMBER_ID,
        confirmedAmountCents: 4500,
      });

      const replay = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({ ...raiseInput(), store: tx });
      });

      expect(replay.created).toBe(false);
      expect(replay.status).toBe("COMPLETED");

      const tasks = await prisma.manualRefundTask.findMany({
        where: { bookingId: BOOKING_ID },
      });
      expect(tasks).toHaveLength(1);

      const credits = await prisma.memberCredit.findMany({
        where: { sourceBookingModificationId: MODIFICATION_ID },
      });
      expect(credits).toHaveLength(1);
    });
  },
);
