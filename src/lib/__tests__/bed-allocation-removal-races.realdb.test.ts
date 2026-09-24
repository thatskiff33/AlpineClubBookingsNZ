/**
 * Real-PostgreSQL serialization proofs for reviewed bed-allocation removal
 * (#2594) and reviewed moves (#2595). Ordinary Vitest runs skip the production-
 * path races. The explicit concurrency job imports this file from
 * concurrency-lock-races.realdb.test.ts after migrating a disposable,
 * loopback-only database.
 *
 * A third connection holds the exact production global booking lock while the
 * two real writers reach PostgreSQL. The test observes their waiters in
 * pg_locks, queues them in a deliberate order, then releases the holder. This
 * forces the interleaving without sleeps or test-only hooks in production code.
 */
import type { PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
// The explicit auto writer computes a full dashboard plan before it enters the
// transaction. A cold disposable database can legitimately spend more than two
// seconds there; use the parent harness's five-second diagnostic bound rather
// than misreporting that planning time as a missing global-lock participant.
const LOCK_POLL_TIMEOUT_MS = 5_000;
const RACE_TEST_TIMEOUT_MS = 30_000;

const ACTOR_ID = "race-2594-admin";
const LODGE_ID = "race-2594-lodge";
const ROOM_ID = "race-2594-room";
const REQUESTED_ROOM_RACE_ID = "race-2594-requested-room";
const REQUESTED_ROOM_RACE_NAME = "Race 2594 requested room";
const OLD_DOUBLE_BED_ID = "race-2594-old-double";
const DESTINATION_BED_ID = "race-2594-destination";
const OTHER_BED_ID = "race-2594-other";
const BOOKING_ID = "race-2594-booking";
const PARTNER_BOOKING_ID = "race-2594-partner-booking";
const GUEST_ID = "race-2594-guest";
const PARTNER_GUEST_ID = "race-2594-partner-guest";
const TARGET_ALLOCATION_ID = "race-2594-target-allocation";
const OTHER_ALLOCATION_ID = "race-2594-other-allocation";
const PARTNER_ALLOCATION_ID = "race-2594-partner-allocation";
const FIRST_NIGHT = new Date("2099-04-01T00:00:00.000Z");
const SECOND_NIGHT = new Date("2099-04-02T00:00:00.000Z");
const CHECK_OUT = new Date("2099-04-03T00:00:00.000Z");
const FIRST_NIGHT_DATE_ONLY = "2099-04-01";
const SECOND_NIGHT_DATE_ONLY = "2099-04-02";
const TARGET_APPROVED_AT = new Date("2099-03-01T00:00:00.000Z");

const REMOVAL_AUDIT_ACTIONS = [
  "BED_ALLOCATION_REMOVAL_APPLIED",
  "BED_ALLOCATION_PARTNERS_PROMOTED",
] as const;
const MOVE_AUDIT_ACTIONS = [
  "BED_ALLOCATION_MANUAL_SET",
  "BED_ALLOCATION_PARTNER_PROMOTED",
] as const;
const REQUESTED_ROOM_AUDIT_ACTIONS = [
  "booking.requested_room.updated",
  "booking.requested_room.cleared",
] as const;
const MOVE_366_DELAY_TRIGGER = "race_2595_move_statement_delay_trigger";
const MOVE_366_DELAY_FUNCTION = "race_2595_move_statement_delay_fn";

type RemovalRollbackFailureStage = "delete" | "promotion" | "audit";

const ROLLBACK_FAILURE_OBJECTS = {
  delete: {
    trigger: "race_2594_fail_delete_trigger",
    function: "race_2594_fail_delete_fn",
    table: "BedAllocation",
  },
  promotion: {
    trigger: "race_2594_fail_promotion_trigger",
    function: "race_2594_fail_promotion_fn",
    table: "BedAllocation",
  },
  audit: {
    trigger: "race_2594_fail_audit_trigger",
    function: "race_2594_fail_audit_fn",
    table: "AuditLog",
  },
} as const;

let prisma: typeof import("@/lib/prisma")["prisma"];
let previewBedAllocationRemoval: typeof import("@/lib/bed-allocation-removal")["previewBedAllocationRemoval"];
let applyBedAllocationRemoval: typeof import("@/lib/bed-allocation-removal")["applyBedAllocationRemoval"];
let previewBedAllocationMove: typeof import("@/lib/bed-allocation-move")["previewBedAllocationMove"];
let applyBedAllocationMove: typeof import("@/lib/bed-allocation-move")["applyBedAllocationMove"];
let moveBedAllocationsSameDate: typeof import("@/lib/bed-allocation-manual-writes")["moveBedAllocationsSameDate"];
let runAutoBedAllocation: typeof import("@/lib/bed-allocation-auto-allocate")["runAutoBedAllocation"];
let deleteBedAllocationRoom: typeof import("@/lib/bed-allocation-rooms")["deleteBedAllocationRoom"];
let reconcileBedAllocationsForBooking: typeof import("@/lib/bed-allocation-lifecycle")["reconcileBedAllocationsForBooking"];
let cancelBooking: typeof import("@/lib/booking-cancel")["cancelBooking"];
let writeRequestedRoom: typeof import("@/lib/requested-room-write")["writeRequestedRoom"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

/** Standalone fail-closed copy: importing this file must not register the parent suite. */
export function assertSafeRemovalRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Bed-allocation removal races need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run bed-allocation removal races against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Bed-allocation removal race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Bed-allocation removal race DB name must contain 'concurrency_race_1881'.",
    );
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function pendingGlobalLockWaiters(): Promise<number> {
  const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = 0
      AND objid = 1
      AND granted = false
  `;
  return rows[0]?.count ?? 0;
}

async function waitForGlobalLockWaiters(expected: number): Promise<void> {
  const startedAt = process.hrtime.bigint();
  let seen = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    seen = await pendingGlobalLockWaiters();
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${expected} writer(s) on global bed-allocation lock(1); saw ${seen}. A production writer may have stopped joining the global cohort.`,
  );
}

/**
 * Queue two production writers in an explicit order behind a real holder of
 * lock(1). PostgreSQL grants advisory waiters in queue order; observing each
 * waiter before starting the next makes the expected serialized outcome
 * deterministic and mutation-sensitive.
 *
 * ONE PROPERTY OF THIS DEVICE THAT ITS FAILURES DO NOT ADVERTISE: the second
 * writer's ARRIVAL time is spent inside the FIRST writer's transaction budget.
 * The holder cannot release until both are queued, and the first writer has
 * already opened its own transaction (Prisma's default 5s) to reach lock(1). So a
 * second writer that does any real work before its first `pg_advisory_xact_lock`
 * rejects the first writer with `P2028` for reasons that have nothing to do with
 * the lock protocol under test. `member-merge-shared-double-races` documents the
 * same hazard on its lodge-key device and requires a pre-built preview for that
 * reason. Assert with `settledValueOrThrow` rather than `toMatchObject` on the
 * settled result, so when it does happen the error says which it was instead of
 * a bare "rejected".
 */
