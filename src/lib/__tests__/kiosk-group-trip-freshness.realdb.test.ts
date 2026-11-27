/**
 * Opt-in real-PostgreSQL proof for #5239: Group Trip sibling cover on the kiosk.
 *
 * The kiosk shows adult cover resting on a trip sibling only while the hosting
 * snapshot's freshness stamp matches its trip's `coverageInvalidationRevision`.
 * The unit suites pin the comparison and the writer's shape against fakes. What
 * only a real database can show is the part that lives in PostgreSQL:
 *
 *  1. the AuditLog trigger bumps the revision for exactly the truncation row, in
 *     the inserting transaction, and a rollback takes the bump with it;
 *  2. an insert written the way a deployed OLD colour writes it — the audit row
 *     through raw SQL, a trip that never names the new column — still works and
 *     still bumps, which is why the increment is a trigger and not app code;
 *  3. the real truncation writer (`reportGroupTripDependentCeilingBound`) bumps;
 *  4. a booking evaluated before a truncation stays unverifiable however small the
 *     trip is now, until a fresh canonical evaluation restamps it — without
 *     reopening the officer's decision;
 *  5. both interleavings of an evaluation and a truncating fan-out: the stamp can
 *     be OLDER than the facts the evaluation read, never newer;
 *  6. a member merge, which has no Group Trip fan-out, moves the revision of the
 *     trips the merged person attends, and so does the set-based bump a bound
 *     member fan-out ceiling makes, by every route the person attends a trip
 *     (organiser, join, and the split child of either), and by none other.
 *
 * Ordinary runs stay database-free: the suite runs only when
 * `RUN_CONCURRENCY_RACE_TESTS=1`, reads only the guarded race URL, and cleans its
 * own `race-5239-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 5_000;
const TRUNCATED = "booking.hostingCoverage.groupTripFanoutTruncated";

const IDS = {
  lodge: "race-5239-lodge",
  policy: "race-5239-policy",
  organiserMember: "race-5239-member-organiser",
  joinerMember: "race-5239-member-joiner",
  adultMember: "race-5239-member-adult",
  organiserBooking: "race-5239-booking-organiser",
  joinerBooking: "race-5239-booking-joiner",
  group: "race-5239-group",
  joinRow: "race-5239-join",
} as const;
/**
 * One member attending trips by every route the set-based member bump names,
 * plus stays it must not reach. Seeded only by the test that uses them.
 */
const WIDE = {
  member: "race-5239-member-wide",
  organiserTrip: "race-5239-wide-g-organiser",
  joinTrip: "race-5239-wide-g-join",
  organiserSplitTrip: "race-5239-wide-g-organiser-split",
  joinSplitTrip: "race-5239-wide-g-join-split",
  cancelledTrip: "race-5239-wide-g-cancelled",
  finishedTrip: "race-5239-wide-g-finished",
  unrelatedTrip: "race-5239-wide-g-unrelated",
} as const;
const WIDE_TRIP_IDS = Object.values(WIDE).filter((id) => id !== WIDE.member);
const WIDE_BOOKING_IDS = [
  ...WIDE_TRIP_IDS.map((trip) => `${trip}-organiser`),
  `${WIDE.joinTrip}-joiner`,
  `${WIDE.joinSplitTrip}-joiner`,
  `${WIDE.organiserSplitTrip}-child`,
  `${WIDE.joinSplitTrip}-child`,
];
const MEMBER_IDS = [IDS.organiserMember, IDS.joinerMember, IDS.adultMember, WIDE.member];
const BOOKING_IDS = [IDS.organiserBooking, IDS.joinerBooking, ...WIDE_BOOKING_IDS];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let primary: PrismaClient;
let writerA: PrismaClient;
let writerB: PrismaClient;
let observer: PrismaClient;

let review: typeof import("@/lib/adult-member-hosting-review");
let storedReview: typeof import("@/lib/adult-member-hosting-stored-review");
let ceilings: typeof import("@/lib/adult-member-hosting-coverage-ceilings");
let mergePlan: typeof import("@/lib/adult-member-hosting-merge-coverage-plan");
let memberFanout: typeof import("@/lib/adult-member-hosting-member-fanout");
let locks: typeof import("@/lib/adult-member-hosting-coverage-lock");
let kioskCover: typeof import("@/lib/kiosk-adult-cover");
let HOSTING_COVERAGE_RETRY_CODE: string;

