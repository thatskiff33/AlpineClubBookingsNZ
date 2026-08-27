/**
 * Opt-in real-PostgreSQL concurrency proof for issue #2597.
 *
 * The ordinary queue seams take exact owner/actor Member rows FOR KEY SHARE
 * NOWAIT; member merge takes the complete sorted owner union FOR UPDATE. These
 * tests force both winner orders against the production functions, prove that
 * a later bulk seam aborts its complete outer transaction, exercise under-lock
 * fan-out drift, and check the policy/config/merge lock order in both directions.
 *
 * Four full `executeMemberMerge` races use a test-only Prisma transaction proxy.
 * It delegates every statement to PostgreSQL and pauses only immediately before
 * or after the production Member `FOR UPDATE` statement. No production hook or
 * reimplementation of the merge algorithm is involved.
 *
 * Ordinary test runs remain database-free. The suite runs only when
 * `RUN_CONCURRENCY_RACE_TESTS=1`, reads only the guarded race URL, and is also
 * registered by `concurrency-lock-races.realdb.test.ts` for the migration-drift
 * job's dedicated PostgreSQL service.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const LOCK_POLL_TIMEOUT_MS = 5_000;

const IDS = {
  lodge: "race-2597-lodge",
  policy: "race-2597-policy",
  master: "race-2597-master",
  loser: "race-2597-loser",
  actor: "race-2597-actor",
  ownerA: "race-2597-owner-a",
  ownerB: "race-2597-owner-b",
  target: "race-2597-target",
  ancillaryA: "race-2597-ancillary-a",
  ancillaryB: "race-2597-ancillary-b",
  mergeBooking: "race-2597-booking-merge",
  bookingA: "race-2597-booking-a",
  bookingB: "race-2597-booking-b",
  fanoutBookingA: "race-2597-booking-fanout-a",
  fanoutBookingB: "race-2597-booking-fanout-b",
  fanoutGuestA: "race-2597-guest-fanout-a",
  fanoutGuestB: "race-2597-guest-fanout-b",
  deletionHoldBooking: "race-2597-booking-deletion-hold",
  deletionHoldAdult: "race-2597-guest-deletion-hold-adult",
  deletionHoldNonMember: "race-2597-guest-deletion-hold-nonmember",
  mergeGuestBeforeLock: "race-2597-guest-merge-before-lock",
  mergeGuestAfterLock: "race-2597-guest-merge-after-lock",
  deletionRequest: "race-2597-deletion-request",
} as const;

const MEMBER_IDS = [
  IDS.master,
  IDS.loser,
  IDS.actor,
  IDS.ownerA,
  IDS.ownerB,
  IDS.target,
  IDS.ancillaryA,
  IDS.ancillaryB,
];
const BOOKING_IDS = [
  IDS.mergeBooking,
  IDS.bookingA,
  IDS.bookingB,
  IDS.fanoutBookingA,
  IDS.fanoutBookingB,
];
const ALL_BOOKING_IDS = [...BOOKING_IDS, IDS.deletionHoldBooking];
const MARKER_ACTION = "RACE_2597_OUTER_TRANSACTION_MARKER";

export function assertSafeHostingQueueRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Hosting queue race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing hosting queue race DB port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error("Hosting queue race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Hosting queue race DB name must contain 'concurrency_race_1881'.",
    );
  }
}

type Deferred = ReturnType<typeof deferred>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rawStatement(input: unknown): string {
  if (Array.isArray(input)) return input.join("?");
  const strings = (input as { strings?: readonly string[] })?.strings;
  return strings ? strings.join("?") : String(input);
}

type ParticipantPause = {
  position: "before" | "after";
  reached: Deferred;
  release: Deferred;
};

/** Wrap only `$transaction`; every model call still uses the real client. */
function createParticipantPauseClient(
  client: PrismaClient,
  pause: ParticipantPause,
  lockClause = "FOR UPDATE",
): PrismaClient {
  let consumed = false;
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
                if (txProperty === "$executeRaw") {
                  return async (query: unknown, ...values: unknown[]) => {
                    const statement = rawStatement(query);
                    const isParticipantLock =
                      !consumed &&
                      statement.includes('FROM "Member"') &&
                      statement.includes(lockClause);
                    if (isParticipantLock && pause.position === "before") {
                      consumed = true;
                      pause.reached.resolve();
                      await pause.release.promise;
                    }
                    const result = (await Reflect.apply(
                      txTarget.$executeRaw,
                      txTarget,
                      [query, ...values],
                    )) as number;
                    if (isParticipantLock && pause.position === "after") {
                      consumed = true;
                      pause.reached.resolve();
                      await pause.release.promise;
                    }
                    return result;
                  };
                }
                const value = Reflect.get(txTarget, txProperty);
                return typeof value === "function"
                  ? value.bind(txTarget)
                  : value;
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

async function waitForPauseOrFail<T>(
  pause: ParticipantPause,
  operation: Promise<T>,
): Promise<void> {
  const outcome = await Promise.race([
    pause.reached.promise.then(() => ({ kind: "paused" as const })),
    operation.then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    ),
  ]);
  if (outcome.kind === "completed") {
    throw new Error(
      "Member merge completed before reaching its participant lock.",
    );
  }
  if (outcome.kind === "failed") throw outcome.error;
}

describe("hosting queue/member merge race DB safety guard (#2597)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeHostingQueueRaceDbUrl(
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
    expect(() => assertSafeHostingQueueRaceDbUrl(url)).toThrow();
  });
});

let primary: PrismaClient;
let ordinary: PrismaClient;
let mergeA: PrismaClient;
let mergeB: PrismaClient;
let observer: PrismaClient;

let acquireHostingCoverageQueueParticipantProof: (typeof import("@/lib/adult-member-hosting-queue-participants"))["acquireHostingCoverageQueueParticipantProof"];
let lockActiveBookingRequestLinkedMembers: (typeof import("@/lib/adult-member-hosting-queue-participants"))["lockActiveBookingRequestLinkedMembers"];
let lockMemberMergeHostingCoverageParticipants: (typeof import("@/lib/adult-member-hosting-queue-participants"))["lockMemberMergeHostingCoverageParticipants"];
let HostingCoverageParticipantRetryError: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HostingCoverageParticipantRetryError"];
let HOSTING_COVERAGE_RETRY_CODE: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HOSTING_COVERAGE_RETRY_CODE"];
let HOSTING_COVERAGE_RETRY_MESSAGE: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HOSTING_COVERAGE_RETRY_MESSAGE"];
let enqueueOwnHostingCoverageReevaluation: (typeof import("@/lib/adult-member-hosting-review"))["enqueueOwnHostingCoverageReevaluation"];
let enqueueHostingCoverageReevaluationForMember: (typeof import("@/lib/adult-member-hosting-review"))["enqueueHostingCoverageReevaluationForMember"];
let reconcileAdultMemberHostingReviewWithSiblings: (typeof import("@/lib/adult-member-hosting-review"))["reconcileAdultMemberHostingReviewWithSiblings"];
let acquireFuturePartnerSharedAllocationLocks: (typeof import("@/lib/bed-allocation-lifecycle"))["acquireFuturePartnerSharedAllocationLocks"];
let acquireMemberLifecycleLocks: (typeof import("@/lib/member-lifecycle-lock"))["acquireMemberLifecycleLocks"];
let acquireLodgeCapacityLock: (typeof import("@/lib/capacity"))["acquireLodgeCapacityLock"];
let buildMemberMergePreview: (typeof import("@/lib/member-merge"))["buildMemberMergePreview"];
let executeMemberMerge: (typeof import("@/lib/member-merge"))["executeMemberMerge"];
let acquireConfigImportLock: (typeof import("@/lib/config-transfer-lock"))["acquireConfigImportLock"];
let lockMinimumStayPolicySet: (typeof import("@/lib/minimum-stay-policy-set"))["lockMinimumStayPolicySet"];
let lockAdultMemberHostingPolicySet: (typeof import("@/lib/adult-member-hosting-policy-set"))["lockAdultMemberHostingPolicySet"];
let enqueueActiveHostingIncidentPolicyReconciliation: (typeof import("@/lib/adult-member-hosting-policy-reconciliation"))["enqueueActiveHostingIncidentPolicyReconciliation"];
let HOSTING_POLICY_RECONCILIATION_SELECT: (typeof import("@/lib/adult-member-hosting-policy-reconciliation"))["HOSTING_POLICY_RECONCILIATION_SELECT"];
let reserveMemberContactCreateOperation: (typeof import("@/lib/xero-contacts"))["reserveMemberContactCreateOperation"];
let reserveMemberContactUpdateOperation: (typeof import("@/lib/xero-contacts"))["reserveMemberContactUpdateOperation"];
let completeMemberContactUpdateOperation: (typeof import("@/lib/xero-contacts"))["completeMemberContactUpdateOperation"];
let lockMemberForManualXeroContactLink: (typeof import("@/lib/xero-contact-create-recovery"))["lockMemberForManualXeroContactLink"];
let lockMemberForAccountDeletionXeroFence: (typeof import("@/lib/xero-contact-create-recovery"))["lockMemberForAccountDeletionXeroFence"];
let applyInboundMemberContactPatch: (typeof import("@/lib/xero-contact-create-recovery"))["applyInboundMemberContactPatch"];
let backfillMemberContactLink: (typeof import("@/lib/xero-hardening-backfill"))["backfillMemberContactLink"];
let DELETED_ACCOUNT_PASSWORD_HASH: (typeof import("@/lib/xero-contact-create-recovery"))["DELETED_ACCOUNT_PASSWORD_HASH"];
let commitManualXeroContactLink: (typeof import("@/lib/xero-manual-contact-link"))["commitManualXeroContactLink"];
let claimDeletionRequestDecision: (typeof import("@/lib/deletion-request-decision"))["claimDeletionRequestDecision"];
let claimDeletionRequestApproval: (typeof import("@/lib/deletion-request-decision"))["claimDeletionRequestApproval"];
let releaseDeletionRequestApprovalClaim: (typeof import("@/lib/deletion-request-decision"))["releaseDeletionRequestApprovalClaim"];
let deletionApprovalWasReleased: (typeof import("@/lib/deletion-request-decision"))["deletionApprovalWasReleased"];

