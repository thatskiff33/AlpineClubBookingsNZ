/**
 * Real-PostgreSQL proof for the member-merge shared-double defect (#2595).
 *
 * Merging a duplicate whose CONFIRMED partner link is DROPPED by the merge
 * (because the master already has its one confirmed partner) leaves the master
 * and the duplicate's ex-partner sitting in the same DOUBLE bed on a future
 * lodge night with no partnership backing the share. Every other lifecycle
 * event that breaks the sharing precondition — link dissolve, deactivation,
 * ADULT-to-minor correction, account deletion, seasonal tier change — runs the
 * canonical partner-share sweep; merge never did, and no database constraint
 * supplies the invariant.
 *
 * This suite drives the REAL production entrypoints against a real database:
 * `buildMemberMergePreview` + `executeMemberMerge`, which since the #2618
 * integration performs the repair itself as merge step 3b. Every assertion below
 * therefore reads COMMITTED rows written by the production merge — no
 * re-implementation of either side, and no test-only composition of the two.
 * `acquireMemberMergePartnerSharedLodgeLocks` +
 * `sweepUnbackedFutureSharedDoublesWithLocksHeld` are imported only to drive a
 * SECOND pass for the idempotence case.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` already
 * provisions (#1881) and cleans its own uniquely-namespaced fixtures.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
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


/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

// A member merge joins the per-lodge tier at the TOP of its transaction (#2595
// takes the partner-share lodge prefix immediately after the hosting policy-set
// key, so the fixed lodge -> member order holds). Merge deliberately takes NO
// global cohort key, which is why the queue device below sequences writers on the
// LODGE capacity key. A timeout in the poller must mean "a production writer
// stopped taking the lodge key", never "the merge was still building its
// preview" — every case pre-builds the preview outside the queued window (see
// `queueableMergeWriter`).
const LOCK_POLL_TIMEOUT_MS = 30_000;
const RACE_TEST_TIMEOUT_MS = 120_000;

const ACTOR_ID = "race-2595-admin";
const LOSER_ID = "race-2595-loser";
const MASTER_ID = "race-2595-master";
const EX_PARTNER_ID = "race-2595-partner";
const MASTER_PARTNER_ID = "race-2595-qpartner";
const MERGE_MEMBER_IDS = [
  ACTOR_ID,
  LOSER_ID,
  MASTER_ID,
  EX_PARTNER_ID,
  MASTER_PARTNER_ID,
] as const;

const LODGE_ID = "race-2595-merge-lodge";
const ROOM_ID = "race-2595-merge-room";
// A SECOND lodge, used only by the derivation case. The master holds a future
// booking here and NOT ONE bed allocation, so it is in merge's prefix if and
// only if the prefix derives lodges from future GUEST-NIGHTS (#2595). It has a
// room and a bed purely so the lodge is a realistic allocation target.
const GUEST_NIGHT_ONLY_LODGE_ID = "race-2595-guestnight-lodge";
const GUEST_NIGHT_ONLY_ROOM_ID = "race-2595-guestnight-room";
const GUEST_NIGHT_ONLY_BED_ID = "race-2595-guestnight-bed";
const GUEST_NIGHT_ONLY_BOOKING_ID = "race-2595-guestnight-booking";
const GUEST_NIGHT_ONLY_GUEST_ID = "race-2595-guestnight-guest";
// A THIRD lodge, for #2672. The duplicate holds a guest row here whose stay is
// entirely in the PAST, and nothing else — no future night, no allocation. Under
// the derivation #2641 shipped (future guest-nights only) this lodge is invisible
// to merge, and a real admin date shift can pull that stay into the future while
// the merge runs, into a lodge merge holds no key for. Under the derivation this
// suite now pins (every guest row, no date filter) it is covered.
const PAST_STAY_LODGE_ID = "race-2672-past-lodge";
const PAST_STAY_ROOM_ID = "race-2672-past-room";
const PAST_STAY_DOUBLE_BED_ID = "race-2672-past-double";
const PAST_STAY_BOOKING_ID = "race-2672-past-booking";
const PAST_STAY_GUEST_ID = "race-2672-past-guest";
const PAST_STAY_PARTNER_BOOKING_ID = "race-2672-past-partner-booking";
const PAST_STAY_PARTNER_GUEST_ID = "race-2672-past-partner-guest";
const PAST_STAY_PARTNER_ALLOCATION_ID = "race-2672-past-partner-allocation";
// A FOURTH lodge, used only by the coverage-refusal case: no fixture at all
// until a booking is created there mid-merge.
const LATE_LODGE_ID = "race-2672-late-lodge";
const LATE_LODGE_ROOM_ID = "race-2672-late-room";
const LATE_LODGE_BOOKING_ID = "race-2672-late-booking";
const LATE_LODGE_GUEST_ID = "race-2672-late-guest";

const ALL_LODGE_IDS = [
  LODGE_ID,
  GUEST_NIGHT_ONLY_LODGE_ID,
  PAST_STAY_LODGE_ID,
  LATE_LODGE_ID,
];
const UNBACKED_DOUBLE_ID = "race-2595-unbacked-double";
const BACKED_DOUBLE_ID = "race-2595-backed-double";
// Spare singles so the racing production writers have somewhere to place their
// own booking without displacing anybody: a cramped room would make the race
// cases fail on the planner's displacement bookkeeping instead of on this
// issue's invariant.
const SPARE_SINGLE_IDS = [
  "race-2595-spare-single-1",
  "race-2595-spare-single-2",
];
const MERGE_BED_IDS = [
  UNBACKED_DOUBLE_ID,
  BACKED_DOUBLE_ID,
  ...SPARE_SINGLE_IDS,
];

const LOSER_BOOKING_ID = "race-2595-loser-booking";
const EX_PARTNER_BOOKING_ID = "race-2595-partner-booking";
const MASTER_BOOKING_ID = "race-2595-master-booking";
const MASTER_PARTNER_BOOKING_ID = "race-2595-qpartner-booking";
const NEIGHBOUR_BOOKING_ID = "race-2595-neighbour-booking";
const MERGE_BOOKING_IDS = [
  LOSER_BOOKING_ID,
  EX_PARTNER_BOOKING_ID,
  MASTER_BOOKING_ID,
  MASTER_PARTNER_BOOKING_ID,
];
const ALL_BOOKING_IDS = [
  ...MERGE_BOOKING_IDS,
  NEIGHBOUR_BOOKING_ID,
  GUEST_NIGHT_ONLY_BOOKING_ID,
  PAST_STAY_BOOKING_ID,
  PAST_STAY_PARTNER_BOOKING_ID,
  LATE_LODGE_BOOKING_ID,
];

const LOSER_GUEST_ID = "race-2595-loser-guest";
const EX_PARTNER_GUEST_ID = "race-2595-partner-guest";
const MASTER_GUEST_ID = "race-2595-master-guest";
const MASTER_PARTNER_GUEST_ID = "race-2595-qpartner-guest";
const NEIGHBOUR_GUEST_ID = "race-2595-neighbour-guest";

const LOSER_ALLOCATION_ID = "race-2595-loser-allocation";
const EX_PARTNER_ALLOCATION_ID = "race-2595-partner-allocation";
const MASTER_ALLOCATION_ID = "race-2595-master-allocation";
const MASTER_PARTNER_ALLOCATION_ID = "race-2595-qpartner-allocation";

// Far-future lodge nights, so the frozen test clock (#2481) can never make the
// sweep's `stayDate >= today` window vacuous. The merge fixture occupies ONE
// night; the neighbouring booking the race cases drive occupies the NEXT one.
const MERGE_NIGHT = new Date("2099-06-01T00:00:00.000Z");
const MERGE_CHECK_OUT = new Date("2099-06-02T00:00:00.000Z");
const NEIGHBOUR_NIGHT = new Date("2099-06-02T00:00:00.000Z");
const NEIGHBOUR_CHECK_OUT = new Date("2099-06-03T00:00:00.000Z");
const MERGE_NIGHT_DATE_ONLY = "2099-06-01";
const NEIGHBOUR_NIGHT_DATE_ONLY = "2099-06-02";
const NEIGHBOUR_CHECK_OUT_DATE_ONLY = "2099-06-03";

// #2672's fully-past stay, and the future night a real `adminShiftBookingDates`
// translates it onto. Both are one night long, because "shift dates" refuses to
// change the night count.
const PAST_STAY_NIGHT = new Date("2020-06-01T00:00:00.000Z");
const PAST_STAY_CHECK_OUT = new Date("2020-06-02T00:00:00.000Z");
const SHIFTED_NIGHT = new Date("2099-07-01T00:00:00.000Z");
const SHIFTED_CHECK_OUT = new Date("2099-07-02T00:00:00.000Z");
const SHIFTED_NIGHT_DATE_ONLY = "2099-07-01";
const SHIFTED_CHECK_OUT_DATE_ONLY = "2099-07-02";

const SHARE_SWEPT_AUDIT_ACTION = "BED_ALLOCATION_PARTNER_SHARE_SWEPT";

let prisma: typeof import("@/lib/prisma")["prisma"];
let buildMemberMergePreview: typeof import("@/lib/member-merge")["buildMemberMergePreview"];
let executeMemberMerge: typeof import("@/lib/member-merge")["executeMemberMerge"];
let runAutoBedAllocation: typeof import("@/lib/bed-allocation-auto-allocate")["runAutoBedAllocation"];
let manuallyAllocateBed: typeof import("@/lib/bed-allocation-manual-writes")["manuallyAllocateBed"];
let adminShiftBookingDates: typeof import("@/lib/booking-date-modification-service")["adminShiftBookingDates"];
let reconcileBedAllocationsForBooking: typeof import("@/lib/bed-allocation-lifecycle")["reconcileBedAllocationsForBooking"];
let acquireMemberMergePartnerSharedLodgeLocks: typeof import("@/lib/bed-allocation-lifecycle")["acquireMemberMergePartnerSharedLodgeLocks"];
let sweepUnbackedFutureSharedDoublesWithLocksHeld: typeof import("@/lib/bed-allocation-lifecycle")["sweepUnbackedFutureSharedDoublesWithLocksHeld"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

/** Standalone fail-closed copy: importing this file must not register the parent suite. */
export function assertSafeMergeShareRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Member-merge shared-double races need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run member-merge shared-double races against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Member-merge shared-double race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Member-merge shared-double race DB name must contain 'concurrency_race_1881'.",
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

