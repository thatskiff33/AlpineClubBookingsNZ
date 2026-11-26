/**
 * Real-PostgreSQL proof of #5433's fourth pull request: the rest of the
 * confirm-pending job's notices are owed until sent. For each kind, the marker
 * commits with the change in a real transaction and a rolled-back change
 * leaves none; the attempt right after the commit sends the notice and clears
 * the marker; and after a simulated stop between the commit and the send, the
 * sweep sends it exactly once, with the event key as the `EmailLog` id.
 *
 * Each case runs the REAL marker write inside a real transaction beside the
 * change it records (the zero-balance PAID claim, the hold-ended cancel, the
 * link mint under the lodge lock, the saved card's clear through the real
 * `retireAndEscalateUnusableSavedCard`), the real delivery, the real sweep and
 * the real email core. The job itself (`confirmPendingBookings`) is not run
 * here: it acts on every due PENDING booking in the database, and this
 * database is shared with the other real-database suites; its own
 * transactions are proved through the transaction double in
 * `cron-confirm-pending.test.ts`.
 *
 * Ordinary Vitest runs skip the whole file. It runs in CI's `realdb-all` job on
 * the guarded, disposable loopback PostgreSQL the race harness provisions
 * (#1881), and owns and cleans its own `race-5433d-` rows: each case has its
 * own owner and booking (stays in 2034, which no other suite uses), and its
 * sweeps read only its own markers. No provider is called: the installation is
 * declared non-production, so the email core records each message and
 * withholds it (a member notice so withheld counts as told), and the saved
 * card's detach at Stripe is the shared double's hook.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

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
// The real delivery right after the saved card's clear, made to return at once
// while `stop.on` is set: the process stopped between the commit and its sends.
const stop = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/saved-card-unusable-notices", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/saved-card-unusable-notices");
  return {
    ...real,
    deliverSavedCardUnusableNotices: vi.fn(async (...args: Parameters<typeof real.deliverSavedCardUnusableNotices>) =>
      stop.on ? undefined : real.deliverSavedCardUnusableNotices(...args),
    ),
  };
});
// The real "Booking email not sent" alert, with its result read as a live site
// would give it: on this copy the core withholds every admin copy, which the
// once-only claim would read as nobody reached (see the same double in
// `paid-booking-confirmation.realdb.test.ts`). The alert's EmailLog rows are real.
vi.mock("@/lib/email/admin-alerts-booking-notice-unsent", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email/admin-alerts-booking-notice-unsent");
  return {
    ...real,
    sendAdminBookingNoticeUnsentAlert: vi.fn(async (...args: Parameters<typeof real.sendAdminBookingNoticeUnsentAlert>) => {
      const result = await real.sendAdminBookingNoticeUnsentAlert(...args);
      return result.recipients > 0 ? { ...result, sent: result.sent + result.notDelivered, notDelivered: 0 } : result;
    }),
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5433d-";
const LODGE_ID = `${PREFIX}lodge`;
const ADMIN_ID = `${PREFIX}admin`;
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const PRICE_CENTS = 12_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WAIT_PAST = 31 * MINUTE;

/** One case's own owner, booking (and a parent for a split child), payment and nights. */
function caseIds(tag: string, checkIn: Date) {
  return {
    tag,
    ownerId: `${PREFIX}owner-${tag}`,
    ownerEmail: `${PREFIX}owner-${tag}@example.test`,
    bookingId: `${PREFIX}${tag}`,
    parentId: `${PREFIX}${tag}-parent`,
    paymentId: `${PREFIX}payment-${tag}`,
    checkIn,
    night2: new Date(checkIn.getTime() + DAY),
    checkOut: new Date(checkIn.getTime() + 2 * DAY),
  };
}
type CaseIds = ReturnType<typeof caseIds>;

