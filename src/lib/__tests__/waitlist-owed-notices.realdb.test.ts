/**
 * Real-PostgreSQL proof of #5433's waitlist pull request (WL-1, WL-2) and of
 * owner decision D2: a waitlist offer's notices and an offer-expired email are
 * owed from the commit until sent; a sweep that sends the offer email restarts
 * the window, under lock(1) and the lodge key, and a lost claim sends nothing;
 * no offer-expired email goes for an offer the member was never told about,
 * and the officers are alerted once about it instead (owner decision D5).
 *
 * Each case runs the REAL offer pass, expiry, restart, delivery and sweep
 * against the real `OwedNotice`, `Booking` and `EmailLog` tables and the real
 * email core. A "stop between the commit and the send" is a case that commits
 * exactly what the offer pass (or the expiry) commits, markers included, and
 * then delivers nothing. The races with the expiry job are forced: a third
 * transaction holds lock(1) while both sides queue behind it in a known order
 * (`pg_blocking_pids`), then lets them go.
 *
 * Ordinary Vitest runs skip the whole file. It runs in CI's `realdb-all` job on
 * the guarded, disposable loopback PostgreSQL the race harness provisions
 * (#1881), and owns and cleans its own `race-5433w-` rows: each case has its own
 * booking, owner and nights (in 2033, which no other suite uses), and asserts
 * on its own rows only; `expireStaleOffers` is database-wide, so its counts are
 * never asserted. No provider is called: the installation is declared
 * non-production, so the email core records each message and withholds it
 * (an offer email so withheld counts as told), and the officers' "not sent"
 * alert's result is read as a live site's (the double below).
 *
 * Round 2 adds: a send that returns without reaching the member (a suppressed
 * address, recorded `BOUNCED`; a placeholder address, recorded nowhere) counts
 * as not told, and the officers hear once; a suppressed address gets no
 * restart; a replayable `FAILED` offer email is retired once the offer is over.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EMAIL_RETRY_MAX_ATTEMPTS } from "@/lib/email/retry-selection";
import { PLACEHOLDER_CONTACT_EMAIL_DOMAIN } from "@/lib/placeholder-contact-email";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, untilBlockedChain } from "./support/race-lock-waits";
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
// The real message renderer, made to throw while `outage.down` is set: a send
// that fails before its EmailLog row exists (#5433 review C).
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
// The real "Waitlist email not sent" alert, with its result read as the live
// site would give it. On this copy the core withholds every admin copy, and
// `sendAdminAlertTo` counts a non-production withhold as not delivered, so a
// once-only claim would be deferred for a day and its marker kept, which no
// live site does when an officer is opted in. The alert's EmailLog rows are
// the real ones; only the count of copies an officer has is moved.
vi.mock("@/lib/email/admin-alerts-waitlist-notice-unsent", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email/admin-alerts-waitlist-notice-unsent");
  return {
    ...real,
    sendAdminWaitlistNoticeUnsentAlert: vi.fn(async (...args: Parameters<typeof real.sendAdminWaitlistNoticeUnsentAlert>) => {
      const result = await real.sendAdminWaitlistNoticeUnsentAlert(...args);
      return result.recipients > 0 ? { ...result, sent: result.sent + result.notDelivered, notDelivered: 0 } : result;
    }),
  };
});
// The real senders, wrapped so a case can count and filter their calls.
vi.mock("@/lib/email", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email");
  return {
    ...real,
    sendWaitlistOfferEmail: vi.fn(real.sendWaitlistOfferEmail),
    sendWaitlistOfferExpiredEmail: vi.fn(real.sendWaitlistOfferExpiredEmail),
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const LODGE_ID = "race-5433w-lodge";
/** The lodge a cross-lodge offer is made at (review A); it prices the case's nights. */
const OFFERED_LODGE_ID = "race-5433w-lodge-b";
const OFFERED_SEASON_ID = "race-5433w-season";
const HOUR = 60 * 60 * 1000;
const WINDOW_MS = 48 * HOUR;

/** One case's own owner, booking and nights. */
function caseIds(tag: string, stayDay: number) {
  const checkIn = new Date(Date.UTC(2033, 4, stayDay));
  return {
    ownerId: `race-5433w-owner-${tag}`,
    bookingId: `race-5433w-${tag}`,
    checkIn,
    checkOut: new Date(checkIn.getTime() + 2 * 86_400_000),
  };
}
type CaseIds = ReturnType<typeof caseIds>;

