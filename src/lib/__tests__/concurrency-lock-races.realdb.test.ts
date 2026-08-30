/**
 * Real-DB race regression harness for the two-tier lock protocol (#1881).
 *
 * These tests reproduce the concurrent interleavings the protocol exists to
 * defend against, against a REAL PostgreSQL. They are OFF by default and MUST be
 * a no-op in ordinary CI/local runs:
 *
 *   - They run ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`. With the flag unset the
 *     whole suite is `describe.skip`, so `npm test` never needs a live DB.
 *   - They read ONLY `CONCURRENCY_RACE_DATABASE_URL` and require a loopback host,
 *     explicit port 55442+, and a database name containing the dedicated
 *     `concurrency_race_1881` marker. Any mismatch aborts before Prisma imports.
 *
 * Run locally against a scratch database, e.g.:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts
 *
 * After validation, the dedicated URL is copied to DATABASE_URL solely for the
 * app's Prisma singleton/driver adapter used by this isolated test process.
 *
 * The harness validates the MECHANISMS the fixes rest on — advisory-lock
 * mutual exclusion plus status-guarded compare-and-set, and the trusted
 * induction baseline's maintenance-only table lock — against the migrated
 * schema. This keeps the probes deterministic while proving actual PostgreSQL
 * lock/rollback behavior.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
// #2363 reuses this suite's already-guarded, disposable hosted PostgreSQL but
// creates/drops its own unique schema. Importing registers the trigger proofs in
// the explicit CI race command without changing the workflow or making ordinary
// `npm test` depend on a database.
import "./minimum-stay-policy-trigger.realdb.test";
// #2532 reuses the same guarded harness to prove the AI Diagnostics monthly
// budget (AID-2, #2371) can never be overspent by concurrent reservers. Its
// race describe is `describe.skip` unless RUN_CONCURRENCY_RACE_TESTS=1, so this
// import adds the over-budget race proof to the explicit CI race command without
// making ordinary `npm test` depend on a database.
import "./ai-diagnostics-budget-race.realdb.test";
// #2786 reuses the same guarded harness to prove the AI Diagnostics read-only
// SEAM against a real server rather than a double: that the transaction really is
// READ ONLY and REPEATABLE READ inside the callback, that the statement timeout
// really took, that an INSERT is refused with 25006 on a connection whose
// privileges would otherwise permit it, and that the timeout is released at commit
// instead of leaking onto the pooled application connection. The unit suite can
// only prove the statements were SENT. Same envelope: a no-op unless
// RUN_CONCURRENCY_RACE_TESTS=1.
import "./ai-diagnostics-readonly-seam.realdb.test";
// #2597 reuses this suite's guarded PostgreSQL to force ordinary-queue/member-
// merge winner orders, whole-transaction NOWAIT rollback, under-lock fan-out
// drift, and the existing policy/config/merge lock order against production
// seams. It remains a no-op unless RUN_CONCURRENCY_RACE_TESTS=1.
import "./adult-member-hosting-queue-merge.realdb.test";
// #2594 reuses this guarded disposable PostgreSQL to force the reviewed reset
// apply path against the real move, explicit auto-allocation, lifecycle, and
// cancellation writers. Its own describe stays skipped unless the shared race
// flag is set, and its uniquely-namespaced fixtures are cleaned independently.
import "./bed-allocation-removal-races.realdb.test";
// #3032 reuses the same guarded disposable PostgreSQL to prove the two race
// properties the unpriceable-edit review lifecycle turns on and that no mock can
// show: that two concurrent applies of ONE occurrence queue on lock(1) and raise
// exactly one task, and that two admins completing ONE task queue on its row and
// issue exactly one credit. Its own describe stays skipped unless the shared race
// flag is set, and its uniquely-namespaced fixtures are cleaned independently.
import "./edit-financial-review-races.realdb.test";
// #2595 reuses the same guarded disposable PostgreSQL to prove that a member
// merge cannot leave two people sharing a double bed with no confirmed
// partnership, driving the real `executeMemberMerge` and the real
// bed-allocation reconciliation. Its own describe stays skipped unless the
// shared race flag is set, and its uniquely-namespaced fixtures are cleaned
// independently.
import "./member-merge-shared-double-races.realdb.test";
// #2656 reuses the same guarded PostgreSQL to prove the shared-DOUBLE
// invariants against the real indexes: the two dangerous write outcomes are
// both properties of `@@unique([bedId, stayDate, isSecondOccupant])` and of the
// partial index behind it, which no mock can establish. Its describe stays
// skipped unless RUN_CONCURRENCY_RACE_TESTS=1 and its fixtures are namespaced
// and cleaned independently.
import "./bed-allocation-shared-double.realdb.test";
// #2622 reuses the same guarded PostgreSQL to force both winner orders of a
// booking date change against roster Save/Regenerate/Confirm now that a chore
// row can legitimately sit on a booking's CHECK-OUT date. Its describe stays
// skipped unless RUN_CONCURRENCY_RACE_TESTS=1 and its fixtures are namespaced
// and cleaned independently.
import "./roster-checkout-day-races.realdb.test";
// #2701 shares the same guarded database to prove booking admission versus
// lodge deactivation, last-two-lodge deactivation, and hut-leader overlap
// serialization on the production lock helpers.
import "./lodge-admission-races.realdb.test";
// #2926 shares the same guarded database to prove that the hut-leader overlap
// predicate's school-teacher carve-out is a property of the ROW rather than of
// the member — specifically that reclassifying a member as an organisation
// leaves their LIVE assignment in the predicate, which is a claim about
// executing the predicate on either side of a real membership edit and not
// about the shape of the query. Its describe stays skipped unless
// RUN_CONCURRENCY_RACE_TESTS=1 and its fixtures are namespaced and cleaned
// independently.
import "./hut-leader-teacher-exclusion.realdb.test";
// #2374 (AID-5) deliberately is NOT imported here, unlike the two suites above.
// `ai-diagnostics-select-only-role.realdb.test.ts` provisions and drops a cluster
// ROLE and revokes `TEMPORARY ... FROM PUBLIC` on the shared throwaway database
// for the duration of its run, so it gets its OWN named CI step and its own
// vitest process rather than interleaving with these lock races on the same
// database. That step is pinned by `review-findings-contracts.test.ts`.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

let prisma: typeof import("@/lib/prisma")["prisma"];
let markGroupSettlementIntentFailed: typeof import("@/lib/group-settlement")["markGroupSettlementIntentFailed"];
let moveBedAllocationsSameDate: typeof import("@/lib/bed-allocation-manual-writes")["moveBedAllocationsSameDate"];
let runInductionBaseline: typeof import("@/lib/induction-baseline")["runInductionBaseline"];
let InductionBaselinePlanMismatchError: typeof import("@/lib/induction-baseline")["InductionBaselinePlanMismatchError"];
let inductionBaselineLockSql: string;
let baselineClientA: PrismaClient;
let baselineClientB: PrismaClient;
let ordinaryWriterClient: PrismaClient;

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the test-only database marker.
 */
