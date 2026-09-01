/**
 * Opt-in real-PostgreSQL concurrency proof for issue #3039 (epic #2943).
 *
 * WHAT ONLY A REAL DATABASE CAN SHOW. The unit suite
 * (`adult-member-hosting-group-trip-reconciliation.test.ts`) pins the SQL shape, the
 * acquisition order and the queue item shape against a fake store. It cannot show
 * that the per-trip key really excludes a counterpart, that the two coverage
 * families really occupy disjoint keyspaces in PostgreSQL, or that the under-lock
 * sibling re-read really observes another transaction's committed rows — those are
 * properties of PostgreSQL, not of the code's text. This suite forces the
 * interleavings against the production functions.
 *
 * FOUR PROOFS:
 *
 *  1. the trip key is genuinely mutually exclusive, and is a DIFFERENT keyspace from
 *     the owner key, so enabling the group scope serialises trips and not accounts;
 *  2. group BEFORE owner, observed as the real execution order of statements a real
 *     database ran (`INV-LOCK-002`);
 *  3. a full reconcile HOLDS the trip key for its whole transaction, so a concurrent
 *     sibling writer in the same trip is answered with the stable retry rather than
 *     interleaving;
 *  4. the sibling set is re-read UNDER the key: a joiner committed between the
 *     unlocked plan and the key rolls the whole change back instead of enqueueing
 *     work against an owner this transaction never locked.
 *
 * Ordinary test runs remain database-free. The suite runs only when
 * `RUN_CONCURRENCY_RACE_TESTS=1`, reads only the guarded race URL, and is registered
 * by `concurrency-lock-races.realdb.test.ts` for the migration-drift job's dedicated
 * PostgreSQL service. Its fixtures are namespaced `race-3039-` and cleaned
 * independently of every other suite sharing that database.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 5_000;

const IDS = {
  lodge: "race-3039-lodge",
  policy: "race-3039-policy",
  organiserMember: "race-3039-member-organiser",
  joinerMember: "race-3039-member-joiner-a",
  lateJoinerMember: "race-3039-member-joiner-b",
  adultMember: "race-3039-member-adult",
  organiserBooking: "race-3039-booking-organiser",
  joinerBooking: "race-3039-booking-joiner-a",
  lateJoinerBooking: "race-3039-booking-joiner-b",
  group: "race-3039-group",
  joinRow: "race-3039-join-a",
  lateJoinRow: "race-3039-join-b",
} as const;

const MEMBER_IDS = [
  IDS.organiserMember,
  IDS.joinerMember,
  IDS.lateJoinerMember,
  IDS.adultMember,
];
const BOOKING_IDS = [
  IDS.organiserBooking,
  IDS.joinerBooking,
  IDS.lateJoinerBooking,
];

/**
 * The same loopback/port/name guard every other suite on this database applies,
 * restated rather than imported so this file cannot be pointed at a real database
 * by an import going missing.
 */
export function assertSafeGroupTripRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Group Trip race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing Group Trip race DB port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error("Group Trip race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Group Trip race DB name must contain 'concurrency_race_1881'.",
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

function rawStatement(input: unknown): string {
  if (Array.isArray(input)) return input.join("?");
  const strings = (input as { strings?: readonly string[] })?.strings;
  return strings ? strings.join("?") : String(input);
}

type RecordedLock = { namespace: string; blocking: boolean };

/**
 * A transaction proxy that RECORDS every advisory-lock statement the production
 * code issues, and optionally pauses immediately before the first per-trip
 * acquisition.
 *
 * Only `$transaction` is wrapped; every statement still reaches PostgreSQL, so the
 * recorded sequence is the order a real database executed rather than a fake's
 * idea of it. That distinction is the whole reason this proof is worth running:
 * assertion 2 below is about execution order, and only a real client can witness it.
 */
function createRecordingClient(
  client: PrismaClient,
  recorded: RecordedLock[],
  pauseBeforeGroupKey?: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> },
): PrismaClient {
  let paused = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") {
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: {
            maxWait?: number;
            timeout?: number;
            isolationLevel?: Prisma.TransactionIsolationLevel;
          },
        ) =>
          target.$transaction(async (tx) => {
            const txProxy = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === "$executeRaw" || txProperty === "$queryRaw") {
                  const blocking = txProperty === "$executeRaw";
                  return async (query: unknown, ...values: unknown[]) => {
                    const statement = rawStatement(query);
                    const namespace = String(values[0] ?? "");
                    const isAdvisory = statement.includes("advisory_xact_lock");
                    const isGroupKey =
                      isAdvisory && namespace === "hosting-coverage-group";
                    if (isGroupKey && pauseBeforeGroupKey && !paused) {
                      paused = true;
                      pauseBeforeGroupKey.reached.resolve();
                      await pauseBeforeGroupKey.release.promise;
                    }
                    if (isAdvisory) recorded.push({ namespace, blocking });
                    return Reflect.apply(
                      txTarget[txProperty as "$executeRaw"],
                      txTarget,
                      [query, ...values],
                    );
                  };
                }
                const value = Reflect.get(txTarget, txProperty);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            });
            return callback(txProxy);
          }, options);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("Group Trip race DB safety guard (#3039)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeGroupTripRaceDbUrl(
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
    expect(() => assertSafeGroupTripRaceDbUrl(url)).toThrow();
  });
});