const CASES = {
  offer: caseIds("offer", 1),
  rollback: caseIds("rbk", 4),
  recovered: caseIds("rec", 7),
  recorded: caseIds("rcd", 10),
  confirmed: caseIds("cnf", 13),
  expired: caseIds("exp", 16),
  reoffered: caseIds("reo", 19),
  expiryFirst: caseIds("exf", 22),
  restartFirst: caseIds("rsf", 25),
  neverTold: caseIds("ntl", 28),
  told: caseIds("tld", 1 + 31),
  lapseRecovered: caseIds("lrc", 4 + 31),
  alreadyAlerted: caseIds("aal", 7 + 31),
  crossLodge: caseIds("xlc", 10 + 31),
  retrying: caseIds("rty", 13 + 31),
  exhausted: caseIds("exh", 16 + 31),
  bounced: caseIds("bnc", 19 + 31),
  lapseFailed: caseIds("lfl", 22 + 31),
  resend: caseIds("rsn", 25 + 31),
  // Its stay begins on the frozen "today", so its check-in date has begun at
  // the club. Seeded on those dates: a booking's dates cannot move away from
  // its guests' stay ranges (round 1's CI failure, a CHECK violation).
  floor: { ...caseIds("flr", 28 + 31), checkIn: new Date("2026-07-01T00:00:00.000Z"), checkOut: new Date("2026-07-03T00:00:00.000Z") },
  suppressedAtOffer: caseIds("sup", 31 + 31),
  placeholderAtOffer: caseIds("plh", 34 + 31),
  suppressedAtSweep: caseIds("sps", 37 + 31),
  movedOnRetired: caseIds("mvr", 40 + 31),
};

/** A case's owner's address: a walk-in placeholder for the one case about it (round 2, item 2). */
const ownerEmail = (ids: CaseIds) =>
  ids === CASES.placeholderAtOffer ? `${ids.ownerId}@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}` : `${ids.ownerId}@example.test`;
/** The cases whose owner's address is on the SES suppression list (round 2, items 2 and 6). */
const SUPPRESSED = [CASES.suppressedAtOffer, CASES.suppressedAtSweep];

