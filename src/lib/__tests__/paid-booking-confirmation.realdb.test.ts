/**
 * Real-PostgreSQL proof of #5433's card-payment confirmation pull request (ST,
 * CP-2) and of owner decision D1: a card settle records the member's
 * confirmation as owed in its own transaction, the attempt right after the
 * commit sends it once and clears the marker, and a sweep sends what that
 * attempt never did, exactly once; a booking cancelled in the meantime is not
 * sent; past the end of the check-in day the member is sent nothing and the
 * officers are alerted once; a send that does not reach the owner (a
 * suppressed address) alerts them too.
 *
 * Each case runs the REAL settle, webhook processor, delivery and sweep against
 * the real `OwedNotice`, `Booking`, `Payment` and `EmailLog` tables and the
 * real email core. A "stop between the commit and the send" is the real
 * webhook with its delivery made to return at once (as if the process stopped
 * there); everything else is the real code.
 *
 * Ordinary Vitest runs skip the whole file. It runs in CI's `realdb-all` job on
 * the guarded, disposable loopback PostgreSQL the race harness provisions
 * (#1881), and owns and cleans its own `race-5433c-` rows: each case has its
 * own booking, owner and payment (stays in 2034, which no other suite uses, or
 * just before the frozen today for the cut-off case), and asserts on its own
 * rows only. Its sweeps read only its own markers. No provider is called: the
 * installation is declared non-production, so the email core records each
 * message and withholds it (a confirmation so withheld counts as told), and
 * the officers' alert's result is read as a live site's (the double below).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
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
// The real delivery right after the commit, made to return at once while
// `stop.on` is set: the process stopped between the settle's commit and its send.
const stop = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/paid-booking-confirmation-notice", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/paid-booking-confirmation-notice");
  return {
    ...real,
    deliverPaidBookingConfirmation: vi.fn(async (...args: Parameters<typeof real.deliverPaidBookingConfirmation>) =>
      stop.on ? undefined : real.deliverPaidBookingConfirmation(...args),
    ),
  };
});
// The real "Booking confirmation not sent" alert, with its result read as the
// live site would give it. On this copy the core withholds every admin copy, and
// `sendAdminAlertTo` counts a non-production withhold as not delivered, so the
// once-only claim would be held for a day and the marker kept, which no live
// site does when an officer is opted in. The alert's EmailLog rows are the real
// ones; only the count of copies an officer has is moved.
vi.mock("@/lib/email/admin-alerts-booking-confirmation-unsent", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/email/admin-alerts-booking-confirmation-unsent");
  return {
    ...real,
    sendAdminBookingConfirmationUnsentAlert: vi.fn(async (...args: Parameters<typeof real.sendAdminBookingConfirmationUnsentAlert>) => {
      const result = await real.sendAdminBookingConfirmationUnsentAlert(...args);
      return result.recipients > 0 ? { ...result, sent: result.sent + result.notDelivered, notDelivered: 0 } : result;
    }),
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5433c-";
const LODGE_ID = `${PREFIX}lodge`;
const ADMIN_ID = `${PREFIX}admin`;
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const PRICE_CENTS = 20_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One case's own owner, booking, payment, intent and nights. */
function caseIds(tag: string, checkIn: Date) {
  return {
    tag,
    ownerId: `${PREFIX}owner-${tag}`,
    ownerEmail: `${PREFIX}owner-${tag}@example.test`,
    bookingId: `${PREFIX}${tag}`,
    paymentId: `${PREFIX}payment-${tag}`,
    intentId: `pi_race_5433c_${tag}`,
    checkIn,
    night2: new Date(checkIn.getTime() + DAY),
    checkOut: new Date(checkIn.getTime() + 2 * DAY),
  };
}
type CaseIds = ReturnType<typeof caseIds>;

