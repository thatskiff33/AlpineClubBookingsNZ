/**
 * Real-PostgreSQL proof of #5433's waitlist pull request (WL-1, WL-2) and of
 * owner decision D2: a waitlist offer's notices and an offer-expired email are
 * owed from the commit until sent; a sweep that sends the offer email restarts
 * the window, under lock(1) and the lodge key, and a lost claim sends nothing;
 * and no offer-expired email goes for an offer the member was never told about.
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
 * non-production, so the email core records each message and withholds it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
};

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
      await prisma.emailLog.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: ids.bookingId } } });
      await prisma.owedNotice.deleteMany({ where: { subjectId: ids.bookingId } });
      await prisma.auditLog.deleteMany({ where: { targetId: ids.bookingId } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.booking.deleteMany({ where: { id: ids.bookingId } });
    }

    async function deleteFixtures() {
      for (const ids of Object.values(CASES)) await deleteCaseRows(ids);
      await prisma.member.deleteMany({ where: { id: { in: Object.values(CASES).map((ids) => ids.ownerId) } } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
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

    const offerSendsFor = (ids: CaseIds) =>
      vi.mocked(email.sendWaitlistOfferEmail).mock.calls.filter(([context]) => context.bookingId === ids.bookingId);

    /** A transaction holding lock(1) until released, and its backend id. */
    async function holdLock1() {
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let reportPid = (_pid: number) => {};
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
      for (const ids of Object.values(CASES)) {
        await prisma.member.create({
          data: { id: ids.ownerId, email: `${ids.ownerId}@example.test`, passwordHash: "not-a-real-password", firstName: "Ada", lastName: ids.bookingId, ageTier: "ADULT", canLogin: true },
        });
      }
    }, 90_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
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
          await expiredNotice.recordWaitlistOfferExpiredNoticesOwed(tx, [{ bookingId: ids.bookingId, expiredAt: at }]);
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
      await expect(restartWaitlistOfferWindow({ bookingId: ids.bookingId, offeredAt, zone: "Pacific/Auckland" as never })).resolves.toMatchObject({ kind: "moved-on" });
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
      // Never told: no offer-expired email, and none owed.
      expect(await rows(ids)).toEqual({ offerEmails: [], expiredEmails: [], markers: [{ id: expect.stringMatching(/^waitlist-offer-officers:/) }] });
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

    it("sends no offer-expired email for a lapsed offer the member was never told about, and one for an offer they were (D2)", async () => {
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
      expect((await rows(CASES.neverTold)).markers.map((marker) => marker.id)).not.toContainEqual(expect.stringMatching(/^waitlist-offer-expired:/));
      const told = await rows(CASES.told);
      expect(told.expiredEmails).toHaveLength(1);
      expect(told.expiredEmails[0]!.id).toMatch(new RegExp(`^email:waitlist-offer-expired:${CASES.told.bookingId}:\\d+$`));
      expect(told.markers).toEqual([]);
    });

    it("recovers an offer-expired email whose first attempt never started, once", async () => {
      const ids = CASES.lapseRecovered;
      await seedWaitlisted(ids);
      const expiredAt = new Date(Date.now() - 2 * HOUR);
      await prisma.$transaction((tx) => expiredNotice.recordWaitlistOfferExpiredNoticesOwed(tx, [{ bookingId: ids.bookingId, expiredAt }]));

      await drainOwedNotices(new Date(), { deliverers: [expiredNotice.WAITLIST_OFFER_EXPIRED_NOTICE_DELIVERER] });
      await drainOwedNotices(new Date(Date.now() + HOUR), { deliverers: [expiredNotice.WAITLIST_OFFER_EXPIRED_NOTICE_DELIVERER] });

      expect(await rows(ids)).toEqual({
        offerEmails: [],
        expiredEmails: [{ id: `email:waitlist-offer-expired:${ids.bookingId}:${expiredAt.getTime()}` }],
        markers: [],
      });
      expect(vi.mocked(email.sendWaitlistOfferExpiredEmail).mock.calls.filter(([context]) => context.bookingId === ids.bookingId)).toHaveLength(1);
    });
  },
);