/** Ungranted waiters on the global cohort key `pg_advisory_xact_lock(1)`. */
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

/**
 * Ungranted waiters on ONE per-lodge capacity key.
 *
 * `acquireLodgeCapacityLock` takes the single-argument `pg_advisory_xact_lock`
 * form, so PostgreSQL splits the 64-bit `hashtextextended(lodgeId, 0)` key into
 * `(classid, objid)` with `objsubid = 1`. The split is done in SQL rather than in
 * JS so the observer never has to marshal a signed 64-bit hash.
 */
async function pendingLodgeLockWaiters(lodgeId: string): Promise<number> {
  const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND objsubid = 1
      AND granted = false
      AND classid::bigint = ((hashtextextended(${lodgeId}, 0) >> 32) & 4294967295)
      AND objid::bigint = (hashtextextended(${lodgeId}, 0) & 4294967295)
  `;
  return rows[0]?.count ?? 0;
}

async function waitForLodgeLockWaiters(
  expected: number,
  lodgeId = LODGE_ID,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  let seen = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    seen = await pendingLodgeLockWaiters(lodgeId);
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${expected} writer(s) on the ${lodgeId} capacity key; saw ${seen}. A production writer may have stopped taking the per-lodge tier.`,
  );
}

/**
 * The `member-lifecycle:<id>` key of whichever merged member sorts FIRST — the
 * key merge takes immediately after its lodge prefix.
 *
 * That makes it the one barrier in the merge that sits exactly between "the
 * lodge set has been derived and locked" and "anything has been written". Every
 * #2672 case parks the merge there, does its concurrent work, and releases.
 * `member-lifecycle:` keys use the single-argument `pg_advisory_xact_lock` with
 * `hashtext` (a signed int4), so the `(classid, objid)` split is done in SQL for
 * the same reason as the lodge poller above.
 */
const FIRST_MEMBER_LIFECYCLE_KEY = `member-lifecycle:${[MASTER_ID, LOSER_ID].sort()[0]}`;

async function pendingMemberLifecycleLockWaiters(): Promise<number> {
  const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND objsubid = 1
      AND granted = false
      AND classid::bigint = ((hashtext(${FIRST_MEMBER_LIFECYCLE_KEY})::bigint >> 32) & 4294967295)
      AND objid::bigint = (hashtext(${FIRST_MEMBER_LIFECYCLE_KEY})::bigint & 4294967295)
  `;
  return rows[0]?.count ?? 0;
}

/**
 * Park a running merge on the member-lifecycle key and hand the caller the point
 * in the transaction where the lodge prefix is held and nothing is written yet.
 *
 * `body` runs there; then the key is released and the merge's own settled
 * outcome is returned, so a case can assert on a 409 as easily as on a success.
 */
async function withMergeParkedAfterItsLodgePrefix<T>(
  mergeWriter: () => Promise<Awaited<ReturnType<typeof executeMemberMerge>>>,
  body: () => Promise<T>,
): Promise<{
  body: T;
  merge: PromiseSettledResult<Awaited<ReturnType<typeof executeMemberMerge>>>;
}> {
  let merge: Promise<Awaited<ReturnType<typeof executeMemberMerge>>> | undefined;
  let bodyResult!: T;
  await whileHoldingAdvisoryKey(
    (tx) =>
      tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIRST_MEMBER_LIFECYCLE_KEY}))`,
    async () => {
      merge = mergeWriter();
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await pendingMemberLifecycleLockWaiters();
        if (seen >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (seen < 1) {
        throw new Error(
          `Timed out waiting for the merge to queue on ${FIRST_MEMBER_LIFECYCLE_KEY}. Merge must take its lodge prefix and THEN the sorted member-lifecycle pair.`,
        );
      }
      bodyResult = await body();
    },
  );
  const [settled] = await Promise.allSettled([merge!]);
  return { body: bodyResult, merge: settled };
}

/** Hold one advisory key on a separate connection for the body's duration. */
async function whileHoldingAdvisoryKey<T>(
  take: (tx: Prisma.TransactionClient) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const lockHeld = deferred();
  const releaseLock = deferred();
  let holderError: unknown;
  const holder = lockHolderClient
    .$transaction(
      async (tx) => {
        await take(tx);
        lockHeld.resolve();
        await releaseLock.promise;
      },
      { maxWait: 5_000, timeout: LOCK_POLL_TIMEOUT_MS + 30_000 },
    )
    .catch((error: unknown) => {
      holderError = error;
      lockHeld.resolve();
    });

  await lockHeld.promise;
  if (holderError) {
    throw new Error(`Could not hold the advisory key: ${String(holderError)}`);
  }
  try {
    return await body();
  } finally {
    releaseLock.resolve();
    await holder;
  }
}

/**
 * Queue two production writers in an explicit order behind a real holder of the
 * fixture lodge's capacity key. PostgreSQL grants advisory waiters in queue
 * order, so observing each waiter before starting the next makes the serialized
 * outcome deterministic without sleeps or test-only hooks in production code.
 *
 * The device sits on the LODGE key, not the global cohort key, because #2595's
 * merge deliberately takes no global key at all. Both racing bed-allocation
 * writers still take `lock(1)` first and then this lodge key, so they queue here
 * too — while holding the global key, which is exactly the convoy the owner
 * decision was weighing.
 *
 * The second writer's ARRIVAL time is part of the first writer's transaction
 * budget: the holder cannot release until both are queued, and the first writer
 * has already opened its own (default 5s) transaction. Every merge writer passed
 * here must therefore be a `queueableMergeWriter`, whose preview is built BEFORE
 * the window opens; a raw `runRealMemberMerge` would spend seconds of the first
 * writer's budget on preview work and reject it for reasons that have nothing to
 * do with the lock protocol.
 */