describe("kiosk Group Trip freshness race DB safety guard (#5239)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
        "Group Trip freshness",
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRaceDbUrl(
        "postgresql://user:pass@db.example.org:5432/app",
        "Group Trip freshness",
      ),
    ).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "Group Trip cover freshness — real PostgreSQL (#5239)",
  { timeout: 120_000 },
  () => {
    const STAY = {
      checkIn: new Date("2099-05-01"),
      checkOut: new Date("2099-05-03"),
      status: "PAID" as const,
      lodgeId: IDS.lodge,
      totalPriceCents: 100,
      finalPriceCents: 100,
      hasNonMembers: true,
    };

    async function clearFixtures(): Promise<void> {
      await primary.auditLog.deleteMany({ where: { entityId: IDS.group } });
      await primary.hostingCoverageIncident.deleteMany({
        where: { bookingId: { in: BOOKING_IDS } },
      });
      await primary.hostingCoverageReevaluation.deleteMany({
        where: { sourceBookingId: { in: BOOKING_IDS } },
      });
      await primary.groupBookingJoin.deleteMany({ where: { id: IDS.joinRow } });
      await primary.groupBookingJoin.deleteMany({
        where: { groupBookingId: { in: WIDE_TRIP_IDS } },
      });
      await primary.groupBooking.deleteMany({
        where: { id: { in: [IDS.group, ...WIDE_TRIP_IDS] } },
      });
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
     * An ENFORCED lodge with Group Trip cover on. The organiser's adult stays the
     * first night only; the joiner, on another account, brings a non-member guest
     * for both. So the joiner's snapshot records night one covered from the trip
     * and night two uncovered — the shape the kiosk reports as "1 of 2 nights".
     */
    async function seedFixtures(): Promise<void> {
      await primary.member.createMany({
        data: MEMBER_IDS.map((id) => ({
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: id.split("-").at(-1) ?? "Race",
          lastName: "Race",
          role: "USER" as const,
          ageTier: "ADULT" as const,
          active: true,
          canLogin: false,
        })),
      });
      await primary.lodge.create({
        data: { id: IDS.lodge, name: "Race 5239 Lodge", slug: "race-5239-lodge" },
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
                stayEnd: new Date("2099-05-02"),
                priceCents: 50,
                nights: {
                  create: [{ stayDate: new Date("2099-05-01"), priceCents: 50 }],
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
      // AS A DEPLOYED OLD COLOUR WRITES IT: the insert never names the new
      // column, so this is also the proof that old code can still create trips.
      await primary.$executeRaw`
        INSERT INTO "GroupBooking"
          ("id", "organiserBookingId", "organiserMemberId", "joinCode", "paymentMode", "updatedAt")
        VALUES
          (${IDS.group}, ${IDS.organiserBooking}, ${IDS.organiserMember}, 'RACE5239', 'EACH_PAYS_OWN', NOW())
      `;
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

    async function revision(): Promise<number> {
      const row = await observer.groupBooking.findUniqueOrThrow({
        where: { id: IDS.group },
        select: { coverageInvalidationRevision: true },
      });
      return row.coverageInvalidationRevision;
    }

    function truncationAudit(db: Pick<PrismaClient, "auditLog">) {
      return db.auditLog.create({
        data: {
          action: TRUNCATED,
          entityType: "GroupBooking",
          entityId: IDS.group,
          category: "booking",
          severity: "important",
          outcome: "success",
        },
      });
    }

    /** One canonical writer evaluation of the joiner, as the queue drain runs it. */
    function evaluateJoiner(client: PrismaClient) {
      return client.$transaction((tx) =>
        review.reconcileAdultMemberHostingReview(IDS.joinerBooking, tx as never, {
          enforcement: "REVIEW_ONLY",
        }),
      );
    }

    /** What the kiosk would say about the joiner against the trip as it is now. */
    async function kioskSays() {
      const booking = await observer.booking.findUniqueOrThrow({
        where: { id: IDS.joinerBooking },
        select: { adultMemberHostingReview: true },
      });
      return kioskCover.deriveKioskAdultCoverSource(
        booking.adultMemberHostingReview,
        {
          queuedReevaluation: false,
          openIncident: false,
          currentGroupTripCover: { groupBookingId: IDS.group, revision: await revision() },
        },
      );
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
      throw new Error(`Timed out waiting for ${applicationName} to block on a lock.`);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Group Trip freshness");
      process.env.DATABASE_URL = RACE_DB_URL;
      [review, storedReview, ceilings, locks, kioskCover, mergePlan, memberFanout] = await Promise.all([
        import("@/lib/adult-member-hosting-review"),
        import("@/lib/adult-member-hosting-stored-review"),
        import("@/lib/adult-member-hosting-coverage-ceilings"),
        import("@/lib/adult-member-hosting-coverage-lock"),
        import("@/lib/kiosk-adult-cover"),
        import("@/lib/adult-member-hosting-merge-coverage-plan"),
        import("@/lib/adult-member-hosting-member-fanout"),
      ]);
      HOSTING_COVERAGE_RETRY_CODE = (
        await import("@/lib/adult-member-hosting-queue-participants")
      ).HOSTING_COVERAGE_RETRY_CODE;

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const createClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      primary = createClient("race-5239-primary");
      writerA = createClient("race-5239-writer-a");
      writerB = createClient("race-5239-writer-b");
      observer = createClient("race-5239-observer");
      await Promise.all(
        [primary, writerA, writerB, observer].map((client) => client.$connect()),
      );
    });

    afterAll(async () => {
      if (!primary) return;
      await clearFixtures();
      await Promise.all(
        [primary, writerA, writerB, observer].map((client) => client.$disconnect()),
      );
    });

    beforeEach(async () => {
      await clearFixtures();
      await seedFixtures();
    });

    it("bumps the revision for the truncation row only, inside the inserting transaction", async () => {
      expect(await revision(), "a trip created by old code reads the default").toBe(0);

      await expect(
        writerA.$transaction(async (tx) => {
          await truncationAudit(tx);
          throw new Error("roll the fan-out back");
        }),
      ).rejects.toThrow("roll the fan-out back");
      expect(await revision(), "a rolled-back fan-out leaves no bump").toBe(0);

      await writerA.$transaction(async (tx) => {
        await truncationAudit(tx);
        await tx.auditLog.create({
          data: { action: "booking.hostingCoverage.somethingElse", entityType: "GroupBooking", entityId: IDS.group },
        });
        await tx.auditLog.create({
          data: { action: TRUNCATED, entityType: "Booking", entityId: IDS.group },
        });
      });
      expect(await revision(), "only the GroupBooking truncation row counts").toBe(1);
    });

    it("bumps for an audit row written the way the deployed old colour writes it", async () => {
      await primary.$executeRaw`
        INSERT INTO "AuditLog" ("id", "action", "entityType", "entityId", "createdAt")
        VALUES ('race-5239-old-colour-audit', ${TRUNCATED}, 'GroupBooking', ${IDS.group}, NOW())
      `;
      expect(await revision()).toBe(1);
      // Audit retention may delete the row; the revision never goes back.
      await primary.auditLog.deleteMany({ where: { id: "race-5239-old-colour-audit" } });
      expect(await revision()).toBe(1);
    });

    it("bumps through the real truncation writer", async () => {
      await writerA.$transaction((tx) =>
        ceilings.reportGroupTripDependentCeilingBound(
          { groupBookingId: IDS.group, lodgeId: IDS.lodge },
          ceilings.GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
          "group-trip-fanout",
          tx,
        ),
      );
      expect(await revision()).toBe(1);
    });

    it("keeps a booking evaluated before a truncation unverifiable until it is re-evaluated", async () => {
      expect((await evaluateJoiner(writerA)).action).toBe("opened");
      expect(await kioskSays()).toMatchObject({
        status: "EVALUATED",
        scopes: ["SAME_GROUP_TRIP"],
      });

      // A fan-out somewhere in the trip was truncated. The trip is two bookings,
      // nowhere near the ceiling: its present size proves nothing about who an
      // earlier fan-out missed.
      await writerB.$transaction((tx) => truncationAudit(tx));
      expect(await kioskSays()).toEqual({ status: "STALE", nights: [], scopes: [] });

      // An officer decided it meanwhile; a fresh evaluation must not undo that.
      await primary.booking.update({
        where: { id: IDS.joinerBooking },
        data: { adultMemberHostingReviewStatus: "APPROVED" },
      });
      expect((await evaluateJoiner(writerA)).action).toBe("unchanged");
      expect(await kioskSays()).toMatchObject({
        status: "EVALUATED",
        scopes: ["SAME_GROUP_TRIP"],
      });
      const row = await observer.booking.findUniqueOrThrow({
        where: { id: IDS.joinerBooking },
        select: { adultMemberHostingReviewStatus: true },
      });
      expect(row.adultMemberHostingReviewStatus).toBe("APPROVED");
    });

    it("leaves sibling cover unverified after a member merge touches the trip's host", async () => {
      // Merge has no Group Trip fan-out, so it moves the revision of every trip the
      // merged person attends instead (the adult here attends the organiser's booking).
      expect((await evaluateJoiner(writerA)).action).toBe("opened");
      await writerB.$transaction(async (tx) => {
        const plan = await mergePlan.buildMemberMergeHostingCoveragePlan(
          {
            masterId: IDS.adultMember,
            capturedLoserOwnedBookingIds: [],
            today: new Date("2026-07-01T00:00:00.000Z"),
          },
          tx as never,
        );
        expect(plan.invalidatedGroupTripIds).toEqual([IDS.group]);
        await mergePlan.enqueueMemberMergeHostingCoveragePlan(
          { ...plan, items: [] },
          {} as never,
          tx as never,
        );
      });
      expect(await revision()).toBe(1);
      expect(await kioskSays()).toEqual({ status: "STALE", nights: [], scopes: [] });
    });

    it("moves every trip a member attends, set-based, when their fan-out ceiling binds", async () => {
      // The relation filter is checked against the real schema here: the adult
      // attends the organiser's booking, so exactly this trip moves; a member who
      // attends nothing moves no trip.
      const today = new Date("2026-07-01T00:00:00.000Z");
      expect((await evaluateJoiner(writerA)).action).toBe("opened");
      const moved = await writerB.$transaction((tx) =>
        memberFanout.invalidateMemberGroupTripCover(IDS.adultMember, today, tx, "member-merge"),
      );
      expect(moved).toBe(1);
      expect(await revision()).toBe(1);
      expect(await kioskSays()).toEqual({ status: "STALE", nights: [], scopes: [] });
      const none = await writerB.$transaction((tx) =>
        memberFanout.invalidateMemberGroupTripCover(IDS.joinerMember, today, tx, "member-merge"),
      );
      expect(none).toBe(0);
      expect(await revision()).toBe(1);
    });

    /** A stay owned by the organiser member, with the wide member as a guest if `attends`. */
    async function wideStay(
      id: string,
      options: {
        attends: boolean;
        ownerId?: string;
        parentBookingId?: string;
        status?: "PAID" | "CANCELLED";
        checkIn?: Date;
        checkOut?: Date;
      },
    ): Promise<void> {
      const checkIn = options.checkIn ?? STAY.checkIn;
      const checkOut = options.checkOut ?? STAY.checkOut;
      await primary.booking.create({
        data: {
          ...STAY,
          id,
          memberId: options.ownerId ?? IDS.organiserMember,
          status: options.status ?? "PAID",
          checkIn,
          checkOut,
          parentBookingId: options.parentBookingId ?? null,
          guests: options.attends
            ? {
                create: [
                  {
                    memberId: WIDE.member,
                    firstName: "Wide",
                    lastName: "Member",
                    ageTier: "ADULT",
                    isMember: true,
                    stayStart: checkIn,
                    stayEnd: checkOut,
                    priceCents: 50,
                    nights: { create: [{ stayDate: checkIn, priceCents: 50 }] },
                  },
                ],
              }
            : undefined,
        },
      });
    }

    /** A trip anchored on `<trip>-organiser`, optionally with `<trip>-joiner` joined. */
    async function wideTrip(trip: string, withJoiner: boolean): Promise<void> {
      await primary.groupBooking.create({
        data: {
          id: trip,
          organiserBookingId: `${trip}-organiser`,
          organiserMemberId: IDS.organiserMember,
          joinCode: trip.toUpperCase(),
          paymentMode: "EACH_PAYS_OWN",
        },
      });
      if (withJoiner) {
        await primary.groupBookingJoin.create({
          data: {
            groupBookingId: trip,
            bookingId: `${trip}-joiner`,
            joinerMemberId: IDS.joinerMember,
            isMember: true,
          },
        });
      }
    }

    it("reaches every route a member attends a trip by, and no stay it must not (#5239)", async () => {
      const today = new Date("2026-07-01T00:00:00.000Z");
      // 1. As a guest on the organiser's booking.
      await wideStay(`${WIDE.organiserTrip}-organiser`, { attends: true });
      await wideTrip(WIDE.organiserTrip, false);
      // 2. As a guest on a booking joined to the trip.
      await wideStay(`${WIDE.joinTrip}-organiser`, { attends: false });
      await wideStay(`${WIDE.joinTrip}-joiner`, { attends: true, ownerId: IDS.joinerMember });
      await wideTrip(WIDE.joinTrip, true);
      // 3. On the split child of the organiser's booking (#738).
      await wideStay(`${WIDE.organiserSplitTrip}-organiser`, { attends: false });
      await wideStay(`${WIDE.organiserSplitTrip}-child`, {
        attends: true,
        parentBookingId: `${WIDE.organiserSplitTrip}-organiser`,
      });
      await wideTrip(WIDE.organiserSplitTrip, false);
      // 4. On the split child of a joiner's booking.
      await wideStay(`${WIDE.joinSplitTrip}-organiser`, { attends: false });
      await wideStay(`${WIDE.joinSplitTrip}-joiner`, { attends: false, ownerId: IDS.joinerMember });
      await wideStay(`${WIDE.joinSplitTrip}-child`, {
        attends: true,
        ownerId: IDS.joinerMember,
        parentBookingId: `${WIDE.joinSplitTrip}-joiner`,
      });
      await wideTrip(WIDE.joinSplitTrip, true);
      // Not reached: a cancelled stay, a stay that ended before today, and a trip
      // the member has no booking in.
      await wideStay(`${WIDE.cancelledTrip}-organiser`, { attends: true, status: "CANCELLED" });
      await wideTrip(WIDE.cancelledTrip, false);
      await wideStay(`${WIDE.finishedTrip}-organiser`, {
        attends: true,
        checkIn: new Date("2026-06-20"),
        checkOut: new Date("2026-06-22"),
      });
      await wideTrip(WIDE.finishedTrip, false);
      await wideStay(`${WIDE.unrelatedTrip}-organiser`, { attends: false });
      await wideTrip(WIDE.unrelatedTrip, false);

      const moved = await writerB.$transaction((tx) =>
        memberFanout.invalidateMemberGroupTripCover(WIDE.member, today, tx, "member-standing-fanout"),
      );
      const revisions = Object.fromEntries(
        (
          await observer.groupBooking.findMany({
            where: { id: { in: [IDS.group, ...WIDE_TRIP_IDS] } },
            select: { id: true, coverageInvalidationRevision: true },
          })
        ).map((row) => [row.id, row.coverageInvalidationRevision]),
      );
      expect(moved).toBe(4);
      expect(revisions).toEqual({
        [IDS.group]: 0,
        [WIDE.organiserTrip]: 1,
        [WIDE.joinTrip]: 1,
        [WIDE.organiserSplitTrip]: 1,
        [WIDE.joinSplitTrip]: 1,
        [WIDE.cancelledTrip]: 0,
        [WIDE.finishedTrip]: 0,
        [WIDE.unrelatedTrip]: 0,
      });
    });

    it("leaves the stamp behind when a truncation waits for an evaluation holding the trip key", async () => {
      // Evaluation first: pause it inside its transaction once it holds the key.
      const held = deferred();
      const release = deferred();
      const evaluation = writerA.$transaction(async (tx) => {
        await locks.lockHostingCoverageGroup(tx, IDS.group);
        held.resolve();
        await release.promise;
        // Re-entrant on the same session: the evaluator's own acquisition passes.
        return review.reconcileAdultMemberHostingReview(IDS.joinerBooking, tx as never, {
          enforcement: "REVIEW_ONLY",
        });
      });
      await held.promise;

      // A truncating fan-out (old or new colour) holds the same key while it
      // writes its audit row, so it waits.
      const fanout = writerB.$transaction(async (tx) => {
        await locks.lockHostingCoverageGroup(tx, IDS.group);
        await truncationAudit(tx);
      });
      await waitForClientToBlock("race-5239-writer-b");
      release.resolve();
      await evaluation;
      await fanout;

      expect(await revision()).toBe(1);
      expect(
        await kioskSays(),
        "INV-HOST-045: the evaluation read revision 0; the bump that followed it must leave it unverifiable",
      ).toEqual({ status: "STALE", nights: [], scopes: [] });
    });

    it("refuses an evaluation while a truncating fan-out holds the key, then stamps the new revision", async () => {
      const held = deferred();
      const release = deferred();
      const fanout = writerB.$transaction(async (tx) => {
        await locks.lockHostingCoverageGroup(tx, IDS.group);
        await truncationAudit(tx);
        held.resolve();
        await release.promise;
      });
      await held.promise;

      await expect(
        evaluateJoiner(writerA),
        "the trip key is fail-fast: an evaluation never reads under an uncommitted bump",
      ).rejects.toMatchObject({ code: HOSTING_COVERAGE_RETRY_CODE });

      release.resolve();
      await fanout;
      expect((await evaluateJoiner(writerA)).action).toBe("opened");
      expect(await kioskSays()).toMatchObject({ status: "EVALUATED" });
      expect(
        storedReview.readStoredGroupTripCoverFreshness(
          (
            await observer.booking.findUniqueOrThrow({
              where: { id: IDS.joinerBooking },
              select: { adultMemberHostingReview: true },
            })
          ).adultMemberHostingReview,
        ),
      ).toEqual({ groupBookingId: IDS.group, revision: 1 });
    });
  },
);