export function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Concurrency race tests need a valid CONCURRENCY_RACE_DATABASE_URL."
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port)) {
    throw new Error(
      "Concurrency race DB URL must specify an explicit port (a throwaway instance at 55442+)."
    );
  }
  if (port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run concurrency race tests against port ${port}: use a throwaway Postgres on 55442+ (never the default 5432).`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Concurrency race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Concurrency race DB name must contain the dedicated marker 'concurrency_race_1881'."
    );
  }
}

const PROBE_TABLE = "_concurrency_race_probe_1881";
const APP_MEMBER_ID = "race-1881-member";
const APP_LODGE_ID = "race-1881-lodge";
const APP_BOOKING_ID = "race-1881-booking";
const APP_GROUP_ID = "race-1881-group";
const APP_SETTLEMENT_ID = "race-1881-settlement";
const BASELINE_ACTOR_ID = "race-2361-admin";
const BASELINE_MEMBER_A_ID = "race-2361-member-a";
const BASELINE_MEMBER_B_ID = "race-2361-member-b";
const BASELINE_NA_MEMBER_ID = "race-2361-member-na";
const BASELINE_TEMPLATE_ID = "race-2361-template";
const BASELINE_TEMPLATE_SECTION_ID = "race-2361-template-section";
const BASELINE_TEMPLATE_ITEM_ID = "race-2361-template-item";
const BASELINE_CLUB_NAME = "Race 2361 Alpine Club";
const BASELINE_AUDIT_ACTION = "MEMBER_INDUCTION_LEGACY_BASELINE_APPLIED";
const BASELINE_PROVENANCE_PREFIX = "Trusted legacy induction baseline:";
const BASELINE_DATE = "2024-06-30";
const MOVE_BOOKING_ID = "race-2366-move-booking";
const MOVE_BLOCKER_BOOKING_ID = "race-2366-blocker-booking";
const MOVE_ROOM_ID = "race-2366-room";
const MOVE_OLD_BED_ID = "race-2366-old-double";
const MOVE_DESTINATION_BED_ID = "race-2366-destination";
const MOVE_BED_IDS = [MOVE_OLD_BED_ID, MOVE_DESTINATION_BED_ID];
const MOVE_GUEST_ID = "race-2366-mover";
const MOVE_PARTNER_GUEST_ID = "race-2366-partner";
const MOVE_BLOCKER_GUEST_ID = "race-2366-blocker";
const MOVE_FIRST_ALLOCATION_ID = "race-2366-source-1";
const MOVE_SECOND_ALLOCATION_ID = "race-2366-source-2";
const MOVE_PARTNER_ALLOCATION_ID = "race-2366-partner-allocation";
const MOVE_BLOCKER_ALLOCATION_ID = "race-2366-blocker-allocation";
const MOVE_FIRST_NIGHT = new Date("2099-02-01");
const MOVE_SECOND_NIGHT = new Date("2099-02-02");
const BASELINE_MEMBER_IDS = [
  APP_MEMBER_ID,
  BASELINE_ACTOR_ID,
  BASELINE_MEMBER_A_ID,
  BASELINE_MEMBER_B_ID,
  BASELINE_NA_MEMBER_ID,
];
const BASELINE_ELIGIBLE_MEMBER_IDS = [
  APP_MEMBER_ID,
  BASELINE_ACTOR_ID,
  BASELINE_MEMBER_A_ID,
  BASELINE_MEMBER_B_ID,
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * How long the lock pollers below wait before giving up with their own named
 * diagnostic (far more useful than Vitest's generic test timeout).
 *
 * Measured with `process.hrtime.bigint()`, never `Date.now()`: since #2481 every
 * test file runs with `Date` frozen, so a `Date.now()` deadline can never expire
 * — the poller would spin against PostgreSQL until the test was killed, with no
 * lock named. This file is not in the fast local gate; it runs in CI's required
 * `Migration drift check` job, so the failure would surface at its least useful.
 */
const LOCK_POLL_TIMEOUT_MS = 5_000;

async function waitForTableLock(params: {
  mode: "RowExclusiveLock" | "ShareRowExclusiveLock";
  granted: boolean;
  applicationName?: string;
}): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const applicationName = params.applicationName ?? null;
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks AS locks
      JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
      WHERE locks.relation = '"MemberInduction"'::regclass
        AND locks.mode = ${params.mode}
        AND locks.granted = ${params.granted}
        AND (${applicationName}::text IS NULL OR activity.application_name = ${applicationName})
    `;
    if ((rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${params.granted ? "granted" : "pending"} ${params.mode} on MemberInduction`,
  );
}

async function waitForPendingGlobalAdvisoryLock(): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = 0
        AND objid = 1
        AND granted = false
    `;
    if ((rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Timed out waiting for the bed move to queue on global advisory lock(1)",
  );
}

type BaselineStoreHooks = {
  afterLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  replaceAuditCreate?: (tx: Prisma.TransactionClient) => Promise<never>;
};

/**
 * Test-only transaction proxy. It delegates every operation to a real
 * PrismaClient/transaction, pausing only after PostgreSQL has granted the
 * production lock or replacing the audit create with an intentional real-DB
 * failure. No production hook is needed.
 */
function createBaselineStore(
  client: PrismaClient,
  hooks: BaselineStoreHooks = {},
) {
  return {
    $transaction<T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
      options: {
        isolationLevel: Prisma.TransactionIsolationLevel;
        maxWait: number;
        timeout: number;
      },
    ) {
      return client.$transaction(async (tx) => {
        let lockHookRan = false;
        const txProxy = new Proxy(tx, {
          get(target, property) {
            if (property === "$executeRawUnsafe") {
              const execute = target.$executeRawUnsafe.bind(target) as (
                query: string,
                ...values: unknown[]
              ) => Promise<number>;
              return async (query: string, ...values: unknown[]) => {
                const result = await execute(query, ...values);
                if (
                  !lockHookRan &&
                  query === inductionBaselineLockSql &&
                  hooks.afterLock
                ) {
                  lockHookRan = true;
                  await hooks.afterLock(target);
                }
                return result;
              };
            }
            if (property === "auditLog" && hooks.replaceAuditCreate) {
              return new Proxy(target.auditLog, {
                get(delegate, delegateProperty) {
                  if (delegateProperty === "create") {
                    return () => hooks.replaceAuditCreate!(target);
                  }
                  const value = Reflect.get(delegate, delegateProperty);
                  return typeof value === "function"
                    ? value.bind(delegate)
                    : value;
                },
              });
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(txProxy);
      }, options);
    },
  };
}

describe("concurrency race DB safety guard (#1881)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881"
      )
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeRaceDbUrl(url)).toThrow();
  });
});

// Run only when explicitly enabled; otherwise this is a pure no-op.
(RUN ? describe : describe.skip)(
  "two-tier lock protocol — real-DB interleavings (#1881)",
  () => {
    let setupCompleted = false;

    async function clearBaselineRunState() {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: BASELINE_AUDIT_ACTION },
            { id: "race-2361-forced-audit-failure" },
          ],
        },
      });
      await prisma.memberInduction.deleteMany({
        where: { memberId: { in: BASELINE_MEMBER_IDS } },
      });
    }

    async function clearBaselineFixtures() {
      await clearBaselineRunState();
      await prisma.inductionChecklistTemplate.deleteMany({
        where: { id: BASELINE_TEMPLATE_ID },
      });
      await prisma.memberAccessRole.deleteMany({
        where: { memberId: { in: BASELINE_MEMBER_IDS } },
      });
      await prisma.member.deleteMany({
        where: {
          id: {
            in: [
              BASELINE_ACTOR_ID,
              BASELINE_MEMBER_A_ID,
              BASELINE_MEMBER_B_ID,
              BASELINE_NA_MEMBER_ID,
            ],
          },
        },
      });
      await prisma.membershipNominationSettings.deleteMany({
        where: { id: "default" },
      });
      await prisma.ageTierSetting.deleteMany({
        where: { tier: { in: ["INFANT", "CHILD", "YOUTH", "ADULT"] } },
      });
      await prisma.clubIdentitySettings.deleteMany({
        where: { id: "default" },
      });
    }

    async function seedBaselineFixtures() {
      await prisma.clubIdentitySettings.create({
        data: { id: "default", name: BASELINE_CLUB_NAME },
      });
      await prisma.ageTierSetting.createMany({
        data: [
          {
            tier: "INFANT",
            minAge: 0,
            maxAge: 4,
            label: "Infant",
            sortOrder: 0,
          },
          {
            tier: "CHILD",
            minAge: 5,
            maxAge: 9,
            label: "Child",
            sortOrder: 1,
          },
          {
            tier: "YOUTH",
            minAge: 10,
            maxAge: 17,
            label: "Youth",
            sortOrder: 2,
          },
          {
            tier: "ADULT",
            minAge: 18,
            maxAge: null,
            label: "Adult",
            sortOrder: 3,
          },
        ],
      });
      await prisma.membershipNominationSettings.create({
        data: { id: "default", requiredSignOffs: 2 },
      });
      await prisma.inductionChecklistTemplate.create({
        data: {
          id: BASELINE_TEMPLATE_ID,
          name: "Race harness New Member induction",
          version: "race-2361-v1",
          kind: "NEW_MEMBER",
          isActive: true,
          sections: {
            create: {
              id: BASELINE_TEMPLATE_SECTION_ID,
              title: "Safety",
              priority: "GENERAL",
              items: {
                create: {
                  id: BASELINE_TEMPLATE_ITEM_ID,
                  label: "Emergency exits",
                },
              },
            },
          },
        },
      });
      await prisma.member.createMany({
        data: [
          {
            id: BASELINE_ACTOR_ID,
            email: "race-2361-admin@example.invalid",
            passwordHash: "not-a-real-password",
            firstName: "Baseline",
            lastName: "Admin",
            role: "ADMIN",
            ageTier: "ADULT",
            canLogin: true,
          },
          {
            id: BASELINE_MEMBER_A_ID,
            email: "race-2361-a@example.invalid",
            passwordHash: "not-a-real-password",
            firstName: "Baseline",
            lastName: "Child",
            role: "USER",
            ageTier: "CHILD",
          },
          {
            id: BASELINE_MEMBER_B_ID,
            email: "race-2361-b@example.invalid",
            passwordHash: "not-a-real-password",
            firstName: "Baseline",
            lastName: "Adult",
            role: "USER",
            ageTier: "ADULT",
          },
          {
            id: BASELINE_NA_MEMBER_ID,
            email: "race-2361-na@example.invalid",
            passwordHash: "not-a-real-password",
            firstName: "Baseline",
            lastName: "NotApplicable",
            role: "USER",
            ageTier: "NOT_APPLICABLE",
          },
        ],
      });
      await prisma.memberAccessRole.create({
        data: { memberId: BASELINE_ACTOR_ID, role: "ADMIN" },
      });
    }

    function baselineDatabaseTarget() {
      const parsed = new URL(RACE_DB_URL);
      return {
        host: parsed.host,
        databaseName: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
      };
    }

    function planInductionBaseline(
      store: PrismaClient | ReturnType<typeof createBaselineStore>,
    ) {
      return runInductionBaseline({
        actorMemberId: BASELINE_ACTOR_ID,
        baselineDate: BASELINE_DATE,
        provenanceNote: "Race harness committee minute",
        databaseTarget: baselineDatabaseTarget(),
        store: store as never,
        fallbackClubName: "unused",
        fallbackClubNameSource: "primary",
      });
    }

    function applyInductionBaseline(
      store: PrismaClient | ReturnType<typeof createBaselineStore>,
      confirmPlanDigest: string,
    ) {
      return runInductionBaseline({
        actorMemberId: BASELINE_ACTOR_ID,
        baselineDate: BASELINE_DATE,
        provenanceNote: "Race harness committee minute",
        databaseTarget: baselineDatabaseTarget(),
        apply: true,
        confirmClubName: BASELINE_CLUB_NAME,
        confirmPlanDigest,
        store: store as never,
        fallbackClubName: "unused",
        fallbackClubNameSource: "primary",
      });
    }

    async function countBaselineRows() {
      return prisma.memberInduction.count({
        where: {
          memberId: { in: BASELINE_ELIGIBLE_MEMBER_IDS },
          status: "COMPLETED",
          finalComments: { startsWith: BASELINE_PROVENANCE_PREFIX },
        },
      });
    }

    async function countBaselineAudits() {
      return prisma.auditLog.count({
        where: { action: BASELINE_AUDIT_ACTION },
      });
    }

    beforeAll(async () => {
      // Never touch a default/production DB: the singleton connects via
      // dedicated URL, so guard THAT before importing Prisma or creating any
      // scratch state. Keeping the import behind the opt-in hook makes the
      // skipped suite a true no-op when the dedicated URL is absent.
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ markGroupSettlementIntentFailed } = await import("@/lib/group-settlement"));
      ({ moveBedAllocationsSameDate } = await import(
        "@/lib/bed-allocation-manual-writes"
      ));
      const baseline = await import("@/lib/induction-baseline");
      runInductionBaseline = baseline.runInductionBaseline;
      InductionBaselinePlanMismatchError =
        baseline.InductionBaselinePlanMismatchError;
      inductionBaselineLockSql = baseline.INDUCTION_BASELINE_LOCK_SQL;
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
      baselineClientA = createSeparateClient("race-2361-baseline-a");
      baselineClientB = createSeparateClient("race-2361-baseline-b");
      ordinaryWriterClient = createSeparateClient("race-2361-writer");
      await Promise.all([
        baselineClientA.$connect(),
        baselineClientB.$connect(),
        ordinaryWriterClient.$connect(),
      ]);

      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${PROBE_TABLE}" (id text PRIMARY KEY, status text NOT NULL)`
      );
      // Idempotent recovery from an interrupted earlier opt-in run.
      await prisma.groupBooking.deleteMany({ where: { id: APP_GROUP_ID } });
      await prisma.booking.deleteMany({
        where: { id: { in: [MOVE_BOOKING_ID, MOVE_BLOCKER_BOOKING_ID] } },
      });
      await prisma.lodgeBed.deleteMany({
        where: { id: { in: MOVE_BED_IDS } },
      });
      await prisma.lodgeRoom.deleteMany({ where: { id: MOVE_ROOM_ID } });
      await prisma.booking.deleteMany({ where: { id: APP_BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: APP_LODGE_ID } });
      await clearBaselineFixtures();
      await prisma.member.deleteMany({ where: { id: APP_MEMBER_ID } });

      await prisma.member.create({
        data: {
          id: APP_MEMBER_ID,
          email: "race-1881@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Race",
          lastName: "Harness",
        },
      });
      await prisma.lodge.create({
        data: { id: APP_LODGE_ID, name: "Race Harness", slug: "race-1881" },
      });
      await prisma.booking.create({
        data: {
          id: APP_BOOKING_ID,
          memberId: APP_MEMBER_ID,
          lodgeId: APP_LODGE_ID,
          checkIn: new Date("2099-01-01"),
          checkOut: new Date("2099-01-02"),
          totalPriceCents: 100,
          finalPriceCents: 100,
        },
      });
      await prisma.lodgeRoom.create({
        data: {
          id: MOVE_ROOM_ID,
          lodgeId: APP_LODGE_ID,
          name: "Race 2366 Room",
        },
      });
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: MOVE_OLD_BED_ID,
            roomId: MOVE_ROOM_ID,
            name: "Old double",
            bedType: "DOUBLE",
          },
          {
            id: MOVE_DESTINATION_BED_ID,
            roomId: MOVE_ROOM_ID,
            name: "Destination",
            bedType: "SINGLE",
          },
        ],
      });
      await prisma.booking.createMany({
        data: [
          {
            id: MOVE_BOOKING_ID,
            memberId: APP_MEMBER_ID,
            lodgeId: APP_LODGE_ID,
            checkIn: MOVE_FIRST_NIGHT,
            checkOut: new Date("2099-02-03"),
            status: "CONFIRMED",
            totalPriceCents: 200,
            finalPriceCents: 200,
          },
          {
            id: MOVE_BLOCKER_BOOKING_ID,
            memberId: APP_MEMBER_ID,
            lodgeId: APP_LODGE_ID,
            checkIn: MOVE_FIRST_NIGHT,
            checkOut: new Date("2099-02-03"),
            status: "CONFIRMED",
            totalPriceCents: 200,
            finalPriceCents: 200,
          },
        ],
      });
      await prisma.bookingGuest.createMany({
        data: [
          {
            id: MOVE_GUEST_ID,
            bookingId: MOVE_BOOKING_ID,
            firstName: "Move",
            lastName: "Guest",
            ageTier: "ADULT",
            stayStart: MOVE_FIRST_NIGHT,
            stayEnd: new Date("2099-02-03"),
            priceCents: 200,
          },
          {
            id: MOVE_PARTNER_GUEST_ID,
            bookingId: MOVE_BLOCKER_BOOKING_ID,
            firstName: "Partner",
            lastName: "Guest",
            ageTier: "ADULT",
            stayStart: MOVE_FIRST_NIGHT,
            stayEnd: MOVE_SECOND_NIGHT,
            priceCents: 100,
          },
          {
            id: MOVE_BLOCKER_GUEST_ID,
            bookingId: MOVE_BLOCKER_BOOKING_ID,
            firstName: "Blocker",
            lastName: "Guest",
            ageTier: "ADULT",
            stayStart: MOVE_SECOND_NIGHT,
            stayEnd: new Date("2099-02-03"),
            priceCents: 100,
          },
        ],
      });
      await prisma.groupBooking.create({
        data: {
          id: APP_GROUP_ID,
          organiserBookingId: APP_BOOKING_ID,
          organiserMemberId: APP_MEMBER_ID,
          joinCode: "RACE1881",
          paymentMode: "ORGANISER_PAYS",
        },
      });
      await prisma.groupBookingSettlement.create({
        data: {
          id: APP_SETTLEMENT_ID,
          groupBookingId: APP_GROUP_ID,
          stripePaymentIntentId: "pi_race_old",
          amountCents: 100,
        },
      });
      await seedBaselineFixtures();
      setupCompleted = true;
    }, 60_000);

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const attemptCleanup = async (cleanup: () => Promise<unknown>) => {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };

      if (typeof prisma !== "undefined") {
        await attemptCleanup(() => clearBaselineFixtures());
        await attemptCleanup(() =>
          prisma.groupBooking.deleteMany({ where: { id: APP_GROUP_ID } })
        );
        await attemptCleanup(() =>
          prisma.auditLog.deleteMany({
            where: {
              action: {
                in: [
                  "BED_ALLOCATION_BULK_SET",
                  "BED_ALLOCATION_MANUAL_SET",
                  "BED_ALLOCATION_PARTNER_PROMOTED",
                ],
              },
              memberId: APP_MEMBER_ID,
            },
          })
        );
        await attemptCleanup(() =>
          prisma.booking.deleteMany({
            where: { id: { in: [MOVE_BOOKING_ID, MOVE_BLOCKER_BOOKING_ID] } },
          })
        );
        await attemptCleanup(() =>
          prisma.lodgeBed.deleteMany({
            where: { id: { in: MOVE_BED_IDS } },
          })
        );
        await attemptCleanup(() =>
          prisma.lodgeRoom.deleteMany({ where: { id: MOVE_ROOM_ID } })
        );
        await attemptCleanup(() =>
          prisma.booking.deleteMany({ where: { id: APP_BOOKING_ID } })
        );
        await attemptCleanup(() =>
          prisma.lodge.deleteMany({ where: { id: APP_LODGE_ID } })
        );
        await attemptCleanup(() =>
          prisma.member.deleteMany({ where: { id: APP_MEMBER_ID } })
        );
        await attemptCleanup(() =>
          prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`)
        );
      }
      if (typeof baselineClientA !== "undefined") {
        await attemptCleanup(() => baselineClientA.$disconnect());
      }
      if (typeof baselineClientB !== "undefined") {
        await attemptCleanup(() => baselineClientB.$disconnect());
      }
      if (typeof ordinaryWriterClient !== "undefined") {
        await attemptCleanup(() => ordinaryWriterClient.$disconnect());
      }
      if (typeof prisma !== "undefined") {
        await attemptCleanup(() => prisma.$disconnect());
      }

      // A partial setup already has a primary beforeAll failure. Best-effort
      // teardown must never replace it with a secondary cleanup error.
      if (setupCompleted && cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Real-DB race harness teardown failed"
        );
      }
    }, 60_000);

    async function seedProbe(id: string, status: string) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${PROBE_TABLE}" (id, status) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        id,
        status
      );
    }

    async function readStatus(id: string): Promise<string> {
      const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "${PROBE_TABLE}" WHERE id = $1`,
        id
      );
      return rows[0]?.status ?? "";
    }

    /**
     * One "writer": take an advisory lock (transaction-scoped), then a
     * status-guarded compare-and-set from `fromStatus` to `toStatus`. Returns
     * the number of rows it claimed (1 = winner, 0 = lost the race).
     */
    async function guardedClaim(
      id: string,
      lockSql: string,
      fromStatus: string,
      toStatus: string
    ): Promise<number> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(lockSql);
        const res = await tx.$executeRawUnsafe(
          `UPDATE "${PROBE_TABLE}" SET status = $1 WHERE id = $2 AND status = $3`,
          toStatus,
          id,
          fromStatus
        );
        return typeof res === "number" ? res : 0;
      });
    }

    const GLOBAL_LOCK = "SELECT pg_advisory_xact_lock(1)";

    async function resetBedMoveFixture() {
      await prisma.auditLog.deleteMany({
        where: {
          action: {
            in: [
              "BED_ALLOCATION_BULK_SET",
              "BED_ALLOCATION_MANUAL_SET",
              "BED_ALLOCATION_PARTNER_PROMOTED",
            ],
          },
          memberId: APP_MEMBER_ID,
        },
      });
      await prisma.bedAllocation.deleteMany({
        where: {
          id: {
            in: [
              MOVE_FIRST_ALLOCATION_ID,
              MOVE_SECOND_ALLOCATION_ID,
              MOVE_PARTNER_ALLOCATION_ID,
              MOVE_BLOCKER_ALLOCATION_ID,
            ],
          },
        },
      });
      await prisma.booking.update({
        where: { id: MOVE_BOOKING_ID },
        data: { status: "CONFIRMED" },
      });
      await prisma.bedAllocation.createMany({
        data: [
          {
            id: MOVE_FIRST_ALLOCATION_ID,
            bookingId: MOVE_BOOKING_ID,
            bookingGuestId: MOVE_GUEST_ID,
            roomId: MOVE_ROOM_ID,
            bedId: MOVE_OLD_BED_ID,
            bedType: "DOUBLE",
            stayDate: MOVE_FIRST_NIGHT,
          },
          {
            id: MOVE_SECOND_ALLOCATION_ID,
            bookingId: MOVE_BOOKING_ID,
            bookingGuestId: MOVE_GUEST_ID,
            roomId: MOVE_ROOM_ID,
            bedId: MOVE_OLD_BED_ID,
            bedType: "DOUBLE",
            stayDate: MOVE_SECOND_NIGHT,
          },
          {
            id: MOVE_PARTNER_ALLOCATION_ID,
            bookingId: MOVE_BLOCKER_BOOKING_ID,
            bookingGuestId: MOVE_PARTNER_GUEST_ID,
            roomId: MOVE_ROOM_ID,
            bedId: MOVE_OLD_BED_ID,
            bedType: "DOUBLE",
            stayDate: MOVE_FIRST_NIGHT,
            isSecondOccupant: true,
          },
          {
            id: MOVE_BLOCKER_ALLOCATION_ID,
            bookingId: MOVE_BLOCKER_BOOKING_ID,
            bookingGuestId: MOVE_BLOCKER_GUEST_ID,
            roomId: MOVE_ROOM_ID,
            bedId: MOVE_DESTINATION_BED_ID,
            bedType: "SINGLE",
            stayDate: MOVE_SECOND_NIGHT,
          },
        ],
      });
    }

    describe("bed-allocation move global/lodge transaction (#2366)", () => {
      beforeEach(resetBedMoveFixture);

      it("waits for cancellation's prune and cannot resurrect the deleted allocation", async () => {
        const cancelPruned = deferred();
        const releaseCancel = deferred();
        const cancellation = ordinaryWriterClient.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          await tx.booking.update({
            where: { id: MOVE_BOOKING_ID },
            data: { status: "CANCELLED" },
          });
          await tx.bedAllocation.deleteMany({
            where: { bookingId: MOVE_BOOKING_ID },
          });
          cancelPruned.resolve();
          await releaseCancel.promise;
        });
        await cancelPruned.promise;

        const move = moveBedAllocationsSameDate({
          allocationIds: [MOVE_FIRST_ALLOCATION_ID],
          bedId: MOVE_DESTINATION_BED_ID,
          actorMemberId: APP_MEMBER_ID,
        });
        await waitForPendingGlobalAdvisoryLock();
        releaseCancel.resolve();
        await cancellation;

        await expect(move).rejects.toMatchObject({
          status: 404,
          message: "Allocation not found",
        });
        expect(
          await prisma.bedAllocation.count({
            where: { bookingId: MOVE_BOOKING_ID },
          }),
        ).toBe(0);
        expect(
          await prisma.auditLog.count({
            where: {
              memberId: APP_MEMBER_ID,
              action: {
                in: [
                  "BED_ALLOCATION_BULK_SET",
                  "BED_ALLOCATION_MANUAL_SET",
                  "BED_ALLOCATION_PARTNER_PROMOTED",
                ],
              },
            },
          }),
        ).toBe(0);
      });

      it("rolls back the earlier row move and partner promotion when a later night conflicts", async () => {
        await expect(
          moveBedAllocationsSameDate({
            allocationIds: [
              MOVE_FIRST_ALLOCATION_ID,
              MOVE_SECOND_ALLOCATION_ID,
            ],
            bedId: MOVE_DESTINATION_BED_ID,
            actorMemberId: APP_MEMBER_ID,
          }),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining("No allocations were moved"),
        });

        const [first, second, partner, audits] = await Promise.all([
          prisma.bedAllocation.findUniqueOrThrow({
            where: { id: MOVE_FIRST_ALLOCATION_ID },
            select: { bedId: true },
          }),
          prisma.bedAllocation.findUniqueOrThrow({
            where: { id: MOVE_SECOND_ALLOCATION_ID },
            select: { bedId: true },
          }),
          prisma.bedAllocation.findUniqueOrThrow({
            where: { id: MOVE_PARTNER_ALLOCATION_ID },
            select: { isSecondOccupant: true },
          }),
          prisma.auditLog.count({
            where: {
              memberId: APP_MEMBER_ID,
              action: {
                in: [
                  "BED_ALLOCATION_BULK_SET",
                  "BED_ALLOCATION_PARTNER_PROMOTED",
                ],
              },
            },
          }),
        ]);
        expect(first.bedId).toBe(MOVE_OLD_BED_ID);
        expect(second.bedId).toBe(MOVE_OLD_BED_ID);
        expect(partner.isSecondOccupant).toBe(true);
        expect(audits).toBe(0);
      });
    });

    it("global lock(1) + status guard: exactly one of two concurrent claimers wins (cancel-vs-capture shape)", async () => {
      // Reproduces F1/F3/F2: two money/status writers race to flip the SAME row
      // out of PENDING (one to PAID, one to CANCELLED). Under lock(1) they
      // serialise, and the status-guarded update makes exactly one win.
      for (let i = 0; i < 25; i += 1) {
        const id = `race-global-${i}`;
        await seedProbe(id, "PENDING");
        const [a, b] = await Promise.all([
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "PAID"),
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "CANCELLED"),
        ]);
        // Exactly one writer claimed the row.
        expect(a + b).toBe(1);
        // The final state is whichever writer won — never a clobbered hybrid.
        expect(["PAID", "CANCELLED"]).toContain(await readStatus(id));
      }
    });

    it("status guard is the STRUCTURAL backstop even on mismatched keys (why the shared key matters)", async () => {
      // Reproduces the pre-#1881 defect shape: the two writers hold DIFFERENT
      // advisory keys (one global, one per-lodge), so they do NOT mutually
      // exclude. The status-guarded compare-and-set still yields exactly one
      // winner — proving the guard is the structural safety net beneath the
      // lock. (Without the guard, a bare UPDATE by id would let the loser
      // clobber the winner; see the next test.)
      const perLodgeLock =
        "SELECT pg_advisory_xact_lock(hashtextextended('lodge-x', 0))";
      for (let i = 0; i < 25; i += 1) {
        const id = `race-mismatched-${i}`;
        await seedProbe(id, "PENDING");
        const [a, b] = await Promise.all([
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "PAID"),
          guardedClaim(id, perLodgeLock, "PENDING", "CANCELLED"),
        ]);
        expect(a + b).toBe(1);
        expect(["PAID", "CANCELLED"]).toContain(await readStatus(id));
      }
    });

    it("demonstrates that a BARE id-only update on mismatched keys CAN clobber (the bug the guard fixes)", async () => {
      // Documents the failure mode the status guard prevents: two bare updates
      // by id on different locks both "succeed", and the final state is simply
      // the last writer's — a cancelled booking resurrected to PAID, or vice
      // versa. This test asserts the clobber is POSSIBLE (both claim 1 row),
      // which is exactly why every status write in the cluster is guarded.
      const perLodgeLock =
        "SELECT pg_advisory_xact_lock(hashtextextended('lodge-y', 0))";
      async function bareClaim(id: string, lockSql: string, toStatus: string) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lockSql);
          const res = await tx.$executeRawUnsafe(
            `UPDATE "${PROBE_TABLE}" SET status = $1 WHERE id = $2`,
            toStatus,
            id
          );
          return typeof res === "number" ? res : 0;
        });
      }
      const id = "race-bare-clobber";
      await seedProbe(id, "PENDING");
      const [a, b] = await Promise.all([
        bareClaim(id, GLOBAL_LOCK, "PAID"),
        bareClaim(id, perLodgeLock, "CANCELLED"),
      ]);
      // Both bare updates matched the row by id (no status guard), so both
      // report a claim — the clobber the guarded pattern eliminates.
      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    it("application settlement failure cannot clobber an intent re-pointed under lock(1)", async () => {
      for (let i = 0; i < 20; i += 1) {
        const oldIntent = `pi_race_old_${i}`;
        const newIntent = `pi_race_new_${i}`;
        await prisma.groupBookingSettlement.update({
          where: { id: APP_SETTLEMENT_ID },
          data: { stripePaymentIntentId: oldIntent, status: "PENDING" },
        });

        await Promise.all([
          // Real application webhook writer.
          markGroupSettlementIntentFailed(oldIntent),
          // Representative settlement retry writer using the production lock
          // order and re-pointing the provider identity atomically.
          prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            await tx.groupBookingSettlement.update({
              where: { id: APP_SETTLEMENT_ID },
              data: { stripePaymentIntentId: newIntent, status: "PENDING" },
            });
          }),
        ]);

        const current = await prisma.groupBookingSettlement.findUniqueOrThrow({
          where: { id: APP_SETTLEMENT_ID },
          select: { stripePaymentIntentId: true, status: true },
        });
        expect(current).toEqual({
          stripePaymentIntentId: newIntent,
          status: "PENDING",
        });
      }
    });

    describe("trusted induction baseline table-lock protocol (#2361)", { timeout: 15_000 }, () => {
      beforeEach(async () => {
        await clearBaselineRunState();
      });

      it("holds SHARE ROW EXCLUSIVE until commit and blocks an ordinary induction create", async () => {
        const plan = await planInductionBaseline(baselineClientA);
        const lockAcquired = deferred();
        const releaseBaseline = deferred();
        const baselineStore = createBaselineStore(baselineClientA, {
          afterLock: async () => {
            lockAcquired.resolve();
            await releaseBaseline.promise;
          },
        });
        const applyPromise = applyInductionBaseline(
          baselineStore,
          plan.planDigest,
        );
        await lockAcquired.promise;

        let writerSettled = false;
        const writerPromise = ordinaryWriterClient
          .$transaction((tx) =>
            tx.memberInduction.create({
              data: {
                id: "race-2361-writer-after-baseline",
                memberId: BASELINE_MEMBER_A_ID,
                templateId: BASELINE_TEMPLATE_ID,
                kind: "RE_INDUCTION",
                status: "IN_PROGRESS",
                requiredSignOffs: 2,
                createdByMemberId: BASELINE_ACTOR_ID,
              },
            }),
          )
          .finally(() => {
            writerSettled = true;
          });

        let observationError: unknown;
        try {
          await waitForTableLock({
            mode: "ShareRowExclusiveLock",
            granted: true,
          });
          await waitForTableLock({ mode: "RowExclusiveLock", granted: false });
          expect(writerSettled).toBe(false);
        } catch (error) {
          observationError = error;
        } finally {
          releaseBaseline.resolve();
        }

        const [report, writer] = await Promise.all([
          applyPromise,
          writerPromise,
        ]);
        if (observationError) throw observationError;
        expect(report.appliedCount).toBe(BASELINE_ELIGIBLE_MEMBER_IDS.length);
        expect(report.planDigest).toBe(plan.planDigest);
        expect(writer.id).toBe("race-2361-writer-after-baseline");
        expect(await countBaselineRows()).toBe(
          BASELINE_ELIGIBLE_MEMBER_IDS.length,
        );
        expect(await countBaselineAudits()).toBe(1);
      });

      it("waits behind an ordinary writer, re-reads after commit, and rejects the stale digest before baseline writes", async () => {
        const plan = await planInductionBaseline(baselineClientA);
        const writerInserted = deferred();
        const releaseWriter = deferred();
        const writerPromise = ordinaryWriterClient.$transaction(async (tx) => {
          const row = await tx.memberInduction.create({
            data: {
              id: "race-2361-writer-before-baseline",
              memberId: BASELINE_MEMBER_B_ID,
              templateId: BASELINE_TEMPLATE_ID,
              kind: "RE_INDUCTION",
              status: "IN_PROGRESS",
              requiredSignOffs: 2,
              createdByMemberId: BASELINE_ACTOR_ID,
            },
          });
          writerInserted.resolve();
          await releaseWriter.promise;
          return row;
        });
        await writerInserted.promise;

        let applySettled = false;
        const applyPromise = applyInductionBaseline(
          baselineClientA,
          plan.planDigest,
        ).finally(() => {
          applySettled = true;
        });
        let observationError: unknown;
        try {
          await waitForTableLock({ mode: "RowExclusiveLock", granted: true });
          await waitForTableLock({
            mode: "ShareRowExclusiveLock",
            granted: false,
          });
          expect(applySettled).toBe(false);
        } catch (error) {
          observationError = error;
        } finally {
          releaseWriter.resolve();
        }

        await writerPromise;
        let applyError: unknown;
        try {
          await applyPromise;
        } catch (error) {
          applyError = error;
        }
        if (observationError) throw observationError;
        expect(applyError).toBeInstanceOf(
          InductionBaselinePlanMismatchError,
        );
        expect(
          (
            applyError as InstanceType<
              typeof InductionBaselinePlanMismatchError
            >
          )
            .report.openWorkflows,
        ).toEqual([
          expect.objectContaining({ memberId: BASELINE_MEMBER_B_ID }),
        ]);
        expect(
          (
            applyError as InstanceType<
              typeof InductionBaselinePlanMismatchError
            >
          ).report.planDigest,
        ).not.toBe(plan.planDigest);
        expect(await countBaselineRows()).toBe(0);
        expect(await countBaselineAudits()).toBe(0);
        expect(
          await prisma.memberInduction.count({
            where: {
              memberId: { in: BASELINE_MEMBER_IDS },
              status: { in: ["DRAFT", "IN_PROGRESS"] },
            },
          }),
        ).toBe(1);
      });

      it("rolls back baseline rows and audit when the real audit insert fails", async () => {
        const plan = await planInductionBaseline(baselineClientA);
        const forcedAuditId = "race-2361-forced-audit-failure";
        let rowsVisibleBeforeAudit = 0;
        const baselineStore = createBaselineStore(baselineClientA, {
          replaceAuditCreate: async (tx) => {
            rowsVisibleBeforeAudit = await tx.memberInduction.count({
              where: {
                memberId: { in: BASELINE_ELIGIBLE_MEMBER_IDS },
                status: "COMPLETED",
                finalComments: {
                  startsWith: BASELINE_PROVENANCE_PREFIX,
                },
              },
            });
            await tx.$executeRawUnsafe(
              `INSERT INTO "AuditLog" ("id", "action") VALUES ($1, NULL)`,
              forcedAuditId,
            );
            throw new Error("Expected PostgreSQL to reject a null audit action");
          },
        });

        await expect(
          applyInductionBaseline(baselineStore, plan.planDigest),
        ).rejects.toThrow();
        expect(rowsVisibleBeforeAudit).toBe(
          BASELINE_ELIGIBLE_MEMBER_IDS.length,
        );
        expect(await countBaselineRows()).toBe(0);
        expect(await countBaselineAudits()).toBe(0);
        expect(
          await prisma.auditLog.count({ where: { id: forcedAuditId } }),
        ).toBe(0);
      });

      it("serializes two concurrent applies so the stale second digest fails, then permits a freshly planned no-op", async () => {
        const plan = await planInductionBaseline(baselineClientA);
        const firstLockAcquired = deferred();
        const releaseFirstApply = deferred();
        const firstStore = createBaselineStore(baselineClientA, {
          afterLock: async () => {
            firstLockAcquired.resolve();
            await releaseFirstApply.promise;
          },
        });
        const firstPromise = applyInductionBaseline(
          firstStore,
          plan.planDigest,
        );
        await firstLockAcquired.promise;

        let secondSettled = false;
        const secondPromise = applyInductionBaseline(
          baselineClientB,
          plan.planDigest,
        );
        void secondPromise.then(
          () => {
            secondSettled = true;
          },
          () => {
            secondSettled = true;
          },
        );

        let observationError: unknown;
        try {
          await waitForTableLock({
            mode: "ShareRowExclusiveLock",
            granted: true,
            applicationName: "race-2361-baseline-a",
          });
          await waitForTableLock({
            mode: "ShareRowExclusiveLock",
            granted: false,
            applicationName: "race-2361-baseline-b",
          });
          expect(secondSettled).toBe(false);
        } catch (error) {
          observationError = error;
        } finally {
          releaseFirstApply.resolve();
        }

        const outcomes = await Promise.allSettled([
          firstPromise,
          secondPromise,
        ]);
        if (observationError) throw observationError;
        expect(outcomes[0]).toMatchObject({
          status: "fulfilled",
          value: {
            appliedCount: BASELINE_ELIGIBLE_MEMBER_IDS.length,
            planDigest: plan.planDigest,
          },
        });
        expect(outcomes[1]).toMatchObject({ status: "rejected" });
        if (outcomes[1].status !== "rejected") {
          throw new Error("Expected the second apply to reject its stale digest");
        }
        expect(outcomes[1].reason).toBeInstanceOf(
          InductionBaselinePlanMismatchError,
        );
        const refreshedPlan = await planInductionBaseline(baselineClientB);
        expect(refreshedPlan.planDigest).not.toBe(plan.planDigest);
        const noOp = await applyInductionBaseline(
          baselineClientB,
          refreshedPlan.planDigest,
        );
        expect(noOp.appliedCount).toBe(0);
        expect(noOp.planDigest).toBe(refreshedPlan.planDigest);
        expect(await countBaselineRows()).toBe(
          BASELINE_ELIGIBLE_MEMBER_IDS.length,
        );
        expect(await countBaselineAudits()).toBe(1);
        expect(
          await prisma.memberInduction.count({
            where: { memberId: BASELINE_NA_MEMBER_ID },
          }),
        ).toBe(0);
      });
    });
  }
);