async function runWritersInLodgeQueueOrder<A, B>(
  firstWriter: () => Promise<A>,
  secondWriter: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const lockHeld = deferred();
  const releaseLock = deferred();
  let holderError: unknown;
  const holder = lockHolderClient
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LODGE_ID}, 0))`;
        lockHeld.resolve();
        await releaseLock.promise;
      },
      { maxWait: 5_000, timeout: LOCK_POLL_TIMEOUT_MS + 30_000 },
    )
    .catch((error: unknown) => {
      holderError = error;
      lockHeld.resolve();
    });

  await lockHeld.promise;
  if (holderError) {
    throw new Error(
      `Could not hold the ${LODGE_ID} capacity key: ${String(holderError)}`,
    );
  }

  const first = firstWriter();
  let second: Promise<B> | undefined;
  let observationError: unknown;
  try {
    await waitForLodgeLockWaiters(1);
    second = secondWriter();
    await waitForLodgeLockWaiters(2);
  } catch (error) {
    observationError = error;
  } finally {
    releaseLock.resolve();
  }

  await holder;
  if (holderError) {
    throw new Error(
      `The ${LODGE_ID} capacity key holder failed: ${String(holderError)}`,
    );
  }
  if (!second) {
    await Promise.allSettled([first]);
    throw observationError;
  }
  const outcomes = await Promise.allSettled([first, second]);
  if (observationError) throw observationError;
  return outcomes;
}

/** Surface a losing writer's real error instead of a bare "rejected". */
function settledValueOrThrow<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

async function clearMergeFixtures(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { memberId: { in: [...MERGE_MEMBER_IDS] } },
        { actorMemberId: { in: [...MERGE_MEMBER_IDS] } },
        { targetId: { in: [...MERGE_MEMBER_IDS, ...ALL_BOOKING_IDS] } },
      ],
    },
  });
  await prisma.hostingCoverageReevaluation.deleteMany({
    where: { memberId: { in: [...MERGE_MEMBER_IDS] } },
  });
  await prisma.hostingCoverageIncident.deleteMany({
    where: { bookingId: { in: ALL_BOOKING_IDS } },
  });
  await prisma.bookingEvent.deleteMany({
    where: { bookingId: { in: ALL_BOOKING_IDS } },
  });
  // #2672 drives a real `adminShiftBookingDates`, which records a
  // `BookingModification` — a RESTRICT relation, so it has to go before the
  // booking or the whole fixture teardown fails on the foreign key.
  await prisma.bookingModification.deleteMany({
    where: { bookingId: { in: ALL_BOOKING_IDS } },
  });
  await prisma.booking.deleteMany({ where: { id: { in: ALL_BOOKING_IDS } } });
  await prisma.memberPartnerLink.deleteMany({
    where: {
      OR: [
        { memberAId: { in: [...MERGE_MEMBER_IDS] } },
        { memberBId: { in: [...MERGE_MEMBER_IDS] } },
      ],
    },
  });
}

function canonicalPair(a: string, b: string) {
  return a < b ? { memberAId: a, memberBId: b } : { memberAId: b, memberBId: a };
}

const MERGE_MEMBER_SEED = [
  {
    id: ACTOR_ID,
    email: "race-2595-admin@example.invalid",
    firstName: "Merge",
    lastName: "Admin",
    role: "ADMIN" as const,
  },
  {
    id: LOSER_ID,
    email: "race-2595-loser@example.invalid",
    firstName: "Duplicate",
    lastName: "Loser",
    role: "USER" as const,
  },
  {
    id: MASTER_ID,
    email: "race-2595-master@example.invalid",
    firstName: "Surviving",
    lastName: "Master",
    role: "USER" as const,
  },
  {
    id: EX_PARTNER_ID,
    email: "race-2595-partner@example.invalid",
    firstName: "Dropped",
    lastName: "Partner",
    role: "USER" as const,
  },
  {
    id: MASTER_PARTNER_ID,
    email: "race-2595-qpartner@example.invalid",
    firstName: "Kept",
    lastName: "Partner",
    role: "USER" as const,
  },
];

/**
 * Re-establish the five members. Called per case, not once, because the merge
 * HARD-DELETES the duplicate — the next case's bookings would otherwise fail
 * the `Booking_memberId_fkey` foreign key.
 */
async function seedMergeMembers(): Promise<void> {
  for (const member of MERGE_MEMBER_SEED) {
    await prisma.member.upsert({
      where: { id: member.id },
      create: {
        id: member.id,
        email: member.email,
        passwordHash: "not-a-real-password",
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        ageTier: "ADULT",
        active: true,
      },
      update: {
        email: member.email,
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
      },
    });
  }
  // `actorIsFullAdmin` reads the access-role join, not `Member.role`.
  await prisma.memberAccessRole.upsert({
    where: { memberId_role: { memberId: ACTOR_ID, role: "ADMIN" } },
    create: { memberId: ACTOR_ID, role: "ADMIN" },
    update: {},
  });
}

async function seedBooking(params: {
  bookingId: string;
  memberId: string;
  guestId: string;
  guestMemberId: string | null;
  firstName: string;
  lastName: string;
  night: Date;
  checkOut: Date;
  /** Defaults to the fixture lodge; the derivation case seeds a second one. */
  lodgeId?: string;
}): Promise<void> {
  await prisma.booking.create({
    data: {
      id: params.bookingId,
      memberId: params.memberId,
      lodgeId: params.lodgeId ?? LODGE_ID,
      checkIn: params.night,
      checkOut: params.checkOut,
      status: "CONFIRMED",
      totalPriceCents: 100,
      finalPriceCents: 100,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: params.guestId,
      bookingId: params.bookingId,
      memberId: params.guestMemberId,
      firstName: params.firstName,
      lastName: params.lastName,
      ageTier: "ADULT",
      stayStart: params.night,
      stayEnd: params.checkOut,
      priceCents: 100,
    },
  });
  await prisma.bookingGuestNight.create({
    data: {
      bookingGuestId: params.guestId,
      stayDate: params.night,
      priceCents: 100,
    },
  });
}

/**
 * The exact scenario recorded on #2595, plus one neighbouring booking on the
 * NEXT night for the race cases to drive.
 *
 * The duplicate L holds a CONFIRMED partner link with P and shares a future
 * DOUBLE bed with them (L primary, P second occupant). The master M already
 * holds its one CONFIRMED partner Q and shares a DIFFERENT double with them,
 * which the merge must leave completely alone.
 */
async function seedMergeScenario(): Promise<void> {
  await clearMergeFixtures();
  // The merge HARD-DELETES the duplicate, so every case re-creates the members.
  await seedMergeMembers();

  const mergeNight = { night: MERGE_NIGHT, checkOut: MERGE_CHECK_OUT };
  await seedBooking({
    bookingId: LOSER_BOOKING_ID,
    memberId: LOSER_ID,
    guestId: LOSER_GUEST_ID,
    guestMemberId: LOSER_ID,
    firstName: "Duplicate",
    lastName: "Loser",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: EX_PARTNER_BOOKING_ID,
    memberId: EX_PARTNER_ID,
    guestId: EX_PARTNER_GUEST_ID,
    guestMemberId: EX_PARTNER_ID,
    firstName: "Dropped",
    lastName: "Partner",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: MASTER_BOOKING_ID,
    memberId: MASTER_ID,
    guestId: MASTER_GUEST_ID,
    guestMemberId: MASTER_ID,
    firstName: "Surviving",
    lastName: "Master",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: MASTER_PARTNER_BOOKING_ID,
    memberId: MASTER_PARTNER_ID,
    guestId: MASTER_PARTNER_GUEST_ID,
    guestMemberId: MASTER_PARTNER_ID,
    firstName: "Kept",
    lastName: "Partner",
    ...mergeNight,
  });
  // The race writers' own work: the night AFTER the merge fixture, with a
  // NON-member guest. See NEIGHBOUR_ALLOCATION_WINDOW_NOTE below.
  await seedBooking({
    bookingId: NEIGHBOUR_BOOKING_ID,
    memberId: ACTOR_ID,
    guestId: NEIGHBOUR_GUEST_ID,
    guestMemberId: null,
    firstName: "Neighbouring",
    lastName: "Guest",
    night: NEIGHBOUR_NIGHT,
    checkOut: NEIGHBOUR_CHECK_OUT,
  });

  await prisma.memberPartnerLink.createMany({
    data: [
      {
        ...canonicalPair(LOSER_ID, EX_PARTNER_ID),
        status: "CONFIRMED",
        confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        ...canonicalPair(MASTER_ID, MASTER_PARTNER_ID),
        status: "CONFIRMED",
        confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  });

  await prisma.bedAllocation.createMany({
    data: [
      {
        id: LOSER_ALLOCATION_ID,
        bookingId: LOSER_BOOKING_ID,
        bookingGuestId: LOSER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: UNBACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
      },
      {
        id: EX_PARTNER_ALLOCATION_ID,
        bookingId: EX_PARTNER_BOOKING_ID,
        bookingGuestId: EX_PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: UNBACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
        isSecondOccupant: true,
      },
      {
        id: MASTER_ALLOCATION_ID,
        bookingId: MASTER_BOOKING_ID,
        bookingGuestId: MASTER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: BACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
      },
      {
        id: MASTER_PARTNER_ALLOCATION_ID,
        bookingId: MASTER_PARTNER_BOOKING_ID,
        bookingGuestId: MASTER_PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: BACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
        isSecondOccupant: true,
      },
    ],
  });
}

/**
 * #2672's fixture, on top of `seedMergeScenario()`: the exact shape the old
 * date-filtered derivation could not see.
 *
 * At a THIRD lodge:
 *  - the duplicate is a guest on somebody else's booking whose stay finished in
 *    2020 — a real, ordinary row, invisible to a `stayEnd >= today` filter; and
 *  - the duplicate's confirmed partner already holds that lodge's one DOUBLE bed
 *    on a FUTURE night, as the primary.
 *
 * Neither of those puts the lodge in a future-guest-night derivation: the past
 * stay fails the date filter, and the ex-partner is not one of the merged
 * members, so their own future booking and allocation are out of scope for both
 * reads. One real `adminShiftBookingDates` translates the 2020 stay onto the
 * ex-partner's night, and the duplicate is suddenly placeable beside them.
 */
async function seedPastStayLodgeScenario(): Promise<void> {
  // The duplicate's fully-past stay, on a booking OWNED by the admin. Owner
  // matters: a booking the duplicate owned would be re-pointed by `applyMoves`,
  // and the date shift would then queue on that row lock instead of on the lodge
  // key, which is a different fence and would hide the one under test.
  await prisma.booking.create({
    data: {
      id: PAST_STAY_BOOKING_ID,
      memberId: ACTOR_ID,
      lodgeId: PAST_STAY_LODGE_ID,
      checkIn: PAST_STAY_NIGHT,
      checkOut: PAST_STAY_CHECK_OUT,
      status: "COMPLETED",
      totalPriceCents: 100,
      finalPriceCents: 100,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: PAST_STAY_GUEST_ID,
      bookingId: PAST_STAY_BOOKING_ID,
      memberId: LOSER_ID,
      firstName: "Duplicate",
      lastName: "Loser",
      ageTier: "ADULT",
      stayStart: PAST_STAY_NIGHT,
      stayEnd: PAST_STAY_CHECK_OUT,
      priceCents: 100,
    },
  });
  await prisma.bookingGuestNight.create({
    data: {
      bookingGuestId: PAST_STAY_GUEST_ID,
      stayDate: PAST_STAY_NIGHT,
      priceCents: 100,
    },
  });

  // The ex-partner's own future booking at the same lodge, holding the double.
  await seedBooking({
    bookingId: PAST_STAY_PARTNER_BOOKING_ID,
    memberId: EX_PARTNER_ID,
    guestId: PAST_STAY_PARTNER_GUEST_ID,
    guestMemberId: EX_PARTNER_ID,
    firstName: "Dropped",
    lastName: "Partner",
    night: SHIFTED_NIGHT,
    checkOut: SHIFTED_CHECK_OUT,
    lodgeId: PAST_STAY_LODGE_ID,
  });
  await prisma.bedAllocation.create({
    data: {
      id: PAST_STAY_PARTNER_ALLOCATION_ID,
      bookingId: PAST_STAY_PARTNER_BOOKING_ID,
      bookingGuestId: PAST_STAY_PARTNER_GUEST_ID,
      roomId: PAST_STAY_ROOM_ID,
      bedId: PAST_STAY_DOUBLE_BED_ID,
      bedType: "DOUBLE",
      stayDate: SHIFTED_NIGHT,
      source: "MANUAL",
    },
    select: { id: true },
  });
}

/** Every occupant of #2672's double bed on the shifted night. */
async function pastStayDoubleOccupants() {
  const rows = await prisma.bedAllocation.findMany({
    where: { bedId: PAST_STAY_DOUBLE_BED_ID, stayDate: SHIFTED_NIGHT },
    select: {
      id: true,
      isSecondOccupant: true,
      bookingGuest: { select: { memberId: true } },
    },
    orderBy: { isSecondOccupant: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    isSecondOccupant: row.isSecondOccupant,
    memberId: row.bookingGuest.memberId,
  }));
}

/** Drive the real preview + execute pair, exactly as the admin route does. */
async function runRealMemberMerge() {
  return (await queueableMergeWriter())();
}

/**
 * The same production pair, split so the PREVIEW happens now and only the
 * transaction-owning `executeMemberMerge` is left in the returned closure.
 *
 * The admin route builds its preview in a separate request, outside the merge
 * transaction, so this is faithful rather than a shortcut — and it is what makes
 * the queued-order cases about the lock protocol instead of about how long a
 * preview takes on a loaded runner. `buildMemberMergePreview` takes no lock, so
 * calling it before the queue window cannot perturb the race.
 */
async function queueableMergeWriter() {
  const preview = await buildMemberMergePreview({
    masterId: MASTER_ID,
    loserId: LOSER_ID,
    actorMemberId: ACTOR_ID,
  });
  expect(preview.blockers).toEqual([]);
  return () =>
    executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: preview.previewToken,
      confirmationText: preview.confirmationPhrase,
    });
}

/**
 * ============================= THE WIRED SEAM ==============================
 * `executeMemberMerge` now owns the reconciliation. The two edits that used to
 * be held out of this branch behind PR #2618 are in `src/lib/member-merge.ts`:
 *
 *   1. immediately AFTER `await lockAdultMemberHostingPolicySet(tx)` and BEFORE
 *      the two sorted `member-lifecycle:` advisory locks:
 *
 *          const partnerShareLodgeIds =
 *            await acquireMemberMergePartnerSharedLodgeLocks(
 *              tx, [masterId, loserId], clubTodayForMerge);
 *
 *      — every affected lodge key, sorted, and deliberately NOT the global cohort
 *      `lock(1)` (#2595 owner decision): a merge holds its keys for up to 120s,
 *      and the global key would reject every 5s-budget cohort writer in the club.
 *      The lodge set is therefore derived from the two members' future
 *      GUEST-NIGHTS as well as their existing allocations, so a lodge a placement
 *      could still land in is covered. Taking any of it at the point of use would
 *      acquire a lodge key with member keys already held.
 *
 *   2. as step 3b, AFTER `applyMoves` (guest rows now name the master), AFTER
 *      step 2's `resolvePartnerLinks` (the surviving partnerships are final),
 *      and after every drift refusal, BEFORE step 4's Xero teardown:
 *
 *          sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
 *            memberIds: [masterId, loserId],
 *            lockedLodgeIds: partnerShareLodgeIds,
 *            reason: "members_merged",
 *            today: clubTodayForMerge,
 *            db: tx,
 *          });
 *
 *      — the lodge set is passed back in so the sweep REFUSES (409) rather than
 *      judge a bed-night in a lodge the prefix did not cover.
 *
 * plus the post-commit `sendAdminPartnerShareSweptAlert` next to
 * `settleHostingCoverageAfterCommit`.
 *
 * That source order is pinned structurally by
 * `adult-member-hosting-coverage-lock.test.ts` ("pins the merge participant
 * re-plan, late sweeps, queue write and drain order"). This suite proves the
 * OBSERVABLE result of it on real PostgreSQL: `runRealMemberMerge()` below is
 * the entire production path, and every assertion reads committed rows.
 * ==========================================================================
 */

/**
 * A SECOND reconciliation pass over the same scope, driven through the same two
 * production helpers the merge itself uses. Only the idempotence case needs it:
 * the merge hard-deletes the loser, so a second merge cannot be run, and this is
 * the only way to ask "does another pass write anything?".
 */
async function runSecondReconciliationPass() {
  return prisma.$transaction(async (tx) => {
    const lockedLodgeIds = await acquireMemberMergePartnerSharedLodgeLocks(tx, [
      MASTER_ID,
      LOSER_ID,
    ], CLUB_TODAY_DATE_ONLY);
    return sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: [MASTER_ID, LOSER_ID],
      lockedLodgeIds,
      reason: "members_merged",
      db: tx,
    });
  });
}

async function sharedDoubleOccupants(bedId: string) {
  const rows = await prisma.bedAllocation.findMany({
    where: { bedId, stayDate: MERGE_NIGHT },
    select: {
      id: true,
      bedId: true,
      isSecondOccupant: true,
      bookingId: true,
      bookingGuest: { select: { memberId: true } },
    },
    orderBy: { isSecondOccupant: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    bedId: row.bedId,
    isSecondOccupant: row.isSecondOccupant,
    bookingId: row.bookingId,
    memberId: row.bookingGuest.memberId,
  }));
}

async function confirmedPartnerIdsOf(memberId: string): Promise<string[]> {
  const links = await prisma.memberPartnerLink.findMany({
    where: {
      status: "CONFIRMED",
      OR: [{ memberAId: memberId }, { memberBId: memberId }],
    },
    select: { memberAId: true, memberBId: true },
  });
  return links
    .map((link) => (link.memberAId === memberId ? link.memberBId : link.memberAId))
    .sort();
}

async function shareSweptAuditRows() {
  return prisma.auditLog.findMany({
    where: {
      action: SHARE_SWEPT_AUDIT_ACTION,
      targetId: { in: ALL_BOOKING_IDS },
    },
    select: { targetId: true, metadata: true },
    orderBy: { targetId: "asc" },
  });
}

/**
 * The #2595 invariant, read back from the committed rows: no FUTURE bed-night
 * in the fixture lodge holds two occupants without a CONFIRMED partner link
 * behind them, AND the master's own backed share is still there.
 *
 * Deliberately a scan of the whole lodge window rather than a fixed row list, so
 * a concurrent writer that re-plans the contested pair onto a different bed
 * cannot satisfy it by accident — and the second half stops "sweep everything"
 * from passing.
 */
async function expectNoUnbackedSharedDouble(): Promise<void> {
  const rows = await prisma.bedAllocation.findMany({
    where: { room: { lodgeId: LODGE_ID }, stayDate: { gte: MERGE_NIGHT } },
    select: {
      id: true,
      bedId: true,
      stayDate: true,
      isSecondOccupant: true,
      bookingGuest: { select: { memberId: true } },
    },
  });
  const confirmed = await prisma.memberPartnerLink.findMany({
    where: { status: "CONFIRMED" },
    select: { memberAId: true, memberBId: true },
  });
  const confirmedPairs = new Set(
    confirmed.map((link) => `${link.memberAId}:${link.memberBId}`),
  );

  const byBedNight = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.bedId}:${row.stayDate.toISOString().slice(0, 10)}`;
    byBedNight.set(key, [...(byBedNight.get(key) ?? []), row]);
  }
  for (const [bedNight, occupants] of byBedNight) {
    if (occupants.length < 2) continue;
    const primaryMemberId =
      occupants.find((row) => !row.isSecondOccupant)?.bookingGuest.memberId ?? null;
    const secondMemberId =
      occupants.find((row) => row.isSecondOccupant)?.bookingGuest.memberId ?? null;
    const pair =
      primaryMemberId && secondMemberId
        ? canonicalPair(primaryMemberId, secondMemberId)
        : null;
    expect({
      bedNight,
      primaryMemberId,
      secondMemberId,
      backedByConfirmedPartnership: Boolean(
        pair && confirmedPairs.has(`${pair.memberAId}:${pair.memberBId}`),
      ),
    }).toMatchObject({ backedByConfirmedPartnership: true });
  }

  const backed = await sharedDoubleOccupants(BACKED_DOUBLE_ID);
  expect(backed.map((row) => row.id)).toEqual([
    MASTER_ALLOCATION_ID,
    MASTER_PARTNER_ALLOCATION_ID,
  ]);
}

