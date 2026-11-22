/**
 * Real-PostgreSQL proof of #5407 item 13: a bump's notices are owed from the
 * commit until sent, and the member's email is recorded once per bump.
 *
 * Each case commits a bump the way the confirm-pending cron does (the guarded
 * PENDING -> CANCELLED claim and `recordBumpNoticesOwed` in one transaction),
 * then runs the REAL post-commit delivery and sweep against the real
 * `AlertCooldown` table, the real email core and its `EmailLog` rows, and the
 * real officer audience:
 *
 * - both notices throw right after the commit; the sweep sends each once, a
 *   second sweep adds nothing, and a member marker left standing after its
 *   send (a crash before the clear) finds the row recorded and sends nothing;
 * - a bump whose transaction rolls back leaves no marker;
 * - two sweeps at the same moment send the officers' alert once.
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
// The real senders, wrapped so a case can make one attempt throw first.
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
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let owed: typeof import("@/lib/booking-bump-notice-owed");
let email: typeof import("@/lib/email");
let formatBookingReference: (typeof import("@/lib/booking-reference"))["formatBookingReference"];
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

    /** The cron's bump, as far as the notices care: the guarded claim and the markers, in one transaction. */
    async function commitBump(ids: CaseIds, bumpedAt: Date, failAfterMarkers = false) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.booking.updateMany({
          where: { id: ids.bookingId, status: "PENDING" },
          data: { status: "CANCELLED", nonMemberHoldUntil: null },
        });
        expect(claimed.count).toBe(1);
        await owed.recordBumpNoticesOwed(tx, { bookingId: ids.bookingId, bumpedAt, flagged: false });
        if (failAfterMarkers) throw new Error("the bump's transaction failed after its markers");
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
        markers: await prisma.alertCooldown.count({ where: { key: { contains: ids.bookingId } } }),
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "bump notice owed proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      owed = await import("@/lib/booking-bump-notice-owed");
      email = await import("@/lib/email");
      ({ formatBookingReference } = await import("@/lib/booking-reference"));

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

    it("sends both notices from the sweep once when they threw right after the commit, and records the member's email once", async () => {
      const ids = CASES.threw;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const bumpedAt = new Date();
      await commitBump(ids, bumpedAt);
      expect((await recorded(ids)).markers).toBe(2);

      // Right after the commit, both sends throw before writing anything.
      vi.mocked(email.sendBookingBumpedEmail).mockRejectedValueOnce(new Error("SMTP down"));
      vi.mocked(email.sendAdminBookingBumpedAlert).mockRejectedValueOnce(new Error("SMTP down"));
      const booking = await readBooking(ids);
      await owed.deliverBumpNotice("member", booking, false, bumpedAt);
      await owed.deliverBumpNotice("officers", booking, false, bumpedAt);
      expect(await recorded(ids)).toEqual({ memberRows: [], officerRows: 0, markers: 2 });

      // A later run's sweep sends each, once.
      const firstSweep = await owed.drainOwedBumpNotices(new Date(bumpedAt.getTime() + WAIT_PAST));
      expect(firstSweep.delivered).toBeGreaterThanOrEqual(2);
      const memberLogId = `email:booking-bumped:${owed.bumpNoticeIdempotencyKey(ids.bookingId, bumpedAt)}`;
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });

      // A second sweep finds nothing owed.
      await owed.drainOwedBumpNotices(new Date(bumpedAt.getTime() + 2 * WAIT_PAST));
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });

      // A member marker still standing after its send (a crash before the
      // clear): the sweep's send finds the row recorded and adds none.
      const memberKey = owed.bumpNoticeOwedKey("member", ids.bookingId, bumpedAt, false);
      await prisma.alertCooldown.create({ data: { key: memberKey, lastAlertedAt: bumpedAt } });
      const sendsBefore = vi.mocked(email.sendBookingBumpedEmail).mock.calls.length;
      await owed.drainOwedBumpNotices(new Date(bumpedAt.getTime() + 3 * WAIT_PAST));
      expect(vi.mocked(email.sendBookingBumpedEmail).mock.calls.length).toBe(sendsBefore + 1);
      expect(await recorded(ids)).toEqual({ memberRows: [{ id: memberLogId }], officerRows: 1, markers: 0 });
    });

    it("leaves no marker when the bump's transaction rolls back", async () => {
      const ids = CASES.rollback;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);

      await expect(commitBump(ids, new Date(), true)).rejects.toThrow("failed after its markers");

      expect((await recorded(ids)).markers).toBe(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, select: { status: true } })).status).toBe("PENDING");
    });

    it("sends the officers' alert once when two sweeps reach its marker at the same moment", async () => {
      const ids = CASES.race;
      await deleteCaseRows(ids);
      await seedPendingBooking(ids);
      const bumpedAt = new Date();
      await commitBump(ids, bumpedAt);
      // Only the officers' marker is owed here; the member's was delivered.
      await prisma.alertCooldown.delete({ where: { key: owed.bumpNoticeOwedKey("member", ids.bookingId, bumpedAt, false) } });

      const sweepAt = new Date(bumpedAt.getTime() + WAIT_PAST);
      await Promise.all([owed.drainOwedBumpNotices(sweepAt), owed.drainOwedBumpNotices(sweepAt)]);

      const alertsForThisBooking = vi
        .mocked(email.sendAdminBookingBumpedAlert)
        .mock.calls.filter(([alert]) => alert.bookingReference === formatBookingReference(ids.bookingId));
      expect(alertsForThisBooking).toHaveLength(1);
      expect(await recorded(ids)).toEqual({ memberRows: [], officerRows: 1, markers: 0 });
    });
  },
);