/**
 * Surface a losing writer's real error instead of a bare "rejected".
 *
 * `expect(outcome).toMatchObject({ status: "fulfilled", ... })` prints only
 * `{ status: "rejected" }` and omits `reason` from the diff, so a CI-only failure
 * here says nothing about WHY — which cost a full cycle on #2641 before the cause
 * could even be named. Throwing the reason puts the real error, and its Prisma
 * code, in the test output.
 */
function settledValueOrThrow(outcome: PromiseSettledResult<unknown>): unknown {
  // Deliberately not generic. These call sites destructure a two-writer tuple
  // whose element type is a union of both writers' results, so a generic
  // `PromiseSettledResult<T>` cannot narrow and TypeScript rejects the call.
  // `unknown` is enough: the value only ever reaches a runtime `toMatchObject`.
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

async function runWritersInGlobalQueueOrder<A, B>(
  firstWriter: () => Promise<A>,
  secondWriter: () => Promise<B>,
): Promise<[
  PromiseSettledResult<A>,
  PromiseSettledResult<B>,
]> {
  const lockHeld = deferred();
  const releaseLock = deferred();
  let holderError: unknown;
  const holder = lockHolderClient
    .$transaction(
      async (tx) => {
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
    throw new Error(`Could not hold global lock(1): ${String(holderError)}`);
  }

  const first = firstWriter();
  let second: Promise<B> | undefined;
  let observationError: unknown;
  try {
    await waitForGlobalLockWaiters(1);
    second = secondWriter();
    await waitForGlobalLockWaiters(2);
  } catch (error) {
    observationError = error;
  } finally {
    releaseLock.resolve();
  }

  await holder;
  if (holderError) {
    throw new Error(`Global lock(1) holder failed: ${String(holderError)}`);
  }
  if (!second) {
    await Promise.allSettled([first]);
    throw observationError;
  }
  const outcomes = await Promise.allSettled([first, second]);
  if (observationError) throw observationError;
  return outcomes;
}

function rejectionStatus(outcome: PromiseSettledResult<unknown>): number | null {
  if (outcome.status === "fulfilled") return null;
  return typeof outcome.reason === "object" &&
    outcome.reason !== null &&
    "status" in outcome.reason &&
    typeof outcome.reason.status === "number"
    ? outcome.reason.status
    : null;
}

async function clearBookingFixtures(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { memberId: ACTOR_ID },
        { actorMemberId: ACTOR_ID },
        { targetId: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
      ],
    },
  });
  await prisma.bookingEvent.deleteMany({
    where: { bookingId: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
  });
  await prisma.booking.deleteMany({
    where: { id: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
  });
}

async function recreateRequestedRoomRaceFixture(): Promise<void> {
  await prisma.lodgeRoom.upsert({
    where: { id: REQUESTED_ROOM_RACE_ID },
    create: {
      id: REQUESTED_ROOM_RACE_ID,
      lodgeId: LODGE_ID,
      name: REQUESTED_ROOM_RACE_NAME,
      sortOrder: 99,
    },
    update: {
      lodgeId: LODGE_ID,
      name: REQUESTED_ROOM_RACE_NAME,
      sortOrder: 99,
      active: true,
      notes: null,
    },
  });
}

async function deleteRequestedRoomRaceFixture(): Promise<void> {
  await prisma.lodgeRoom.deleteMany({
    where: { id: REQUESTED_ROOM_RACE_ID },
  });
}

async function seedBookings(
  status: "CONFIRMED" | "AWAITING_REVIEW" = "CONFIRMED",
  includePartner = true,
) {
  await clearBookingFixtures();
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: ACTOR_ID,
      lodgeId: LODGE_ID,
      checkIn: FIRST_NIGHT,
      checkOut: CHECK_OUT,
      status,
      totalPriceCents: 200,
      finalPriceCents: 200,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Removal",
      lastName: "Guest",
      ageTier: "ADULT",
      stayStart: FIRST_NIGHT,
      stayEnd: CHECK_OUT,
      priceCents: 200,
    },
  });
  await prisma.bookingGuestNight.createMany({
    data: [FIRST_NIGHT, SECOND_NIGHT].map((stayDate) => ({
      bookingGuestId: GUEST_ID,
      stayDate,
      priceCents: 100,
    })),
  });
  if (includePartner) {
    await prisma.booking.create({
      data: {
        id: PARTNER_BOOKING_ID,
        memberId: ACTOR_ID,
        lodgeId: LODGE_ID,
        checkIn: FIRST_NIGHT,
        checkOut: CHECK_OUT,
        status: "CONFIRMED",
        totalPriceCents: 200,
        finalPriceCents: 200,
      },
    });
    await prisma.bookingGuest.create({
      data: {
        id: PARTNER_GUEST_ID,
        bookingId: PARTNER_BOOKING_ID,
        firstName: "Shared",
        lastName: "Partner",
        ageTier: "ADULT",
        stayStart: FIRST_NIGHT,
        stayEnd: CHECK_OUT,
        priceCents: 200,
      },
    });
    await prisma.bookingGuestNight.createMany({
      data: [FIRST_NIGHT, SECOND_NIGHT].map((stayDate) => ({
        bookingGuestId: PARTNER_GUEST_ID,
        stayDate,
        priceCents: 100,
      })),
    });
  }
}

async function seedTargetWithPartner(stayDate = FIRST_NIGHT): Promise<void> {
  await prisma.bedAllocation.createMany({
    data: [
      {
        id: TARGET_ALLOCATION_ID,
        bookingId: BOOKING_ID,
        bookingGuestId: GUEST_ID,
        roomId: ROOM_ID,
        bedId: OLD_DOUBLE_BED_ID,
        bedType: "DOUBLE",
        stayDate,
        source: "MANUAL",
      },
      {
        id: PARTNER_ALLOCATION_ID,
        bookingId: PARTNER_BOOKING_ID,
        bookingGuestId: PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: OLD_DOUBLE_BED_ID,
        bedType: "DOUBLE",
        stayDate,
        source: "MANUAL",
        isSecondOccupant: true,
      },
    ],
  });
}

