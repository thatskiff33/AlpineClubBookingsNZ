/**
 * Real-PostgreSQL proof of #5407 item 13: a bump's notices are owed from the
 * commit until sent, and the member's email is recorded once per bump.
 *
 * Each case commits a bump the way the confirm-pending cron does (the guarded
 * PENDING -> CANCELLED claim and `recordBumpNoticesOwed` in one transaction),
 * then runs the REAL post-commit delivery and sweep against the real
 * `OwedNotice` table (#5433; and `AlertCooldown`, where a release before
 * #5433 left its markers), the real email core and its `EmailLog` rows, and
 * the real officer audience:
 *
 * - right after the commit the email core's render throws (as one on a stored
 *   override can), so the member's email throws and every officer's copy
 *   fails before its `EmailLog` row exists; both markers stay, the member's
 *   is sent by the next sweep and the officers' a day later, a further sweep
 *   adds nothing, and a member marker left standing after its send (a crash
 *   before the clear) finds the row recorded and sends nothing;
 * - a settlement marker (a `CANCELLED` event that cancels nothing) after the
 *   bump does not stop the notice; a genuine cancel after it does;
 * - a bump whose transaction rolls back leaves no marker;
 * - two sweeps at the same moment send each notice once;
 * - a legacy `AlertCooldown` marker and an `OwedNotice` marker for the same
 *   bump (#5433's blue-green overlap) record the member's email once.
 *
 * The cron's own wiring (that it writes the markers inside its transaction and
 * delivers after the commit) is proved in cron-confirm-pending.test.ts.
 *
 * Ordinary Vitest runs skip the whole file. It runs in CI's `realdb-all` job
 * on the guarded, disposable loopback PostgreSQL the race harness provisions
 * (#1881), and owns and cleans its own `race-5407-` fixtures: each case has
 * its own booking, stay and owner, and asserts only on its own rows. No
 * provider is called: the installation is declared non-production, so the
 * email core records each message and withholds it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { listingTogether } from "./support/owed-notice-listing-barrier";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
// A full factory, never `importOriginal`: the real module imports next-auth,
// which does not resolve under plain Node ESM. Nothing this suite runs calls it.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: false })),
  requireSession: vi.fn(async () => ({ ok: false })),
}));
// The real message renderer, made to throw while `outage.down` is set: the email
// core renders before it writes a copy's EmailLog row, so this is a failure
// before the row, as a render that throws on a stored override would be.
const outage = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/email-message-renderer", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email-message-renderer");
  return {
    ...real,
    prepareEmailMessage: async (...args: Parameters<typeof real.prepareEmailMessage>) => {
      if (outage.down) throw new Error("render failed");
      return real.prepareEmailMessage(...args);
    },
  };
});
// The real senders, wrapped so a case can count and filter their calls.
vi.mock("@/lib/email", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email");
  return {
    ...real,
    sendBookingBumpedEmail: vi.fn(real.sendBookingBumpedEmail),
    sendAdminBookingBumpedAlert: vi.fn(real.sendAdminBookingBumpedAlert),
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ADMIN_ID = "race-5407-admin";
const ADMIN_EMAIL = "race-5407-admin@example.test";
const LODGE_ID = "race-5407-lodge";
const WAIT_PAST = 2 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * One case's own owner, booking and stay. The booking id starts with a tag of
 * its own because the alert's subject carries the first eight characters
 * (`formatBookingReference`), which is how a case finds its officer rows.
 */
function caseIds(tag: string, stayDay: number) {
  const checkIn = new Date(Date.UTC(2027, 7, stayDay));
  return {
    ownerId: `race-5407-owner-${tag}`,
    ownerEmail: `race-5407-owner-${tag}@example.test`,
    bookingId: `b5407${tag}-race-booking`,
    guestId: `race-5407-guest-${tag}`,
    checkIn,
    checkOut: new Date(checkIn.getTime() + 2 * 86_400_000),
  };
}
type CaseIds = ReturnType<typeof caseIds>;