const ADMIN_ID = "race-5433w-admin";
const ADMIN_EMAIL = "race-5433w-admin@example.test";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let waitlist: typeof import("@/lib/waitlist");
let notices: typeof import("@/lib/waitlist-offer-notices");
let expiredNotice: typeof import("@/lib/waitlist-offer-expired-notice");
let restartWaitlistOfferWindow: (typeof import("@/lib/waitlist-offer-window-restart"))["restartWaitlistOfferWindow"];
let drainOwedNotices: (typeof import("@/lib/owed-notice/drain"))["drainOwedNotices"];
let email: typeof import("@/lib/email");
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "a waitlist offer's notices are owed until sent, and its window restarts from the real send (D2) - real PostgreSQL (#5433)",
  { timeout: 90_000 },
  () => {
    async function deleteCaseRows(ids: CaseIds) {
      // A cancelled cross-lodge entry may carry money rows whose keys restrict its delete.
      await releaseBookingFinancialHistoryForTeardown(prisma, [ids.bookingId]);
      await prisma.emailLog.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: ids.bookingId } } });
      await prisma.owedNotice.deleteMany({ where: { subjectId: ids.bookingId } });
      await prisma.auditLog.deleteMany({ where: { targetId: ids.bookingId } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bookingWaitlistAlternateLodge.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.booking.deleteMany({ where: { id: ids.bookingId } });
    }

    /**
     * The cross-lodge confirm's replacement booking (review A), at the offered
     * lodge, owned by the case's member, with every row a confirmed booking
     * can carry whose key restricts its delete (`Booking.memberId` among them,
     * so this runs before any member is deleted). A row this does not know of
     * fails the teardown, naming the booking, rather than leaving the booking
     * and its owner behind for the next run to trip over.
     */
    async function deleteReplacementBookings() {
      const ids = (
        await prisma.booking.findMany({ where: { lodgeId: OFFERED_LODGE_ID, memberId: CASES.crossLodge.ownerId }, select: { id: true } })
      ).map((row) => row.id);
      if (ids.length === 0) return;
      const where = { bookingId: { in: ids } };
      try {
        await releaseBookingFinancialHistoryForTeardown(prisma, ids);
        const paymentIds = (await prisma.payment.findMany({ where, select: { id: true } })).map((row) => row.id);
        await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
        await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
        await prisma.payment.deleteMany({ where });
        await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
        await prisma.emailLog.deleteMany({ where });
        await prisma.owedNotice.deleteMany({ where: { subjectId: { in: ids } } });
        await prisma.bookingModification.deleteMany({ where });
        await prisma.bookingEvent.deleteMany({ where });
        await prisma.bedAllocation.deleteMany({ where });
        await prisma.bookingGuest.deleteMany({ where });
        await prisma.booking.deleteMany({ where: { id: { in: ids } } });
      } catch (err) {
        throw new Error(`Could not delete the cross-lodge replacement booking(s) ${ids.join(", ")}`, { cause: err });
      }
    }

    async function deleteFixtures() {
      // Bookings first: `Booking.memberId` and `Booking.lodgeId` restrict a delete of either.
      await deleteReplacementBookings();
      for (const ids of Object.values(CASES)) await deleteCaseRows(ids);
      await prisma.emailLog.deleteMany({ where: { to: ADMIN_EMAIL } });
      await prisma.emailSuppression.deleteMany({ where: { email: { in: SUPPRESSED.map(ownerEmail) } } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN_ID } });
      await prisma.member.deleteMany({ where: { id: ADMIN_ID } });
      await prisma.member.deleteMany({ where: { id: { in: Object.values(CASES).map((ids) => ids.ownerId) } } });
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: OFFERED_SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: OFFERED_SEASON_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: { in: [LODGE_ID, OFFERED_LODGE_ID] } } });
      await prisma.lodge.deleteMany({ where: { id: { in: [LODGE_ID, OFFERED_LODGE_ID] } } });
    }

    async function setCapacity(capacity: number) {
      await prisma.lodgeSettings.upsert({
        where: { id: LODGE_ID },
        create: { id: LODGE_ID, lodgeId: LODGE_ID, capacity },
        update: { capacity },
      });
    }

    async function seedWaitlisted(ids: CaseIds) {
      await deleteCaseRows(ids);
      await prisma.booking.create({
        data: {
          id: ids.bookingId,
          memberId: ids.ownerId,
          lodgeId: LODGE_ID,
          checkIn: ids.checkIn,
          checkOut: ids.checkOut,
          status: "WAITLISTED",
          createdAt: new Date("2026-05-01T09:00:00.000Z"),
          totalPriceCents: 10_000,
          finalPriceCents: 10_000,
          guests: {
            create: [{ firstName: "Guest", lastName: ids.bookingId, ageTier: "ADULT", isMember: false, stayStart: ids.checkIn, stayEnd: ids.checkOut, priceCents: 10_000 }],
          },
        },
      });
    }

    /**
     * What the offer pass commits for an offer made at `offeredAt`, markers
     * included, and nothing after: as if the job stopped before its sends.
     */
    async function commitOfferThenStop(ids: CaseIds, offeredAt: Date) {
      await seedWaitlisted(ids);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await tx.booking.update({
          where: { id: ids.bookingId },
          data: { status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date(offeredAt.getTime() + WINDOW_MS) },
        });
        await notices.recordWaitlistOfferNoticesOwed(tx, { bookingId: ids.bookingId, offeredAt, position: 1 });
      });
    }

    const memberMarkerId = (ids: CaseIds, offeredAt: Date) => `waitlist-offer-member:${ids.bookingId}:${offeredAt.getTime()}`;
    const offerEmailId = (ids: CaseIds, offeredAt: Date) => `email:waitlist-offer:${ids.bookingId}:${offeredAt.getTime()}`;
    const memberDeliverer = () => [notices.WAITLIST_OFFER_NOTICE_DELIVERERS[0]!];

    function readBooking(ids: CaseIds) {
      return prisma.booking.findUniqueOrThrow({
        where: { id: ids.bookingId },
        select: { status: true, waitlistOfferedAt: true, waitlistOfferExpiresAt: true },
      });
    }

    async function rows(ids: CaseIds) {
      return {
        offerEmails: await prisma.emailLog.findMany({ where: { bookingId: ids.bookingId, templateName: "waitlist-offer" }, select: { id: true } }),
        expiredEmails: await prisma.emailLog.findMany({ where: { bookingId: ids.bookingId, templateName: "waitlist-offer-expired" }, select: { id: true } }),
        markers: await prisma.owedNotice.findMany({ where: { subjectId: ids.bookingId }, select: { id: true } }),
      };
    }

    /** The officers' "Waitlist email not sent" alerts about this case's member. */
    const unsentAlertsFor = (ids: CaseIds) =>
      prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-waitlist-notice-unsent", subject: { contains: ids.bookingId } } });

    /** The officers' routine "Waitlist Offer" alerts about this case's member. */
    const routineOfferAlertsFor = (ids: CaseIds) =>
      prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-waitlist-offer", subject: { contains: ids.bookingId } } });

    /** What the offer email's row holds now, for the fields the told rule and the retry cron read. */
    const offerEmailRowAfter = (ids: CaseIds, offeredAt: Date) =>
      prisma.emailLog.findUnique({
        where: { id: offerEmailId(ids, offeredAt) },
        select: { status: true, attempts: true, htmlBody: true, bookingRetryHtmlBody: true },
      });

    const offerSendsFor = (ids: CaseIds) =>
      vi.mocked(email.sendWaitlistOfferEmail).mock.calls.filter(([context]) => context.bookingId === ids.bookingId);

    /** A transaction holding lock(1) until released, and its backend id. */
    async function holdLock1() {
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let reportPid: (pid: number) => void = () => {};
      const pid = new Promise<number>((resolve) => (reportPid = resolve));
      const held = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          reportPid(await backendPid(tx));
          await released;
        },
        { maxWait: 30_000, timeout: 120_000 },
      );
      return { pid: await pid, release, held };
    }

    /** Until `count` backends wait behind the holder. */
    async function untilWaiting(holderPid: number, count: number) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ((await untilBlockedChain(prisma, holderPid, 1)).length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${count} backends never queued behind the lock(1) holder`);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "waitlist owed notices proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      waitlist = await import("@/lib/waitlist");
      notices = await import("@/lib/waitlist-offer-notices");
      expiredNotice = await import("@/lib/waitlist-offer-expired-notice");
      ({ restartWaitlistOfferWindow } = await import("@/lib/waitlist-offer-window-restart"));
      ({ drainOwedNotices } = await import("@/lib/owed-notice/drain"));
      email = await import("@/lib/email");

      await deleteFixtures();
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5433 waitlist lodge", slug: LODGE_ID, active: true } });
      // A Full Admin: covers the bookings area, and waitlist offer alerts are on by default.
      await prisma.member.create({
        data: { id: ADMIN_ID, email: ADMIN_EMAIL, passwordHash: "not-a-real-password", firstName: "Officer", lastName: "Proof", ageTier: "ADULT", canLogin: true, role: "ADMIN" },
      });
      await prisma.memberAccessRole.create({ data: { memberId: ADMIN_ID, role: "ADMIN" } });
      for (const ids of Object.values(CASES)) {
        await prisma.member.create({
          data: { id: ids.ownerId, email: ownerEmail(ids), passwordHash: "not-a-real-password", firstName: "Ada", lastName: ids.bookingId, ageTier: "ADULT", canLogin: true },
        });
      }
      // As SES feedback leaves an address it may no longer be sent to.
      for (const ids of SUPPRESSED) {
        await prisma.emailSuppression.create({
          data: { email: ownerEmail(ids), reason: "BOUNCE", suppressedAt: new Date(Date.now() - 24 * HOUR), lastEventType: "Bounce", lastBounceType: "Permanent" },
        });
      }
    }, 90_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      outage.down = false;
      vi.mocked(email.sendWaitlistOfferEmail).mockClear();
      vi.mocked(email.sendWaitlistOfferExpiredEmail).mockClear();
      // Capacity 0 unless a case sets it: a re-offer pass after a lapse offers nothing.
      await setCapacity(0);
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

    it("an offer commits its two markers, and the attempt right after the commit sends the offer email once with the offer's own window and clears them", async () => {
      const ids = CASES.offer;
      await seedWaitlisted(ids);
      await setCapacity(10);

      const result = await waitlist.processWaitlistForDates({ checkIn: ids.checkIn, checkOut: ids.checkOut, lodgeId: LODGE_ID }, CLUB_FORMAT_TEST);

      expect(result.offeredBookingId).toBe(ids.bookingId);
      const booking = await readBooking(ids);
      expect(booking.status).toBe("WAITLIST_OFFERED");
      const offeredAt = booking.waitlistOfferedAt!;
      expect(booking.waitlistOfferExpiresAt!.getTime() - offeredAt.getTime()).toBe(WINDOW_MS);
      expect(await rows(ids)).toEqual({ offerEmails: [{ id: offerEmailId(ids, offeredAt) }], expiredEmails: [], markers: [] });
      expect(offerSendsFor(ids)[0]![6]).toEqual(booking.waitlistOfferExpiresAt);
    });

    it("leaves no marker when the transaction that records them rolls back", async () => {
      const ids = CASES.rollback;
      await seedWaitlisted(ids);
      const at = new Date(Date.now() - HOUR);
      await expect(
        prisma.$transaction(async (tx) => {
          await notices.recordWaitlistOfferNoticesOwed(tx, { bookingId: ids.bookingId, offeredAt: at, position: 1 });
          await expiredNotice.recordWaitlistLapseNoticesOwed(tx, [
            { bookingId: ids.bookingId, expiredAt: at },
            { bookingId: ids.bookingId, expiredAt: new Date(at.getTime() + 1), untoldOfferedAt: at },
          ]);
          throw new Error("the change's transaction failed after its markers");
        }),
      ).rejects.toThrow("failed after its markers");
      expect((await rows(ids)).markers).toEqual([]);
    });

    it("recovers an offer whose first attempt never started: the sweep restarts the window from its send and sends the offer email exactly once, stating that deadline", async () => {
      const ids = CASES.recovered;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      expect((await rows(ids)).markers).toHaveLength(2);

      const before = Date.now();
      await drainOwedNotices(new Date(), { deliverers: notices.WAITLIST_OFFER_NOTICE_DELIVERERS });
      const after = Date.now();

      const booking = await readBooking(ids);
      expect(booking.status).toBe("WAITLIST_OFFERED");
      // The offer is the same offer: its identity is untouched.
      expect(booking.waitlistOfferedAt).toEqual(offeredAt);
      const expiresAt = booking.waitlistOfferExpiresAt!.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + WINDOW_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + WINDOW_MS);
      // The email states the deadline now in force.
      expect(offerSendsFor(ids)).toHaveLength(1);
      expect((offerSendsFor(ids)[0]![6] as Date).getTime()).toBe(expiresAt);
      expect(await rows(ids)).toEqual({ offerEmails: [{ id: offerEmailId(ids, offeredAt) }], expiredEmails: [], markers: [] });

      // A later sweep finds nothing owed and moves nothing.
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: notices.WAITLIST_OFFER_NOTICE_DELIVERERS });
      expect(offerSendsFor(ids)).toHaveLength(1);
      expect((await readBooking(ids)).waitlistOfferExpiresAt!.getTime()).toBe(expiresAt);
    });

    it("neither restarts nor sends again when the offer email was recorded and the job stopped before the marker cleared", async () => {
      const ids = CASES.recorded;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await prisma.emailLog.create({
        data: { id: offerEmailId(ids, offeredAt), to: `${ids.ownerId}@example.test`, subject: "Spot Available!", templateName: "waitlist-offer", status: "SENT", bookingId: ids.bookingId },
      });

      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(new Date(offeredAt.getTime() + WINDOW_MS));
      expect((await rows(ids)).markers.map((marker) => marker.id)).not.toContain(memberMarkerId(ids, offeredAt));
    });

    it.each([
      ["confirmed", "confirmed", { status: "PAYMENT_PENDING", waitlistOfferedAt: null, waitlistOfferExpiresAt: null }],
      ["expired", "expired", { status: "WAITLISTED", waitlistOfferedAt: null, waitlistOfferExpiresAt: null }],
      ["re-offered", "reoffered", { waitlistOfferedAt: new Date(Date.now() - HOUR) }],
    ] as const)("clears a %s offer's notices without sending them or restarting anything", async (_label, key, change) => {
      const ids = CASES[key];
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await prisma.booking.update({ where: { id: ids.bookingId }, data: change });
      const moved = await readBooking(ids);

      await drainOwedNotices(new Date(), { deliverers: notices.WAITLIST_OFFER_NOTICE_DELIVERERS });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect(await readBooking(ids)).toEqual(moved);
      expect(await rows(ids)).toEqual({ offerEmails: [], expiredEmails: [], markers: [] });
      // The restart itself, handed the stale offer, claims nothing.
      await expect(
        restartWaitlistOfferWindow({ bookingId: ids.bookingId, offeredAt, zone: "Pacific/Auckland" as never, now: new Date() }),
      ).resolves.toMatchObject({ kind: "moved-on" });
      expect(await readBooking(ids)).toEqual(moved);
    });

    it("expiry first: when the expiry job takes lock(1) before the restart, the offer lapses, no offer email and no offer-expired email go, and the restart changes nothing", async () => {
      const ids = CASES.expiryFirst;
      const offeredAt = new Date(Date.now() - WINDOW_MS - 2 * HOUR); // its window ran out two hours ago
      await commitOfferThenStop(ids, offeredAt);

      const holder = await holdLock1();
      const expiry = waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await untilWaiting(holder.pid, 1);
      const sweep = drainOwedNotices(new Date(), { deliverers: memberDeliverer() });
      await untilWaiting(holder.pid, 2);
      holder.release();
      await Promise.all([holder.held, expiry, sweep]);

      const booking = await readBooking(ids);
      expect(booking.status).toBe("WAITLISTED");
      expect(offerSendsFor(ids)).toHaveLength(0);
      // Never told: no offer-expired email, and none owed; the officers are alerted once instead (D5).
      expect(await rows(ids)).toEqual({ offerEmails: [], expiredEmails: [], markers: [{ id: expect.stringMatching(/^waitlist-offer-officers:/) }] });
      expect(await unsentAlertsFor(ids)).toBe(1);
    });

    it("restart first: when the restart takes lock(1) before the expiry job, the offer gets a full window, its email states it, and the expiry leaves it alone", async () => {
      const ids = CASES.restartFirst;
      const offeredAt = new Date(Date.now() - WINDOW_MS - 2 * HOUR);
      await commitOfferThenStop(ids, offeredAt);

      const holder = await holdLock1();
      const before = Date.now();
      const sweep = drainOwedNotices(new Date(), { deliverers: memberDeliverer() });
      await untilWaiting(holder.pid, 1);
      const expiry = waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await untilWaiting(holder.pid, 2);
      holder.release();
      await Promise.all([holder.held, sweep, expiry]);

      const booking = await readBooking(ids);
      expect(booking.status).toBe("WAITLIST_OFFERED");
      expect(booking.waitlistOfferExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + WINDOW_MS);
      expect(offerSendsFor(ids)).toHaveLength(1);
      expect(offerSendsFor(ids)[0]![6]).toEqual(booking.waitlistOfferExpiresAt);
      const recorded = await rows(ids);
      expect(recorded.offerEmails).toEqual([{ id: offerEmailId(ids, offeredAt) }]);
      expect(recorded.expiredEmails).toEqual([]);
    });

    it("sends no offer-expired email for a lapsed offer the member was never told about but alerts the officers once (D2, D5), and the email for an offer they were", async () => {
      const offeredAt = new Date(Date.now() - WINDOW_MS - 2 * HOUR);
      await commitOfferThenStop(CASES.neverTold, offeredAt);
      await commitOfferThenStop(CASES.told, offeredAt);
      // The told member's offer email went, and its notices were cleared.
      await prisma.emailLog.create({
        data: { id: offerEmailId(CASES.told, offeredAt), to: `${CASES.told.ownerId}@example.test`, subject: "Spot Available!", templateName: "waitlist-offer", status: "SENT", bookingId: CASES.told.bookingId },
      });
      await prisma.owedNotice.deleteMany({ where: { subjectId: CASES.told.bookingId } });

      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);

      for (const ids of [CASES.neverTold, CASES.told]) expect((await readBooking(ids)).status).toBe("WAITLISTED");
      expect((await rows(CASES.neverTold)).expiredEmails).toEqual([]);
      expect((await rows(CASES.neverTold)).markers.map((marker) => marker.id)).not.toContainEqual(expect.stringMatching(/^waitlist-offer-(expired|lapsed-untold):/));
      expect(await unsentAlertsFor(CASES.neverTold)).toBe(1);
      expect(await unsentAlertsFor(CASES.told)).toBe(0);
      const told = await rows(CASES.told);
      expect(told.expiredEmails).toHaveLength(1);
      expect(told.expiredEmails[0]!.id).toMatch(new RegExp(`^email:waitlist-offer-expired:${CASES.told.bookingId}:\\d+$`));
      expect(told.markers).toEqual([]);
    });

    it("recovers an offer-expired email whose first attempt never started, once", async () => {
      const ids = CASES.lapseRecovered;
      await seedWaitlisted(ids);
      const expiredAt = new Date(Date.now() - 2 * HOUR);
      await prisma.$transaction((tx) => expiredNotice.recordWaitlistLapseNoticesOwed(tx, [{ bookingId: ids.bookingId, expiredAt }]));

      await drainOwedNotices(new Date(), { deliverers: expiredNotice.WAITLIST_LAPSE_NOTICE_DELIVERERS });
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: expiredNotice.WAITLIST_LAPSE_NOTICE_DELIVERERS });

      expect(await rows(ids)).toEqual({
        offerEmails: [],
        expiredEmails: [{ id: `email:waitlist-offer-expired:${ids.bookingId}:${expiredAt.getTime()}` }],
        markers: [],
      });
      expect(vi.mocked(email.sendWaitlistOfferExpiredEmail).mock.calls.filter(([context]) => context.bookingId === ids.bookingId)).toHaveLength(1);
    });

    it("alerts the officers once per offer: a never-told lapse after its email's past-cut-off alert sends no second alert (D5)", async () => {
      const ids = CASES.alreadyAlerted;
      const offeredAt = new Date(Date.now() - WINDOW_MS - 2 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      // The offer email's past-cut-off step already ran for this offer: its
      // once-ever claim and its sent stamp are kept and its marker cleared,
      // the email unsent. (A claim with no sent stamp, older than the wait, is
      // a holder that died before sending, which the takeover sends for.)
      const memberMarker = notices.waitlistOfferMemberMarker(ids.bookingId, offeredAt);
      for (const key of [`owed-notice-past-cutoff:${memberMarker.id}`, `owed-notice-past-cutoff-sent:${memberMarker.id}`]) {
        await prisma.alertCooldown.create({ data: { key, lastAlertedAt: new Date(Date.now() - HOUR) } });
      }
      await prisma.owedNotice.deleteMany({ where: { id: memberMarker.id } });

      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: expiredNotice.WAITLIST_LAPSE_NOTICE_DELIVERERS });

      expect((await readBooking(ids)).status).toBe("WAITLISTED");
      expect(await unsentAlertsFor(ids)).toBe(0);
      const recorded = await rows(ids);
      expect(recorded.expiredEmails).toEqual([]);
      expect(recorded.markers.map((marker) => marker.id)).not.toContainEqual(expect.stringMatching(/^waitlist-offer-lapsed-untold:/));
    });

    /** An offer email's row, as the email core or the retry cron would leave it. */
    async function offerEmailRow(ids: CaseIds, offeredAt: Date, status: "FAILED" | "BOUNCED", attempts: number) {
      await prisma.emailLog.create({
        data: {
          id: offerEmailId(ids, offeredAt),
          to: `${ids.ownerId}@example.test`,
          subject: "Spot Available!",
          templateName: "waitlist-offer",
          status,
          attempts,
          bookingId: ids.bookingId,
          bookingRetryHtmlBody: "<p>the offer</p>",
        },
      });
    }

    it("leaves a FAILED offer email the retry cron can still replay to the cron: no restart, no send, the notice kept (review B)", async () => {
      const ids = CASES.retrying;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await offerEmailRow(ids, offeredAt, "FAILED", 1);

      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(new Date(offeredAt.getTime() + WINDOW_MS));
      expect((await rows(ids)).markers.map((marker) => marker.id)).toContain(memberMarkerId(ids, offeredAt));
      expect(await unsentAlertsFor(ids)).toBe(0);
    });

    it.each([
      ["an exhausted FAILED", "exhausted", "FAILED", 3],
      ["a BOUNCED", "bounced", "BOUNCED", 1],
    ] as const)("alerts the officers once for %s offer email instead of clearing it silently, restarting and sending nothing (review B)", async (_label, key, status, attempts) => {
      const ids = CASES[key];
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await offerEmailRow(ids, offeredAt, status, attempts);

      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(new Date(offeredAt.getTime() + WINDOW_MS));
      expect(await unsentAlertsFor(ids)).toBe(1);
      expect((await rows(ids)).markers.map((marker) => marker.id)).not.toContain(memberMarkerId(ids, offeredAt));
    });

    it("counts a lapsed offer whose email row is FAILED as never told, with no marker or claim left: no offer-expired email, one officers' alert, and the row retired so the cron never replays a dead offer (review B, D5; round 2, items 2 and 4)", async () => {
      const ids = CASES.lapseFailed;
      const offeredAt = new Date(Date.now() - WINDOW_MS - 2 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await offerEmailRow(ids, offeredAt, "FAILED", 2);
      // The row decides, whatever else remains: no owed notice and no claim.
      await prisma.owedNotice.deleteMany({ where: { subjectId: ids.bookingId } });

      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);

      expect((await readBooking(ids)).status).toBe("WAITLISTED");
      expect((await rows(ids)).expiredEmails).toEqual([]);
      expect(await unsentAlertsFor(ids)).toBe(1);
      expect(await offerEmailRowAfter(ids, offeredAt)).toEqual({ status: "FAILED", attempts: EMAIL_RETRY_MAX_ATTEMPTS, htmlBody: null, bookingRetryHtmlBody: null });
    });

    it("retires a replayable FAILED offer email when the sweep finds the offer over, and sends and restarts nothing (round 2, item 4)", async () => {
      const ids = CASES.movedOnRetired;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);
      await offerEmailRow(ids, offeredAt, "FAILED", 1);
      await prisma.booking.update({ where: { id: ids.bookingId }, data: { status: "PAYMENT_PENDING", waitlistOfferedAt: null, waitlistOfferExpiresAt: null } });

      await drainOwedNotices(new Date(), { deliverers: notices.WAITLIST_OFFER_NOTICE_DELIVERERS });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await rows(ids)).markers).toEqual([]);
      expect(await offerEmailRowAfter(ids, offeredAt)).toEqual({ status: "FAILED", attempts: EMAIL_RETRY_MAX_ATTEMPTS, htmlBody: null, bookingRetryHtmlBody: null });
      expect(await unsentAlertsFor(ids)).toBe(0);
    });

    it("counts an offer email the core recorded but never sent, to a suppressed address, as not told: the officers hear once, the routine offer alert goes saying so, and its lapse alerts nobody again (round 2, item 2)", async () => {
      const ids = CASES.suppressedAtOffer;
      await seedWaitlisted(ids);
      await setCapacity(10);

      await waitlist.processWaitlistForDates({ checkIn: ids.checkIn, checkOut: ids.checkOut, lodgeId: LODGE_ID }, CLUB_FORMAT_TEST);

      const offeredAt = (await readBooking(ids)).waitlistOfferedAt!;
      // The send returned without throwing; its row says it reached nobody.
      expect(offerSendsFor(ids)).toHaveLength(1);
      expect(await offerEmailRowAfter(ids, offeredAt)).toMatchObject({ status: "BOUNCED" });
      expect(await unsentAlertsFor(ids)).toBe(1);
      // The routine alert still goes, as for every offer before #5433, saying the email did not reach them.
      expect(await routineOfferAlertsFor(ids)).toBe(1);
      expect((await rows(ids)).markers).toEqual([]);

      // Its lapse: never told, so no offer-expired email, and the shared claim holds the officers to one alert.
      await setCapacity(0);
      await prisma.booking.update({ where: { id: ids.bookingId }, data: { waitlistOfferExpiresAt: new Date(Date.now() - HOUR) } });
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: expiredNotice.WAITLIST_LAPSE_NOTICE_DELIVERERS });

      expect((await readBooking(ids)).status).toBe("WAITLISTED");
      expect((await rows(ids)).expiredEmails).toEqual([]);
      expect(await unsentAlertsFor(ids)).toBe(1);
    });

    it("tells the officers once, and sends the routine offer alert once without looping, for an owner with only a placeholder address, whose send records no row at all (round 2, item 2)", async () => {
      const ids = CASES.placeholderAtOffer;
      await seedWaitlisted(ids);
      await setCapacity(10);

      await waitlist.processWaitlistForDates({ checkIn: ids.checkIn, checkOut: ids.checkOut, lodgeId: LODGE_ID }, CLUB_FORMAT_TEST);
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: notices.WAITLIST_OFFER_NOTICE_DELIVERERS });

      expect((await readBooking(ids)).status).toBe("WAITLIST_OFFERED");
      expect(await rows(ids)).toEqual({ offerEmails: [], expiredEmails: [], markers: [] });
      expect(await unsentAlertsFor(ids)).toBe(1);
      // The routine alert still goes, as for every offer before #5433, saying the email did not reach them.
      expect(await routineOfferAlertsFor(ids)).toBe(1);
    });

    it("restarts nothing and sends nothing when the owner's address is suppressed, and tells the officers once instead (round 2, item 6)", async () => {
      const ids = CASES.suppressedAtSweep;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);

      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(new Date(offeredAt.getTime() + WINDOW_MS));
      expect(await prisma.auditLog.count({ where: { targetId: ids.bookingId, action: "waitlist.offer_window_restarted" } })).toBe(0);
      expect(await unsentAlertsFor(ids)).toBe(1);
      expect((await rows(ids)).markers.map((marker) => marker.id)).not.toContain(memberMarkerId(ids, offeredAt));
    });

    it("restarts a window once: a send that fails again leaves the restarted deadline, which a later sweep states unmoved (review C)", async () => {
      const ids = CASES.resend;
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await commitOfferThenStop(ids, offeredAt);

      outage.down = true;
      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });
      outage.down = false;
      const restarted = (await readBooking(ids)).waitlistOfferExpiresAt!;
      expect(restarted.getTime()).toBeGreaterThan(offeredAt.getTime() + WINDOW_MS);
      expect((await rows(ids)).offerEmails).toEqual([]);

      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: memberDeliverer() });

      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(restarted);
      expect((await rows(ids)).offerEmails).toEqual([{ id: offerEmailId(ids, offeredAt) }]);
      expect(offerSendsFor(ids).at(-1)![6]).toEqual(restarted);
      expect(await prisma.auditLog.count({ where: { targetId: ids.bookingId, action: "waitlist.offer_window_restarted" } })).toBe(1);
    });

    it("sends no offer email, and alerts the officers instead, when less than the waitlist wait would remain (review D)", async () => {
      const ids = CASES.floor;
      // Its original deadline is ten minutes away, and its check-in date has
      // begun at the club, so a restart has nothing to give.
      const offeredAt = new Date(Date.now() - WINDOW_MS + 10 * 60 * 1000);
      await seedWaitlisted(ids);
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: ids.bookingId },
          data: { status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date(offeredAt.getTime() + WINDOW_MS) },
        });
        await notices.recordWaitlistOfferNoticesOwed(tx, { bookingId: ids.bookingId, offeredAt, position: 1 });
      });

      await drainOwedNotices(new Date(), { deliverers: memberDeliverer() });

      expect(offerSendsFor(ids)).toHaveLength(0);
      expect((await readBooking(ids)).waitlistOfferExpiresAt).toEqual(new Date(offeredAt.getTime() + WINDOW_MS));
      expect(await unsentAlertsFor(ids)).toBe(1);
    });

    it("a window restart between the cross-lodge confirm's first and last phases is the same offer: the confirm completes and strands no entry (review A)", async () => {
      const ids = CASES.crossLodge;
      // What the confirm checks, and why this fixture passes each (re-read for
      // round 2, item 1): the owner has no lodge-access rows, so may book every
      // active lodge; the paid-up-adult rule runs only in NON_MEMBER_PRICING
      // mode, and the migrated database's lockout mode is HARD_BLOCK, which
      // refuses at the request routes, not in this library call; no
      // adult-member hosting policy exists club-wide or for the offered
      // lodge (the table is created empty), so a party of one non-member adult
      // is not held for hosting; and the offered lodge prices the nights from
      // this season's non-member rates, the same quote the offer pass made.
      await prisma.lodge.upsert({
        where: { id: OFFERED_LODGE_ID },
        create: { id: OFFERED_LODGE_ID, name: "Race 5433 offered lodge", slug: OFFERED_LODGE_ID, active: true },
        update: { active: true },
      });
      await prisma.lodgeSettings.upsert({
        where: { id: OFFERED_LODGE_ID },
        create: { id: OFFERED_LODGE_ID, lodgeId: OFFERED_LODGE_ID, capacity: 10 },
        update: { capacity: 10 },
      });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.upsert({
        where: { id: OFFERED_SEASON_ID },
        create: {
          id: OFFERED_SEASON_ID,
          name: "Race 5433 cross-lodge",
          type: "WINTER",
          startDate: new Date(ids.checkIn.getTime() - 5 * 86_400_000),
          endDate: new Date(ids.checkOut.getTime() + 5 * 86_400_000),
          active: true,
          lodgeId: OFFERED_LODGE_ID,
          membershipTypeRates: {
            create: [
              { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: 5000 },
              { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: 5000 },
            ],
          },
        },
        update: {},
      });
      await seedWaitlisted(ids);
      await prisma.bookingWaitlistAlternateLodge.create({ data: { bookingId: ids.bookingId, lodgeId: OFFERED_LODGE_ID } });

      // The offer pass makes a cross-lodge offer at the offered lodge, at its quote.
      const pass = await waitlist.processWaitlistForDates({ checkIn: ids.checkIn, checkOut: ids.checkOut, lodgeId: OFFERED_LODGE_ID }, CLUB_FORMAT_TEST);
      expect(pass.offeredBookingId).toBe(ids.bookingId);
      // Three hours on, so a restart from now moves its deadline.
      const offeredAt = new Date(Date.now() - 3 * HOUR);
      await prisma.booking.update({
        where: { id: ids.bookingId },
        data: { waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date(offeredAt.getTime() + WINDOW_MS) },
      });

      // Forced order: the confirm's first phase, then the restart, then its later phases.
      const holder = await holdLock1();
      const confirm = waitlist.confirmWaitlistOffer(ids.bookingId, ids.ownerId, CLUB_FORMAT_TEST);
      await untilWaiting(holder.pid, 1);
      const restart = restartWaitlistOfferWindow({ bookingId: ids.bookingId, offeredAt, zone: "Pacific/Auckland" as never, now: new Date() });
      await untilWaiting(holder.pid, 2);
      holder.release();
      const [, confirmed, restarted] = await Promise.all([holder.held, confirm, restart]);

      expect(restarted).toMatchObject({ kind: "in-force", restarted: true });
      expect(confirmed).toMatchObject({ success: true });
      expect(confirmed.newBookingId).toBeTruthy();
      // Not stranded: the entry was cancelled and linked, not left a live offer.
      const entry = await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, select: { status: true, waitlistOfferedAt: true } });
      expect(entry).toEqual({ status: "CANCELLED", waitlistOfferedAt: null });
    });
  },
);