async function reviewedTargetRemoval(stayDate: string) {
  const request = {
    scope: {
      type: "ALLOCATION" as const,
      allocationId: TARGET_ALLOCATION_ID,
      bookingId: BOOKING_ID,
      bookingGuestId: GUEST_ID,
      lodgeId: LODGE_ID,
      stayDate,
    },
    categories: ["MANUAL_DRAFT" as const],
  };
  const preview = await previewBedAllocationRemoval(request);
  return {
    preview,
    apply: () =>
      applyBedAllocationRemoval({
        actorMemberId: ACTOR_ID,
        request: { ...request, previewDigest: preview.digest },
      }),
  };
}

async function reviewedTargetMove(
  scope: "ALLOCATION_NIGHT" | "BOOKING_GUEST" = "ALLOCATION_NIGHT",
) {
  const request = {
    anchorAllocationId: TARGET_ALLOCATION_ID,
    destinationBedId: DESTINATION_BED_ID,
    scope,
  };
  const preview = await previewBedAllocationMove(request);
  return {
    preview,
    apply: () =>
      applyBedAllocationMove({
        actorMemberId: ACTOR_ID,
        request: { ...request, previewDigest: preview.digest },
      }),
  };
}

async function actionCount(actions: readonly string[]): Promise<number> {
  return prisma.auditLog.count({
    where: { memberId: ACTOR_ID, action: { in: [...actions] } },
  });
}

async function fixtureRemovalAuditCount(): Promise<number> {
  return prisma.auditLog.count({
    where: {
      action: { in: [...REMOVAL_AUDIT_ACTIONS] },
      OR: [
        { memberId: ACTOR_ID },
        { actorMemberId: ACTOR_ID },
        { targetId: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
      ],
    },
  });
}

async function requestedRoomAuditRows() {
  return prisma.auditLog.findMany({
    where: {
      targetId: BOOKING_ID,
      action: { in: [...REQUESTED_ROOM_AUDIT_ACTIONS] },
    },
    select: {
      action: true,
      memberId: true,
      targetId: true,
      details: true,
    },
  });
}

async function dropRemovalRollbackFailureInjection(): Promise<void> {
  for (const object of Object.values(ROLLBACK_FAILURE_OBJECTS)) {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${object.trigger} ON "${object.table}"`,
    );
  }
  for (const object of Object.values(ROLLBACK_FAILURE_OBJECTS)) {
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${object.function}()`,
    );
  }
}

async function dropMove366StatementDelay(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${MOVE_366_DELAY_TRIGGER} ON "BedAllocation"`,
  );
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS ${MOVE_366_DELAY_FUNCTION}()`,
  );
}

async function installMove366StatementDelay(): Promise<void> {
  await dropMove366StatementDelay();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${MOVE_366_DELAY_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $race2595$
    BEGIN
      PERFORM pg_sleep(0.02);
      RETURN NULL;
    END;
    $race2595$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${MOVE_366_DELAY_TRIGGER}
    BEFORE UPDATE ON "BedAllocation"
    FOR EACH STATEMENT
    EXECUTE FUNCTION ${MOVE_366_DELAY_FUNCTION}()
  `);
}

async function installRemovalRollbackFailureInjection(
  stage: RemovalRollbackFailureStage,
): Promise<void> {
  await dropRemovalRollbackFailureInjection();

  if (stage === "delete") {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.delete.function}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $race2594$
      BEGIN
        RAISE EXCEPTION 'race 2594 forced delete failure';
        RETURN OLD;
      END;
      $race2594$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${ROLLBACK_FAILURE_OBJECTS.delete.trigger}
      BEFORE DELETE ON "BedAllocation"
      FOR EACH ROW
      WHEN (OLD."id" = '${TARGET_ALLOCATION_ID}')
      EXECUTE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.delete.function}()
    `);
    return;
  }

  if (stage === "promotion") {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.promotion.function}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $race2594$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "BedAllocation"
          WHERE "id" = '${TARGET_ALLOCATION_ID}'
        ) THEN
          RAISE EXCEPTION 'race 2594 promotion reached before delete';
        END IF;
        RAISE EXCEPTION 'race 2594 forced promotion failure after delete';
        RETURN NEW;
      END;
      $race2594$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${ROLLBACK_FAILURE_OBJECTS.promotion.trigger}
      BEFORE UPDATE OF "isSecondOccupant" ON "BedAllocation"
      FOR EACH ROW
      WHEN (
        OLD."id" = '${PARTNER_ALLOCATION_ID}'
        AND OLD."isSecondOccupant" = TRUE
        AND NEW."isSecondOccupant" = FALSE
      )
      EXECUTE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.promotion.function}()
    `);
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.audit.function}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $race2594$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM "BedAllocation"
        WHERE "id" = '${TARGET_ALLOCATION_ID}'
      ) THEN
        RAISE EXCEPTION 'race 2594 audit reached before delete';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "BedAllocation"
        WHERE "id" = '${PARTNER_ALLOCATION_ID}'
          AND "isSecondOccupant" = TRUE
      ) THEN
        RAISE EXCEPTION 'race 2594 audit reached before promotion';
      END IF;
      RAISE EXCEPTION 'race 2594 forced audit failure after delete and promotion';
      RETURN NEW;
    END;
    $race2594$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${ROLLBACK_FAILURE_OBJECTS.audit.trigger}
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW
    WHEN (NEW."action" = 'BED_ALLOCATION_REMOVAL_APPLIED')
    EXECUTE FUNCTION ${ROLLBACK_FAILURE_OBJECTS.audit.function}()
  `);
}

async function expectOriginalSharedDoubleState(): Promise<void> {
  const [allocations, removalAuditCount] = await Promise.all([
    prisma.bedAllocation.findMany({
      where: {
        id: { in: [TARGET_ALLOCATION_ID, PARTNER_ALLOCATION_ID] },
      },
      select: {
        id: true,
        bedId: true,
        source: true,
        approvedAt: true,
        isSecondOccupant: true,
      },
      orderBy: { id: "asc" },
    }),
    fixtureRemovalAuditCount(),
  ]);
  expect(allocations).toEqual([
    {
      id: PARTNER_ALLOCATION_ID,
      bedId: OLD_DOUBLE_BED_ID,
      source: "MANUAL",
      approvedAt: null,
      isSecondOccupant: true,
    },
    {
      id: TARGET_ALLOCATION_ID,
      bedId: OLD_DOUBLE_BED_ID,
      source: "MANUAL",
      approvedAt: null,
      isSecondOccupant: false,
    },
  ]);
  expect(removalAuditCount).toBe(0);
}