describe("member-merge shared-double race DB safety guard (#2595)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeMergeShareRaceDbUrl(
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
    expect(() => assertSafeMergeShareRaceDbUrl(url)).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "member merge leaves no unbacked shared double - real PostgreSQL (#2595)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let previousBedAllocationModuleEnabled: boolean | null = null;
    let moduleSettingsExisted = false;

    beforeAll(async () => {
      assertSafeMergeShareRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ buildMemberMergePreview, executeMemberMerge } = await import(
        "@/lib/member-merge"
      ));
      ({ runAutoBedAllocation } = await import(
        "@/lib/bed-allocation-auto-allocate"
      ));
      ({ manuallyAllocateBed } = await import(
        "@/lib/bed-allocation-manual-writes"
      ));
      ({ adminShiftBookingDates } = await import(
        "@/lib/booking-date-modification-service"
      ));
      ({
        acquireMemberMergePartnerSharedLodgeLocks,
        reconcileBedAllocationsForBooking,
        sweepUnbackedFutureSharedDoublesWithLocksHeld,
      } = await import("@/lib/bed-allocation-lifecycle"));

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
      lockHolderClient = createSeparateClient("race-2595-merge-lock-holder");
      observerClient = createSeparateClient("race-2595-merge-observer");
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
        // Explicit select on a WRITE too: Prisma's implicit RETURNING would
        // otherwise name every column of the singleton, which the #175
        // blue/green guard forbids anywhere under `src/`.
        select: { id: true },
      });

      await prisma.bedAllocationSettings.deleteMany({
        where: { id: { in: ALL_LODGE_IDS } },
      });
      await clearMergeFixtures();
      await prisma.lodgeBed.deleteMany({
        where: {
          id: {
            in: [
              ...MERGE_BED_IDS,
              GUEST_NIGHT_ONLY_BED_ID,
              PAST_STAY_DOUBLE_BED_ID,
            ],
          },
        },
      });
      await prisma.lodgeRoom.deleteMany({
        where: {
          id: {
            in: [
              ROOM_ID,
              GUEST_NIGHT_ONLY_ROOM_ID,
              PAST_STAY_ROOM_ID,
              LATE_LODGE_ROOM_ID,
            ],
          },
        },
      });
      await prisma.lodge.deleteMany({ where: { id: { in: ALL_LODGE_IDS } } });
      await prisma.member.deleteMany({
        where: { id: { in: [...MERGE_MEMBER_IDS] } },
      });
      await seedMergeMembers();

      await prisma.lodge.create({
        data: {
          id: LODGE_ID,
          name: "Race 2595 Merge Lodge",
          slug: "race-2595-merge",
        },
      });
      await prisma.lodgeRoom.create({
        data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 2595 Merge Room" },
      });
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: UNBACKED_DOUBLE_ID,
            roomId: ROOM_ID,
            name: "Unbacked double",
            bedType: "DOUBLE",
            sortOrder: 0,
          },
          {
            id: BACKED_DOUBLE_ID,
            roomId: ROOM_ID,
            name: "Backed double",
            bedType: "DOUBLE",
            sortOrder: 1,
          },
          ...SPARE_SINGLE_IDS.map((id, index) => ({
            id,
            roomId: ROOM_ID,
            name: `Spare single ${index + 1}`,
            bedType: "SINGLE" as const,
            sortOrder: 2 + index,
          })),
        ],
      });
      // The second lodge: a room and one DOUBLE bed, and NO allocation ever.
      await prisma.lodge.create({
        data: {
          id: GUEST_NIGHT_ONLY_LODGE_ID,
          name: "Race 2595 Guest-night Lodge",
          slug: "race-2595-guestnight",
        },
      });
      await prisma.lodgeRoom.create({
        data: {
          id: GUEST_NIGHT_ONLY_ROOM_ID,
          lodgeId: GUEST_NIGHT_ONLY_LODGE_ID,
          name: "Race 2595 Guest-night Room",
        },
      });
      await prisma.lodgeBed.create({
        data: {
          id: GUEST_NIGHT_ONLY_BED_ID,
          roomId: GUEST_NIGHT_ONLY_ROOM_ID,
          name: "Guest-night double",
          bedType: "DOUBLE",
          sortOrder: 0,
        },
      });
      // #2672's third lodge: one DOUBLE bed and nothing else. The ex-partner
      // holds it on the shifted night; the duplicate's own stay here is in the
      // past until an admin shifts it forward.
      await prisma.lodge.create({
        data: {
          id: PAST_STAY_LODGE_ID,
          name: "Race 2672 Past-stay Lodge",
          slug: "race-2672-past-stay",
        },
      });
      await prisma.lodgeRoom.create({
        data: {
          id: PAST_STAY_ROOM_ID,
          lodgeId: PAST_STAY_LODGE_ID,
          name: "Race 2672 Past-stay Room",
        },
      });
      await prisma.lodgeBed.create({
        data: {
          id: PAST_STAY_DOUBLE_BED_ID,
          roomId: PAST_STAY_ROOM_ID,
          name: "Past-stay double",
          bedType: "DOUBLE",
          sortOrder: 0,
        },
      });
      // The fourth lodge has a room so a booking there is realistic, and is
      // otherwise untouched until the coverage-refusal case creates one.
      await prisma.lodge.create({
        data: {
          id: LATE_LODGE_ID,
          name: "Race 2672 Late Lodge",
          slug: "race-2672-late",
        },
      });
      await prisma.lodgeRoom.create({
        data: {
          id: LATE_LODGE_ROOM_ID,
          lodgeId: LATE_LODGE_ID,
          name: "Race 2672 Late Room",
        },
      });
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
    }, 120_000);

    beforeEach(async () => {
      await clearMergeFixtures();
    });

    afterEach(async () => {
      await clearMergeFixtures();
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
        await attempt(clearMergeFixtures);
        await attempt(() =>
          prisma.bedAllocationSettings.deleteMany({
            where: { id: { in: ALL_LODGE_IDS } },
          }),
        );
        await attempt(() =>
          prisma.lodgeBed.deleteMany({
            where: {
              id: {
                in: [
                  ...MERGE_BED_IDS,
                  GUEST_NIGHT_ONLY_BED_ID,
                  PAST_STAY_DOUBLE_BED_ID,
                ],
              },
            },
          }),
        );
        await attempt(() =>
          prisma.lodgeRoom.deleteMany({
            where: {
              id: {
                in: [
                  ROOM_ID,
                  GUEST_NIGHT_ONLY_ROOM_ID,
                  PAST_STAY_ROOM_ID,
                  LATE_LODGE_ROOM_ID,
                ],
              },
            },
          }),
        );
        await attempt(() =>
          prisma.lodge.deleteMany({ where: { id: { in: ALL_LODGE_IDS } } }),
        );
        await attempt(() =>
          prisma.member.deleteMany({ where: { id: { in: [...MERGE_MEMBER_IDS] } } }),
        );
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
      await attempt(() => lockHolderClient?.$disconnect());
      await attempt(() => observerClient?.$disconnect());
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Member-merge share race cleanup failed",
        );
      }
    });

    it("removes the shared double the dropped partner link no longer backs", async () => {
      await seedMergeScenario();

      // THE defect this issue records. Nothing but the production merge runs.
      const merge = await runRealMemberMerge();
      expect(merge.masterId).toBe(MASTER_ID);

      const [unbacked, backed, masterPartners, sweptAudits] = await Promise.all([
        sharedDoubleOccupants(UNBACKED_DOUBLE_ID),
        sharedDoubleOccupants(BACKED_DOUBLE_ID),
        confirmedPartnerIdsOf(MASTER_ID),
        shareSweptAuditRows(),
      ]);

      // The dropped L-P link is gone and the master keeps only its own Q.
      expect(masterPartners).toEqual([MASTER_PARTNER_ID]);

      // The bed the merge invalidated keeps only its primary; the ex-partner's
      // second-occupant row is back in the awaiting-allocation queue.
      expect(unbacked).toEqual([
        {
          id: LOSER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: LOSER_BOOKING_ID,
          memberId: MASTER_ID,
        },
      ]);

      // The master's own still-CONFIRMED share is untouched — the whole reason
      // merge cannot reuse the #1756 member-scope sweep.
      expect(backed).toEqual([
        {
          id: MASTER_ALLOCATION_ID,
          bedId: BACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: MASTER_BOOKING_ID,
          memberId: MASTER_ID,
        },
        {
          id: MASTER_PARTNER_ALLOCATION_ID,
          bedId: BACKED_DOUBLE_ID,
          isSecondOccupant: true,
          bookingId: MASTER_PARTNER_BOOKING_ID,
          memberId: MASTER_PARTNER_ID,
        },
      ]);

      // Both sides of the swept bed-night are audited, against the merge issue.
      // This is also where the removed row is NAMED in committed state — the
      // same facts the post-commit admin alert is built from.
      expect(sweptAudits).toHaveLength(2);
      expect(sweptAudits.map((row) => row.targetId).sort()).toEqual(
        [EX_PARTNER_BOOKING_ID, LOSER_BOOKING_ID].sort(),
      );
      for (const row of sweptAudits) {
        expect(row.metadata).toMatchObject({
          issue: 2595,
          reason: "members_merged",
          stayDates: [MERGE_NIGHT_DATE_ONLY],
          allocationIds: [EX_PARTNER_ALLOCATION_ID],
        });
      }
      expect(
        sweptAudits.map((row) => [
          row.targetId,
          (row.metadata as { role?: string } | null)?.role,
          (row.metadata as { counterpartBookingId?: string } | null)
            ?.counterpartBookingId,
        ]),
      ).toEqual(
        [
          [EX_PARTNER_BOOKING_ID, "second_occupant", LOSER_BOOKING_ID],
          [LOSER_BOOKING_ID, "primary", EX_PARTNER_BOOKING_ID],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    });

    it("is idempotent: a second reconciliation pass writes nothing", async () => {
      await seedMergeScenario();
      await runRealMemberMerge();

      const second = await runSecondReconciliationPass();
      expect(second).toEqual([]);
      expect(await shareSweptAuditRows()).toHaveLength(2);
      expect(await sharedDoubleOccupants(UNBACKED_DOUBLE_ID)).toHaveLength(1);
      expect(await sharedDoubleOccupants(BACKED_DOUBLE_ID)).toHaveLength(2);
    });

    it("keeps the share the merge CARRIES OVER when the master had no confirmed partner", async () => {
      await seedMergeScenario();
      // Drop the master's own confirmed partner, so `planPartnerLinkMerge`
      // re-points the duplicate's CONFIRMED link onto the master instead of
      // deleting it. The share stays fully backed and must survive.
      await prisma.memberPartnerLink.deleteMany({
        where: canonicalPair(MASTER_ID, MASTER_PARTNER_ID),
      });
      await prisma.bedAllocation.deleteMany({
        where: { id: MASTER_PARTNER_ALLOCATION_ID },
      });

      await runRealMemberMerge();

      expect(await confirmedPartnerIdsOf(MASTER_ID)).toEqual([EX_PARTNER_ID]);
      expect(await sharedDoubleOccupants(UNBACKED_DOUBLE_ID)).toEqual([
        {
          id: LOSER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: LOSER_BOOKING_ID,
          memberId: MASTER_ID,
        },
        {
          id: EX_PARTNER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: true,
          bookingId: EX_PARTNER_BOOKING_ID,
          memberId: EX_PARTNER_ID,
        },
      ]);
      expect(await shareSweptAuditRows()).toEqual([]);
    });

    // The PIN that used to sit here — "the merge transaction does not yet
    // reconcile (wiring deferred behind #2618)" — is deleted, because the wiring
    // landed and it was written to fail the moment it did. The first case above
    // is its replacement: the SAME bare `runRealMemberMerge()` call, now
    // asserting that the invalid share is gone instead of that it survives.

    // -----------------------------------------------------------------------
    // NEIGHBOUR_ALLOCATION_WINDOW_NOTE
    //
    // Both race cases below point their planner-running writer at the
    // NEIGHBOURING lodge night rather than the contested one. That is a
    // work-around for a SEPARATE pre-existing defect, not a weakening of the
    // race.
    //
    // `assertRoomNightAgeMixConsistent` (`bed-allocation.ts`; test-only — it
    // runs under `NODE_ENV === "test"`) used to throw whenever the planner was
    // seeded with an EXISTING shared DOUBLE, because its recomputation read
    // `occupantByKey` — keyed `bedId:stayDate`, so a double's two occupants
    // collapse to one entry — while `roomNightAgeMix` counts both. That is
    // FIXED (the check now recomputes from `occupantsByBooking`), and the two
    // race arms this note used to call out as unowned pre-existing failures
    // (`bed-allocation-removal-races.realdb.test.ts`, `AUTO_FIRST` and
    // `LIFECYCLE_FIRST`) are green. They were this branch's own tests and were
    // failing hosted CI's required "Migration drift check"; "predates this work
    // and is out of scope" was true about the mechanism and wrong about who
    // owned the red check.
    //
    // The neighbouring-night targeting below is KEPT anyway, and now on its own
    // merits rather than as a work-around. Pointing the racing writer at the
    // contested night would put both writers on the same bed-night, which tests
    // bed-level contention; what these two cases exist to prove is that the
    // merge reconciliation joins the per-LODGE tier. Keeping the writers on
    // adjacent nights isolates the lodge key as the only thing that can
    // serialise them, which is the stronger form of the claim.
    //
    // What these cases do still prove, which is what this issue needs: the
    // merge reconciliation JOINS the per-lodge tier, so PostgreSQL grants it and
    // the other bed-allocation writer in a deterministic order on the same
    // lodge, and the #2595 invariant holds on the committed rows in EITHER grant
    // order.
    // -----------------------------------------------------------------------
    const NEIGHBOUR_RANGE = {
      from: NEIGHBOUR_NIGHT,
      to: NEIGHBOUR_CHECK_OUT,
      fromDate: NEIGHBOUR_NIGHT_DATE_ONLY,
      toDate: NEIGHBOUR_CHECK_OUT_DATE_ONLY,
    };

    /**
     * The committed evidence that the MERGE removed exactly the unbacked row:
     * the row is gone and both audit sides name its allocation id. Read from
     * committed state rather than a returned array, because the production
     * entrypoint under test is `executeMemberMerge` alone.
     */
    async function expectMergeSweptOnlyTheUnbackedRow(): Promise<void> {
      const audits = await shareSweptAuditRows();
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        expect(row.metadata).toMatchObject({
          issue: 2595,
          reason: "members_merged",
          allocationIds: [EX_PARTNER_ALLOCATION_ID],
        });
      }
      expect(
        await prisma.bedAllocation.findUnique({
          where: { id: EX_PARTNER_ALLOCATION_ID },
          select: { id: true },
        }),
      ).toBeNull();
    }

    /**
     * ============ THE SAME-LODGE WRITER QUEUED BEHIND A MERGE ==============
     * A consequence of #2595 that is production behaviour, not a test artifact,
     * and is stated here rather than hidden behind a retry.
     *
     * The owner decision took the global cohort `lock(1)` OUT of merge's prefix,
     * so a merge no longer excludes the whole club. What it necessarily still
     * holds is the capacity key of every lodge it touches, and an advisory xact
     * lock is released only at COMMIT — while a merge deliberately runs with
     * `timeout: 120s`, because re-pointing 70+ relations takes hundreds of
     * sequential round-trips (docs/CONCURRENCY_AND_LOCKING.md → "Member merge").
     * The ordinary bed-allocation writers raced here open their own interactive
     * transaction and then block on that lodge key on Prisma's default 5-second
     * budget (`writeUnderLocks` in `bed-allocation-auto-allocate.ts`,
     * `reconcileBedAllocationsForBookingWithGlobalLockHeld`). So a same-lodge
     * writer that arrives while a merge is running either gets the key in time,
     * or its own budget expires first and Prisma rejects it with `P2028`.
     *
     * That is the residue of the cost, and it is much smaller than before: it now
     * needs the writer to be in one of the merge's OWN lodges, where previously
     * every cancel/capture/settle/refund and every bed-allocation writer in the
     * club queued behind `lock(1)`. "Commits while another session holds lock(1)"
     * below is the proof of the difference.
     *
     * Both outcomes are SAFE, and this helper asserts exactly that: the writer
     * either committed its own work, or it wrote NOTHING and was rejected with a
     * retryable transaction expiry. What it must never do is commit anything that
     * breaks the #2595 invariant, and the caller asserts the invariant itself
     * either way. Asserting "it always commits" for a writer queued BEHIND the
     * merge would pass or fail on how loaded the machine is rather than on the
     * contract — and unlike the previous shape of this suite, the writer queued
     * FIRST now genuinely must commit, because it never waits on the merge at all.
     * ======================================================================
     */
    function isRetryableTransactionExpiry(error: unknown): boolean {
      return (
        error instanceof Error && /expired transaction/i.test(error.message)
      );
    }

    async function neighbourAllocationRows() {
      return prisma.bedAllocation.findMany({
        where: { bookingId: NEIGHBOUR_BOOKING_ID },
        select: { bookingGuestId: true, stayDate: true, source: true },
      });
    }

    /**
     * The queued writer's outcome, whichever way the budget fell. `onCommitted`
     * asserts the writer's OWN success contract; the rejected arm proves it wrote
     * nothing at all.
     */
    async function expectQueuedWriterCommittedOrCleanlyRejected<T>(
      outcome: PromiseSettledResult<T>,
      onCommitted: (value: T) => void,
    ): Promise<void> {
      if (outcome.status === "fulfilled") {
        onCommitted(outcome.value);
        await expectNeighbourAllocated();
        return;
      }
      expect(
        isRetryableTransactionExpiry(outcome.reason),
        `A writer queued behind a merge may only fail with a retryable ` +
          `transaction expiry; got: ${String(outcome.reason)}`,
      ).toBe(true);
      // Rejected, so its whole transaction rolled back: no partial placement.
      expect(await neighbourAllocationRows()).toEqual([]);
    }

    async function expectNeighbourAllocated(): Promise<void> {
      const rows = await neighbourAllocationRows();
      expect(rows).toEqual([
        {
          bookingGuestId: NEIGHBOUR_GUEST_ID,
          stayDate: NEIGHBOUR_NIGHT,
          source: "AUTO",
        },
      ]);
    }

    it.each(["MERGE_FIRST", "AUTO_FIRST"] as const)(
      "serializes the merge reconciliation and explicit auto-allocation when %s is queued first",
      async (order) => {
        await seedMergeScenario();

        // Preview built OUTSIDE the queue window: see `queueableMergeWriter`.
        const mergeWriter = await queueableMergeWriter();
        const autoWriter = () =>
          runAutoBedAllocation({ range: NEIGHBOUR_RANGE, lodgeId: LODGE_ID });

        // Destructured per branch rather than by swapping one tuple: the two
        // writers return different shapes, so a swapped tuple would widen both
        // to a union and lose the assertions below.
        let mergeOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof mergeWriter>>
        >;
        let autoOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof autoWriter>>
        >;
        if (order === "MERGE_FIRST") {
          [mergeOutcome, autoOutcome] = await runWritersInLodgeQueueOrder(
            mergeWriter,
            autoWriter,
          );
        } else {
          [autoOutcome, mergeOutcome] = await runWritersInLodgeQueueOrder(
            autoWriter,
            mergeWriter,
          );
        }

        // The merge always commits: its own 120s budget outlasts the queue wait
        // in either order, and its step-3b reconciliation removed exactly the
        // unbacked row.
        expect(settledValueOrThrow(mergeOutcome).masterId).toBe(MASTER_ID);
        await expectMergeSweptOnlyTheUnbackedRow();

        if (order === "AUTO_FIRST") {
          // Queued FIRST, so it is granted the lodge key before the merge and
          // never waits on it: STRICT must-commit.
          //
          // This arm did NOT fail CI on `75b9582bc`, and an earlier version of
          // this note said it did. Both red arms in that run
          // (`Migration drift check`, job 92924429194) were in a DIFFERENT
          // suite — `bed-allocation-removal-races.realdb.test.ts`, "serializes
          // a reviewed person move and explicit auto-allocation when AUTO_FIRST
          // is queued first" (:1173) and "…and lifecycle reconciliation when
          // LIFECYCLE_FIRST is queued first" (:1290). Neither has a merge in it
          // at all, so a harness explanation about the merge's preview window
          // could not have applied to either. This arm PASSED in that same run,
          // in 368ms. The real cause is the one recorded at
          // NEIGHBOUR_ALLOCATION_WINDOW_NOTE above and fixed in
          // `assertRoomNightAgeMixConsistent`: the age-mix self-check
          // recomputed from `occupantByKey`, which collapses a shared double's
          // two occupants into one entry, and those two fixtures seed a partner
          // sharing a double.
          //
          // The two suites' arms share the name `AUTO_FIRST`, which is exactly
          // how the misattribution got written and then repeated into the PR
          // body — where it credited a harness change for a red REQUIRED check
          // that was actually fixed by editing a Critical allocator file. When
          // you cite a CI failure here, cite the job and the failing test's own
          // suite, never the arm name alone.
          //
          // The preview IS built outside the queue window (see
          // `queueableMergeWriter`), and that is still worth doing for this
          // arm's determinism — it is just not a fix for anything that was red.
          expect(settledValueOrThrow(autoOutcome)).toEqual({ count: 1 });
          await expectNeighbourAllocated();
        } else {
          // Queued BEHIND the merge on its own 5s budget, in one of the merge's
          // OWN lodges — see "THE SAME-LODGE WRITER QUEUED BEHIND A MERGE".
          await expectQueuedWriterCommittedOrCleanlyRejected(
            autoOutcome,
            (value) => expect(value).toEqual({ count: 1 }),
          );
        }

        // The invariant holds on the committed rows either way — the point of
        // the whole case.
        await expectNoUnbackedSharedDouble();
      },
    );

    it.each(["MERGE_FIRST", "LIFECYCLE_FIRST"] as const)(
      "serializes the merge reconciliation and lifecycle reconciliation when %s is queued first",
      async (order) => {
        await seedMergeScenario();

        // Preview built OUTSIDE the queue window: see `queueableMergeWriter`.
        const mergeWriter = await queueableMergeWriter();
        const lifecycleWriter = () =>
          reconcileBedAllocationsForBooking({ bookingId: NEIGHBOUR_BOOKING_ID });

        let mergeOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof mergeWriter>>
        >;
        let lifecycleOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof lifecycleWriter>>
        >;
        if (order === "MERGE_FIRST") {
          [mergeOutcome, lifecycleOutcome] = await runWritersInLodgeQueueOrder(
            mergeWriter,
            lifecycleWriter,
          );
        } else {
          [lifecycleOutcome, mergeOutcome] = await runWritersInLodgeQueueOrder(
            lifecycleWriter,
            mergeWriter,
          );
        }

        expect(settledValueOrThrow(mergeOutcome).masterId).toBe(MASTER_ID);
        await expectMergeSweptOnlyTheUnbackedRow();

        if (order === "LIFECYCLE_FIRST") {
          // Queued FIRST: STRICT must-commit, for the same reason as AUTO_FIRST.
          expect(settledValueOrThrow(lifecycleOutcome)).toMatchObject({
            enabled: true,
            createdCount: 1,
            deletedCount: 0,
          });
          await expectNeighbourAllocated();
        } else {
          await expectQueuedWriterCommittedOrCleanlyRejected(
            lifecycleOutcome,
            (value) =>
              expect(value).toMatchObject({
                enabled: true,
                createdCount: 1,
                deletedCount: 0,
              }),
          );
        }

        await expectNoUnbackedSharedDouble();
      },
    );

    /**
     * ============ THE OWNER DECISION, PROVED DIRECTLY (#2595) ==============
     * Merge must NOT take the global cohort `lock(1)`.
     *
     * A separate session holds `lock(1)` for the whole of the real merge, and the
     * `pg_locks` waiter count on that exact key is polled until the merge settles:
     * a merge that reached for the global key would show up as an ungranted
     * waiter and fail here immediately.
     *
     * "It commits eventually" is deliberately NOT the assertion. That version of
     * this test PASSED against a mutant that re-added `lock(1)`: the holder's own
     * transaction budget expired after 60s, released the key, and the merge — on
     * its 120s budget — then went on to commit. Only the waiter poll distinguishes
     * "never asked for the key" from "waited a minute for it".
     */
    it("commits and sweeps while another session holds the global cohort lock(1)", async () => {
      await seedMergeScenario();
      const mergeWriter = await queueableMergeWriter();

      const merged = await whileHoldingAdvisoryKey(
        (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`,
        async () => {
          // The key really is held by the other session while we run.
          const held = await observerClient.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS "count"
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid = 0
              AND objid = 1
              AND granted = true
          `;
          expect(held[0]?.count ?? 0).toBeGreaterThanOrEqual(1);

          let settled = false;
          const merge = mergeWriter();
          // Keep the rejection handled even if the poll below throws first.
          const outcome = merge.then(
            (value) => {
              settled = true;
              return { ok: true as const, value };
            },
            (error: unknown) => {
              settled = true;
              return { ok: false as const, error };
            },
          );
          while (!settled) {
            expect(
              await pendingGlobalLockWaiters(),
              "the merge must never queue on the global cohort key",
            ).toBe(0);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const result = await outcome;
          if (!result.ok) throw result.error;
          return result.value;
        },
      );

      expect(merged.masterId).toBe(MASTER_ID);
      await expectMergeSweptOnlyTheUnbackedRow();
      await expectNoUnbackedSharedDouble();
    });

    /**
     * The other half of the same contract: dropping the global key must NOT have
     * dropped the lodge tier. Hold the fixture lodge's capacity key and prove the
     * real merge QUEUES on that exact key, then commits and sweeps once released.
     */
    it("waits on the affected lodge capacity key it must still hold", async () => {
      await seedMergeScenario();
      const mergeWriter = await queueableMergeWriter();

      let merge: Promise<Awaited<ReturnType<typeof mergeWriter>>> | undefined;
      await whileHoldingAdvisoryKey(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LODGE_ID}, 0))`,
        async () => {
          merge = mergeWriter();
          await waitForLodgeLockWaiters(1, LODGE_ID);
        },
      );

      const merged = await merge!;
      expect(merged.masterId).toBe(MASTER_ID);
      await expectMergeSweptOnlyTheUnbackedRow();
      await expectNoUnbackedSharedDouble();
    });

    /**
     * ========= THE GUEST-NIGHT DERIVATION, PROVED ON REAL LOCKS ============
     * The reason the global key can be dropped at all: merge's lodge set covers
     * every lodge a placement could still LAND in, not just the lodges where a
     * bed is already allocated.
     *
     * The master holds a future booking in a SECOND lodge with no allocation in
     * it whatsoever. That lodge's capacity key is held by another session, and the
     * merge must queue on it. Derive the set from existing allocations only and
     * the merge sails past this key and the poller times out.
     */
    it("takes the capacity key of a lodge known only from a future guest-night", async () => {
      await seedMergeScenario();
      await seedBooking({
        bookingId: GUEST_NIGHT_ONLY_BOOKING_ID,
        memberId: MASTER_ID,
        guestId: GUEST_NIGHT_ONLY_GUEST_ID,
        guestMemberId: MASTER_ID,
        firstName: "Surviving",
        lastName: "Master",
        night: NEIGHBOUR_NIGHT,
        checkOut: NEIGHBOUR_CHECK_OUT,
        lodgeId: GUEST_NIGHT_ONLY_LODGE_ID,
      });
      // The premise, asserted rather than assumed: not one allocation there.
      expect(
        await prisma.bedAllocation.count({
          where: { room: { lodgeId: GUEST_NIGHT_ONLY_LODGE_ID } },
        }),
      ).toBe(0);

      const mergeWriter = await queueableMergeWriter();
      let merge: Promise<Awaited<ReturnType<typeof mergeWriter>>> | undefined;
      await whileHoldingAdvisoryKey(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${GUEST_NIGHT_ONLY_LODGE_ID}, 0))`,
        async () => {
          merge = mergeWriter();
          await waitForLodgeLockWaiters(1, GUEST_NIGHT_ONLY_LODGE_ID);
        },
      );

      const merged = await merge!;
      expect(merged.masterId).toBe(MASTER_ID);
      await expectMergeSweptOnlyTheUnbackedRow();
      await expectNoUnbackedSharedDouble();
    });

    /**
     * ===== THE MUTABLE-DATE HOLE THAT DERIVATION LEFT OPEN (#2672) =========
     * Same proof one step further out, and it is the whole issue.
     *
     * #2641's derivation asked for FUTURE guest-nights. `BookingGuest.stayStart`,
     * `stayEnd` and `BookingGuestNight` are all MUTABLE, so a lodge where the
     * duplicate's only stay finished in 2020 answered "not relevant" — and stayed
     * that way exactly until an admin shifted the booking forward, which needs
     * neither the global key nor any member key merge holds.
     *
     * The fixture holds nothing here but that past guest row. Restore the date
     * filter and the merge sails past this lodge's key and the poller times out.
     */
    it("takes the capacity key of a lodge known only from a guest row whose stay is entirely in the past", async () => {
      await seedMergeScenario();
      await seedPastStayLodgeScenario();

      // The premise, asserted rather than assumed: the merged members hold no
      // allocation here and not one guest-night that is still in the future.
      expect(
        await prisma.bedAllocation.count({
          where: {
            room: { lodgeId: PAST_STAY_LODGE_ID },
            bookingGuest: { memberId: { in: [MASTER_ID, LOSER_ID] } },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.bookingGuest.count({
          where: {
            memberId: { in: [MASTER_ID, LOSER_ID] },
            booking: { lodgeId: PAST_STAY_LODGE_ID },
            OR: [
              { stayEnd: { gte: new Date() } },
              { nights: { some: { stayDate: { gte: new Date() } } } },
            ],
          },
        }),
      ).toBe(0);

      const mergeWriter = await queueableMergeWriter();
      let merge: Promise<Awaited<ReturnType<typeof mergeWriter>>> | undefined;
      await whileHoldingAdvisoryKey(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PAST_STAY_LODGE_ID}, 0))`,
        async () => {
          merge = mergeWriter();
          await waitForLodgeLockWaiters(1, PAST_STAY_LODGE_ID);
        },
      );

      const merged = await merge!;
      expect(merged.masterId).toBe(MASTER_ID);
      await expectMergeSweptOnlyTheUnbackedRow();
      await expectNoUnbackedSharedDouble();
    });

    /**
     * ========= THE FOUR-STEP INTERLEAVING, DRIVEN END TO END (#2672) =======
     * The escape the old derivation allowed, with every step a real production
     * writer and no test-only seam in any of them:
     *
     *   1. the merge derives its lodge prefix — the past-stay lodge is in it now
     *      and was not before;
     *   2. `adminShiftBookingDates` translates the duplicate's 2020 stay onto a
     *      future night at that lodge, and auto-allocates on the new nights;
     *   3. an admin hand-places the duplicate beside their still-confirmed
     *      partner on that lodge's double bed (auto-allocation cannot: it writes
     *      no `isSecondOccupant` at all); and
     *   4. both commit after the sweep's candidate read, so the sweep never sees
     *      them and the merge's own commit drops the partnership underneath.
     *
     * The merge is parked on its member-lifecycle key — after the lodge prefix,
     * before anything is written — which is the exact moment step 2 used to be
     * free to run. What this asserts is that it is not free any more: the real
     * date shift QUEUES on a capacity key the merge now holds. Steps 3 and 4 then
     * cannot happen at all, and the case follows through to prove it: once the
     * merge has committed, the same hand placement is REFUSED, because the
     * partnership it would have relied on is gone.
     *
     * With the date filter restored, the shift commits immediately, no waiter
     * ever appears on that key, and the poll below fails the case.
     */
    it("fences the admin date shift that used to walk a past stay into an unlocked lodge", async () => {
      await seedMergeScenario();
      await seedPastStayLodgeScenario();

      const mergeWriter = await queueableMergeWriter();
      let shift: ReturnType<typeof adminShiftBookingDates> | undefined;

      const parked = await withMergeParkedAfterItsLodgePrefix(
        mergeWriter,
        async () => {
          shift = adminShiftBookingDates({
            bookingId: PAST_STAY_BOOKING_ID,
            actor: { id: ACTOR_ID, role: "ADMIN" },
            input: {
              checkIn: SHIFTED_NIGHT_DATE_ONLY,
              checkOut: SHIFTED_CHECK_OUT_DATE_ONLY,
              confirmOverCapacity: true,
              notifyMember: false,
            },
            ipAddress: "127.0.0.1",
          });
          // Keep the rejection handled: the shift cannot settle until the merge
          // commits, and it may lose its own 5s budget doing so.
          shift.catch(() => {});
          // THE ASSERTION. The date writer takes `lock(1)` and then its booking's
          // lodge key; the merge holds no global key, so this waiter can only be
          // the lodge key — the one the derivation had to widen to cover.
          await waitForLodgeLockWaiters(1, PAST_STAY_LODGE_ID);
        },
      );

      expect(settledValueOrThrow(parked.merge).masterId).toBe(MASTER_ID);
      await expectMergeSweptOnlyTheUnbackedRow();
      await expectNoUnbackedSharedDouble();

      const [shiftOutcome] = await Promise.allSettled([shift!]);
      if (shiftOutcome.status === "rejected") {
        // Queued behind a merge on its own default budget — the documented
        // convoy. Rolled back whole, so the stay is still in 2020.
        expect(
          isRetryableTransactionExpiry(shiftOutcome.reason),
          `A date shift queued behind a merge may only fail with a retryable transaction expiry; got: ${String(shiftOutcome.reason)}`,
        ).toBe(true);
        const guest = await prisma.bookingGuest.findUnique({
          where: { id: PAST_STAY_GUEST_ID },
          select: { stayEnd: true },
        });
        expect(guest?.stayEnd).toEqual(PAST_STAY_CHECK_OUT);
      }

      // Step 3, attempted AFTER the merge — the only order the fence leaves. The
      // duplicate's guest row now names the master, and the master never had a
      // partnership with the ex-partner, so the board refuses the placement in
      // the admin's own words rather than writing an unbacked share.
      await expect(
        manuallyAllocateBed({
          bookingGuestId: PAST_STAY_GUEST_ID,
          bedId: PAST_STAY_DOUBLE_BED_ID,
          stayDate: SHIFTED_NIGHT_DATE_ONLY,
        }),
      ).rejects.toThrow();

      // And the bed-night the escape targeted holds exactly one occupant: the
      // ex-partner, alone, on their own booking.
      expect(await pastStayDoubleOccupants()).toEqual([
        {
          id: PAST_STAY_PARTNER_ALLOCATION_ID,
          isSecondOccupant: false,
          memberId: EX_PARTNER_ID,
        },
      ]);
    });

    /**
     * ========== THE COVERAGE PROOF, AND WHAT IT REFUSES (#2672) ============
     * Dropping the date filter fixes what the prefix CONTAINS. It says nothing
     * about a guest row created at a lodge these members had never booked, in
     * the window between the derivation at the top of the merge and the sweep.
     *
     * So step 3b re-derives the same guest-row lodge set under merge's sorted
     * `Member … FOR UPDATE` and refuses if the prefix no longer covers it. That
     * placement is what makes it a fence rather than a second look:
     * `BookingGuest.memberId` is a foreign key to `Member`, so every insert
     * naming these members needs `FOR KEY SHARE` on the member row and cannot
     * commit while the merge holds `FOR UPDATE` on it.
     *
     * The guest row created here is deliberately a PAST one, on a booking the
     * merged members do not own, in a lodge with no bed inventory at all: there
     * is nothing for the sweep to remove and nothing for it to see, and it must
     * still refuse. Nothing is written; the admin retries.
     */
    it("refuses the whole merge when a guest row appears in a lodge the prefix never locked", async () => {
      await seedMergeScenario();

      const mergeWriter = await queueableMergeWriter();
      const parked = await withMergeParkedAfterItsLodgePrefix(
        mergeWriter,
        async () => {
          await prisma.booking.create({
            data: {
              id: LATE_LODGE_BOOKING_ID,
              memberId: ACTOR_ID,
              lodgeId: LATE_LODGE_ID,
              checkIn: PAST_STAY_NIGHT,
              checkOut: PAST_STAY_CHECK_OUT,
              status: "COMPLETED",
              totalPriceCents: 100,
              finalPriceCents: 100,
            },
            select: { id: true },
          });
          await prisma.bookingGuest.create({
            data: {
              id: LATE_LODGE_GUEST_ID,
              bookingId: LATE_LODGE_BOOKING_ID,
              memberId: MASTER_ID,
              firstName: "Surviving",
              lastName: "Master",
              ageTier: "ADULT",
              stayStart: PAST_STAY_NIGHT,
              stayEnd: PAST_STAY_CHECK_OUT,
              priceCents: 100,
            },
            select: { id: true },
          });
        },
      );

      expect(parked.merge.status).toBe("rejected");
      const reason =
        parked.merge.status === "rejected" ? parked.merge.reason : null;
      expect((reason as { code?: string } | null)?.code).toBe(
        "partner_share_lodge_drift",
      );
      expect(
        (reason as { details?: { lodgeIds?: string[] } } | null)?.details
          ?.lodgeIds,
      ).toEqual([LATE_LODGE_ID]);

      // Nothing merged and nothing swept: the duplicate, its confirmed link and
      // the unbacked share are all exactly where the fixture left them.
      expect(
        await prisma.member.count({ where: { id: LOSER_ID } }),
      ).toBe(1);
      expect(await confirmedPartnerIdsOf(LOSER_ID)).toEqual([EX_PARTNER_ID]);
      expect((await sharedDoubleOccupants(UNBACKED_DOUBLE_ID)).map((r) => r.id)).toEqual([
        LOSER_ALLOCATION_ID,
        EX_PARTNER_ALLOCATION_ID,
      ]);
      expect(await shareSweptAuditRows()).toEqual([]);
    });
  },
);