const CASES = {
  threw: caseIds("thr", 2),
  rollback: caseIds("rbk", 10),
  race: caseIds("rce", 18),
  marker: caseIds("stl", 26),
  cancelled: caseIds("cxl", 6),
  both: caseIds("bth", 14),
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let owed: typeof import("@/lib/booking-bump-notice-owed");
let drainOwedNotices: (typeof import("@/lib/owed-notice/drain"))["drainOwedNotices"];
let owedNoticeTableSource: (typeof import("@/lib/owed-notice/deliver"))["owedNoticeTableSource"];
let email: typeof import("@/lib/email");
let formatBookingReference: (typeof import("@/lib/booking-reference"))["formatBookingReference"];
let SETTLEMENT_MARKER_EVENT_REASONS: (typeof import("@/lib/manual-settlement-reversal-event"))["SETTLEMENT_MARKER_EVENT_REASONS"];
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "a bump's notices are owed until sent, and the member's email is recorded once - real PostgreSQL (#5407)",
  { timeout: 60_000 },
  () => {
    async function deleteCaseRows(ids: CaseIds) {
      await prisma.emailLog.deleteMany({
        where: { OR: [{ bookingId: ids.bookingId }, { to: ADMIN_EMAIL, subject: { contains: formatBookingReference(ids.bookingId) } }] },
      });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: ids.bookingId } } });
      await prisma.owedNotice.deleteMany({ where: { subjectId: ids.bookingId } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.booking.deleteMany({ where: { id: ids.bookingId } });
    }

    async function deleteFixtures() {
      for (const ids of Object.values(CASES)) await deleteCaseRows(ids);
      await prisma.emailLog.deleteMany({ where: { to: ADMIN_EMAIL } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [ADMIN_ID, ...Object.values(CASES).map((ids) => ids.ownerId)] } } });
      await prisma.member.deleteMany({ where: { id: { in: [ADMIN_ID, ...Object.values(CASES).map((ids) => ids.ownerId)] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    }

    async function seedPendingBooking(ids: CaseIds) {
      await prisma.booking.create({
        data: {
          id: ids.bookingId,
          memberId: ids.ownerId,
          lodgeId: LODGE_ID,
          checkIn: ids.checkIn,
          checkOut: ids.checkOut,
          status: "PENDING",
          totalPriceCents: 10_000,
          finalPriceCents: 10_000,
          nonMemberHoldUntil: new Date("2026-06-30T00:00:00.000Z"),
        },
      });
      await prisma.bookingGuest.create({
        data: {
          id: ids.guestId, bookingId: ids.bookingId, firstName: "Guest", lastName: "Proof", ageTier: "ADULT",
          stayStart: ids.checkIn, stayEnd: ids.checkOut, priceCents: 10_000,
        },
      });
    }

    /**
     * The cron's bump, as far as the notices care: the guarded claim and the
     * markers, in one transaction. Returns the owed descriptor the delivery
     * claims with, as the cron's `bumped` resolution carries it.
     */
    async function commitBump(ids: CaseIds, failAfterMarkers = false) {
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.booking.updateMany({
          where: { id: ids.bookingId, status: "PENDING" },
          data: { status: "CANCELLED", nonMemberHoldUntil: null },
        });
        expect(claimed.count).toBe(1);
        const recorded = await owed.recordBumpNoticesOwed(tx, { bookingId: ids.bookingId, flagged: false });
        if (failAfterMarkers) throw new Error("the bump's transaction failed after its markers");
        return recorded;
      });
    }

    function readBooking(ids: CaseIds) {
      return prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, select: owed.BUMP_NOTICE_BOOKING_SELECT });
    }

    /** This case's notices as recorded: the member's rows, the officer's rows, and the markers standing. */
    async function recorded(ids: CaseIds) {
      const reference = formatBookingReference(ids.bookingId);
      return {
        memberRows: await prisma.emailLog.findMany({
          where: { bookingId: ids.bookingId, templateName: "booking-bumped" },
          select: { id: true },
        }),
        officerRows: await prisma.emailLog.count({
          where: { to: ADMIN_EMAIL, templateName: "admin-booking-bumped", subject: { contains: reference } },
        }),
        markers:
          (await prisma.owedNotice.count({ where: { subjectId: ids.bookingId } })) +
          (await prisma.alertCooldown.count({ where: { key: { contains: ids.bookingId } } })),
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "bump notice owed proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      owed = await import("@/lib/booking-bump-notice-owed");
      ({ drainOwedNotices } = await import("@/lib/owed-notice/drain"));
      ({ owedNoticeTableSource } = await import("@/lib/owed-notice/deliver"));
      email = await import("@/lib/email");
      ({ formatBookingReference } = await import("@/lib/booking-reference"));
      ({ SETTLEMENT_MARKER_EVENT_REASONS } = await import("@/lib/manual-settlement-reversal-event"));

      await deleteFixtures();
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5407 Lodge", slug: "race-5407" } });
      await prisma.member.create({
        data: { id: ADMIN_ID, email: ADMIN_EMAIL, passwordHash: "not-a-real-password", firstName: "Officer", lastName: "Proof", ageTier: "ADULT", canLogin: true, role: "ADMIN" },
      });
      // A Full Admin: covers the bookings area, and the bumped alert is on by default.
      await prisma.memberAccessRole.create({ data: { memberId: ADMIN_ID, role: "ADMIN" } });
      for (const ids of Object.values(CASES)) {
        await prisma.member.create({
          data: { id: ids.ownerId, email: ids.ownerEmail, passwordHash: "not-a-real-password", firstName: "Ada", lastName: "Proof", ageTier: "ADULT", canLogin: true, role: "USER" },
        });
      }
    }, 60_000);

    beforeEach(() => {
      resetStripeRaceHooks();
      outage.down = false;
      vi.mocked(email.sendBookingBumpedEmail).mockClear();
      vi.mocked(email.sendAdminBookingBumpedAlert).mockClear();
    });

    afterAll(async () => {
      try {
        resetStripeRaceHooks();
        if (typeof prisma !== "undefined") {
          try {
            await deleteFixtures();
          } finally {
            await prisma.$disconnect().catch(() => {});
          }
        }
      } finally {
        harnessRole?.restore();
      }
    });

    it("sends both notices from the sweep once when they failed before any row right after the commit, and records the member's email once", async () => {
      const ids = CASES.threw;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const bumped = await commitBump(ids);
      const bumpedAt = bumped.bumpedAt;
      expect((await recorded(ids)).markers).toBe(2);

      // Right after the commit the email core's render throws: the member's
      // email throws, and every officer's copy fails before its row.
      outage.down = true;
      await owed.deliverBumpNotices(await readBooking(ids), bumped);
      outage.down = false;
      expect(vi.mocked(email.sendAdminBookingBumpedAlert)).toHaveBeenCalledTimes(1);
      expect(await recorded(ids)).toEqual({ memberRows: [], officerRows: 0, markers: 2 });

      // The next sweep sends the member's email; the officers' alert, which
      // reached nobody, is held a day.
      await drainOwedNotices(new Date(bumpedAt.getTime() + WAIT_PAST));
      const memberLogId = `email:booking-bumped:${owed.bumpNoticeIdempotencyKey(ids.bookingId, bumpedAt)}`;
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 0, markers: 1 });

      // A day later the sweep sends the officers' alert, once.
      await drainOwedNotices(new Date(bumpedAt.getTime() + DAY + WAIT_PAST));
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });

      // A further sweep finds nothing owed.
      await drainOwedNotices(new Date(bumpedAt.getTime() + 2 * DAY));
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });

      // A member marker still standing after its send (a crash before the
      // clear): the sweep's send finds the row recorded and adds none.
      const memberId = owed.bumpNoticeId("member", ids.bookingId, bumpedAt, false);
      await prisma.owedNotice.create({
        data: { id: memberId, kind: "booking-bump-member", subjectId: ids.bookingId, eventAt: bumpedAt, variant: "b", stampedAt: bumpedAt },
      });
      const sendsBefore = vi.mocked(email.sendBookingBumpedEmail).mock.calls.length;
      await drainOwedNotices(new Date(bumpedAt.getTime() + 3 * DAY));
      expect(vi.mocked(email.sendBookingBumpedEmail).mock.calls.length).toBe(sendsBefore + 1);
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });
    });

    it("leaves no marker when the bump's transaction rolls back", async () => {
      const ids = CASES.rollback;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);

      await expect(commitBump(ids, true)).rejects.toThrow("failed after its markers");

      expect((await recorded(ids)).markers).toBe(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, select: { status: true } })).status).toBe("PENDING");
    });

    it("sends each notice once when two sweeps reach its markers at the same moment", async () => {
      const ids = CASES.race;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const { bumpedAt } = await commitBump(ids);

      const sweepAt = new Date(bumpedAt.getTime() + WAIT_PAST);
      // Each drain lists a kind's markers only once both have, so they truly overlap.
      const sources = [listingTogether(owedNoticeTableSource), owed.legacyBumpMarkerSource];
      const results = await Promise.all([drainOwedNotices(sweepAt, { sources }), drainOwedNotices(sweepAt, { sources })]);
      // Both runs listed both of this case's markers: run one after the other,
      // the second would have found none of them.
      for (const result of results) expect(result.checked).toBeGreaterThanOrEqual(2);

      const alertsForThisBooking = vi
        .mocked(email.sendAdminBookingBumpedAlert)
        .mock.calls.filter(([alert]) => alert.bookingReference === formatBookingReference(ids.bookingId));
      expect(alertsForThisBooking).toHaveLength(1);
      // The member's send itself ran once: the claim, not only the event key, kept the second sweep out.
      const memberSendsForThisBooking = vi
        .mocked(email.sendBookingBumpedEmail)
        .mock.calls.filter(([context]) => context.bookingId === ids.bookingId);
      expect(memberSendsForThisBooking).toHaveLength(1);
      expect((await recorded(ids)).memberRows).toHaveLength(1);
      expect(await recorded(ids)).toMatchObject({ officerRows: 1, markers: 0 });
    });

    // #5433 blue-green: the release before #5433 wrote its bump markers to
    // AlertCooldown. A bump is committed by one release only, so this pair is
    // the worst case, not the usual one: both stores hold the member's marker.
    it("records the member's email once when a legacy AlertCooldown marker and an OwedNotice marker name the same bump", async () => {
      const ids = CASES.both;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const { bumpedAt } = await commitBump(ids);
      await prisma.owedNotice.delete({ where: { id: owed.bumpNoticeId("officers", ids.bookingId, bumpedAt, false) } });
      await prisma.alertCooldown.create({
        data: { key: owed.legacyBumpNoticeKey("member", ids.bookingId, bumpedAt, false), lastAlertedAt: bumpedAt },
      });
      expect((await recorded(ids)).markers).toBe(2);

      await drainOwedNotices(new Date(bumpedAt.getTime() + WAIT_PAST));

      // Both markers were sent (each store's sweep found its own), with one event key.
      const memberSends = vi
        .mocked(email.sendBookingBumpedEmail)
        .mock.calls.filter(([context]) => context.bookingId === ids.bookingId);
      expect(memberSends).toHaveLength(2);
      expect(memberSends[0]![0].idempotencyKey).toBe(memberSends[1]![0].idempotencyKey);
      const memberLogId = `email:booking-bumped:${owed.bumpNoticeIdempotencyKey(ids.bookingId, bumpedAt)}`;
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 0, markers: 0 });
    });

    /** Commit a bump whose member email is owed alone, then record `reason` as a CANCELLED event after it. */
    async function bumpThenCancelledEvent(ids: CaseIds, reason: string | null) {
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const { bumpedAt } = await commitBump(ids);
      await prisma.owedNotice.delete({ where: { id: owed.bumpNoticeId("officers", ids.bookingId, bumpedAt, false) } });
      await prisma.bookingEvent.create({
        data: { bookingId: ids.bookingId, type: "CANCELLED", reason, occurredAt: new Date(bumpedAt.getTime() + 60_000) },
      });
      return bumpedAt;
    }

    it("still sends the member's email when the only later CANCELLED event is a settlement marker", async () => {
      const ids = CASES.marker;
      const bumpedAt = await bumpThenCancelledEvent(ids, SETTLEMENT_MARKER_EVENT_REASONS[0]!);

      await drainOwedNotices(new Date(bumpedAt.getTime() + WAIT_PAST));

      expect((await recorded(ids)).memberRows).toHaveLength(1);
      expect((await recorded(ids)).markers).toBe(0);
    });

    it("clears the member's notice unsent when a genuine cancel with no reason was recorded after the bump", async () => {
      const ids = CASES.cancelled;
      const bumpedAt = await bumpThenCancelledEvent(ids, null);

      await drainOwedNotices(new Date(bumpedAt.getTime() + WAIT_PAST));

      expect(await recorded(ids)).toEqual({ memberRows: [], officerRows: 0, markers: 0 });
    });
  },
);