let primary: PrismaClient;
let writerA: PrismaClient;
let writerB: PrismaClient;
let observer: PrismaClient;

let lockHostingCoverageGroup: (typeof import("@/lib/adult-member-hosting-coverage-lock"))["lockHostingCoverageGroup"];
let tryLockHostingCoverageGroup: (typeof import("@/lib/adult-member-hosting-coverage-lock"))["tryLockHostingCoverageGroup"];
let tryLockHostingCoverageOwner: (typeof import("@/lib/adult-member-hosting-coverage-lock"))["tryLockHostingCoverageOwner"];
let reconcileAdultMemberHostingReviewWithSiblings: (typeof import("@/lib/adult-member-hosting-review"))["reconcileAdultMemberHostingReviewWithSiblings"];
let HOSTING_COVERAGE_RETRY_CODE: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HOSTING_COVERAGE_RETRY_CODE"];

(RUN ? describe : describe.skip)(
  "Group Trip coverage interleavings — real PostgreSQL (#3039)",
  { timeout: 120_000 },
  () => {
    const STAY = {
      checkIn: new Date("2099-05-01"),
      checkOut: new Date("2099-05-03"),
      status: "CONFIRMED" as const,
      lodgeId: IDS.lodge,
      totalPriceCents: 100,
      finalPriceCents: 100,
      hasNonMembers: true,
    };

    async function clearFixtures(): Promise<void> {
      await primary.hostingCoverageIncident.deleteMany({
        where: { bookingId: { in: BOOKING_IDS } },
      });
      await primary.hostingCoverageReevaluation.deleteMany({
        where: {
          OR: [
            { memberId: { in: MEMBER_IDS } },
            { actorMemberId: { in: MEMBER_IDS } },
            { sourceBookingId: { in: BOOKING_IDS } },
          ],
        },
      });
      await primary.groupBookingJoin.deleteMany({
        where: { id: { in: [IDS.joinRow, IDS.lateJoinRow] } },
      });
      await primary.groupBooking.deleteMany({ where: { id: IDS.group } });
      await primary.bookingGuestNight.deleteMany({
        where: { bookingGuest: { bookingId: { in: BOOKING_IDS } } },
      });
      await primary.bookingGuest.deleteMany({
        where: { bookingId: { in: BOOKING_IDS } },
      });
      await primary.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
      await primary.adultMemberHostingPolicy.deleteMany({
        where: { id: IDS.policy },
      });
      await primary.lodge.deleteMany({ where: { id: IDS.lodge } });
      await primary.member.deleteMany({ where: { id: { in: MEMBER_IDS } } });
    }

    /**
     * The trip: an organiser booking carrying the one qualifying adult, and a joined
     * booking on ANOTHER account carrying a non-member guest and nobody who can host
     * them. Removing the organiser's adult is therefore exactly the change that
     * strands the joiner — the shape #3039 exists for.
     */
    async function seedFixtures(): Promise<void> {
      await primary.member.createMany({
        data: MEMBER_IDS.map((id) => ({
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: id.split("-").at(-1)!,
          lastName: "Race",
          role: "USER" as const,
          ageTier: "ADULT" as const,
          active: true,
          canLogin: false,
        })),
      });
      await primary.lodge.create({
        data: { id: IDS.lodge, name: "Race 3039 Lodge", slug: "race-3039-lodge" },
      });
      await primary.adultMemberHostingPolicy.create({
        data: {
          id: IDS.policy,
          lodgeId: IDS.lodge,
          scopeKey: IDS.lodge,
          mode: "ADMIN_REVIEW_REQUIRED",
          capacityMode: "NO_HOLD",
          hostScopeSameBooking: true,
          // Both cross-booking scopes ON, so the ORDER of the two keys is
          // observable. `ADMIN_REVIEW_REQUIRED` rather than `ENFORCED` so an
          // uncovered joiner produces a review rather than a throw that would end
          // the transaction before the fan-out runs.
          hostScopeSameBookingOwner: true,
          hostScopeSameGroupTrip: true,
        },
      });
      await primary.booking.create({
        data: {
          id: IDS.organiserBooking,
          memberId: IDS.organiserMember,
          ...STAY,
          guests: {
            create: [
              {
                memberId: IDS.adultMember,
                firstName: "Adult",
                lastName: "Host",
                ageTier: "ADULT",
                isMember: true,
                stayStart: STAY.checkIn,
                stayEnd: STAY.checkOut,
                priceCents: 100,
                nights: {
                  create: [
                    { stayDate: new Date("2099-05-01"), priceCents: 50 },
                    { stayDate: new Date("2099-05-02"), priceCents: 50 },
                  ],
                },
              },
            ],
          },
        },
      });
      await primary.booking.create({
        data: {
          id: IDS.joinerBooking,
          memberId: IDS.joinerMember,
          ...STAY,
          guests: {
            create: [
              {
                firstName: "Non-member",
                lastName: "Guest",
                ageTier: "ADULT",
                isMember: false,
                stayStart: STAY.checkIn,
                stayEnd: STAY.checkOut,
                priceCents: 100,
                nights: {
                  create: [
                    { stayDate: new Date("2099-05-01"), priceCents: 50 },
                    { stayDate: new Date("2099-05-02"), priceCents: 50 },
                  ],
                },
              },
            ],
          },
        },
      });
      await primary.groupBooking.create({
        data: {
          id: IDS.group,
          organiserBookingId: IDS.organiserBooking,
          organiserMemberId: IDS.organiserMember,
          joinCode: "RACE3039",
          paymentMode: "EACH_PAYS_OWN",
        },
      });
      await primary.groupBookingJoin.create({
        data: {
          id: IDS.joinRow,
          groupBookingId: IDS.group,
          bookingId: IDS.joinerBooking,
          joinerMemberId: IDS.joinerMember,
          isMember: true,
        },
      });
    }

    async function waitForClientToBlock(applicationName: string): Promise<void> {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observer.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
            AND wait_event_type = 'Lock'
            AND state = 'active'
        `;
        if ((rows[0]?.count ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for PostgreSQL client ${applicationName} to block on a lock.`,
      );
    }

    beforeAll(async () => {
      assertSafeGroupTripRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;

      const [locks, review, participants] = await Promise.all([
        import("@/lib/adult-member-hosting-coverage-lock"),
        import("@/lib/adult-member-hosting-review"),
        import("@/lib/adult-member-hosting-queue-participants"),
      ]);
      lockHostingCoverageGroup = locks.lockHostingCoverageGroup;
      tryLockHostingCoverageGroup = locks.tryLockHostingCoverageGroup;
      tryLockHostingCoverageOwner = locks.tryLockHostingCoverageOwner;
      reconcileAdultMemberHostingReviewWithSiblings =
        review.reconcileAdultMemberHostingReviewWithSiblings;
      HOSTING_COVERAGE_RETRY_CODE = participants.HOSTING_COVERAGE_RETRY_CODE;

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([
          import("@prisma/client"),
          import("@/lib/prisma-adapter"),
        ]);
      const createClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      primary = createClient("race-3039-primary");
      writerA = createClient("race-3039-writer-a");
      writerB = createClient("race-3039-writer-b");
      observer = createClient("race-3039-observer");
      await Promise.all(
        [primary, writerA, writerB, observer].map((client) => client.$connect()),
      );
    });

    afterAll(async () => {
      if (!primary) return;
      await clearFixtures();
      await Promise.all(
        [primary, writerA, writerB, observer].map((client) =>
          client.$disconnect(),
        ),
      );
    });

    beforeEach(async () => {
      await clearFixtures();
      await seedFixtures();
    });

    it("makes the per-trip key mutually exclusive, in its own keyspace", async () => {
      const held = deferred();
      const release = deferred();
      const holder = writerA.$transaction(async (tx) => {
        await lockHostingCoverageGroup(tx, IDS.group);
        held.resolve();
        await release.promise;
      });
      await held.promise;

      // A second transaction cannot take the same trip key...
      await expect(
        writerB.$transaction(async (tx) =>
          tryLockHostingCoverageGroup(tx, IDS.group),
        ),
      ).resolves.toBe(false);
      // ...but a DIFFERENT trip is unaffected, so enabling the scope does not
      // serialise a club's trips against each other.
      await expect(
        writerB.$transaction(async (tx) =>
          tryLockHostingCoverageGroup(tx, "race-3039-some-other-trip"),
        ),
      ).resolves.toBe(true);
      // ...and neither is the OWNER key, even for a member id equal to the trip id.
      // Two families in one namespace would silently serialise an account against an
      // unrelated trip; this is what proves the namespaces are disjoint in
      // PostgreSQL and not merely different strings in the source.
      await expect(
        writerB.$transaction(async (tx) =>
          tryLockHostingCoverageOwner(tx, IDS.group),
        ),
      ).resolves.toBe(true);

      release.resolve();
      await holder;

      // Released with the transaction, not the session: the key is available again
      // on the very next transaction of the same pooled connection.
      await expect(
        writerB.$transaction(async (tx) =>
          tryLockHostingCoverageGroup(tx, IDS.group),
        ),
      ).resolves.toBe(true);
    });

    it("acquires the trip key BEFORE any owner key, as executed", async () => {
      // INV-LOCK-002, witnessed as the real order a real database ran the statements
      // in. Reversing the two lines in `reconcileAdultMemberHostingReviewWithSiblings`
      // fails here as well as in the unit suite.
      const recorded: RecordedLock[] = [];
      const recording = createRecordingClient(writerA, recorded);
      await recording.$transaction(async (tx) => {
        await reconcileAdultMemberHostingReviewWithSiblings(
          IDS.organiserBooking,
          tx as never,
          {
            dependentCoverage: "ESCALATE",
            coverageActorMemberId: IDS.organiserMember,
            coverageChange: {
              cause: "SYSTEM_CHANGE",
              actorMemberId: IDS.organiserMember,
              reason: null,
            },
          },
        );
      });
      const coverage = recorded.filter((lock) =>
        ["hosting-coverage-group", "hosting-coverage-owner"].includes(
          lock.namespace,
        ),
      );
      const firstGroup = coverage.findIndex(
        (lock) => lock.namespace === "hosting-coverage-group",
      );
      const firstOwner = coverage.findIndex(
        (lock) => lock.namespace === "hosting-coverage-owner",
      );
      expect(firstGroup).toBeGreaterThan(-1);
      expect(firstOwner).toBeGreaterThan(-1);
      expect(
        firstGroup,
        "INV-LOCK-002 (docs/invariants/operations.md): hosting-coverage-group must be acquired before hosting-coverage-owner",
      ).toBeLessThan(firstOwner);
      // And the first trip acquisition is the fail-fast form.
      expect(coverage[firstGroup]?.blocking).toBe(false);
    });

    it("holds the trip key for the whole reconciliation, so a sibling writer retries", async () => {
      const reached = deferred();
      const release = deferred();
      const recorded: RecordedLock[] = [];
      const paused = createRecordingClient(writerA, recorded, {
        reached,
        release,
      });
      const first = paused.$transaction(async (tx) => {
        await reconcileAdultMemberHostingReviewWithSiblings(
          IDS.organiserBooking,
          tx as never,
          {
            dependentCoverage: "ESCALATE",
            coverageActorMemberId: IDS.organiserMember,
            coverageChange: {
              cause: "SYSTEM_CHANGE",
              actorMemberId: IDS.organiserMember,
              reason: null,
            },
          },
        );
        // Stay inside the transaction until the second writer has been answered, so
        // the key is genuinely still held when it asks.
        await release.promise;
      });
      await reached.promise;
      // Take the key on this connection, then let the paused writer proceed: its own
      // fail-fast acquisition must lose rather than wait.
      const blocker = writerB.$transaction(async (tx) => {
        await lockHostingCoverageGroup(tx, IDS.group);
        release.resolve();
        // Hold it while the first writer runs into it.
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await expect(first).rejects.toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
      });
      await blocker;

      // Nothing was recorded for the sibling: a lost race must not half-write the
      // obligation.
      await expect(
        primary.hostingCoverageReevaluation.count({
          where: { memberId: IDS.joinerMember },
        }),
      ).resolves.toBe(0);
    });

    it("re-reads the sibling set under the key, and rolls back if a joiner arrived", async () => {
      // The issue's explicit reasoning, proven rather than argued: the plan runs
      // unlocked because the owners it finds are what the participant fence must
      // lock, so a joiner that commits between the plan and the key would otherwise
      // be enqueued against a `Member` row this transaction never locked — or missed
      // entirely.
      const reached = deferred();
      const release = deferred();
      const recorded: RecordedLock[] = [];
      const paused = createRecordingClient(writerA, recorded, {
        reached,
        release,
      });
      const operation = paused.$transaction(async (tx) => {
        await reconcileAdultMemberHostingReviewWithSiblings(
          IDS.organiserBooking,
          tx as never,
          {
            dependentCoverage: "ESCALATE",
            coverageActorMemberId: IDS.organiserMember,
            coverageChange: {
              cause: "SYSTEM_CHANGE",
              actorMemberId: IDS.organiserMember,
              reason: null,
            },
          },
        );
      });
      await reached.promise;
      try {
        await writerB.booking.create({
          data: {
            id: IDS.lateJoinerBooking,
            memberId: IDS.lateJoinerMember,
            ...STAY,
            guests: {
              create: [
                {
                  firstName: "Late",
                  lastName: "Guest",
                  ageTier: "ADULT",
                  isMember: false,
                  stayStart: STAY.checkIn,
                  stayEnd: STAY.checkOut,
                  priceCents: 100,
                },
              ],
            },
          },
        });
        await writerB.groupBookingJoin.create({
          data: {
            id: IDS.lateJoinRow,
            groupBookingId: IDS.group,
            bookingId: IDS.lateJoinerBooking,
            joinerMemberId: IDS.lateJoinerMember,
            isMember: true,
          },
        });
      } finally {
        release.resolve();
      }

      await expect(operation).rejects.toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
      });
      await expect(
        primary.hostingCoverageReevaluation.count({
          where: { memberId: { in: [IDS.joinerMember, IDS.lateJoinerMember] } },
        }),
      ).resolves.toBe(0);
    });

    it("enqueues one item per sibling owner on a clean run, and none for itself as a sibling", async () => {
      await writerA.$transaction(async (tx) => {
        await reconcileAdultMemberHostingReviewWithSiblings(
          IDS.organiserBooking,
          tx as never,
          {
            dependentCoverage: "ESCALATE",
            coverageActorMemberId: IDS.organiserMember,
            coverageChange: {
              cause: "SYSTEM_CHANGE",
              actorMemberId: IDS.organiserMember,
              reason: null,
            },
          },
        );
      });
      const rows = await primary.hostingCoverageReevaluation.findMany({
        where: { sourceBookingId: { in: BOOKING_IDS } },
        select: { memberId: true, lodgeId: true, sourceBookingId: true, cause: true },
        orderBy: { sourceBookingId: "asc" },
      });
      const sibling = rows.filter(
        (row) => row.sourceBookingId === IDS.joinerBooking,
      );
      expect(
        sibling,
        "INV-HOST-046: the sibling owner's re-evaluation item must name the sibling as its own source",
      ).toEqual([
        {
          memberId: IDS.joinerMember,
          lodgeId: IDS.lodge,
          sourceBookingId: IDS.joinerBooking,
          cause: "SYSTEM_CHANGE",
        },
      ]);
      // Waiting for a real block is what distinguishes "the key was taken" from "the
      // statement happened to run": a second writer must actually wait on it.
      const held = deferred();
      const release = deferred();
      const holder = writerA.$transaction(async (tx) => {
        await lockHostingCoverageGroup(tx, IDS.group);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const waiter = writerB.$transaction(async (tx) => {
        await lockHostingCoverageGroup(tx, IDS.group);
      });
      await waitForClientToBlock("race-3039-writer-b");
      release.resolve();
      await holder;
      await waiter;
    });
  },
);