(RUN ? describe : describe.skip)(
  "hosting queue/member merge interleavings — real PostgreSQL (#2597)",
  { timeout: 120_000 },
  () => {
    async function reserveStaticContactCreate(
      memberId: string,
      input: import("@/lib/xero-contacts").MemberContactCreateReservationPlan<null>["input"],
      db: PrismaClient = ordinary,
    ) {
      const { operation } = await reserveMemberContactCreateOperation(
        memberId,
        () => ({ input, value: null }),
        db,
      );
      return operation;
    }

    async function clearFixtures(): Promise<void> {
      await primary.hostingCoverageIncident.deleteMany({
        where: { bookingId: { in: ALL_BOOKING_IDS } },
      });
      await primary.hostingCoverageReevaluation.deleteMany({
        where: {
          OR: [
            { memberId: { in: MEMBER_IDS } },
            { actorMemberId: { in: MEMBER_IDS } },
            { sourceBookingId: { in: ALL_BOOKING_IDS } },
          ],
        },
      });
      await primary.auditLog.deleteMany({
        where: {
          OR: [
            { action: MARKER_ACTION },
            { entityId: { in: MEMBER_IDS } },
            { subjectMemberId: { in: MEMBER_IDS } },
          ],
        },
      });
      await primary.xeroSyncOperation.deleteMany({
        where: { localModel: "Member", localId: { in: MEMBER_IDS } },
      });
      await primary.xeroObjectLink.deleteMany({
        where: { localModel: "Member", localId: { in: MEMBER_IDS } },
      });
      await primary.deletionRequest.deleteMany({
        where: { id: IDS.deletionRequest },
      });
      await primary.bookingGuest.deleteMany({
        where: { bookingId: { in: ALL_BOOKING_IDS } },
      });
      await primary.booking.deleteMany({
        where: { id: { in: ALL_BOOKING_IDS } },
      });
      await primary.adultMemberHostingPolicy.deleteMany({
        where: { id: IDS.policy },
      });
      await primary.lodge.deleteMany({ where: { id: IDS.lodge } });
      await primary.memberAccessRole.deleteMany({
        where: { memberId: { in: MEMBER_IDS } },
      });
      await primary.member.deleteMany({ where: { id: { in: MEMBER_IDS } } });
    }

    async function seedFixtures(): Promise<void> {
      await primary.member.createMany({
        data: MEMBER_IDS.map((id) => ({
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: id === IDS.loser ? "Duplicate" : id.split("-").at(-1)!,
          lastName: "Race",
          role: id === IDS.actor ? ("ADMIN" as const) : ("USER" as const),
          ageTier: "ADULT" as const,
          active: true,
          canLogin: false,
        })),
      });
      await primary.memberAccessRole.create({
        data: { memberId: IDS.actor, role: "ADMIN" },
      });
      await primary.lodge.create({
        data: {
          id: IDS.lodge,
          name: "Race 2597 Lodge",
          slug: "race-2597-lodge",
        },
      });
      await primary.adultMemberHostingPolicy.create({
        data: {
          id: IDS.policy,
          lodgeId: IDS.lodge,
          scopeKey: IDS.lodge,
          mode: "ENFORCED",
          capacityMode: "NO_HOLD",
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: false,
        },
      });
      const stay = {
        checkIn: new Date("2099-04-01"),
        checkOut: new Date("2099-04-03"),
        status: "CONFIRMED" as const,
        lodgeId: IDS.lodge,
        totalPriceCents: 100,
        finalPriceCents: 100,
      };
      await primary.booking.createMany({
        data: [
          { id: IDS.mergeBooking, memberId: IDS.loser, ...stay },
          { id: IDS.bookingA, memberId: IDS.ownerA, ...stay },
          { id: IDS.bookingB, memberId: IDS.ownerB, ...stay },
          { id: IDS.fanoutBookingA, memberId: IDS.ownerA, ...stay },
          { id: IDS.fanoutBookingB, memberId: IDS.ownerB, ...stay },
        ],
      });
    }

    async function waitForClientToBlock(
      applicationName: string,
    ): Promise<void> {
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

    async function previewMerge() {
      const preview = await buildMemberMergePreview({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        db: primary,
      });
      expect(preview.blockers).toEqual([]);
      return preview;
    }

    function mergeGuestData(id: string) {
      return {
        id,
        bookingId: IDS.mergeBooking,
        memberId: IDS.loser,
        firstName: "Late",
        lastName: "Guest",
        ageTier: "ADULT" as const,
        isMember: true,
        stayStart: new Date("2099-04-01"),
        stayEnd: new Date("2099-04-03"),
        priceCents: 100,
      };
    }

    async function startPausedMerge(position: "before" | "after") {
      const preview = await previewMerge();
      const pause: ParticipantPause = {
        position,
        reached: deferred(),
        release: deferred(),
      };
      const db = createParticipantPauseClient(mergeA, pause);
      const operation = executeMemberMerge({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        previewToken: preview.previewToken,
        confirmationText: preview.confirmationPhrase,
        db: db as never,
      });
      await waitForPauseOrFail(pause, operation);
      return { operation, pause };
    }

    async function createBookingRequestHoldEffect(
      tx: Prisma.TransactionClient,
    ): Promise<void> {
      // This is the production hold's contested database effect: canonical
      // lodge lock, exact linked-member lock + active re-read, active held
      // booking with linked guests, then the production hosting reconciler.
      // Calling the whole public-request service would add bcrypt and quote
      // setup without changing these rows or this lock topology.
      await acquireLodgeCapacityLock(tx, IDS.lodge);
      await lockActiveBookingRequestLinkedMembers(tx, [IDS.target]);
      await tx.booking.create({
        data: {
          id: IDS.deletionHoldBooking,
          memberId: IDS.ownerA,
          lodgeId: IDS.lodge,
          checkIn: new Date("2099-04-01"),
          checkOut: new Date("2099-04-03"),
          status: "AWAITING_REVIEW",
          totalPriceCents: 200,
          finalPriceCents: 200,
          hasNonMembers: true,
          guests: {
            create: [
              {
                id: IDS.deletionHoldAdult,
                memberId: IDS.target,
                firstName: "Target",
                lastName: "Adult",
                ageTier: "ADULT",
                isMember: true,
                stayStart: new Date("2099-04-01"),
                stayEnd: new Date("2099-04-03"),
                priceCents: 100,
              },
              {
                id: IDS.deletionHoldNonMember,
                firstName: "Non-member",
                lastName: "Guest",
                ageTier: "ADULT",
                isMember: false,
                stayStart: new Date("2099-04-01"),
                stayEnd: new Date("2099-04-03"),
                priceCents: 100,
              },
            ],
          },
        },
      });
      await reconcileAdultMemberHostingReviewWithSiblings(
        IDS.deletionHoldBooking,
        tx,
      );
    }

    async function applyDeletionHostingEffect(
      tx: Prisma.TransactionClient,
      afterStandingFanout?: () => Promise<void>,
    ): Promise<number> {
      await acquireFuturePartnerSharedAllocationLocks(tx, [IDS.target], CLUB_TODAY_DATE_ONLY);
      await acquireMemberLifecycleLocks(tx, [IDS.target]);
      const queued = await enqueueHostingCoverageReevaluationForMember(
        IDS.target,
        tx,
        CLUB_TODAY_DATE_ONLY,
        { cause: "SYSTEM_CHANGE", actorMemberId: IDS.actor },
      );
      await afterStandingFanout?.();
      await tx.member.update({
        where: { id: IDS.target },
        data: { active: false },
      });
      await tx.bookingGuest.updateMany({
        where: { memberId: IDS.target },
        data: { memberId: null },
      });
      return queued;
    }

    async function applyXeroDeletionFence(
      tx: Prisma.TransactionClient,
      memberId: string,
    ): Promise<void> {
      await lockMemberForAccountDeletionXeroFence(tx, memberId);
      await tx.member.update({
        where: { id: memberId },
        data: {
          email: `deleted-${memberId}@deleted.invalid`,
          passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
          active: false,
          xeroContactId: null,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          streetAddressLine1: null,
          postalAddressLine1: null,
        },
      });
      await tx.xeroObjectLink.updateMany({
        where: {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "CONTACT",
          active: true,
        },
        data: { active: false },
      });
    }

    async function applyStandingDeactivationEffect(
      tx: Prisma.TransactionClient,
      afterStandingFanout?: () => Promise<void>,
    ): Promise<number> {
      await tx.member.update({
        where: { id: IDS.target },
        data: { active: false },
      });
      const queued = await enqueueHostingCoverageReevaluationForMember(
        IDS.target,
        tx,
        CLUB_TODAY_DATE_ONLY,
        { cause: "SYSTEM_CHANGE", actorMemberId: IDS.actor },
      );
      await afterStandingFanout?.();
      return queued;
    }

    async function applyConfigTransferPolicyReconciliation(
      tx: Prisma.TransactionClient,
    ) {
      const beforePolicies = await tx.adultMemberHostingPolicy.findMany({
        select: HOSTING_POLICY_RECONCILIATION_SELECT,
      });
      const beforeQueueRows = await tx.hostingCoverageReevaluation.findMany({
        where: { sourceBookingId: { in: BOOKING_IDS } },
        select: { id: true },
      });
      const beforeQueueIds = new Set(beforeQueueRows.map((row) => row.id));

      const existingPolicy = beforePolicies.find(
        (policy) => policy.id === IDS.policy,
      );
      if (!existingPolicy) {
        throw new Error("Policy reconciliation fixture is missing its policy.");
      }
      const updated = await tx.adultMemberHostingPolicy.updateMany({
        where: { id: IDS.policy, version: existingPolicy.version },
        data: {
          hostScopeSameBookingOwner: true,
          version: existingPolicy.version + 1,
        },
      });
      if (updated.count !== 1) {
        throw new Error("Policy reconciliation fixture lost its policy CAS.");
      }
      const queued = await enqueueActiveHostingIncidentPolicyReconciliation(
        { beforePolicies, todayDateOnly: "2099-03-31" },
        tx,
      );

      const fixtureRows = (
        await tx.hostingCoverageReevaluation.findMany({
          where: { sourceBookingId: { in: BOOKING_IDS } },
          orderBy: { sourceBookingId: "asc" },
          select: { id: true, memberId: true, sourceBookingId: true },
        })
      ).filter((row) => !beforeQueueIds.has(row.id));
      const mergeBookingRow = fixtureRows.find(
        (row) => row.sourceBookingId === IDS.mergeBooking,
      );
      if (!mergeBookingRow) {
        throw new Error(
          "Policy reconciliation did not enqueue the merge booking fixture.",
        );
      }
      return { fixtureRows, mergeBookingRow, queued };
    }

    beforeAll(async () => {
      assertSafeHostingQueueRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;

      const [
        participants,
        review,
        merge,
        configLock,
        minimumLock,
        hostingLock,
        policyReconciliation,
        bedAllocationLifecycle,
        memberLifecycle,
        capacity,
        xeroContacts,
        xeroContactCreateRecovery,
        xeroManualContactLink,
        xeroHardeningBackfill,
        deletionRequestDecision,
      ] = await Promise.all([
        import("@/lib/adult-member-hosting-queue-participants"),
        import("@/lib/adult-member-hosting-review"),
        import("@/lib/member-merge"),
        import("@/lib/config-transfer-lock"),
        import("@/lib/minimum-stay-policy-set"),
        import("@/lib/adult-member-hosting-policy-set"),
        import("@/lib/adult-member-hosting-policy-reconciliation"),
        import("@/lib/bed-allocation-lifecycle"),
        import("@/lib/member-lifecycle-lock"),
        import("@/lib/capacity"),
        import("@/lib/xero-contacts"),
        import("@/lib/xero-contact-create-recovery"),
        import("@/lib/xero-manual-contact-link"),
        import("@/lib/xero-hardening-backfill"),
        import("@/lib/deletion-request-decision"),
      ]);
      acquireHostingCoverageQueueParticipantProof =
        participants.acquireHostingCoverageQueueParticipantProof;
      lockActiveBookingRequestLinkedMembers =
        participants.lockActiveBookingRequestLinkedMembers;
      lockMemberMergeHostingCoverageParticipants =
        participants.lockMemberMergeHostingCoverageParticipants;
      HostingCoverageParticipantRetryError =
        participants.HostingCoverageParticipantRetryError;
      HOSTING_COVERAGE_RETRY_CODE = participants.HOSTING_COVERAGE_RETRY_CODE;
      HOSTING_COVERAGE_RETRY_MESSAGE =
        participants.HOSTING_COVERAGE_RETRY_MESSAGE;
      enqueueOwnHostingCoverageReevaluation =
        review.enqueueOwnHostingCoverageReevaluation;
      enqueueHostingCoverageReevaluationForMember =
        review.enqueueHostingCoverageReevaluationForMember;
      reconcileAdultMemberHostingReviewWithSiblings =
        review.reconcileAdultMemberHostingReviewWithSiblings;
      buildMemberMergePreview = merge.buildMemberMergePreview;
      executeMemberMerge = merge.executeMemberMerge;
      acquireConfigImportLock = configLock.acquireConfigImportLock;
      lockMinimumStayPolicySet = minimumLock.lockMinimumStayPolicySet;
      lockAdultMemberHostingPolicySet =
        hostingLock.lockAdultMemberHostingPolicySet;
      enqueueActiveHostingIncidentPolicyReconciliation =
        policyReconciliation.enqueueActiveHostingIncidentPolicyReconciliation;
      HOSTING_POLICY_RECONCILIATION_SELECT =
        policyReconciliation.HOSTING_POLICY_RECONCILIATION_SELECT;
      acquireFuturePartnerSharedAllocationLocks =
        bedAllocationLifecycle.acquireFuturePartnerSharedAllocationLocks;
      acquireMemberLifecycleLocks = memberLifecycle.acquireMemberLifecycleLocks;
      acquireLodgeCapacityLock = capacity.acquireLodgeCapacityLock;
      reserveMemberContactCreateOperation =
        xeroContacts.reserveMemberContactCreateOperation;
      reserveMemberContactUpdateOperation =
        xeroContacts.reserveMemberContactUpdateOperation;
      completeMemberContactUpdateOperation =
        xeroContacts.completeMemberContactUpdateOperation;
      lockMemberForManualXeroContactLink =
        xeroContactCreateRecovery.lockMemberForManualXeroContactLink;
      lockMemberForAccountDeletionXeroFence =
        xeroContactCreateRecovery.lockMemberForAccountDeletionXeroFence;
      applyInboundMemberContactPatch =
        xeroContactCreateRecovery.applyInboundMemberContactPatch;
      DELETED_ACCOUNT_PASSWORD_HASH =
        xeroContactCreateRecovery.DELETED_ACCOUNT_PASSWORD_HASH;
      commitManualXeroContactLink =
        xeroManualContactLink.commitManualXeroContactLink;
      backfillMemberContactLink =
        xeroHardeningBackfill.backfillMemberContactLink;
      claimDeletionRequestDecision =
        deletionRequestDecision.claimDeletionRequestDecision;
      claimDeletionRequestApproval =
        deletionRequestDecision.claimDeletionRequestApproval;
      releaseDeletionRequestApprovalClaim =
        deletionRequestDecision.releaseDeletionRequestApprovalClaim;
      deletionApprovalWasReleased =
        deletionRequestDecision.deletionApprovalWasReleased;

      const [
        { PrismaClient: SeparatePrismaClient },
        { createPrismaPgAdapter },
      ] = await Promise.all([
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
      primary = createClient("race-2597-primary");
      ordinary = createClient("race-2597-ordinary");
      mergeA = createClient("race-2597-merge-a");
      mergeB = createClient("race-2597-merge-b");
      observer = createClient("race-2597-observer");
      await Promise.all(
        [primary, ordinary, mergeA, mergeB, observer].map((client) =>
          client.$connect(),
        ),
      );
      await clearFixtures();
    }, 60_000);

    beforeEach(async () => {
      await clearFixtures();
      await seedFixtures();
    }, 60_000);

    afterAll(async () => {
      if (primary) await clearFixtures().catch(() => {});
      await Promise.all(
        [primary, ordinary, mergeA, mergeB, observer].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
    }, 60_000);

    it.each([
      "DISABLED",
      "ADMIN_REVIEW_REQUIRED",
      "ENFORCED",
    ] as const)(
      "hold-first makes deletion fail fast and retry against the committed guest under %s",
      async (mode) => {
        await primary.adultMemberHostingPolicy.update({
          where: { id: IDS.policy },
          data: { mode, version: { increment: 1 } },
        });
        const holdReady = deferred();
        const releaseHold = deferred();
        const hold = ordinary.$transaction(
          async (tx) => {
            await createBookingRequestHoldEffect(tx);
            holdReady.resolve();
            await releaseHold.promise;
          },
          { timeout: 30_000 },
        );
        await holdReady.promise;

        const firstDeletion = mergeA
          .$transaction((tx) => applyDeletionHostingEffect(tx), {
            timeout: 30_000,
          })
          .then(
            (queued) => ({ kind: "committed" as const, queued, error: null }),
            (error: unknown) => ({
              kind: "rolled-back" as const,
              queued: null,
              error,
            }),
          );
        let firstOutcome: Awaited<typeof firstDeletion>;
        try {
          firstOutcome = await firstDeletion;
        } finally {
          releaseHold.resolve();
        }
        await hold;

        expect(firstOutcome.kind).toBe("rolled-back");
        expect(firstOutcome.error).toBeInstanceOf(
          HostingCoverageParticipantRetryError,
        );
        expect(firstOutcome.error).toMatchObject({
          code: HOSTING_COVERAGE_RETRY_CODE,
          statusCode: 409,
          message: HOSTING_COVERAGE_RETRY_MESSAGE,
        });
        await expect(
          primary.member.findUniqueOrThrow({
            where: { id: IDS.target },
            select: { active: true },
          }),
        ).resolves.toEqual({ active: true });
        await expect(
          primary.bookingGuest.findUniqueOrThrow({
            where: { id: IDS.deletionHoldAdult },
            select: { memberId: true },
          }),
        ).resolves.toEqual({ memberId: IDS.target });

        const queueCountBeforeRetry =
          await primary.hostingCoverageReevaluation.count({
            where: { sourceBookingId: IDS.deletionHoldBooking },
          });
        const queued = await mergeA.$transaction((tx) =>
          applyDeletionHostingEffect(tx),
        );
        expect(queued).toBe(mode === "ENFORCED" ? 1 : 0);
        expect(
          await primary.hostingCoverageReevaluation.count({
            where: { sourceBookingId: IDS.deletionHoldBooking },
          }),
        ).toBe(queueCountBeforeRetry + (mode === "ENFORCED" ? 1 : 0));
        await expect(
          primary.bookingGuest.findUniqueOrThrow({
            where: { id: IDS.deletionHoldAdult },
            select: { memberId: true },
          }),
        ).resolves.toEqual({ memberId: null });
      },
    );

    it.each([
      "DISABLED",
      "ADMIN_REVIEW_REQUIRED",
      "ENFORCED",
    ] as const)(
      "deletion-first makes the linked-member hold wait, re-read inactive, and roll back under %s",
      async (mode) => {
        await primary.adultMemberHostingPolicy.update({
          where: { id: IDS.policy },
          data: { mode, version: { increment: 1 } },
        });
        const preflightRead = deferred();
        const allowLinkedMemberLock = deferred();
        const standingFanoutComplete = deferred();
        const releaseDeletion = deferred();

        const hold = ordinary
          .$transaction(
            async (tx) => {
              await acquireLodgeCapacityLock(tx, IDS.lodge);
              const target = await tx.member.findUniqueOrThrow({
                where: { id: IDS.target },
                select: { active: true },
              });
              expect(target.active).toBe(true);
              preflightRead.resolve();
              await allowLinkedMemberLock.promise;
              await createBookingRequestHoldEffect(tx);
            },
            { timeout: 30_000 },
          )
          .then(
            () => ({ kind: "committed" as const, error: null }),
            (error: unknown) => ({ kind: "rolled-back" as const, error }),
          );
        await preflightRead.promise;

        const deletion = mergeA.$transaction(
          (tx) =>
            applyDeletionHostingEffect(tx, async () => {
              standingFanoutComplete.resolve();
              await releaseDeletion.promise;
            }),
          { timeout: 30_000 },
        );
        await standingFanoutComplete.promise;
        allowLinkedMemberLock.resolve();
        try {
          await waitForClientToBlock("race-2597-ordinary");
        } finally {
          releaseDeletion.resolve();
        }

        await expect(deletion).resolves.toBe(0);
        const holdOutcome = await hold;
        expect(holdOutcome.kind).toBe("rolled-back");
        expect(holdOutcome.error).toBeInstanceOf(
          HostingCoverageParticipantRetryError,
        );
        expect(holdOutcome.error).toMatchObject({
          code: HOSTING_COVERAGE_RETRY_CODE,
          statusCode: 409,
        });
        await expect(
          primary.booking.findUnique({
            where: { id: IDS.deletionHoldBooking },
            select: { id: true },
          }),
        ).resolves.toBeNull();
        await expect(
          primary.member.findUniqueOrThrow({
            where: { id: IDS.target },
            select: { active: true },
          }),
        ).resolves.toEqual({ active: false });
      },
    );

    it("hold-first makes an ordinary standing deactivation fail fast with no partial write", async () => {
      const holdReady = deferred();
      const releaseHold = deferred();
      const hold = ordinary.$transaction(
        async (tx) => {
          await createBookingRequestHoldEffect(tx);
          holdReady.resolve();
          await releaseHold.promise;
        },
        { timeout: 30_000 },
      );
      await holdReady.promise;

      const standing = mergeA.$transaction((tx) =>
        applyStandingDeactivationEffect(tx),
      );
      try {
        await expect(standing).rejects.toMatchObject({
          code: HOSTING_COVERAGE_RETRY_CODE,
          statusCode: 409,
        });
      } finally {
        releaseHold.resolve();
      }
      await hold;
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { active: true },
        }),
      ).resolves.toEqual({ active: true });
    });

    it("standing-first makes a stale-preflight hold wait and refuse the now-inactive linked member", async () => {
      const preflightRead = deferred();
      const allowLinkedMemberLock = deferred();
      const standingFanoutComplete = deferred();
      const releaseStanding = deferred();
      const hold = ordinary
        .$transaction(
          async (tx) => {
            await acquireLodgeCapacityLock(tx, IDS.lodge);
            const target = await tx.member.findUniqueOrThrow({
              where: { id: IDS.target },
              select: { active: true },
            });
            expect(target.active).toBe(true);
            preflightRead.resolve();
            await allowLinkedMemberLock.promise;
            await createBookingRequestHoldEffect(tx);
          },
          { timeout: 30_000 },
        )
        .then(
          () => ({ kind: "committed" as const, error: null }),
          (error: unknown) => ({ kind: "rolled-back" as const, error }),
        );
      await preflightRead.promise;

      const standing = mergeA.$transaction(
        (tx) =>
          applyStandingDeactivationEffect(tx, async () => {
            standingFanoutComplete.resolve();
            await releaseStanding.promise;
          }),
        { timeout: 30_000 },
      );
      await standingFanoutComplete.promise;
      allowLinkedMemberLock.resolve();
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        releaseStanding.resolve();
      }

      await expect(standing).resolves.toBe(0);
      const holdOutcome = await hold;
      expect(holdOutcome.kind).toBe("rolled-back");
      expect(holdOutcome.error).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
      });
      await expect(
        primary.booking.findUnique({
          where: { id: IDS.deletionHoldBooking },
          select: { id: true },
        }),
      ).resolves.toBeNull();
    });

    it("ordinary wins between merge moves and participant locks, then the real merge late-sweeps owner plus actor and folds both counts into its result and audit", async () => {
      const { operation, pause } = await startPausedMerge("before");
      let ordinaryError: unknown;
      try {
        await ordinary.$transaction((tx) =>
          enqueueOwnHostingCoverageReevaluation(IDS.mergeBooking, tx, {
            cause: "OFFICER_OVERRIDE",
            actorMemberId: IDS.loser,
            reason: "Race 2597 retained officer reason",
          }),
        );
      } catch (error) {
        ordinaryError = error;
      } finally {
        pause.release.resolve();
      }
      const result = await operation;
      if (ordinaryError) throw ordinaryError;

      expect(result.relationMoves).toContainEqual({
        model: "HostingCoverageReevaluation.member",
        count: 1,
      });
      expect(result.relationMoves).toContainEqual({
        model: "HostingCoverageReevaluation.actorMemberId",
        count: 1,
      });

      const retained =
        await primary.hostingCoverageReevaluation.findFirstOrThrow({
          where: {
            sourceBookingId: IDS.mergeBooking,
            cause: "OFFICER_OVERRIDE",
          },
        });
      expect(retained).toMatchObject({
        memberId: IDS.master,
        actorMemberId: IDS.master,
        reason: "Race 2597 retained officer reason",
      });

      const audit = await primary.auditLog.findFirstOrThrow({
        where: { action: "MEMBER_MERGED", entityId: IDS.master },
        orderBy: { createdAt: "desc" },
      });
      const metadata = audit.metadata as {
        relationMoves?: Array<{ model: string; count: number }>;
      };
      expect(metadata.relationMoves).toEqual(result.relationMoves);
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.toBeNull();
    });

    it("merge wins the Member rows, so an ordinary owner+actor enqueue gets the fixed retry and its complete outer transaction rolls back", async () => {
      const { operation, pause } = await startPausedMerge("after");
      let ordinaryError: unknown;
      try {
        await ordinary.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: { action: MARKER_ACTION, entityId: IDS.mergeBooking },
          });
          await enqueueOwnHostingCoverageReevaluation(IDS.mergeBooking, tx, {
            cause: "OFFICER_OVERRIDE",
            actorMemberId: IDS.loser,
            reason: "must roll back",
          });
        });
      } catch (error) {
        ordinaryError = error;
      } finally {
        pause.release.resolve();
      }

      expect(ordinaryError).toBeInstanceOf(
        HostingCoverageParticipantRetryError,
      );
      expect(ordinaryError).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
        message: HOSTING_COVERAGE_RETRY_MESSAGE,
      });
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: {
            sourceBookingId: IDS.mergeBooking,
            cause: "OFFICER_OVERRIDE",
          },
        }),
      ).toBe(0);
      await expect(operation).resolves.toMatchObject({
        masterId: IDS.master,
        loserId: IDS.loser,
      });
    });

    it("approve owns the claim before cancelling, and a later reject cannot take it back", async () => {
      // The invariant the intermediate state exists for. An approval commits
      // future-booking cancellations in separate transactions before it
      // anonymises anything, so it takes durable ownership first. From that
      // moment an ORDINARY rejection must be impossible — otherwise the request
      // could end REJECTED with the member's stays already destroyed.
      //
      // #2627: "impossible" is exact for as long as the claim stands, which is
      // the property pinned here. It is no longer the same as "a rejection can
      // never be final after a cancellation committed": a Full Admin may release
      // the claim (the tests below), and the request is then rejectable again —
      // deliberately, because the alternative was a request wedged open forever.
      // What closes that hole is disclosure, not the claim: the release leaves a
      // durable marker on the row and the reject path refuses to finalise
      // without a Full Admin and an explicit confirmation.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });

      await expect(
        claimDeletionRequestApproval(mergeA, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "approve wins",
        }),
      ).resolves.toBe("CLAIMED");

      // Stands in for the separately committed cancellations: the approval is
      // owned and partly executed, but not yet final.
      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, reviewedAt: true },
        }),
      ).resolves.toEqual({
        status: "APPROVAL_IN_PROGRESS",
        reviewedAt: null,
      });

      const rejectOutcome = await claimDeletionRequestDecision(mergeB, {
        id: IDS.deletionRequest,
        decision: "REJECTED",
        reviewedBy: IDS.ownerA,
        adminNote: "reject loses",
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(rejectOutcome.ok).toBe(false);
      if (rejectOutcome.ok) {
        throw new Error("Reject overwrote an approval already in progress.");
      }
      expect(rejectOutcome.error).toMatchObject({
        code: "DELETION_REQUEST_ALREADY_REVIEWED",
        statusCode: 409,
      });

      // Finalisation still succeeds from the lane's own claim.
      await expect(
        claimDeletionRequestDecision(mergeA, {
          id: IDS.deletionRequest,
          decision: "APPROVED",
          reviewedBy: IDS.actor,
          adminNote: "approve wins",
        }),
      ).resolves.toBeUndefined();
      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, adminNote: true },
        }),
      ).resolves.toEqual({ status: "APPROVED", adminNote: "approve wins" });
    });

    it("resumes its own in-progress approval rather than deadlocking a retry", async () => {
      // An approval interrupted after some cancellations committed must be
      // completable; refusing the retry would strand the member half-deleted.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      await expect(
        claimDeletionRequestApproval(mergeA, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "first attempt",
        }),
      ).resolves.toBe("CLAIMED");
      await expect(
        claimDeletionRequestApproval(mergeB, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.ownerA,
          adminNote: "retry",
        }),
      ).resolves.toBe("RESUMED");
      // Resuming must not re-attribute the original claim.
      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, adminNote: true, reviewedBy: true },
        }),
      ).resolves.toEqual({
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "first attempt",
        reviewedBy: IDS.actor,
      });
    });

    it("reject wins the exact DeletionRequest claim and a waiting approve cannot overwrite it", async () => {
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      const reached = deferred();
      const release = deferred();
      const reject = mergeB.$transaction(async (tx) => {
        await claimDeletionRequestDecision(tx, {
          id: IDS.deletionRequest,
          decision: "REJECTED",
          reviewedBy: IDS.actor,
          adminNote: "reject wins",
        });
        reached.resolve();
        await release.promise;
      });
      await reached.promise;
      // Both contenders target the SAME still-PENDING row — rejection claims
      // PENDING directly, and an approval's opening claim does too — so this
      // still exercises a real PostgreSQL row-lock wait, not an immediate miss.
      const approve = claimDeletionRequestApproval(mergeA, {
        id: IDS.deletionRequest,
        reviewedBy: IDS.ownerA,
        adminNote: "approve loses",
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        release.resolve();
      }
      await expect(reject).resolves.toBeUndefined();
      const approveOutcome = await approve;
      expect(approveOutcome.ok).toBe(false);
      if (approveOutcome.ok) {
        throw new Error("Approve started on an already-rejected request.");
      }
      expect(approveOutcome.error).toMatchObject({
        code: "DELETION_REQUEST_ALREADY_REVIEWED",
        statusCode: 409,
      });
      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, adminNote: true },
        }),
      ).resolves.toEqual({ status: "REJECTED", adminNote: "reject wins" });
    });

    it("rolls a failed finalisation back to its claim, not back to PENDING", async () => {
      // The rollback target matters. Falling back to PENDING would silently
      // re-open the request to rejection AFTER its approval had already cancelled
      // bookings. It must land on APPROVAL_IN_PROGRESS so only the approval can
      // still finish, and any re-opening is a deliberate, gated, marked release
      // (#2627) rather than a side effect of a failure nobody chose.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      await expect(
        claimDeletionRequestApproval(primary, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "owned before cleanup",
        }),
      ).resolves.toBe("CLAIMED");

      await expect(
        mergeA.$transaction(async (tx) => {
          await claimDeletionRequestDecision(tx, {
            id: IDS.deletionRequest,
            decision: "APPROVED",
            reviewedBy: IDS.actor,
            adminNote: "must roll back",
          });
          throw new Error("forced privacy rollback");
        }),
      ).rejects.toThrow("forced privacy rollback");

      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, reviewedAt: true, reviewedBy: true },
        }),
      ).resolves.toEqual({
        status: "APPROVAL_IN_PROGRESS",
        reviewedAt: null,
        reviewedBy: IDS.actor,
      });

      // Still un-rejectable after the failed finalisation...
      await expect(
        claimDeletionRequestDecision(primary, {
          id: IDS.deletionRequest,
          decision: "REJECTED",
          reviewedBy: IDS.ownerA,
          adminNote: "must not win",
        }),
      ).rejects.toMatchObject({
        code: "DELETION_REQUEST_ALREADY_REVIEWED",
        statusCode: 409,
      });
      // ...and the approval can still be completed on a retry.
      await expect(
        claimDeletionRequestDecision(primary, {
          id: IDS.deletionRequest,
          decision: "APPROVED",
          reviewedBy: IDS.actor,
          adminNote: "recovered",
        }),
      ).resolves.toBeUndefined();
    });

    it("a release that arrives while a finalisation is committing loses on the row lock", async () => {
      // The release's whole safety argument is "PostgreSQL does the work", and a
      // mocked `{ count: 0 }` only proves the code's reaction to a zero-row
      // match — not that PostgreSQL produces one. This forces the losing order
      // for real: the finalisation holds this exact row's write lock, the release
      // blocks on it, and only then re-evaluates its guard against the committed
      // row.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      await expect(
        claimDeletionRequestApproval(primary, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "approval under way",
        }),
      ).resolves.toBe("CLAIMED");

      const reached = deferred();
      const finish = deferred();
      const finalisation = mergeB.$transaction(async (tx) => {
        await claimDeletionRequestDecision(tx, {
          id: IDS.deletionRequest,
          decision: "APPROVED",
          reviewedBy: IDS.actor,
          adminNote: "approval wins",
        });
        reached.resolve();
        await finish.promise;
      });
      await reached.promise;

      const release = mergeA
        .$transaction(async (tx) =>
          releaseDeletionRequestApprovalClaim(tx, {
            id: IDS.deletionRequest,
            adminNote: "release loses",
          }),
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        // A real PostgreSQL lock wait, not an immediate miss: the release's own
        // `SELECT 1 … FOR UPDATE` blocks behind the uncommitted finalisation.
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        finish.resolve();
      }
      await expect(finalisation).resolves.toBeUndefined();

      const releaseOutcome = await release;
      expect(releaseOutcome.ok).toBe(false);
      if (releaseOutcome.ok) {
        throw new Error("A release re-opened an approval that had committed.");
      }
      expect(releaseOutcome.error).toMatchObject({
        code: "DELETION_REQUEST_CLAIM_NOT_HELD",
        statusCode: 409,
      });
      const finalRow = await primary.deletionRequest.findUniqueOrThrow({
        where: { id: IDS.deletionRequest },
        select: {
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
        },
      });
      expect(finalRow).toMatchObject({
        status: "APPROVED",
        // The finalisation writes only status + reviewedAt; the note the claim
        // recorded stands, and the release's note never lands.
        adminNote: "approval under way",
        reviewedBy: IDS.actor,
      });
      // And the loser left no marker behind on a decided request.
      expect(deletionApprovalWasReleased(finalRow)).toBe(false);
    });

    it("a release that commits first makes the finalisation match zero rows, and leaves the marker", async () => {
      // The winning order, and the one the review is about: the request is
      // re-opened, so the next decider MUST be able to see that an approval had
      // already started here. That is carried by the row itself — PENDING with a
      // reviewedAt and no reviewer — written by the same guarded mutation as the
      // transition.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      await expect(
        claimDeletionRequestApproval(primary, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "claim being abandoned",
        }),
      ).resolves.toBe("CLAIMED");

      const reached = deferred();
      const finish = deferred();
      const release = mergeB.$transaction(async (tx) => {
        const released = await releaseDeletionRequestApprovalClaim(tx, {
          id: IDS.deletionRequest,
          adminNote: "release wins",
        });
        reached.resolve();
        await finish.promise;
        return released;
      });
      await reached.promise;

      const finalisation = mergeA
        .$transaction(async (tx) => {
          await claimDeletionRequestDecision(tx, {
            id: IDS.deletionRequest,
            decision: "APPROVED",
            reviewedBy: IDS.actor,
            adminNote: "finalisation loses",
          });
        })
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        finish.resolve();
      }

      // The release's attribution comes from the read it took under that lock.
      await expect(release).resolves.toMatchObject({
        previousClaimHeldBy: IDS.actor,
        previousAdminNote: "claim being abandoned",
      });

      const finalisationOutcome = await finalisation;
      expect(finalisationOutcome.ok).toBe(false);
      if (finalisationOutcome.ok) {
        throw new Error("An approval finalised over a committed release.");
      }
      expect(finalisationOutcome.error).toMatchObject({
        code: "DELETION_REQUEST_ALREADY_REVIEWED",
        statusCode: 409,
      });

      const finalRow = await primary.deletionRequest.findUniqueOrThrow({
        where: { id: IDS.deletionRequest },
        select: {
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
        },
      });
      // The whole finalisation rolled back: pending again, the release's reason
      // on the row, and no approval attribution.
      expect(finalRow.status).toBe("PENDING");
      expect(finalRow.adminNote).toBe("release wins");
      expect(finalRow.reviewedBy).toBeNull();
      expect(finalRow.reviewedAt).not.toBeNull();
      // Which the queue and the reject path both read as "this was released".
      expect(deletionApprovalWasReleased(finalRow)).toBe(true);
    });

    it("an unconfirmed rejection blocks behind a release and then cannot take the row it re-opened", async () => {
      // The TOCTOU the second review found, forced for real. The route decides
      // whether a rejection is a reject-after-release from an UNGUARDED opening
      // read, and there is latency in the window between that read and the write —
      // Prisma queues on an exhausted pool. So:
      //
      //   1. a Membership Officer reads the row: PENDING, no marker, pre-claim;
      //   2. a Full Admin claims it, cancels the member's future stays, fails,
      //      and releases — PENDING again, WITH the marker;
      //   3. the officer's guarded update runs.
      //
      // Guarded on `status: "PENDING"` alone, step 3 lands: a final REJECTED over
      // cancellations that already committed, with no Full-Admin check and no
      // confirmation. Guarded on the flavour of pending it was authorised
      // against — `reviewedAt: null` — PostgreSQL re-evaluates the predicate
      // against the committed row after the lock wait and matches nothing.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });

      // What the officer's request read before anything happened.
      const asRead = await primary.deletionRequest.findUniqueOrThrow({
        where: { id: IDS.deletionRequest },
        select: { status: true, reviewedBy: true, reviewedAt: true },
      });
      expect(deletionApprovalWasReleased(asRead)).toBe(false);

      // Steps 1-2 as one uncommitted unit, so the rejection's predicate still
      // matches the row's committed version and it must genuinely WAIT on the
      // lock rather than miss immediately.
      const reached = deferred();
      const finish = deferred();
      const claimAndRelease = mergeB.$transaction(async (tx) => {
        await claimDeletionRequestApproval(tx, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "approval that cancelled stays and then failed",
        });
        const released = await releaseDeletionRequestApprovalClaim(tx, {
          id: IDS.deletionRequest,
          adminNote: "blocker will never clear",
        });
        reached.resolve();
        await finish.promise;
        return released;
      });
      await reached.promise;

      const rejection = claimDeletionRequestDecision(mergeA, {
        id: IDS.deletionRequest,
        decision: "REJECTED",
        reviewedBy: IDS.ownerA,
        adminNote: "declined, unaware of the release",
        // Exactly what the route derives from `asRead`: no marker was seen, so
        // nobody was shown the disclosure.
        rejectFrom: "PENDING",
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        finish.resolve();
      }
      await expect(claimAndRelease).resolves.toMatchObject({
        previousClaimHeldBy: IDS.actor,
      });

      const rejectionOutcome = await rejection;
      expect(rejectionOutcome.ok).toBe(false);
      if (rejectionOutcome.ok) {
        throw new Error(
          "An unwarned rejection finalised over a released approval.",
        );
      }
      expect(rejectionOutcome.error).toMatchObject({
        code: "DELETION_REQUEST_ALREADY_REVIEWED",
        statusCode: 409,
      });

      const afterRow = await primary.deletionRequest.findUniqueOrThrow({
        where: { id: IDS.deletionRequest },
        select: {
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
        },
      });
      // Still re-openable and still marked: nothing was decided, and the next
      // decider is still told.
      expect(afterRow.status).toBe("PENDING");
      expect(afterRow.adminNote).toBe("blocker will never clear");
      expect(deletionApprovalWasReleased(afterRow)).toBe(true);

      // And the decision is not lost, only re-routed: a Full Admin who IS shown
      // the marker and confirms it rejects the same row through the other half of
      // the partition.
      await expect(
        claimDeletionRequestDecision(primary, {
          id: IDS.deletionRequest,
          decision: "REJECTED",
          reviewedBy: IDS.ownerA,
          adminNote: "declined, and the member is told their stays are gone",
          rejectFrom: "PENDING_RELEASED",
        }),
      ).resolves.toBeUndefined();
      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, reviewedBy: true },
        }),
      ).resolves.toEqual({ status: "REJECTED", reviewedBy: IDS.ownerA });
    });

    it("loses the release and its audit record together, or neither", async () => {
      // The release destroys the claim's own attribution, so its audit row is the
      // only surviving record of who held it. Written best-effort it could vanish
      // independently of the transition; written inside the release's transaction
      // and awaited, an abort takes both.
      await primary.deletionRequest.create({
        data: { id: IDS.deletionRequest, memberId: IDS.target },
      });
      await expect(
        claimDeletionRequestApproval(primary, {
          id: IDS.deletionRequest,
          reviewedBy: IDS.actor,
          adminNote: "held by the first attempt",
        }),
      ).resolves.toBe("CLAIMED");

      await expect(
        mergeA.$transaction(async (tx) => {
          const released = await releaseDeletionRequestApprovalClaim(tx, {
            id: IDS.deletionRequest,
            adminNote: "released then aborted",
          });
          await tx.auditLog.create({
            data: {
              action: MARKER_ACTION,
              entityId: IDS.target,
              details: `previous claim: ${released.previousClaimHeldBy}`,
            },
          });
          throw new Error("forced release rollback");
        }),
      ).rejects.toThrow("forced release rollback");

      await expect(
        primary.deletionRequest.findUniqueOrThrow({
          where: { id: IDS.deletionRequest },
          select: { status: true, adminNote: true, reviewedBy: true },
        }),
      ).resolves.toEqual({
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "held by the first attempt",
        reviewedBy: IDS.actor,
      });
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
    });

    it("contact-update reservation wins before merge and completion leaves no active loser ledger", async () => {
      await primary.member.update({
        where: { id: IDS.loser },
        data: { xeroContactId: "contact-update-before-merge" },
      });
      const preview = await previewMerge();
      const correlationKey = "race-2597-contact-update-before-merge";
      const reservation = await reserveMemberContactUpdateOperation(
        IDS.loser,
        "contact-update-before-merge",
        (locked) => ({
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "UPDATE",
            localModel: "Member",
            localId: IDS.loser,
            idempotencyKey: correlationKey,
            correlationKey,
            requestPayload: { contacts: [{ emailAddress: locked.email }] },
            createdByMemberId: IDS.actor,
          },
          value: locked.email,
        }),
        ordinary,
      );
      await expect(
        executeMemberMerge({
          masterId: IDS.master,
          loserId: IDS.loser,
          actorMemberId: IDS.actor,
          previewToken: preview.previewToken,
          confirmationText: preview.confirmationPhrase,
          db: mergeA,
        }),
      ).rejects.toMatchObject({ code: "merge_blocked", statusCode: 409 });
      await completeMemberContactUpdateOperation(
        IDS.loser,
        "contact-update-before-merge",
        reservation!.operation.id,
        {
          xeroObjectType: "CONTACT",
          xeroObjectId: "contact-update-before-merge",
          extraLinks: [{
            localModel: "Member",
            localId: IDS.loser,
            xeroObjectType: "CONTACT",
            xeroObjectId: "contact-update-before-merge",
            role: "CONTACT",
          }],
        },
        ordinary,
      );
      const finalPreview = await previewMerge();
      await expect(
        executeMemberMerge({
          masterId: IDS.master,
          loserId: IDS.loser,
          actorMemberId: IDS.actor,
          previewToken: finalPreview.previewToken,
          confirmationText: finalPreview.confirmationPhrase,
          db: mergeA,
        }),
      ).resolves.toMatchObject({ loserId: IDS.loser });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("merge wins the Member row and a waiting contact-update cannot reserve or replay PII", async () => {
      await primary.member.update({
        where: { id: IDS.loser },
        data: { xeroContactId: "contact-merge-before-update" },
      });
      const { operation, pause } = await startPausedMerge("after");
      const correlationKey = "race-2597-merge-before-contact-update";
      const reservation = reserveMemberContactUpdateOperation(
        IDS.loser,
        "contact-merge-before-update",
        (locked) => ({
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "UPDATE",
            localModel: "Member",
            localId: IDS.loser,
            idempotencyKey: correlationKey,
            correlationKey,
            requestPayload: { contacts: [{ emailAddress: locked.email }] },
            createdByMemberId: IDS.actor,
          },
          value: locked.email,
        }),
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      const outcome = await reservation;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Update unexpectedly reserved after merge.");
      expect(outcome.error).toMatchObject({ message: `Member not found: ${IDS.loser}` });
      await expect(
        primary.xeroSyncOperation.count({ where: { correlationKey } }),
      ).resolves.toBe(0);
    });

    it("merge-first makes a master contact UPDATE reserve the merged authoritative PII", async () => {
      await primary.member.update({
        where: { id: IDS.master },
        data: {
          xeroContactId: "contact-master-authoritative",
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          streetAddressLine1: null,
        },
      });
      await primary.member.update({
        where: { id: IDS.loser },
        data: {
          phoneCountryCode: "+64",
          phoneAreaCode: "21",
          phoneNumber: "5551234",
          streetAddressLine1: "1 Merge Lane",
        },
      });
      const { operation, pause } = await startPausedMerge("after");
      const correlationKey = "race-2597-merge-before-master-contact-update";
      const reservation = reserveMemberContactUpdateOperation(
        IDS.master,
        "contact-master-authoritative",
        (locked) => ({
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "UPDATE",
            localModel: "Member",
            localId: IDS.master,
            idempotencyKey: correlationKey,
            correlationKey,
            requestPayload: {
              contacts: [{
                phoneNumber: locked.phoneNumber,
                streetAddressLine1: locked.streetAddressLine1,
              }],
            },
            createdByMemberId: IDS.actor,
          },
          value: {
            phoneNumber: locked.phoneNumber,
            streetAddressLine1: locked.streetAddressLine1,
          },
        }),
        ordinary,
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      await expect(reservation).resolves.toMatchObject({
        value: {
          phoneNumber: "5551234",
          streetAddressLine1: "1 Merge Lane",
        },
      });
      const reserved = await reservation;
      await completeMemberContactUpdateOperation(
        IDS.master,
        "contact-master-authoritative",
        reserved!.operation.id,
        {
          xeroObjectType: "CONTACT",
          xeroObjectId: "contact-master-authoritative",
        },
        ordinary,
      );
    });

    it("contact-update reservation wins before deletion; completion then deletion retires its link", async () => {
      await primary.member.update({
        where: { id: IDS.target },
        data: { xeroContactId: "contact-update-before-deletion" },
      });
      const correlationKey = "race-2597-contact-update-before-deletion";
      const reservation = await reserveMemberContactUpdateOperation(
        IDS.target,
        "contact-update-before-deletion",
        (locked) => ({
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "UPDATE",
            localModel: "Member",
            localId: IDS.target,
            idempotencyKey: correlationKey,
            correlationKey,
            requestPayload: { contacts: [{ emailAddress: locked.email }] },
            createdByMemberId: IDS.actor,
          },
          value: locked.email,
        }),
        ordinary,
      );
      await expect(
        mergeA.$transaction((tx) => applyXeroDeletionFence(tx, IDS.target)),
      ).rejects.toMatchObject({
        code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
        statusCode: 409,
      });
      await completeMemberContactUpdateOperation(
        IDS.target,
        "contact-update-before-deletion",
        reservation!.operation.id,
        {
          xeroObjectType: "CONTACT",
          xeroObjectId: "contact-update-before-deletion",
          extraLinks: [{
            localModel: "Member",
            localId: IDS.target,
            xeroObjectType: "CONTACT",
            xeroObjectId: "contact-update-before-deletion",
            role: "CONTACT",
          }],
        },
        ordinary,
      );
      await expect(
        mergeA.$transaction((tx) => applyXeroDeletionFence(tx, IDS.target)),
      ).resolves.toBeUndefined();
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("deletion wins the Member row and a waiting contact-update cannot reserve or create a link", async () => {
      await primary.member.update({
        where: { id: IDS.target },
        data: { xeroContactId: "contact-deletion-before-update" },
      });
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const deletionDb = createParticipantPauseClient(mergeA, pause);
      const deletion = deletionDb.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      await waitForPauseOrFail(pause, deletion);
      const correlationKey = "race-2597-deletion-before-contact-update";
      const reservation = reserveMemberContactUpdateOperation(
        IDS.target,
        "contact-deletion-before-update",
        (locked) => ({
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "UPDATE",
            localModel: "Member",
            localId: IDS.target,
            idempotencyKey: correlationKey,
            correlationKey,
            requestPayload: { contacts: [{ emailAddress: locked.email }] },
            createdByMemberId: IDS.actor,
          },
          value: locked.email,
        }),
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(deletion).resolves.toBeUndefined();
      const outcome = await reservation;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Update unexpectedly reserved after deletion.");
      expect(outcome.error).toMatchObject({
        code: "XERO_MEMBER_UNAVAILABLE",
        statusCode: 409,
      });
      await expect(
        primary.xeroSyncOperation.count({ where: { correlationKey } }),
      ).resolves.toBe(0);
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("inbound contact reconciliation wins before deletion, which then removes its PII and FK-less link", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const inboundDb = createParticipantPauseClient(ordinary, pause);
      const inbound = applyInboundMemberContactPatch(
        {
          memberId: IDS.target,
          xeroContactId: "contact-inbound-before-deletion",
          patch: {
            phoneCountryCode: "+64",
            phoneAreaCode: "21",
            phoneNumber: "5550199",
            streetAddressLine1: "99 Provider Street",
          },
        },
        inboundDb,
      );
      await waitForPauseOrFail(pause, inbound);
      const deletion = mergeA.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        pause.release.resolve();
      }
      await expect(inbound).resolves.toMatchObject({ linked: true });
      await expect(deletion).resolves.toBeUndefined();
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { phoneNumber: true, xeroContactId: true },
        }),
      ).resolves.toEqual({ phoneNumber: null, xeroContactId: null });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("deletion wins before inbound contact reconciliation, which cannot restore PII or a link", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const deletionDb = createParticipantPauseClient(mergeA, pause);
      const deletion = deletionDb.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      await waitForPauseOrFail(pause, deletion);
      const inbound = applyInboundMemberContactPatch(
        {
          memberId: IDS.target,
          xeroContactId: "contact-deletion-before-inbound",
          patch: { phoneNumber: "555-restored" },
        },
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(deletion).resolves.toBeUndefined();
      const outcome = await inbound;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Inbound reconciliation unexpectedly beat deletion.");
      expect(outcome.error).toMatchObject({ code: "XERO_MEMBER_UNAVAILABLE" });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("inbound contact reconciliation wins before merge; stale preview refuses and retry retires the loser link", async () => {
      const preview = await previewMerge();
      await expect(
        applyInboundMemberContactPatch(
          {
            memberId: IDS.loser,
            xeroContactId: "contact-inbound-before-merge",
            patch: { phoneNumber: "555-loser" },
          },
          ordinary,
        ),
      ).resolves.toMatchObject({ linked: true });
      await expect(
        executeMemberMerge({
          masterId: IDS.master,
          loserId: IDS.loser,
          actorMemberId: IDS.actor,
          previewToken: preview.previewToken,
          confirmationText: preview.confirmationPhrase,
          db: mergeA,
        }),
      ).rejects.toMatchObject({ code: "preview_drift", statusCode: 409 });
      const current = await previewMerge();
      await expect(
        executeMemberMerge({
          masterId: IDS.master,
          loserId: IDS.loser,
          actorMemberId: IDS.actor,
          previewToken: current.previewToken,
          confirmationText: current.confirmationPhrase,
          db: mergeA,
        }),
      ).resolves.toMatchObject({ loserId: IDS.loser });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("merge wins before inbound contact reconciliation, which cannot recreate the loser identity", async () => {
      const { operation, pause } = await startPausedMerge("after");
      const inbound = applyInboundMemberContactPatch(
        {
          memberId: IDS.loser,
          xeroContactId: "contact-merge-before-inbound",
          patch: { phoneNumber: "555-orphan" },
        },
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      const outcome = await inbound;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Inbound reconciliation unexpectedly beat merge.");
      expect(outcome.error).toMatchObject({ message: `Member not found: ${IDS.loser}` });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("historical contact backfill wins before deletion, which retires the atomically-created FK-less link", async () => {
      await primary.member.update({
        where: { id: IDS.target },
        data: { xeroContactId: "contact-backfill-before-deletion" },
      });
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const backfillDb = createParticipantPauseClient(ordinary, pause);
      const backfill = backfillMemberContactLink(
        IDS.target,
        "contact-backfill-before-deletion",
        backfillDb,
      );
      await waitForPauseOrFail(pause, backfill);
      const deletion = mergeA.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        pause.release.resolve();
      }
      await expect(backfill).resolves.toMatchObject({ createdLinks: 1 });
      await expect(deletion).resolves.toBeUndefined();
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("deletion wins before historical contact backfill, which cannot recreate its FK-less link", async () => {
      await primary.member.update({
        where: { id: IDS.target },
        data: { xeroContactId: "contact-deletion-before-backfill" },
      });
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const deletionDb = createParticipantPauseClient(mergeA, pause);
      const deletion = deletionDb.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      await waitForPauseOrFail(pause, deletion);
      const backfill = backfillMemberContactLink(
        IDS.target,
        "contact-deletion-before-backfill",
        ordinary,
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(deletion).resolves.toBeUndefined();
      await expect(backfill).resolves.toMatchObject({ createdLinks: 0 });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("historical contact backfill wins before merge, which then retires the loser link", async () => {
      await primary.member.update({
        where: { id: IDS.loser },
        data: { xeroContactId: "contact-backfill-before-merge" },
      });
      const preview = await previewMerge();
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const backfillDb = createParticipantPauseClient(ordinary, pause);
      const backfill = backfillMemberContactLink(
        IDS.loser,
        "contact-backfill-before-merge",
        backfillDb,
      );
      await waitForPauseOrFail(pause, backfill);
      const merge = executeMemberMerge({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        previewToken: preview.previewToken,
        confirmationText: preview.confirmationPhrase,
        db: mergeA,
      });
      try {
        await waitForClientToBlock("race-2597-merge-a");
      } finally {
        pause.release.resolve();
      }
      await expect(backfill).resolves.toMatchObject({ createdLinks: 1 });
      await expect(merge).resolves.toMatchObject({ loserId: IDS.loser });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("merge wins before historical contact backfill, which cannot recreate the loser identity", async () => {
      await primary.member.update({
        where: { id: IDS.loser },
        data: { xeroContactId: "contact-merge-before-backfill" },
      });
      const { operation, pause } = await startPausedMerge("after");
      const backfill = backfillMemberContactLink(
        IDS.loser,
        "contact-merge-before-backfill",
        ordinary,
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }
      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      await expect(backfill).resolves.toMatchObject({ createdLinks: 0 });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser, active: true },
        }),
      ).resolves.toBe(0);
    });

    it("contact-create reservation wins before provider work, so the full merge rolls back and terminal resolution unblocks preview", async () => {
      const preview = await previewMerge();
      const correlationKey = "race-2597-contact-create-reservation-wins";
      const reservation = await reserveStaticContactCreate(
        IDS.loser,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.loser,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Duplicate Race" }] },
          createdByMemberId: IDS.actor,
        },
        ordinary,
      );

      await expect(
        executeMemberMerge({
          masterId: IDS.master,
          loserId: IDS.loser,
          actorMemberId: IDS.actor,
          previewToken: preview.previewToken,
          confirmationText: preview.confirmationPhrase,
          db: mergeA,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "merge_blocked",
      });
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.not.toBeNull();
      await expect(
        primary.xeroSyncOperation.count({
          where: { id: reservation.id, status: "RUNNING" },
        }),
      ).resolves.toBe(1);

      await primary.xeroSyncOperation.update({
        where: { id: reservation.id },
        data: { status: "SUCCEEDED", completedAt: new Date() },
      });
      await expect(previewMerge()).resolves.toBeDefined();
    });

    it("merge wins the Member row, so a later contact-create reservation cannot commit or reach provider work", async () => {
      const { operation, pause } = await startPausedMerge("after");
      const correlationKey = "race-2597-contact-create-merge-wins";
      const reservation = reserveStaticContactCreate(
        IDS.loser,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.loser,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Duplicate Race" }] },
          createdByMemberId: IDS.actor,
        },
        ordinary,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      const reservationOutcome = await reservation;
      expect(reservationOutcome.ok).toBe(false);
      if (reservationOutcome.ok) {
        throw new Error("Contact-create reservation unexpectedly committed.");
      }
      expect(reservationOutcome.error).toMatchObject({
        message: `Member not found: ${IDS.loser}`,
      });
      await expect(
        primary.xeroSyncOperation.count({ where: { correlationKey } }),
      ).resolves.toBe(0);
    });

    it("contact-create reservation wins before manual link and the link refuses after the Member lock", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const createDb = createParticipantPauseClient(
        ordinary,
        pause,
        "FOR KEY SHARE",
      );
      const correlationKey = "race-2597-contact-create-before-manual-link";
      const reservation = reserveStaticContactCreate(
        IDS.loser,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.loser,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Create Wins" }] },
          createdByMemberId: IDS.actor,
        },
        createDb,
      );
      await waitForPauseOrFail(pause, reservation);

      const manualLink = primary
        .$transaction(async (tx) => {
          await lockMemberForManualXeroContactLink(tx, IDS.loser);
          await tx.member.update({
            where: { id: IDS.loser },
            data: { xeroContactId: "contact-manual-lost" },
          });
        })
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await waitForClientToBlock("race-2597-primary");
      } finally {
        pause.release.resolve();
      }

      await expect(reservation).resolves.toMatchObject({ correlationKey });
      const linkOutcome = await manualLink;
      expect(linkOutcome.ok).toBe(false);
      if (linkOutcome.ok) {
        throw new Error("Manual Xero link unexpectedly beat the create reservation.");
      }
      expect(linkOutcome.error).toMatchObject({
        code: "XERO_CONTACT_CREATE_IN_PROGRESS",
        statusCode: 409,
      });
      await expect(
        primary.member.findUnique({
          where: { id: IDS.loser },
          select: { xeroContactId: true },
        }),
      ).resolves.toEqual({ xeroContactId: null });
    });

    it("manual link wins the Member row and a waiting create refuses before reserving or provider work", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const linkDb = createParticipantPauseClient(mergeA, pause);
      const manualLink = linkDb.$transaction(async (tx) => {
        await lockMemberForManualXeroContactLink(tx, IDS.loser);
        await tx.member.update({
          where: { id: IDS.loser },
          data: { xeroContactId: "contact-manual-winner" },
        });
      });
      await waitForPauseOrFail(pause, manualLink);

      const correlationKey = "race-2597-manual-link-before-contact-create";
      const reservation = reserveStaticContactCreate(
        IDS.loser,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.loser,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Link Wins" }] },
          createdByMemberId: IDS.actor,
        },
        ordinary,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(manualLink).resolves.toBeUndefined();
      const reservationOutcome = await reservation;
      expect(reservationOutcome.ok).toBe(false);
      if (reservationOutcome.ok) {
        throw new Error("Contact create unexpectedly reserved after manual link.");
      }
      expect(reservationOutcome.error).toMatchObject({
        code: "XERO_CONTACT_ALREADY_LINKED",
        statusCode: 409,
      });
      await expect(
        primary.xeroSyncOperation.count({ where: { correlationKey } }),
      ).resolves.toBe(0);
      await expect(
        primary.member.findUnique({
          where: { id: IDS.loser },
          select: { xeroContactId: true },
        }),
      ).resolves.toEqual({ xeroContactId: "contact-manual-winner" });
    });

    it("contact-create reservation wins before account deletion and blocks anonymisation", async () => {
      const correlationKey = "race-2597-contact-create-before-deletion";
      const reservation = await reserveStaticContactCreate(
        IDS.target,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.target,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Create Before Delete" }] },
          createdByMemberId: IDS.actor,
        },
        ordinary,
      );

      await expect(
        mergeA.$transaction((tx) => applyXeroDeletionFence(tx, IDS.target)),
      ).rejects.toMatchObject({
        code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
        statusCode: 409,
      });
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { active: true, email: true, passwordHash: true },
        }),
      ).resolves.toEqual({
        active: true,
        email: `${IDS.target}@example.invalid`,
        passwordHash: "not-a-real-password",
      });
      await expect(
        primary.xeroSyncOperation.count({
          where: { id: reservation.id, status: "RUNNING" },
        }),
      ).resolves.toBe(1);
    });

    it("account deletion wins the Member row and a waiting contact-create refuses without a reservation", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const deletionDb = createParticipantPauseClient(mergeA, pause);
      const deletion = deletionDb.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      await waitForPauseOrFail(pause, deletion);

      const correlationKey = "race-2597-deletion-before-contact-create";
      const reservation = reserveStaticContactCreate(
        IDS.target,
        {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: IDS.target,
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { contacts: [{ name: "Delete Before Create" }] },
          createdByMemberId: IDS.actor,
        },
        ordinary,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(deletion).resolves.toBeUndefined();
      const reservationOutcome = await reservation;
      expect(reservationOutcome.ok).toBe(false);
      if (reservationOutcome.ok) {
        throw new Error("Contact-create reservation unexpectedly beat deletion.");
      }
      expect(reservationOutcome.error).toMatchObject({
        code: "XERO_MEMBER_UNAVAILABLE",
        statusCode: 409,
      });
      await expect(
        primary.xeroSyncOperation.count({ where: { correlationKey } }),
      ).resolves.toBe(0);
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { active: true, passwordHash: true },
        }),
      ).resolves.toEqual({
        active: false,
        passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
      });
    });

    it("manual link wins before account deletion, which waits and then clears the local pointer", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const linkDb = createParticipantPauseClient(mergeA, pause);
      const manualLink = commitManualXeroContactLink(
        {
          memberId: IDS.target,
          xeroContactId: "contact-manual-before-deletion",
          contactName: "Manual Before Deletion",
        },
        linkDb,
      );
      await waitForPauseOrFail(pause, manualLink);

      const deletion = ordinary.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(manualLink).resolves.toBeUndefined();
      await expect(deletion).resolves.toBeUndefined();
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { active: true, passwordHash: true, xeroContactId: true },
        }),
      ).resolves.toEqual({
        active: false,
        passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
        xeroContactId: null,
      });
    });

    it("account deletion wins before manual link, which refuses without writing either local link", async () => {
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const deletionDb = createParticipantPauseClient(mergeA, pause);
      const deletion = deletionDb.$transaction((tx) =>
        applyXeroDeletionFence(tx, IDS.target),
      );
      await waitForPauseOrFail(pause, deletion);

      const manualLink = commitManualXeroContactLink(
        {
          memberId: IDS.target,
          xeroContactId: "contact-manual-after-deletion",
          contactName: "Manual After Deletion",
        },
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(deletion).resolves.toBeUndefined();
      const linkOutcome = await manualLink;
      expect(linkOutcome.ok).toBe(false);
      if (linkOutcome.ok) {
        throw new Error("Manual link unexpectedly committed after deletion.");
      }
      expect(linkOutcome.error).toMatchObject({
        code: "XERO_MEMBER_UNAVAILABLE",
        statusCode: 409,
      });
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.target },
        }),
      ).resolves.toBe(0);
      await expect(
        primary.member.findUniqueOrThrow({
          where: { id: IDS.target },
          select: { xeroContactId: true },
        }),
      ).resolves.toEqual({ xeroContactId: null });
    });

    it("manual link wins before merge and merge deactivates its contact ledger without dangling it", async () => {
      const preview = await previewMerge();
      const pause: ParticipantPause = {
        position: "after",
        reached: deferred(),
        release: deferred(),
      };
      const linkDb = createParticipantPauseClient(mergeA, pause);
      const manualLink = commitManualXeroContactLink(
        {
          memberId: IDS.loser,
          xeroContactId: "contact-manual-before-merge",
          contactName: "Manual Before Merge",
        },
        linkDb,
      );
      await waitForPauseOrFail(pause, manualLink);

      const merge = executeMemberMerge({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        previewToken: preview.previewToken,
        confirmationText: preview.confirmationPhrase,
        db: ordinary,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(manualLink).resolves.toBeUndefined();
      const mergeOutcome = await merge;
      expect(mergeOutcome.ok).toBe(true);
      if (!mergeOutcome.ok) throw mergeOutcome.error;
      await expect(
        primary.member.findUnique({
          where: { id: IDS.loser },
        }),
      ).resolves.toBeNull();
      await expect(
        primary.xeroObjectLink.count({
          where: {
            localModel: "Member",
            localId: IDS.loser,
            xeroObjectType: "CONTACT",
            xeroObjectId: "contact-manual-before-merge",
            role: "CONTACT",
            active: true,
          },
        }),
      ).resolves.toBe(0);
      await expect(
        primary.xeroObjectLink.count({
          where: {
            localModel: "Member",
            localId: IDS.loser,
            xeroObjectType: "CONTACT",
            xeroObjectId: "contact-manual-before-merge",
            role: "CONTACT",
            active: false,
          },
        }),
      ).resolves.toBe(1);
    });

    it("merge wins before manual link, which refuses without leaving a loser ledger row", async () => {
      const { operation, pause } = await startPausedMerge("after");
      const manualLink = commitManualXeroContactLink(
        {
          memberId: IDS.loser,
          xeroContactId: "contact-manual-after-merge",
          contactName: "Manual After Merge",
        },
        ordinary,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(operation).resolves.toMatchObject({ loserId: IDS.loser });
      const linkOutcome = await manualLink;
      expect(linkOutcome.ok).toBe(false);
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.toBeNull();
      await expect(
        primary.xeroObjectLink.count({
          where: { localModel: "Member", localId: IDS.loser },
        }),
      ).resolves.toBe(0);
    });

    it("refuses and rolls back the full merge when a loser-linked guest commits after relation moves but before participant locks", async () => {
      const { operation, pause } = await startPausedMerge("before");
      try {
        await ordinary.bookingGuest.create({
          data: mergeGuestData(IDS.mergeGuestBeforeLock),
        });
      } finally {
        pause.release.resolve();
      }

      await expect(operation).rejects.toMatchObject({
        statusCode: 409,
        code: "merge_drift_in_transaction",
        details: {
          driftFields: ["BookingGuest.member"],
          bookingGuestIds: [IDS.mergeGuestBeforeLock],
          bookingIds: [IDS.mergeBooking],
        },
      });

      await expect(
        primary.booking.findUniqueOrThrow({
          where: { id: IDS.mergeBooking },
          select: { memberId: true },
        }),
      ).resolves.toEqual({ memberId: IDS.loser });
      await expect(
        primary.bookingGuest.findUniqueOrThrow({
          where: { id: IDS.mergeGuestBeforeLock },
          select: { memberId: true },
        }),
      ).resolves.toEqual({ memberId: IDS.loser });
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.not.toBeNull();
      expect(
        await primary.auditLog.count({
          where: { action: "MEMBER_MERGED", entityId: IDS.master },
        }),
      ).toBe(0);
    });

    it("blocks a loser-linked guest inserted after participant locks, then fails its FK instead of committing a SetNull row", async () => {
      const { operation, pause } = await startPausedMerge("after");
      const insert = ordinary.bookingGuest
        .create({
          data: mergeGuestData(IDS.mergeGuestAfterLock),
        })
        .then(
          () => ({ kind: "created" as const, error: null }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );

      try {
        await waitForClientToBlock("race-2597-ordinary");
      } finally {
        pause.release.resolve();
      }

      await expect(operation).resolves.toMatchObject({
        masterId: IDS.master,
        loserId: IDS.loser,
      });
      const insertOutcome = await insert;
      expect(insertOutcome.kind).toBe("failed");
      expect(insertOutcome.error).toBeTruthy();
      await expect(
        primary.bookingGuest.findUnique({
          where: { id: IDS.mergeGuestAfterLock },
        }),
      ).resolves.toBeNull();
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.toBeNull();
    });

    it("fails fast on a later bulk seam and rolls back the earlier queue row plus the caller marker", async () => {
      const held = deferred();
      const release = deferred();
      const holder = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.ownerB,
            loserId: IDS.ancillaryA,
            ownerMemberIds: [],
          });
          held.resolve();
          await release.promise;
        },
        { timeout: 30_000 },
      );
      await held.promise;

      let bulkError: unknown;
      try {
        await ordinary.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: { action: MARKER_ACTION, entityId: IDS.bookingA },
          });
          await enqueueOwnHostingCoverageReevaluation(IDS.bookingA, tx);
          await enqueueOwnHostingCoverageReevaluation(IDS.bookingB, tx);
        });
      } catch (error) {
        bulkError = error;
      } finally {
        release.resolve();
      }
      await holder;

      expect(bulkError).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
      });
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: { sourceBookingId: { in: [IDS.bookingA, IDS.bookingB] } },
        }),
      ).toBe(0);
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
    });

    it("rejects missing actor and source-owner drift with the stable retry contract and no marker write", async () => {
      const source = {
        bookingId: IDS.bookingB,
        ownerMemberId: IDS.ownerA,
        lodgeId: IDS.lodge,
      };

      for (const attempt of [
        () =>
          ordinary.$transaction(async (tx) => {
            await tx.auditLog.create({
              data: { action: MARKER_ACTION, entityId: "source-drift" },
            });
            await acquireHostingCoverageQueueParticipantProof(
              { sources: [source] },
              tx,
            );
          }),
        () =>
          ordinary.$transaction(async (tx) => {
            await tx.auditLog.create({
              data: { action: MARKER_ACTION, entityId: "missing-actor" },
            });
            await acquireHostingCoverageQueueParticipantProof(
              {
                sources: [
                  {
                    bookingId: IDS.bookingA,
                    ownerMemberId: IDS.ownerA,
                    lodgeId: IDS.lodge,
                  },
                ],
                actorMemberId: "race-2597-missing-actor",
              },
              tx,
            );
          }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          code: HOSTING_COVERAGE_RETRY_CODE,
          statusCode: 409,
          message: HOSTING_COVERAGE_RETRY_MESSAGE,
        });
      }
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
    });

    it("includes every linked guest committed before the standing-subject lock", async () => {
      const guest = (id: string, bookingId: string) => ({
        id,
        bookingId,
        memberId: IDS.target,
        firstName: "Target",
        lastName: "Race",
        ageTier: "ADULT" as const,
        isMember: true,
        stayStart: new Date("2099-04-01"),
        stayEnd: new Date("2099-04-03"),
        priceCents: 100,
      });
      await primary.bookingGuest.createMany({
        data: [
          guest(IDS.fanoutGuestA, IDS.fanoutBookingA),
          guest(IDS.fanoutGuestB, IDS.fanoutBookingB),
        ],
      });
      await expect(
        ordinary.$transaction((tx) =>
          enqueueHostingCoverageReevaluationForMember(IDS.target, tx, CLUB_TODAY_DATE_ONLY),
        ),
      ).resolves.toBe(2);
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: {
            sourceBookingId: {
              in: [IDS.fanoutBookingA, IDS.fanoutBookingB],
            },
          },
        }),
      ).toBe(2);
    });

    it("sorts overlapping ancillary owner sets so two opposing merge lock plans serialize without deadlock", async () => {
      const firstHeld = deferred();
      const releaseFirst = deferred();
      const first = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [IDS.ancillaryB, IDS.ancillaryA],
          });
          firstHeld.resolve();
          await releaseFirst.promise;
        },
        { timeout: 30_000 },
      );
      await firstHeld.promise;

      const second = mergeB.$transaction(
        (tx) =>
          lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.ancillaryB,
            loserId: IDS.ancillaryA,
            ownerMemberIds: [IDS.loser, IDS.master],
          }),
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
      } finally {
        releaseFirst.resolve();
      }

      await expect(Promise.all([first, second])).resolves.toBeDefined();
    });

    it("bounds the merge participant wait instead of holding the policy key for the whole transaction budget (#2623 T6)", async () => {
      // ONLY REAL POSTGRESQL CAN ESTABLISH THIS. The unit suite proves the
      // statements are emitted in the right order; whether PostgreSQL actually
      // cancels the wait, and whether it reports the cancellation as the same
      // SQLSTATE `55P03` that `NOWAIT` raises, are facts about the database.
      //
      // Before the bound, this second transaction waited for as long as merge's
      // own `timeout: 120_000` allowed — while holding the adult-member hosting
      // policy-set advisory key, and while its own `FOR UPDATE` on up to
      // `HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT` third-party owners blocked every FK
      // write naming them, so an uninvolved booking-create or guest-add waited
      // behind the tail of a merge it had nothing to do with.
      const held = deferred();
      const release = deferred();
      const holder = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [],
          });
          held.resolve();
          await release.promise;
        },
        { timeout: 60_000 },
      );
      await held.promise;

      const startedAt = process.hrtime.bigint();
      let waitedMs = 0;
      let contended: unknown;
      try {
        await mergeB.$transaction(
          async (tx) => {
            await lockAdultMemberHostingPolicySet(tx);
            await lockMemberMergeHostingCoverageParticipants(tx, {
              masterId: IDS.master,
              loserId: IDS.loser,
              ownerMemberIds: [],
            });
          },
          // Deliberately far above the lock bound: if the bound did not exist,
          // this would sit here until the holder released rather than failing.
          { timeout: 60_000 },
        );
      } catch (error) {
        contended = error;
        waitedMs = realElapsedMs(startedAt);
      } finally {
        release.resolve();
      }
      await holder;

      // The stable contract merge already converts into its "nothing was saved,
      // re-run the preview" 409 — not a raw driver error.
      expect(contended).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
        message: HOSTING_COVERAGE_RETRY_MESSAGE,
      });
      // It really waited (this lock is still BLOCKING on purpose) and it really
      // stopped (it did not run to the transaction budget).
      expect(waitedMs).toBeGreaterThan(5_000);
      expect(waitedMs).toBeLessThan(30_000);
    }, 90_000);

    it("still lets a short overlap through, so the bound did not turn the merge lock into NOWAIT (#2623 T6)", async () => {
      // The other half, and the reason the bound is 10s rather than 0: merge is
      // irreversible admin work, so a brief overlap with an ordinary writer must
      // still succeed. `member-merge.ts` documents that blocking wait as
      // deliberate.
      const held = deferred();
      const release = deferred();
      const holder = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [],
          });
          held.resolve();
          await release.promise;
        },
        { timeout: 30_000 },
      );
      await held.promise;

      const waiter = mergeB.$transaction(
        (tx) =>
          lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [],
          }),
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
      } finally {
        release.resolve();
      }
      await expect(waiter).resolves.toEqual([IDS.loser, IDS.master].sort());
      await holder;
    }, 60_000);

    it("moves rows created by config-transfer policy reconciliation when config wins before the full merge", async () => {
      const releaseConfig = deferred();
      const configReady = deferredValue<{
        policyEffect: Awaited<
          ReturnType<typeof applyConfigTransferPolicyReconciliation>
        >;
        preview: Awaited<ReturnType<typeof previewMerge>>;
      }>();
      const configFirst = mergeA.$transaction(
        async (tx) => {
          await acquireConfigImportLock(tx);
          await lockMinimumStayPolicySet(tx);
          await lockAdultMemberHostingPolicySet(tx);
          const policyEffect =
            await applyConfigTransferPolicyReconciliation(tx);
          const preview = await buildMemberMergePreview({
            masterId: IDS.master,
            loserId: IDS.loser,
            actorMemberId: IDS.actor,
            db: tx,
          });
          configReady.resolve({ policyEffect, preview });
          await releaseConfig.promise;
        },
        { timeout: 30_000 },
      );
      const { policyEffect, preview } = await configReady.promise;

      expect(policyEffect.queued).toBeGreaterThanOrEqual(BOOKING_IDS.length);
      expect(policyEffect.fixtureRows).toHaveLength(BOOKING_IDS.length);
      expect(policyEffect.mergeBookingRow.memberId).toBe(IDS.loser);
      expect(preview.blockers).toEqual([]);
      const mergeSecond = executeMemberMerge({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        previewToken: preview.previewToken,
        confirmationText: preview.confirmationPhrase,
        db: mergeB,
      });
      try {
        await waitForClientToBlock("race-2597-merge-b");
        // Waiting on the policy key must happen before merge takes Member rows.
        await expect(
          primary.$transaction(
            (tx) =>
              tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${IDS.master} FOR UPDATE NOWAIT`,
          ),
        ).resolves.toBe(1);
      } finally {
        releaseConfig.resolve();
      }
      const [, mergeResult] = await Promise.all([configFirst, mergeSecond]);

      expect(mergeResult.relationMoves).toContainEqual({
        model: "HostingCoverageReevaluation.member",
        count: 1,
      });
      await expect(
        primary.hostingCoverageReevaluation.findUniqueOrThrow({
          where: { id: policyEffect.mergeBookingRow.id },
          select: { memberId: true, sourceBookingId: true },
        }),
      ).resolves.toEqual({
        memberId: IDS.master,
        sourceBookingId: IDS.mergeBooking,
      });
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.toBeNull();
    });

    it("makes config-transfer wait for a full merge, then reconciles survivor-owned bookings", async () => {
      const { operation: mergeFirst, pause } = await startPausedMerge("before");
      const configSecond = mergeB.$transaction(
        async (tx) => {
          await acquireConfigImportLock(tx);
          await lockMinimumStayPolicySet(tx);
          await lockAdultMemberHostingPolicySet(tx);
          return applyConfigTransferPolicyReconciliation(tx);
        },
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
      } finally {
        pause.release.resolve();
      }
      const [mergeResult, configEffect] = await Promise.all([
        mergeFirst,
        configSecond,
      ]);

      expect(mergeResult).toMatchObject({
        masterId: IDS.master,
        loserId: IDS.loser,
      });
      expect(configEffect.queued).toBeGreaterThanOrEqual(BOOKING_IDS.length);
      expect(configEffect.fixtureRows).toHaveLength(BOOKING_IDS.length);
      expect(configEffect.mergeBookingRow.memberId).toBe(IDS.master);
      await expect(
        primary.hostingCoverageReevaluation.findUniqueOrThrow({
          where: { id: configEffect.mergeBookingRow.id },
          select: { memberId: true, sourceBookingId: true },
        }),
      ).resolves.toEqual({
        memberId: IDS.master,
        sourceBookingId: IDS.mergeBooking,
      });
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: { memberId: IDS.loser },
        }),
      ).toBe(0);
    });
  },
);