async function waitForAuditAction(action: string): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const count = await prisma.auditLog.count({
      where: { memberId: ACTOR_ID, action },
    });
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for asynchronous ${action} audit`);
}

describe("bed-allocation removal race DB safety guard (#2594)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeRemovalRaceDbUrl(
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
    expect(() => assertSafeRemovalRaceDbUrl(url)).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "reviewed bed-allocation removal and move races - real PostgreSQL (#2594, #2595)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let previousBedAllocationModuleEnabled: boolean | null = null;
    let moduleSettingsExisted = false;

    beforeAll(async () => {
      assertSafeRemovalRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ previewBedAllocationRemoval, applyBedAllocationRemoval } = await import(
        "@/lib/bed-allocation-removal"
      ));
      ({ previewBedAllocationMove, applyBedAllocationMove } = await import(
        "@/lib/bed-allocation-move"
      ));
      ({ deleteBedAllocationRoom } = await import("@/lib/bed-allocation-rooms"));
      ({ moveBedAllocationsSameDate } = await import(
        "@/lib/bed-allocation-manual-writes"
      ));
      ({ runAutoBedAllocation } = await import(
        "@/lib/bed-allocation-auto-allocate"
      ));
      ({ reconcileBedAllocationsForBooking } = await import(
        "@/lib/bed-allocation-lifecycle"
      ));
      ({ cancelBooking } = await import("@/lib/booking-cancel"));
      ({ writeRequestedRoom } = await import("@/lib/requested-room-write"));

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
      lockHolderClient = createSeparateClient("race-2594-lock-holder");
      observerClient = createSeparateClient("race-2594-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      const priorModuleSettings = await prisma.clubModuleSettings.findUnique({
        where: { id: "default" },
        select: { bedAllocation: true },
      });
      moduleSettingsExisted = priorModuleSettings !== null;
      previousBedAllocationModuleEnabled =
        priorModuleSettings?.bedAllocation ?? null;
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", bedAllocation: true },
        update: { bedAllocation: true },
        select: { id: true },
      });

      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.bedAllocationSettings.create({
        data: {
          id: LODGE_ID,
          lodgeId: LODGE_ID,
          autoAllocationEnabled: true,
          allocationPriorityOrder: [
            "BOOKING_COHESION",
            "STAY_CONTINUITY",
            "REQUESTED_ROOM",
            "FAMILY_COHESION",
          ],
          updatedByMemberId: ACTOR_ID,
        },
      });

      await clearBookingFixtures();
      await prisma.lodgeBed.deleteMany({
        where: {
          id: { in: [OLD_DOUBLE_BED_ID, DESTINATION_BED_ID, OTHER_BED_ID] },
        },
      });
      await prisma.lodgeRoom.deleteMany({
        where: { id: { in: [ROOM_ID, REQUESTED_ROOM_RACE_ID] } },
      });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ACTOR_ID } });

      await prisma.member.create({
        data: {
          id: ACTOR_ID,
          email: "race-2594@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Removal",
          lastName: "Admin",
          role: "ADMIN",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Race 2594 Lodge", slug: "race-2594" },
      });
      await prisma.lodgeRoom.create({
        data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 2594 Room" },
      });
      await recreateRequestedRoomRaceFixture();
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: OLD_DOUBLE_BED_ID,
            roomId: ROOM_ID,
            name: "Old double",
            bedType: "DOUBLE",
            sortOrder: 0,
          },
          {
            id: DESTINATION_BED_ID,
            roomId: ROOM_ID,
            name: "Destination",
            bedType: "SINGLE",
            sortOrder: 1,
          },
          {
            id: OTHER_BED_ID,
            roomId: ROOM_ID,
            name: "Other",
            bedType: "SINGLE",
            sortOrder: 2,
          },
        ],
      });
    }, 60_000);

    beforeEach(async () => {
      await dropRemovalRollbackFailureInjection();
      await dropMove366StatementDelay();
      await clearBookingFixtures();
      await recreateRequestedRoomRaceFixture();
    });

    afterEach(async () => {
      const cleanupErrors: unknown[] = [];
      try {
        await dropRemovalRollbackFailureInjection();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await dropMove366StatementDelay();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await clearBookingFixtures();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await deleteRequestedRoomRaceFixture();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation removal rollback-proof cleanup failed",
        );
      }
    });

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (typeof prisma !== "undefined") {
        await attempt(dropRemovalRollbackFailureInjection);
        await attempt(dropMove366StatementDelay);
        await attempt(clearBookingFixtures);
        await attempt(() =>
          prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } }),
        );
        await attempt(() =>
          prisma.lodgeBed.deleteMany({
            where: {
              id: { in: [OLD_DOUBLE_BED_ID, DESTINATION_BED_ID, OTHER_BED_ID] },
            },
          }),
        );
        await attempt(() =>
          prisma.lodgeRoom.deleteMany({
            where: { id: { in: [ROOM_ID, REQUESTED_ROOM_RACE_ID] } },
          }),
        );
        await attempt(() => prisma.lodge.deleteMany({ where: { id: LODGE_ID } }));
        await attempt(() => prisma.member.deleteMany({ where: { id: ACTOR_ID } }));
        if (moduleSettingsExisted) {
          await attempt(() =>
            prisma.clubModuleSettings.update({
              where: { id: "default" },
              data: {
                bedAllocation: previousBedAllocationModuleEnabled ?? false,
              },
              select: { id: true },
            }),
          );
        } else {
          await attempt(() =>
            prisma.clubModuleSettings.deleteMany({ where: { id: "default" } }),
          );
        }
      }
      if (typeof lockHolderClient !== "undefined") {
        await attempt(() => lockHolderClient.$disconnect());
      }
      if (typeof observerClient !== "undefined") {
        await attempt(() => observerClient.$disconnect());
      }
      if (typeof prisma !== "undefined") {
        await attempt(() => prisma.$disconnect());
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation removal race teardown failed",
        );
      }
    }, 60_000);

    it("leaves rows untouched and skips downstream work when the real delete fails", async () => {
      await seedBookings();
      await seedTargetWithPartner();
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

      try {
        await installRemovalRollbackFailureInjection("delete");
        await expect(removal.apply()).rejects.toThrow(
          "race 2594 forced delete failure",
        );
      } finally {
        await dropRemovalRollbackFailureInjection();
      }

      await expectOriginalSharedDoubleState();
    });

    it("restores the deleted primary when the real partner promotion fails", async () => {
      await seedBookings();
      await seedTargetWithPartner();
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

      try {
        await installRemovalRollbackFailureInjection("promotion");
        await expect(removal.apply()).rejects.toThrow(
          "race 2594 forced promotion failure after delete",
        );
      } finally {
        await dropRemovalRollbackFailureInjection();
      }

      await expectOriginalSharedDoubleState();
    });

    it("restores delete and promotion state when the real removal audit fails", async () => {
      await seedBookings();
      await seedTargetWithPartner();
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

      try {
        await installRemovalRollbackFailureInjection("audit");
        await expect(removal.apply()).rejects.toThrow(
          "race 2594 forced audit failure after delete and promotion",
        );
      } finally {
        await dropRemovalRollbackFailureInjection();
      }

      await expectOriginalSharedDoubleState();
    });

    it.each(["DELETE_FIRST", "WRITE_FIRST"] as const)(
      "serializes requested-room write and room deletion when %s is queued first",
      async (order) => {
        await seedBookings("CONFIRMED", false);
        const writeRoom = () =>
          writeRequestedRoom({
            bookingId: BOOKING_ID,
            actorMemberId: ACTOR_ID,
            actorIsAdmin: true,
            requestedRoomId: REQUESTED_ROOM_RACE_ID,
            auditActorLabel: "Admin",
          });
        const deleteRoom = () =>
          deleteBedAllocationRoom({
            id: REQUESTED_ROOM_RACE_ID,
            lodgeId: LODGE_ID,
          });

        const outcomes =
          order === "DELETE_FIRST"
            ? await runWritersInGlobalQueueOrder(deleteRoom, writeRoom)
            : await runWritersInGlobalQueueOrder(writeRoom, deleteRoom);
        const [deleteOutcome, writeOutcome] =
          order === "DELETE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        const [booking, room, audits] = await Promise.all([
          prisma.booking.findUniqueOrThrow({
            where: { id: BOOKING_ID },
            select: { requestedRoomId: true },
          }),
          prisma.lodgeRoom.findUnique({
            where: { id: REQUESTED_ROOM_RACE_ID },
            select: { id: true },
          }),
          requestedRoomAuditRows(),
        ]);
        expect(deleteOutcome.status).toBe("fulfilled");
        expect(room).toBeNull();
        expect(booking.requestedRoomId).toBeNull();

        if (order === "DELETE_FIRST") {
          expect(writeOutcome.status).toBe("rejected");
          expect(rejectionStatus(writeOutcome)).toBe(400);
          if (writeOutcome.status === "rejected") {
            expect(writeOutcome.reason).toMatchObject({
              message: "Invalid requested room",
              status: 400,
            });
          }
          expect(audits).toEqual([]);
          return;
        }

        expect(writeOutcome.status).toBe("fulfilled");
        if (writeOutcome.status === "fulfilled") {
          expect(writeOutcome.value).toMatchObject({
            requestedRoomId: REQUESTED_ROOM_RACE_ID,
            requestedRoom: {
              id: REQUESTED_ROOM_RACE_ID,
              name: REQUESTED_ROOM_RACE_NAME,
              active: true,
            },
          });
        }
        expect(audits).toEqual([
          {
            action: "booking.requested_room.updated",
            memberId: ACTOR_ID,
            targetId: BOOKING_ID,
            details: `Admin set requested room to "${REQUESTED_ROOM_RACE_NAME}"`,
          },
        ]);
      },
    );

    it.each(["MOVE_FIRST", "REMOVAL_FIRST"] as const)(
      "serializes reset and move atomically when %s is queued first",
      async (order) => {
        await seedBookings();
        await seedTargetWithPartner();
        const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);
        const move = () =>
          moveBedAllocationsSameDate({
            allocationIds: [TARGET_ALLOCATION_ID],
            bedId: DESTINATION_BED_ID,
            actorMemberId: ACTOR_ID,
          });

        const outcomes =
          order === "MOVE_FIRST"
            ? await runWritersInGlobalQueueOrder(move, removal.apply)
            : await runWritersInGlobalQueueOrder(removal.apply, move);
        const [moveOutcome, removalOutcome] =
          order === "MOVE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        const [target, partner, removalAudits, moveAudits] = await Promise.all([
          prisma.bedAllocation.findUnique({
            where: { id: TARGET_ALLOCATION_ID },
            select: { bedId: true },
          }),
          prisma.bedAllocation.findUniqueOrThrow({
            where: { id: PARTNER_ALLOCATION_ID },
            select: { isSecondOccupant: true },
          }),
          actionCount(REMOVAL_AUDIT_ACTIONS),
          actionCount(MOVE_AUDIT_ACTIONS),
        ]);

        expect(partner.isSecondOccupant).toBe(false);
        if (order === "MOVE_FIRST") {
          expect(moveOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(removalOutcome)).toBe(409);
          expect(target?.bedId).toBe(DESTINATION_BED_ID);
          expect(removalAudits).toBe(0);
          expect(moveAudits).toBe(2);
        } else {
          expect(removalOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(moveOutcome)).toBe(404);
          expect(target).toBeNull();
          expect(removalAudits).toBe(2);
          expect(moveAudits).toBe(0);
        }
      },
    );

    it.each(["MOVE_FIRST", "REMOVAL_FIRST"] as const)(
      "serializes reviewed move and reviewed removal when %s is queued first",
      async (order) => {
        await seedBookings();
        await seedTargetWithPartner();
        const move = await reviewedTargetMove();
        const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

        const outcomes =
          order === "MOVE_FIRST"
            ? await runWritersInGlobalQueueOrder(move.apply, removal.apply)
            : await runWritersInGlobalQueueOrder(removal.apply, move.apply);
        const [moveOutcome, removalOutcome] =
          order === "MOVE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        const [target, partner, reviewedMoveAudits, removalAudits] =
          await Promise.all([
            prisma.bedAllocation.findUnique({
              where: { id: TARGET_ALLOCATION_ID },
              select: { bedId: true, source: true, approvedAt: true },
            }),
            prisma.bedAllocation.findUniqueOrThrow({
              where: { id: PARTNER_ALLOCATION_ID },
              select: { isSecondOccupant: true },
            }),
            actionCount(["BED_ALLOCATION_MOVE_APPLIED"]),
            actionCount(["BED_ALLOCATION_REMOVAL_APPLIED"]),
          ]);

        expect(partner.isSecondOccupant).toBe(false);
        if (order === "MOVE_FIRST") {
          expect(moveOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(removalOutcome)).toBe(409);
          expect(target).toEqual({
            bedId: DESTINATION_BED_ID,
            source: "MANUAL",
            approvedAt: null,
          });
          expect(reviewedMoveAudits).toBe(1);
          expect(removalAudits).toBe(0);
        } else {
          expect(removalOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(moveOutcome)).toBe(409);
          if (moveOutcome.status === "rejected") {
            expect(moveOutcome.reason).toMatchObject({
              refreshedPreview: expect.objectContaining({
                conflicts: [
                  expect.objectContaining({ code: "ALLOCATION_UNAVAILABLE" }),
                ],
              }),
            });
          }
          expect(target).toBeNull();
          expect(reviewedMoveAudits).toBe(0);
          expect(removalAudits).toBe(1);
        }
      },
    );

    it.each(["MOVE_FIRST", "AUTO_FIRST"] as const)(
      "serializes a reviewed person move and explicit auto-allocation when %s is queued first",
      async (order) => {
        await seedBookings();
        await seedTargetWithPartner();
        await prisma.bedAllocation.update({
          where: { id: TARGET_ALLOCATION_ID },
          data: {
            approvedAt: TARGET_APPROVED_AT,
            approvedByMemberId: ACTOR_ID,
          },
        });
        const move = await reviewedTargetMove("BOOKING_GUEST");
        expect(move.preview).toMatchObject({
          resolvedRowCount: 1,
          changedRowCount: 1,
          unchangedRowCount: 0,
          approvedToDraftCount: 1,
          promotions: [{ stayDate: FIRST_NIGHT_DATE_ONLY }],
          conflicts: [],
        });
        const range = {
          from: FIRST_NIGHT,
          to: CHECK_OUT,
          fromDate: FIRST_NIGHT_DATE_ONLY,
          toDate: "2099-04-03",
        };

        const outcomes =
          order === "MOVE_FIRST"
            ? await runWritersInGlobalQueueOrder(move.apply, () =>
                runAutoBedAllocation({ range, lodgeId: LODGE_ID }),
              )
            : await runWritersInGlobalQueueOrder(
                () => runAutoBedAllocation({ range, lodgeId: LODGE_ID }),
                move.apply,
              );
        const [moveOutcome, autoOutcome] =
          order === "MOVE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        expect(settledValueOrThrow(autoOutcome)).toMatchObject({ count: 2 });
        const [targetRows, partner, moveAuditCount, promotionAuditCount] =
          await Promise.all([
            prisma.bedAllocation.findMany({
              where: {
                bookingId: BOOKING_ID,
                bookingGuestId: GUEST_ID,
              },
              select: {
                id: true,
                stayDate: true,
                bedId: true,
                source: true,
                approvedAt: true,
                approvedByMemberId: true,
              },
              orderBy: { stayDate: "asc" },
            }),
            prisma.bedAllocation.findUniqueOrThrow({
              where: { id: PARTNER_ALLOCATION_ID },
              select: { isSecondOccupant: true },
            }),
            actionCount(["BED_ALLOCATION_MOVE_APPLIED"]),
            actionCount(["BED_ALLOCATION_PARTNERS_PROMOTED"]),
          ]);
        expect(targetRows).toHaveLength(2);
        expect(targetRows[1]).toMatchObject({
          stayDate: SECOND_NIGHT,
          source: "AUTO",
          approvedAt: null,
          approvedByMemberId: null,
        });

        if (order === "MOVE_FIRST") {
          expect(settledValueOrThrow(moveOutcome)).toMatchObject({
            noop: false,
            movedRowCount: 1,
            promotedRowCount: 1,
            affectedNights: [FIRST_NIGHT_DATE_ONLY],
          });
          expect(targetRows[0]).toEqual({
            id: TARGET_ALLOCATION_ID,
            stayDate: FIRST_NIGHT,
            bedId: DESTINATION_BED_ID,
            source: "MANUAL",
            approvedAt: null,
            approvedByMemberId: null,
          });
          expect(partner.isSecondOccupant).toBe(false);
          expect(moveAuditCount).toBe(1);
          expect(promotionAuditCount).toBe(1);
          return;
        }

        expect(rejectionStatus(moveOutcome)).toBe(409);
        if (moveOutcome.status === "rejected") {
          expect(moveOutcome.reason).toMatchObject({
            code: "STALE_PREVIEW",
            refreshedPreview: expect.objectContaining({
              scope: "BOOKING_GUEST",
              resolvedRowCount: 2,
            }),
          });
        }
        expect(targetRows[0]).toEqual({
          id: TARGET_ALLOCATION_ID,
          stayDate: FIRST_NIGHT,
          bedId: OLD_DOUBLE_BED_ID,
          source: "MANUAL",
          approvedAt: TARGET_APPROVED_AT,
          approvedByMemberId: ACTOR_ID,
        });
        expect(partner.isSecondOccupant).toBe(true);
        expect(moveAuditCount).toBe(0);
        expect(promotionAuditCount).toBe(0);
      },
    );

    it.each(["MOVE_FIRST", "LIFECYCLE_FIRST"] as const)(
      "serializes a reviewed person move and lifecycle reconciliation when %s is queued first",
      async (order) => {
        await seedBookings();
        await seedTargetWithPartner();
        await prisma.bedAllocation.update({
          where: { id: TARGET_ALLOCATION_ID },
          data: {
            approvedAt: TARGET_APPROVED_AT,
            approvedByMemberId: ACTOR_ID,
          },
        });
        const move = await reviewedTargetMove("BOOKING_GUEST");
        expect(move.preview).toMatchObject({
          resolvedRowCount: 1,
          changedRowCount: 1,
          unchangedRowCount: 0,
          approvedToDraftCount: 1,
          promotions: [{ stayDate: FIRST_NIGHT_DATE_ONLY }],
          conflicts: [],
        });
        const reconcile = () =>
          reconcileBedAllocationsForBooking({ bookingId: BOOKING_ID });

        const outcomes =
          order === "MOVE_FIRST"
            ? await runWritersInGlobalQueueOrder(move.apply, reconcile)
            : await runWritersInGlobalQueueOrder(reconcile, move.apply);
        const [moveOutcome, lifecycleOutcome] =
          order === "MOVE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        expect(settledValueOrThrow(lifecycleOutcome)).toMatchObject({
          enabled: true,
          deletedCount: 0,
          createdCount: 1,
          promotedCount: 0,
        });
        const [targetRows, partner, moveAuditCount, promotionAuditCount] =
          await Promise.all([
            prisma.bedAllocation.findMany({
              where: {
                bookingId: BOOKING_ID,
                bookingGuestId: GUEST_ID,
              },
              select: {
                id: true,
                stayDate: true,
                bedId: true,
                source: true,
                approvedAt: true,
                approvedByMemberId: true,
              },
              orderBy: { stayDate: "asc" },
            }),
            prisma.bedAllocation.findUniqueOrThrow({
              where: { id: PARTNER_ALLOCATION_ID },
              select: { isSecondOccupant: true },
            }),
            actionCount(["BED_ALLOCATION_MOVE_APPLIED"]),
            actionCount(["BED_ALLOCATION_PARTNERS_PROMOTED"]),
          ]);
        expect(targetRows).toHaveLength(2);
        expect(targetRows[1]).toMatchObject({
          stayDate: SECOND_NIGHT,
          source: "AUTO",
          approvedAt: null,
          approvedByMemberId: null,
        });

        if (order === "MOVE_FIRST") {
          expect(settledValueOrThrow(moveOutcome)).toMatchObject({
            noop: false,
            movedRowCount: 1,
            promotedRowCount: 1,
            affectedNights: [FIRST_NIGHT_DATE_ONLY],
          });
          expect(targetRows[0]).toEqual({
            id: TARGET_ALLOCATION_ID,
            stayDate: FIRST_NIGHT,
            bedId: DESTINATION_BED_ID,
            source: "MANUAL",
            approvedAt: null,
            approvedByMemberId: null,
          });
          expect(partner.isSecondOccupant).toBe(false);
          expect(moveAuditCount).toBe(1);
          expect(promotionAuditCount).toBe(1);
          return;
        }

        expect(rejectionStatus(moveOutcome)).toBe(409);
        if (moveOutcome.status === "rejected") {
          expect(moveOutcome.reason).toMatchObject({
            code: "STALE_PREVIEW",
            refreshedPreview: expect.objectContaining({
              scope: "BOOKING_GUEST",
              resolvedRowCount: 2,
            }),
          });
        }
        expect(targetRows[0]).toEqual({
          id: TARGET_ALLOCATION_ID,
          stayDate: FIRST_NIGHT,
          bedId: OLD_DOUBLE_BED_ID,
          source: "MANUAL",
          approvedAt: TARGET_APPROVED_AT,
          approvedByMemberId: ACTOR_ID,
        });
        expect(partner.isSecondOccupant).toBe(true);
        expect(moveAuditCount).toBe(0);
        expect(promotionAuditCount).toBe(0);
      },
    );

    it("applies all 366 person rows in one guarded statement beyond the old default transaction shape", async () => {
      const nights = Array.from(
        { length: 366 },
        (_, index) => new Date(Date.UTC(2099, 3, 1 + index)),
      );
      const checkOut = new Date(Date.UTC(2099, 3, 1 + nights.length));
      const allocationIds = nights.map(
        (_, index) => `race-2595-bulk-${String(index).padStart(3, "0")}`,
      );
      await seedBookings("CONFIRMED", false);
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { checkOut },
      });
      await prisma.bookingGuest.update({
        where: { id: GUEST_ID },
        data: { stayEnd: checkOut },
      });
      await prisma.bookingGuestNight.deleteMany({
        where: { bookingGuestId: GUEST_ID },
      });
      await prisma.bookingGuestNight.createMany({
        data: nights.map((stayDate) => ({
          bookingGuestId: GUEST_ID,
          stayDate,
          priceCents: 100,
        })),
      });
      await prisma.bedAllocation.createMany({
        data: nights.map((stayDate, index) => ({
          id: allocationIds[index],
          bookingId: BOOKING_ID,
          bookingGuestId: GUEST_ID,
          roomId: ROOM_ID,
          bedId: OLD_DOUBLE_BED_ID,
          bedType: "DOUBLE" as const,
          stayDate,
          source: "AUTO" as const,
        })),
      });

      await installMove366StatementDelay();
      const oldShapeStartedAt = process.hrtime.bigint();
      await expect(
        prisma.$transaction(async (tx) => {
          for (const id of allocationIds) {
            await tx.bedAllocation.updateMany({
              where: { id },
              data: { source: "MANUAL" },
            });
          }
        }),
      ).rejects.toMatchObject({ code: "P2028" });
      expect(realElapsedMs(oldShapeStartedAt)).toBeGreaterThanOrEqual(4_500);
      expect(
        await prisma.bedAllocation.count({
          where: {
            id: { in: allocationIds },
            source: "AUTO",
            bedId: OLD_DOUBLE_BED_ID,
          },
        }),
      ).toBe(366);

      const request = {
        anchorAllocationId: allocationIds[0],
        destinationBedId: DESTINATION_BED_ID,
        scope: "BOOKING_GUEST" as const,
      };
      const preview = await previewBedAllocationMove(request);
      expect(preview).toMatchObject({
        resolvedRowCount: 366,
        changedRowCount: 366,
        unchangedRowCount: 0,
        conflicts: [],
      });

      const result = await applyBedAllocationMove({
        actorMemberId: ACTOR_ID,
        request: { ...request, previewDigest: preview.digest },
      });
      expect(result).toMatchObject({
        noop: false,
        movedRowCount: 366,
        promotedRowCount: 0,
      });
      expect(
        await prisma.bedAllocation.count({
          where: {
            id: { in: allocationIds },
            source: "MANUAL",
            bedId: DESTINATION_BED_ID,
            approvedAt: null,
          },
        }),
      ).toBe(366);
      expect(await actionCount(["BED_ALLOCATION_MOVE_APPLIED"])).toBe(1);
    });

    it("serializes an explicit auto run before reset, records no reset-triggered planning, and permits a later explicit rebuild", async () => {
      await seedBookings("CONFIRMED", false);
      await prisma.bedAllocation.create({
        data: {
          id: TARGET_ALLOCATION_ID,
          bookingId: BOOKING_ID,
          bookingGuestId: GUEST_ID,
          roomId: ROOM_ID,
          bedId: OLD_DOUBLE_BED_ID,
          bedType: "DOUBLE",
          stayDate: FIRST_NIGHT,
          source: "MANUAL",
        },
      });
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);
      const range = {
        from: FIRST_NIGHT,
        to: CHECK_OUT,
        fromDate: FIRST_NIGHT_DATE_ONLY,
        toDate: "2099-04-03",
      };

      const [autoOutcome, removalOutcome] = await runWritersInGlobalQueueOrder(
        () => runAutoBedAllocation({ range, lodgeId: LODGE_ID }),
        removal.apply,
      );
      expect(autoOutcome.status).toBe("fulfilled");
      expect(removalOutcome.status).toBe("fulfilled");
      if (autoOutcome.status === "fulfilled") {
        expect(autoOutcome.value.count).toBe(1);
      }

      const afterRace = await prisma.bedAllocation.findMany({
        where: { bookingId: BOOKING_ID },
        select: { stayDate: true, source: true },
        orderBy: { stayDate: "asc" },
      });
      expect(afterRace).toEqual([
        expect.objectContaining({ stayDate: SECOND_NIGHT, source: "AUTO" }),
      ]);
      const removalAudit = await prisma.auditLog.findFirstOrThrow({
        where: { memberId: ACTOR_ID, action: "BED_ALLOCATION_REMOVAL_APPLIED" },
        select: { metadata: true },
      });
      expect(removalAudit.metadata).toMatchObject({
        autoAllocationTriggered: false,
      });

      // D-R19 forbids RESET from invoking the planner. It does not forbid a
      // later, separately authorised Run Auto Allocation action. A fresh run
      // sees the committed missing first night and may rebuild it.
      const laterExplicitRun = await runAutoBedAllocation({
        range,
        lodgeId: LODGE_ID,
      });
      expect(laterExplicitRun.count).toBe(1);
      const rebuilt = await prisma.bedAllocation.findMany({
        where: { bookingId: BOOKING_ID },
        select: { stayDate: true, source: true },
        orderBy: { stayDate: "asc" },
      });
      expect(rebuilt).toEqual([
        expect.objectContaining({ stayDate: FIRST_NIGHT, source: "AUTO" }),
        expect.objectContaining({ stayDate: SECOND_NIGHT, source: "AUTO" }),
      ]);
    });

    it("returns a refreshed stale preview after lifecycle reconciliation wins, with no partial reset audit", async () => {
      await seedBookings();
      await prisma.bedAllocation.create({
        data: {
          id: OTHER_ALLOCATION_ID,
          bookingId: BOOKING_ID,
          bookingGuestId: GUEST_ID,
          roomId: ROOM_ID,
          bedId: OTHER_BED_ID,
          stayDate: FIRST_NIGHT,
          source: "MANUAL",
        },
      });
      await seedTargetWithPartner(SECOND_NIGHT);
      await prisma.bookingGuest.update({
        where: { id: GUEST_ID },
        data: { stayEnd: SECOND_NIGHT },
      });
      await prisma.bookingGuestNight.delete({
        where: {
          bookingGuestId_stayDate: {
            bookingGuestId: GUEST_ID,
            stayDate: SECOND_NIGHT,
          },
        },
      });
      const removal = await reviewedTargetRemoval(SECOND_NIGHT_DATE_ONLY);

      const [lifecycleOutcome, removalOutcome] =
        await runWritersInGlobalQueueOrder(
          () => reconcileBedAllocationsForBooking({ bookingId: BOOKING_ID }),
          removal.apply,
        );

      expect(lifecycleOutcome.status).toBe("fulfilled");
      expect(rejectionStatus(removalOutcome)).toBe(409);
      if (removalOutcome.status === "rejected") {
        expect(removalOutcome.reason).toMatchObject({
          refreshedPreview: expect.objectContaining({ matchedRowCount: 0 }),
        });
      }
      const [target, validRow, partner, removalAudits] = await Promise.all([
        prisma.bedAllocation.findUnique({ where: { id: TARGET_ALLOCATION_ID } }),
          // Lifecycle reconciliation may replace a still-valid draft while it
          // rebuilds the booking's authoritative plan. The invariant is the
          // guest-night, not this fixture row's identity.
          prisma.bedAllocation.findFirst({
            where: {
              bookingId: BOOKING_ID,
              bookingGuestId: GUEST_ID,
              stayDate: FIRST_NIGHT,
            },
          }),
        prisma.bedAllocation.findUniqueOrThrow({
          where: { id: PARTNER_ALLOCATION_ID },
          select: { isSecondOccupant: true },
        }),
        actionCount(REMOVAL_AUDIT_ACTIONS),
      ]);
      expect(target).toBeNull();
      expect(validRow).not.toBeNull();
      expect(partner.isSecondOccupant).toBe(false);
      expect(removalAudits).toBe(0);
    });

    it("returns a refreshed stale preview after production cancellation wins, with no partial reset state", async () => {
      await seedBookings("AWAITING_REVIEW");
      await seedTargetWithPartner();
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

      const [cancelOutcome, removalOutcome] = await runWritersInGlobalQueueOrder(
        () =>
          cancelBooking(
            BOOKING_ID,
            ACTOR_ID,
            "ADMIN",
            "127.0.0.1",
            CLUB_FORMAT_TEST,
            "card",
            {
              suppressCustomerNotification: true,
              notifyMember: false,
            },
          ),
        removal.apply,
      );

      expect(cancelOutcome.status).toBe("fulfilled");
      if (cancelOutcome.status === "fulfilled") {
        expect(cancelOutcome.value.status).toBe(200);
      }
      expect(rejectionStatus(removalOutcome)).toBe(409);
      // cancelBooking intentionally emits its legacy cancellation audit
      // asynchronously. Observe it before teardown so the unique fixture is
      // never cleaned while that write is still in flight.
      await waitForAuditAction("booking.cancel");
      const [booking, target, partner, removalAudits] = await Promise.all([
        prisma.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: { status: true },
        }),
        prisma.bedAllocation.findUnique({ where: { id: TARGET_ALLOCATION_ID } }),
        prisma.bedAllocation.findUniqueOrThrow({
          where: { id: PARTNER_ALLOCATION_ID },
          select: { isSecondOccupant: true },
        }),
        actionCount(REMOVAL_AUDIT_ACTIONS),
      ]);
      expect(booking.status).toBe("CANCELLED");
      expect(target).toBeNull();
      expect(partner.isSecondOccupant).toBe(false);
      expect(removalAudits).toBe(0);
    });

    it("returns an unavailable refreshed move preview after production cancellation wins", async () => {
      await seedBookings("AWAITING_REVIEW");
      await seedTargetWithPartner();
      const move = await reviewedTargetMove();

      const [cancelOutcome, moveOutcome] = await runWritersInGlobalQueueOrder(
        () =>
          cancelBooking(
            BOOKING_ID,
            ACTOR_ID,
            "ADMIN",
            "127.0.0.1",
            CLUB_FORMAT_TEST,
            "card",
            {
              suppressCustomerNotification: true,
              notifyMember: false,
            },
          ),
        move.apply,
      );

      expect(cancelOutcome.status).toBe("fulfilled");
      expect(rejectionStatus(moveOutcome)).toBe(409);
      if (moveOutcome.status === "rejected") {
        expect(moveOutcome.reason).toMatchObject({
          code: "STALE_PREVIEW",
          refreshedPreview: expect.objectContaining({
            conflicts: [
              expect.objectContaining({ code: "ALLOCATION_UNAVAILABLE" }),
            ],
          }),
        });
      }
      await waitForAuditAction("booking.cancel");
      expect(
        await prisma.bedAllocation.findUnique({
          where: { id: TARGET_ALLOCATION_ID },
        }),
      ).toBeNull();
      expect(await actionCount(["BED_ALLOCATION_MOVE_APPLIED"])).toBe(0);
    });
  },
);