const CASES = {
  delivered: caseIds("dlv", new Date("2034-03-01T00:00:00.000Z")),
  recovered: caseIds("rec", new Date("2034-03-05T00:00:00.000Z")),
  cancelled: caseIds("cnl", new Date("2034-03-09T00:00:00.000Z")),
  suppressed: caseIds("sup", new Date("2034-03-13T00:00:00.000Z")),
  rollback: caseIds("rbk", new Date("2034-03-17T00:00:00.000Z")),
  // Its check-in day (30 June, NZ) ended before the frozen today (1 July 2026, midday NZ).
  pastCutoff: caseIds("pco", new Date("2026-06-30T00:00:00.000Z")),
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let reconciliation: typeof import("@/lib/payment-reconciliation");
let notice: typeof import("@/lib/paid-booking-confirmation-notice");
let owedRecord: typeof import("@/lib/paid-booking-confirmation-owed");
let drain: typeof import("@/lib/owed-notice/drain");
let deliver: typeof import("@/lib/owed-notice/deliver");
let harnessRole: { restore: () => void } | undefined;
let webhookEventSequence = 0;

(RUN ? describe : describe.skip)(
  "a card payment's confirmation is owed until sent, and recovered exactly once (D1) - real PostgreSQL (#5433)",
  { timeout: 90_000 },
  () => {
    async function deleteCaseRows(ids: CaseIds) {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_race_5433c_${ids.tag}_` } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: `evt_race_5433c_${ids.tag}_` } } });
      await prisma.owedNotice.deleteMany({ where: { subjectId: ids.bookingId } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: ids.bookingId } } });
      await prisma.emailLog.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [ids.bookingId, ids.paymentId] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [ids.bookingId, ids.paymentId] } } });
      await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: ids.ownerId } });
      await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: ids.bookingId } });
      // The settle posts ledger lines and journal batches whose keys restrict the booking's delete.
      await releaseBookingFinancialHistoryForTeardown(prisma, [ids.bookingId]);
      await prisma.bedAllocation.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: ids.paymentId } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: ids.paymentId } });
      await prisma.payment.deleteMany({ where: { id: ids.paymentId } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: ids.bookingId } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: ids.bookingId } });
      await prisma.booking.deleteMany({ where: { id: ids.bookingId } });
    }

    async function deleteFixtures() {
      // Bookings first: `Booking.memberId` and `Booking.lodgeId` restrict a delete of either.
      for (const ids of Object.values(CASES)) await deleteCaseRows(ids);
      await prisma.emailLog.deleteMany({ where: { to: ADMIN_EMAIL } });
      // Any other officer in the shared database was sent the alert too; its subject names the booking.
      await prisma.emailLog.deleteMany({ where: { templateName: "admin-booking-confirmation-unsent", subject: { contains: PREFIX } } });
      await prisma.emailSuppression.deleteMany({ where: { email: CASES.suppressed.ownerEmail } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [ADMIN_ID, ...Object.values(CASES).map((ids) => ids.ownerId)] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    }

    /**
     * A booking owed its payment: PAYMENT_PENDING, admitted over capacity by an
     * officer (#1771) so the settle's capacity check passes on a lodge with no
     * capacity setting, its intent's PENDING row minted. `status: "PAID"` seeds
     * one already paid instead, for the cut-off case.
     */
    async function seedBooking(ids: CaseIds, status: "PAYMENT_PENDING" | "PAID" = "PAYMENT_PENDING") {
      await deleteCaseRows(ids);
      await prisma.booking.create({
        data: {
          id: ids.bookingId,
          memberId: ids.ownerId,
          lodgeId: LODGE_ID,
          checkIn: ids.checkIn,
          checkOut: ids.checkOut,
          status,
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
          capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
          capacityOverriddenByMemberId: ADMIN_ID,
          guests: {
            create: [
              {
                firstName: "Ada",
                lastName: ids.bookingId,
                ageTier: "ADULT",
                isMember: true,
                stayStart: ids.checkIn,
                stayEnd: ids.checkOut,
                priceCents: PRICE_CENTS,
                nights: {
                  create: [
                    { stayDate: ids.checkIn, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" },
                    { stayDate: ids.night2, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" },
                  ],
                },
              },
            ],
          },
        },
      });
      await prisma.payment.create({
        data: { id: ids.paymentId, bookingId: ids.bookingId, amountCents: PRICE_CENTS, source: "STRIPE", status: status === "PAID" ? "SUCCEEDED" : "PENDING", stripePaymentIntentId: ids.intentId },
      });
      if (status === "PAYMENT_PENDING") {
        await prisma.paymentTransaction.create({
          data: { paymentId: ids.paymentId, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: ids.intentId, amountCents: PRICE_CENTS, status: "PENDING" },
        });
      }
    }

    /** Stripe's `payment_intent.succeeded` for the case's intent, through the real webhook processor; a fresh event id each time. */
    async function deliverWebhook(ids: CaseIds) {
      webhookEventSequence += 1;
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const answered = await processStripeWebhookEvent({
        id: `evt_race_5433c_${ids.tag}_${webhookEventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: {
          object: {
            id: ids.intentId,
            object: "payment_intent",
            amount: PRICE_CENTS,
            currency: "nzd",
            status: "succeeded",
            payment_method: "pm_race_5433c",
            metadata: { bookingId: ids.bookingId },
            latest_charge: null,
            cancellation_reason: null,
            last_payment_error: null,
          },
        },
      } as unknown as import("stripe").Stripe.Event);
      expect(answered.init?.status ?? 200, JSON.stringify(answered.body)).toBe(200);
    }

    /** The settle as the confirm-payment route and the confirm-pending job run it, owing the confirmation, with no delivery after it. */
    function settleOwingConfirmation(ids: CaseIds) {
      return reconciliation.markBookingPaymentSucceeded({
        bookingId: ids.bookingId,
        paymentIntentId: ids.intentId,
        amountCents: PRICE_CENTS,
        paymentMethodId: null,
        format: CLUB_FORMAT_TEST,
        owesPaidConfirmation: true,
      });
    }

    /** A sweep of this kind, reading only this suite's markers. */
    function sweep(now: Date) {
      return drain.drainOwedNotices(now, {
        deliverers: notice.PAID_CONFIRMATION_NOTICE_DELIVERERS,
        sources: [
          {
            name: "OwedNotice (this suite's)",
            listDue: async (deliverer, at) =>
              (await deliver.owedNoticeTableSource.listDue(deliverer, at)).filter((ref) => ref.marker?.subjectId.startsWith(PREFIX)),
          },
        ],
        job: "race-5433c-sweep",
      });
    }

    async function rows(ids: CaseIds) {
      return {
        markers: await prisma.owedNotice.findMany({ where: { subjectId: ids.bookingId }, select: { id: true, eventAt: true } }),
        confirmations: await prisma.emailLog.findMany({ where: { bookingId: ids.bookingId, templateName: "booking-confirmed" }, select: { id: true, status: true } }),
        officerAlerts: await prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: "admin-booking-confirmation-unsent", subject: { contains: ids.bookingId } } }),
      };
    }

    /** What the money tables hold for the case: the redelivery and the sweep must change none of it. */
    async function money(ids: CaseIds) {
      return {
        payment: await prisma.payment.findUniqueOrThrow({ where: { id: ids.paymentId }, select: { status: true, amountCents: true, creditAppliedCents: true, refundedAmountCents: true, settledByTransactionId: true } }),
        transactions: await prisma.paymentTransaction.findMany({ where: { paymentId: ids.paymentId }, select: { stripePaymentIntentId: true, status: true, amountCents: true } }),
        ledgerLines: await prisma.bookingLedgerLine.count({ where: { bookingId: ids.bookingId } }),
        xeroOperations: await prisma.xeroSyncOperation.count({ where: { localId: { in: [ids.bookingId, ids.paymentId] } } }),
      };
    }

    const paidAtOf = async (ids: CaseIds) => (await rows(ids)).markers[0]!.eventAt;

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "paid booking confirmation proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      reconciliation = await import("@/lib/payment-reconciliation");
      notice = await import("@/lib/paid-booking-confirmation-notice");
      owedRecord = await import("@/lib/paid-booking-confirmation-owed");
      drain = await import("@/lib/owed-notice/drain");
      deliver = await import("@/lib/owed-notice/deliver");

      await deleteFixtures();
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5433 confirmation lodge", slug: LODGE_ID, active: true } });
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
        data: { email: CASES.suppressed.ownerEmail, reason: "BOUNCE", suppressedAt: new Date(Date.now() - DAY), lastEventType: "Bounce", lastBounceType: "Permanent" },
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

    it("the webhook's settle commits the marker with the payment, and the attempt right after the commit sends the confirmation once and clears it", async () => {
      const ids = CASES.delivered;
      await seedBooking(ids);

      await deliverWebhook(ids);

      expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId } })).status).toBe("PAID");
      const { markers, confirmations } = await rows(ids);
      expect(markers).toEqual([]);
      // One row, at the payment's keyed id; withheld on this copy, which counts as told.
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]!.id).toMatch(new RegExp(`^email:booking-confirmed:${ids.bookingId}:\\d+$`));
      expect(confirmations[0]!.status).toBe("SKIPPED_NON_PRODUCTION");
    });

    it("a replayed webhook after a simulated stop sends exactly one email: the redelivery finds the booking paid, and the sweep recovers it once", async () => {
      const ids = CASES.recovered;
      await seedBooking(ids);

      // The process stops between the settle's commit and its send.
      stop.on = true;
      await deliverWebhook(ids);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId } })).status).toBe("PAID");
      expect((await rows(ids)).markers).toHaveLength(1);
      expect((await rows(ids)).confirmations).toEqual([]);
      const paidAt = await paidAtOf(ids);

      // Stripe redelivers: the settle reads already_paid, writes no marker and sends nothing.
      stop.on = false;
      await deliverWebhook(ids);
      expect((await rows(ids)).markers).toHaveLength(1);
      expect((await rows(ids)).confirmations).toEqual([]);
      const settled = await money(ids);

      // Not before the kind's wait; then exactly once.
      expect((await sweep(new Date(paidAt.getTime() + notice.PAID_CONFIRMATION_SWEEP_AFTER_MS - MINUTE))).checked).toBe(0);
      expect(await sweep(new Date(paidAt.getTime() + notice.PAID_CONFIRMATION_SWEEP_AFTER_MS + MINUTE))).toMatchObject({ checked: 1, delivered: 1 });
      expect(await rows(ids)).toEqual({
        markers: [],
        confirmations: [{ id: `email:booking-confirmed:${ids.bookingId}:${paidAt.getTime()}`, status: "SKIPPED_NON_PRODUCTION" }],
        officerAlerts: 0,
      });
      expect((await sweep(new Date(paidAt.getTime() + DAY))).checked).toBe(0);
      expect((await rows(ids)).confirmations).toHaveLength(1);

      // The sweeps moved no money, receipt, ledger line or Xero row.
      expect(await money(ids)).toEqual(settled);
    });

    it("a booking cancelled in the meantime is cleared by the sweep, not sent (D1)", async () => {
      const ids = CASES.cancelled;
      await seedBooking(ids);
      expect((await settleOwingConfirmation(ids)).paidConfirmation).toBeDefined();
      const paidAt = await paidAtOf(ids);
      // Cancelled before the sweep reaches it (the status is what the notice reads).
      await prisma.booking.update({ where: { id: ids.bookingId }, data: { status: "CANCELLED" } });

      expect(await sweep(new Date(paidAt.getTime() + notice.PAID_CONFIRMATION_SWEEP_AFTER_MS + MINUTE))).toMatchObject({ checked: 1, cleared: 1, delivered: 0 });

      expect(await rows(ids)).toEqual({ markers: [], confirmations: [], officerAlerts: 0 });
    });

    it("past the end of the check-in day the member is sent nothing and the officers are alerted once (D1)", async () => {
      const ids = CASES.pastCutoff;
      await seedBooking(ids, "PAID");
      const paidAt = new Date(Date.now() - 2 * DAY);
      await prisma.$transaction((tx) => owedRecord.recordPaidBookingConfirmationOwed(tx, { bookingId: ids.bookingId, paidAt }));

      expect(await sweep(new Date())).toMatchObject({ checked: 1, expired: 1, delivered: 0 });
      expect(await rows(ids)).toEqual({ markers: [], confirmations: [], officerAlerts: 1 });

      // Nothing left to sweep, and the once-ever claim holds for this payment.
      expect((await sweep(new Date(Date.now() + DAY))).checked).toBe(0);
      expect((await rows(ids)).officerAlerts).toBe(1);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: ids.bookingId } } })).toBeGreaterThan(0);
    });

    it("a send that does not reach the owner (a suppressed address, recorded BOUNCED) alerts the officers once and clears the marker", async () => {
      const ids = CASES.suppressed;
      await seedBooking(ids);
      const settled = await settleOwingConfirmation(ids);

      await notice.deliverPaidBookingConfirmation(settled.paidConfirmation!, CLUB_FORMAT_TEST, "race-5433c");

      const after = await rows(ids);
      expect(after.markers).toEqual([]);
      expect(after.confirmations.map((row) => row.status)).toEqual(["BOUNCED"]);
      expect(after.officerAlerts).toBe(1);
    });

    it("leaves no marker when the transaction that records it rolls back", async () => {
      const ids = CASES.rollback;
      await seedBooking(ids);
      await expect(
        prisma.$transaction(async (tx) => {
          await owedRecord.recordPaidBookingConfirmationOwed(tx, { bookingId: ids.bookingId, paidAt: new Date() });
          throw new Error("the settle failed after its marker");
        }),
      ).rejects.toThrow("failed after its marker");
      expect((await rows(ids)).markers).toEqual([]);
    });
  },
);