const CASES = {
  zero: caseIds("zero", new Date("2034-04-01T00:00:00.000Z")),
  requestSent: caseIds("rqs", new Date("2034-04-05T00:00:00.000Z")),
  requestStopped: caseIds("rqx", new Date("2034-04-09T00:00:00.000Z")),
  requestBounced: caseIds("rqb", new Date("2034-04-13T00:00:00.000Z")),
  requestRollback: caseIds("rqr", new Date("2034-04-17T00:00:00.000Z")),
  splitStopped: caseIds("spx", new Date("2034-04-21T00:00:00.000Z")),
  linkSent: caseIds("lks", new Date("2034-04-25T00:00:00.000Z")),
  linkStopped: caseIds("lkx", new Date("2034-04-29T00:00:00.000Z")),
  cardSent: caseIds("crs", new Date("2034-05-03T00:00:00.000Z")),
  cardStopped: caseIds("crx", new Date("2034-05-07T00:00:00.000Z")),
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let holdEnded: typeof import("@/lib/hold-ended-cancellation-notices");
let linkNotice: typeof import("@/lib/split-guest-payment-link-notice");
let cardNotices: typeof import("@/lib/saved-card-unusable-notices");
let cardFailure: typeof import("@/lib/saved-card-charge-failure");
let paidOwed: typeof import("@/lib/paid-booking-confirmation-owed");
let paidNotice: typeof import("@/lib/paid-booking-confirmation-notice");
let drain: typeof import("@/lib/owed-notice/drain");
let deliver: typeof import("@/lib/owed-notice/deliver");
let harnessRole: { restore: () => void } | undefined;

/** Whether a marker is this suite's: its subject, or (the payment link, keyed by the link) its payload's booking. */
function isOurs(marker: { subjectId: string; payload: unknown } | null): boolean {
  if (!marker) return false;
  if (marker.subjectId.startsWith(PREFIX)) return true;
  const payload = marker.payload as { bookingId?: unknown } | null;
  return typeof payload?.bookingId === "string" && payload.bookingId.startsWith(PREFIX);
}

(RUN ? describe : describe.skip)(
  "the rest of the confirm-pending job's notices are owed until sent, and recovered exactly once - real PostgreSQL (#5433)",
  { timeout: 90_000 },
  () => {
    async function deleteCaseRows(ids: CaseIds) {
      const bookingIds = [ids.bookingId, ids.parentId];
      await prisma.owedNotice.deleteMany({ where: { subjectId: { in: bookingIds } } });
      await prisma.owedNotice.deleteMany({ where: { payload: { path: ["bookingId"], equals: ids.bookingId } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: ids.bookingId } } });
      await prisma.emailLog.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [...bookingIds, ids.paymentId] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...bookingIds, ids.paymentId] } } });
      await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: ids.ownerId } });
      await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await releaseBookingFinancialHistoryForTeardown(prisma, bookingIds);
      await prisma.paymentLink.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: { in: bookingIds } } } });
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: bookingIds } } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: bookingIds } } });
      // The child first: its parent key restricts the parent's delete.
      await prisma.booking.deleteMany({ where: { id: ids.bookingId } });
      await prisma.booking.deleteMany({ where: { id: ids.parentId } });
    }

    async function deleteFixtures() {
      for (const ids of Object.values(CASES)) await deleteCaseRows(ids);
      await prisma.emailLog.deleteMany({ where: { to: ADMIN_EMAIL } });
      // Any other officer in the shared database was sent the alerts too; their subjects name the owner.
      await prisma.emailLog.deleteMany({ where: { templateName: { startsWith: "admin-" }, subject: { contains: PREFIX } } });
      await prisma.emailLog.deleteMany({ where: { templateName: "admin-payment-failure", htmlBody: { contains: PREFIX } } });
      await prisma.emailSuppression.deleteMany({ where: { email: CASES.requestBounced.ownerEmail } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [ADMIN_ID, ...Object.values(CASES).map((ids) => ids.ownerId)] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    }

    /**
     * One booking of the case's own, with one guest whose two nights lie inside
     * its dates (the check constraint). `split` makes it a split guest portion:
     * non-member guests, a parent booking settled by Internet Banking.
     */
    async function seedBooking(
      ids: CaseIds,
      { status = "PENDING", priceCents = PRICE_CENTS, split = false }: { status?: "PENDING" | "CANCELLED"; priceCents?: number; split?: boolean } = {},
    ) {
      await deleteCaseRows(ids);
      const guest = (bookingTag: string, isMember: boolean) => ({
        firstName: "Ada",
        lastName: bookingTag,
        ageTier: "ADULT" as const,
        isMember,
        stayStart: ids.checkIn,
        stayEnd: ids.checkOut,
        priceCents,
        nights: {
          create: [
            { stayDate: ids.checkIn, priceCents: priceCents / 2, priceSource: "SOLD" as const },
            { stayDate: ids.night2, priceCents: priceCents / 2, priceSource: "SOLD" as const },
          ],
        },
      });
      if (split) {
        await prisma.booking.create({
          data: {
            id: ids.parentId,
            memberId: ids.ownerId,
            lodgeId: LODGE_ID,
            checkIn: ids.checkIn,
            checkOut: ids.checkOut,
            status: "CONFIRMED",
            totalPriceCents: priceCents,
            finalPriceCents: priceCents,
            capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
            capacityOverriddenByMemberId: ADMIN_ID,
            guests: { create: [guest(ids.parentId, true)] },
          },
        });
        await prisma.payment.create({ data: { bookingId: ids.parentId, amountCents: priceCents, source: "INTERNET_BANKING", status: "PENDING" } });
      }
      await prisma.booking.create({
        data: {
          id: ids.bookingId,
          memberId: ids.ownerId,
          lodgeId: LODGE_ID,
          checkIn: ids.checkIn,
          checkOut: ids.checkOut,
          status,
          totalPriceCents: priceCents,
          finalPriceCents: priceCents,
          capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
          capacityOverriddenByMemberId: ADMIN_ID,
          ...(split ? { parentBookingId: ids.parentId, hasNonMembers: true } : {}),
          guests: { create: [guest(ids.bookingId, !split)] },
        },
      });
    }

    /** A sweep of this pull request's kinds, reading only this suite's markers. */
    function sweep(now: Date) {
      return drain.drainOwedNotices(now, {
        deliverers: [
          ...holdEnded.HOLD_ENDED_NOTICE_DELIVERERS,
          ...linkNotice.SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS,
          ...cardNotices.SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS,
          ...paidNotice.PAID_CONFIRMATION_NOTICE_DELIVERERS,
        ] as readonly import("@/lib/owed-notice/deliver").OwedNoticeDeliverer[],
        sources: [
          {
            name: "OwedNotice (this suite's)",
            listDue: async (deliverer, at) => (await deliver.owedNoticeTableSource.listDue(deliverer, at)).filter((ref) => isOurs(ref.marker)),
          },
        ],
        job: "race-5433d-sweep",
      });
    }

    const markerKinds = async (ids: CaseIds) =>
      (
        await prisma.owedNotice.findMany({
          where: { OR: [{ subjectId: ids.bookingId }, { payload: { path: ["bookingId"], equals: ids.bookingId } }] },
          select: { kind: true },
        })
      )
        .map((row) => row.kind)
        .sort();

    const memberEmails = (ids: CaseIds, templateName: string) =>
      prisma.emailLog.findMany({ where: { bookingId: ids.bookingId, templateName }, select: { id: true, status: true }, orderBy: { createdAt: "asc" } });

    /** The hold-ended cancel as the job commits it: the guarded claim, then the markers as the last write. */
    function cancelHold(ids: CaseIds, ended: "request" | "split-guest", parentUnpaid: boolean | null = null, failAfter = false) {
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.booking.updateMany({ where: { id: ids.bookingId, status: "PENDING" }, data: { status: "CANCELLED", nonMemberHoldUntil: null } });
        expect(claimed.count).toBe(1);
        const owed = await holdEnded.recordHoldEndedNoticesOwed(tx, { ended, bookingId: ids.bookingId, parentUnpaid });
        if (failAfter) throw new Error("the cancel failed after its markers");
        return owed!;
      });
    }

    async function bookingForNotice(ids: CaseIds) {
      const { OWED_BOOKING_NOTICE_SELECT } = await import("@/lib/booking-notice-unsent-alert");
      return prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, select: OWED_BOOKING_NOTICE_SELECT });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "confirm-pending owed notices proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      holdEnded = await import("@/lib/hold-ended-cancellation-notices");
      linkNotice = await import("@/lib/split-guest-payment-link-notice");
      cardNotices = await import("@/lib/saved-card-unusable-notices");
      cardFailure = await import("@/lib/saved-card-charge-failure");
      paidOwed = await import("@/lib/paid-booking-confirmation-owed");
      paidNotice = await import("@/lib/paid-booking-confirmation-notice");
      drain = await import("@/lib/owed-notice/drain");
      deliver = await import("@/lib/owed-notice/deliver");

      await deleteFixtures();
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5433 confirm-pending lodge", slug: LODGE_ID, active: true } });
      // A Full Admin: covers the bookings area, and review-required alerts are on by default.
      await prisma.member.create({
        data: { id: ADMIN_ID, email: ADMIN_EMAIL, passwordHash: "not-a-real-password", firstName: "Officer", lastName: "Proof", ageTier: "ADULT", canLogin: true, role: "ADMIN" },
      });
      await prisma.memberAccessRole.create({ data: { memberId: ADMIN_ID, role: "ADMIN" } });
      for (const ids of Object.values(CASES)) {
        await prisma.member.create({
          data: { id: ids.ownerId, email: ids.ownerEmail, passwordHash: "not-a-real-password", firstName: "Ada", lastName: ids.bookingId, ageTier: "ADULT", canLogin: true },
        });
      }
      // As SES feedback leaves an address it may no longer be sent to.
      await prisma.emailSuppression.create({
        data: { email: CASES.requestBounced.ownerEmail, reason: "BOUNCE", suppressedAt: new Date(Date.now() - DAY), lastEventType: "Bounce", lastBounceType: "Permanent" },
      });
    }, 90_000);

    beforeEach(() => {
      resetStripeRaceHooks();
      stop.on = false;
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

    it("CP-1: the zero-balance PAID claim commits the confirmation's marker, and the delivery sends it once at its keyed row and clears it", async () => {
      const ids = CASES.zero;
      await seedBooking(ids, { priceCents: 0 });

      const marker = await prisma.$transaction(async (tx) => {
        const claimed = await tx.booking.updateMany({ where: { id: ids.bookingId, status: "PENDING" }, data: { status: "PAID", nonMemberHoldUntil: null } });
        expect(claimed.count).toBe(1);
        return paidOwed.recordPaidConfirmationOwedUnlessUnkeyable(tx, ids.bookingId);
      });
      expect(await markerKinds(ids)).toEqual(["booking-confirmed"]);

      await paidNotice.deliverPaidBookingConfirmation(marker!, CLUB_FORMAT_TEST, "race-5433d");

      expect(await markerKinds(ids)).toEqual([]);
      expect(await memberEmails(ids, "booking-confirmed")).toEqual([
        { id: `email:booking-confirmed:${ids.bookingId}:${marker!.eventAt.getTime()}`, status: "SKIPPED_NON_PRODUCTION" },
      ]);
    });

    it("CP-4: the cancel commits both markers, and the delivery sends the requester's notice at its keyed row and the officers' notice, clearing both", async () => {
      const ids = CASES.requestSent;
      await seedBooking(ids);
      const owed = await cancelHold(ids, "request");
      expect(await markerKinds(ids)).toEqual(["request-hold-cancelled-member", "request-hold-cancelled-officers"]);

      await holdEnded.deliverHoldEndedNotices(await bookingForNotice(ids), owed, CLUB_FORMAT_TEST, "race-5433d");

      expect(await markerKinds(ids)).toEqual([]);
      expect(await memberEmails(ids, "booking-request-payment-expired")).toEqual([
        { id: `email:booking-request-payment-expired:${ids.bookingId}:${owed.cancelledAt.getTime()}`, status: "SKIPPED_NON_PRODUCTION" },
      ]);
      expect(await prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-booking-request-hold-cancelled", subject: { contains: ids.bookingId } } })).toBe(1);
    });

    it("CP-4: a rolled-back cancel leaves no marker", async () => {
      const ids = CASES.requestRollback;
      await seedBooking(ids);

      await expect(cancelHold(ids, "request", null, true)).rejects.toThrow("failed after its markers");

      expect(await markerKinds(ids)).toEqual([]);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId } })).status).toBe("PENDING");
    });

    it("CP-4: after a stop between the commit and the sends, the sweep sends each notice exactly once, after its wait", async () => {
      const ids = CASES.requestStopped;
      await seedBooking(ids);
      const owed = await cancelHold(ids, "request");

      expect((await sweep(new Date(owed.cancelledAt.getTime() + 29 * MINUTE))).checked).toBe(0);
      expect(await sweep(new Date(owed.cancelledAt.getTime() + WAIT_PAST))).toMatchObject({ checked: 2, delivered: 2 });
      expect(await markerKinds(ids)).toEqual([]);
      expect(await memberEmails(ids, "booking-request-payment-expired")).toHaveLength(1);
      expect(await prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-booking-request-hold-cancelled", subject: { contains: ids.bookingId } } })).toBe(1);

      expect((await sweep(new Date(owed.cancelledAt.getTime() + DAY))).checked).toBe(0);
      expect(await memberEmails(ids, "booking-request-payment-expired")).toHaveLength(1);
    });

    it("CP-4: a requester's notice that does not reach them (a suppressed address, recorded BOUNCED) alerts the officers once and clears the marker", async () => {
      const ids = CASES.requestBounced;
      await seedBooking(ids);
      const owed = await cancelHold(ids, "request");

      await holdEnded.deliverHoldEndedNotices(await bookingForNotice(ids), owed, CLUB_FORMAT_TEST, "race-5433d");

      expect(await markerKinds(ids)).toEqual([]);
      expect((await memberEmails(ids, "booking-request-payment-expired")).map((row) => row.status)).toEqual(["BOUNCED"]);
      expect(await prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-booking-notice-unsent", subject: { contains: ids.bookingId } } })).toBe(1);
    });

    it("CP-5: the split guest cancel's payload survives the commit, and the sweep words the recovered member notice from it, once", async () => {
      const ids = CASES.splitStopped;
      await seedBooking(ids, { split: true });
      const owed = await cancelHold(ids, "split-guest", false);
      const stored = await prisma.owedNotice.findMany({ where: { subjectId: ids.bookingId }, select: { kind: true, payload: true }, orderBy: { kind: "asc" } });
      expect(stored).toEqual([
        { kind: "split-guest-cancelled-member", payload: { parentUnpaid: 0 } },
        { kind: "split-guest-cancelled-officers", payload: { parentUnpaid: 0 } },
      ]);

      expect(await sweep(new Date(owed.cancelledAt.getTime() + WAIT_PAST))).toMatchObject({ checked: 2, delivered: 2 });
      expect(await memberEmails(ids, "split-guest-portion-cancelled")).toEqual([
        { id: `email:split-guest-portion-cancelled:${ids.bookingId}:${owed.cancelledAt.getTime()}`, status: "SKIPPED_NON_PRODUCTION" },
      ]);
      expect((await sweep(new Date(owed.cancelledAt.getTime() + DAY))).checked).toBe(0);
    });

    /** The link mint as the job's extension commits it: under the lodge lock, the marker the last write. */
    async function mintLink(ids: CaseIds) {
      const { readClubTimeZoneOutsideRequest } = await import("@/lib/club-time-zone-runtime");
      const { acquireLodgeCapacityLock } = await import("@/lib/capacity");
      const { mintSplitGuestPaymentLinkIfAbsent } = await import("@/lib/payment-link-split-guest");
      const zone = await readClubTimeZoneOutsideRequest();
      return prisma.$transaction(async (tx) => {
        await acquireLodgeCapacityLock(tx, LODGE_ID);
        const minted = await mintSplitGuestPaymentLinkIfAbsent(tx, { id: ids.bookingId, checkIn: ids.checkIn }, zone);
        const marker = await linkNotice.recordSplitGuestPaymentLinkOwed(tx, { bookingId: ids.bookingId, paymentLinkId: minted!.paymentLinkId });
        return { minted: minted!, marker: marker! };
      });
    }

    it("CP-6: the mint commits a marker keyed by the link, holding no token; the delivery sends at the link's keyed row and, the email undelivered on this copy, revokes the link as before and clears the marker", async () => {
      const ids = CASES.linkSent;
      await seedBooking(ids, { split: true });
      const { minted, marker } = await mintLink(ids);
      const stored = await prisma.owedNotice.findUniqueOrThrow({ where: { id: marker.id } });
      expect(stored).toMatchObject({ kind: "split-guest-payment-link", subjectId: minted.paymentLinkId, payload: { bookingId: ids.bookingId } });
      expect(JSON.stringify(stored)).not.toContain(minted.token);

      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: ids.bookingId },
        include: { member: true, organisation: { select: { name: true, email: true } }, guests: true, payment: true },
      });
      await linkNotice.deliverSplitGuestPaymentLink(marker, { booking, link: minted, format: CLUB_FORMAT_TEST }, "race-5433d");

      expect(await markerKinds(ids)).toEqual([]);
      expect(await memberEmails(ids, "split-guest-payment-link")).toEqual([{ id: `email:split-guest-payment-link:${minted.paymentLinkId}`, status: "SKIPPED_NON_PRODUCTION" }]);
      expect((await prisma.paymentLink.findUniqueOrThrow({ where: { id: minted.paymentLinkId } })).revokedAt).not.toBeNull();
    });

    it("CP-6: after a stop, the sweep re-issues through the booking page's own path once, keyed for one recovery per link, and the original link no longer stands", async () => {
      const ids = CASES.linkStopped;
      await seedBooking(ids, { split: true });
      const { minted, marker } = await mintLink(ids);
      // Older than the re-issue's one-minute double-click guard, as any link a sweep reaches is.
      await prisma.paymentLink.update({ where: { id: minted.paymentLinkId }, data: { createdAt: new Date(Date.now() - HOUR) } });

      expect(await sweep(new Date(marker.eventAt.getTime() + WAIT_PAST))).toMatchObject({ checked: 1, delivered: 1 });

      expect(await markerKinds(ids)).toEqual([]);
      expect((await memberEmails(ids, "split-guest-payment-link")).map((row) => row.id)).toEqual([
        `email:split-guest-payment-link:${linkNotice.splitGuestPaymentLinkRecoveryKey(minted.paymentLinkId)}`,
      ]);
      expect((await prisma.paymentLink.findUniqueOrThrow({ where: { id: minted.paymentLinkId } })).revokedAt).not.toBeNull();
      expect((await sweep(new Date(marker.eventAt.getTime() + DAY))).checked).toBe(0);
    });

    /** A booking whose own payment row carries the card the job charges, and a ledger row naming it. */
    async function seedCard(ids: CaseIds) {
      await seedBooking(ids);
      const pm = `pm_race_5433d_${ids.tag}`;
      await prisma.payment.create({
        data: { id: ids.paymentId, bookingId: ids.bookingId, amountCents: PRICE_CENTS, source: "STRIPE", status: "PENDING", stripeCustomerId: `cus_${ids.tag}`, stripePaymentMethodId: pm, stripeSetupIntentId: `seti_${ids.tag}` },
      });
      stripeRaceHooks.detach = async () => ({ id: pm });
      return pm;
    }

    function escalate(ids: CaseIds, pm: string) {
      return prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId }, include: { member: true, organisation: { select: { name: true, email: true } } } }).then((booking) =>
        cardFailure.retireAndEscalateUnusableSavedCard({
          format: CLUB_FORMAT_TEST,
          booking,
          paymentMethodId: pm,
          paymentIntentId: `pi_race_5433d_${ids.tag}`,
          failure: { outcome: "terminal", reason: "card_permanently_declined", stripeType: "card_error", stripeCode: "card_declined", declineCode: "lost_card", adviceCode: null, message: "Your card was declined." },
          claimReleased: true,
        }),
      );
    }

    it("the saved card's clear commits both markers with it, and the delivery sends the owner's email at its keyed row and clears both", async () => {
      const ids = CASES.cardSent;
      const pm = await seedCard(ids);

      await escalate(ids, pm);

      expect((await prisma.payment.findUniqueOrThrow({ where: { id: ids.paymentId } })).stripePaymentMethodId).toBeNull();
      expect(await markerKinds(ids)).toEqual([]);
      const emails = await memberEmails(ids, "saved-card-charge-failed");
      expect(emails).toHaveLength(1);
      expect(emails[0]!.id).toMatch(new RegExp(`^email:saved-card-charge-failed:${ids.bookingId}:\\d+$`));
    });

    it("the saved card: after a stop between the clear and the sends, the sweep sends each exactly once", async () => {
      const ids = CASES.cardStopped;
      const pm = await seedCard(ids);
      stop.on = true;

      await escalate(ids, pm);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: ids.paymentId } })).stripePaymentMethodId).toBeNull();
      expect(await markerKinds(ids)).toEqual(["saved-card-unusable-member", "saved-card-unusable-officers"]);
      const [{ eventAt, payload }] = await prisma.owedNotice.findMany({ where: { subjectId: ids.bookingId, kind: "saved-card-unusable-officers" }, select: { eventAt: true, payload: true } });
      expect(payload).toEqual({ reason: "card_permanently_declined", claimReleased: 1, amountCents: PRICE_CENTS, paymentIntentId: `pi_race_5433d_${ids.tag}`, stripeCode: "card_declined", declineCode: "lost_card" });

      expect(await sweep(new Date(eventAt.getTime() + WAIT_PAST))).toMatchObject({ checked: 2, delivered: 2 });
      expect(await markerKinds(ids)).toEqual([]);
      expect(await memberEmails(ids, "saved-card-charge-failed")).toEqual([
        { id: `email:saved-card-charge-failed:${ids.bookingId}:${eventAt.getTime()}`, status: "SKIPPED_NON_PRODUCTION" },
      ]);
      expect((await sweep(new Date(eventAt.getTime() + DAY))).checked).toBe(0);
    });
  },
);
