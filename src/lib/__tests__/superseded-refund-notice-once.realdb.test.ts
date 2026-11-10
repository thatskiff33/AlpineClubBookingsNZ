/**
 * Real-PostgreSQL proof of #4690: a superseded payment's refund is announced -
 * the member's "we refunded you" email and the admin alert - exactly once,
 * whichever recovery attempt sends it.
 *
 * #4675 fenced the runner's close on the attempt's own claim. A refund attempt
 * that stalled past the stale reaper then made and recorded its refund and lost
 * its close, and the next claim, reading nothing outstanding, closed the row
 * silently: before #4690 the notice ran only after a close the attempt won, so
 * nobody sent it. Run here against the database through the REAL
 * `runPaymentRecoveryOperationNow`, the real ledger writer, `AlertCooldown`
 * claims and `EmailLog` rows:
 *
 * - the issue's sequence: the attempt stalls inside its Stripe refund, the
 *   reaper hands the row back, the attempt wakes, records the refund and loses
 *   its close; the next claim closes the row. One member email, one admin alert,
 *   one audit row, one booking event; a second run adds nothing.
 * - the reclaiming runner gets there first: Stripe lists the stalled attempt's
 *   refund, so its preflight records it and it announces it with nothing left
 *   to ask (#4699); or Stripe's list lags, and Stripe answers its replay of the
 *   row's key with that refund, which it announces. Either way the stalled
 *   attempt, waking, sends nothing more.
 * - the next claim's half: the attempt recorded its refund and stalled before
 *   its notice; the next claim reads nothing outstanding, proves the recorded
 *   refund the row's own on Stripe, and announces it before its close.
 * - another door's refund (a cancellation's) brings the row to nothing
 *   outstanding: closed with no notice at all.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4690-` fixtures. No Stripe call is made: refunds go to the harness's
 * one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4690-owner";
const ADMIN_ID = "race-4690-admin";
const ADMIN_EMAIL = "race-4690-admin@example.test";
const LODGE_ID = "race-4690-lodge";
const BOOKING_ID = "race-4690-booking";
const PAYMENT_ID = "race-4690-payment";
const PRIMARY_TXN = "race-4690-txn-primary";
const SUPERSEDED_TXN = "race-4690-txn-superseded";
const PRIMARY_INTENT = "pi_race_4690_primary";
const SUPERSEDED_INTENT = "pi_race_4690_superseded";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRIMARY_CENTS = 13_000;
const SUPERSEDED_CENTS = 6_500;
const MEMBER_TEMPLATE = "superseded-payment-refunded";
const ADMIN_TEMPLATE = "admin-superseded-payment-refund";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recovery: typeof import("@/lib/payment-recovery");
let notice: typeof import("@/lib/superseded-additional-refund");
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let buildSupersededPaymentRefundRecoveryIdempotencyKey: (typeof import("@/lib/payment-recovery-keys"))["buildSupersededPaymentRefundRecoveryIdempotencyKey"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "a superseded payment's refund is announced once, whichever attempt sends it - real PostgreSQL (#4690)",
  { timeout: 60_000 },
  () => {
    /** Stripe's refunds by idempotency key: a repeated key is answered with the refund it made. */
    let madeAtStripe: Map<string, Stripe.Refund>;
    let refundAsks: number;

    async function deleteBookingRows() {
      await prisma.emailLog.deleteMany({ where: { OR: [{ bookingId: BOOKING_ID }, { to: ADMIN_EMAIL }] } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: "superseded-payment-refund-report:" } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [BOOKING_ID, PAYMENT_ID] } }, { entityId: { in: [BOOKING_ID, PAYMENT_ID] } }] } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await releaseBookingFinancialHistoryForTeardown(prisma, [BOOKING_ID]);
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [OWNER_ID, ADMIN_ID] } } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, ADMIN_ID] } } });
    }

    /** A paid booking whose superseded ask the member confirmed anyway: captured, owed back, queued. */
    async function seedCapturedSupersededAsk(): Promise<string> {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: OWNER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PRIMARY_CENTS,
          finalPriceCents: PRIMARY_CENTS,
        },
      });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRIMARY_CENTS + SUPERSEDED_CENTS, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PRIMARY_CENTS, status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: SUPERSEDED_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS, status: "SUCCEEDED" },
      });
      const row = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_SUPERSEDED_PAYMENT",
          status: "PENDING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: SUPERSEDED_TXN,
          paymentIntentId: SUPERSEDED_INTENT,
          amountCents: SUPERSEDED_CENTS,
          idempotencyKey: buildSupersededPaymentRefundRecoveryIdempotencyKey(SUPERSEDED_TXN, SUPERSEDED_INTENT),
          nextRetryAt: new Date(0),
        },
      });
      return row.id;
    }

    function stripeRefund(id: string, amountCents: number, metadata: Record<string, string>): Stripe.Refund {
      return {
        id,
        object: "refund",
        amount: amountCents,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
        charge: "ch_race_4690",
        payment_intent: SUPERSEDED_INTENT,
        metadata,
      } as Stripe.Refund;
    }

    /**
     * Stripe makes the refund it is asked for - once per key - and only then
     * does `stall` run, as an attempt stalled on Stripe's answer would.
     */
    function stripeMakesRefunds(stall?: () => Promise<void>) {
      stripeRaceHooks.refund = async (args) => {
        refundAsks += 1;
        const key = args.idempotencyKey!;
        if (!madeAtStripe.has(key)) madeAtStripe.set(key, stripeRefund(`re_race_4690_${madeAtStripe.size + 1}`, args.amountCents, args.metadata ?? {}));
        const once = stall;
        stall = undefined;
        await once?.();
        return madeAtStripe.get(key)!;
      };
      stripeRaceHooks.listRefunds = async () => [...madeAtStripe.values()];
    }

    /** The stale reaper's own fenced write (`resetStaleProcessingOperations`), on the attempt held now. */
    async function reapStaleClaim(operationId: string) {
      const held = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId } });
      const reaped = await prisma.paymentRecoveryOperation.updateMany({
        where: { id: operationId, status: "PROCESSING", attempts: held.attempts, processingStartedAt: held.processingStartedAt },
        data: { status: "FAILED", lastError: "Payment recovery worker timed out before completion.", processingStartedAt: null, nextRetryAt: new Date() },
      });
      expect(reaped.count).toBe(1);
    }

    /** Every notice and record of the refund, as people and the record received it. */
    async function announced() {
      return {
        memberEmails: await prisma.emailLog.count({ where: { bookingId: BOOKING_ID, templateName: MEMBER_TEMPLATE } }),
        adminAlerts: await prisma.emailLog.count({ where: { to: ADMIN_EMAIL, templateName: ADMIN_TEMPLATE } }),
        auditRows: await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking.payment.superseded_payment_refunded" } }),
        events: await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, type: "REFUNDED" } }),
      };
    }
    const ONCE_EACH = { memberEmails: 1, adminAlerts: 1, auditRows: 1, events: 1 };
    const NONE = { memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 };
    const rowNow = (operationId: string) =>
      prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, attempts: true } });
    const ledgerRefunds = () => prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID }, select: { stripeRefundId: true, amountCents: true } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "superseded refund notice proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      recovery = await import("@/lib/payment-recovery");
      notice = await import("@/lib/superseded-additional-refund");
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ buildSupersededPaymentRefundRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      for (const [id, email, firstName, role] of [
        [OWNER_ID, "race-4690-owner@example.test", "Ada", "USER"],
        [ADMIN_ID, ADMIN_EMAIL, "Treasurer", "ADMIN"],
      ] as const) {
        await prisma.member.create({
          data: { id, email, passwordHash: "not-a-real-password", firstName, lastName: "Proof", ageTier: "ADULT", canLogin: true, role },
        });
      }
      // An admin who receives payment alerts (`adminPaymentFailure`, on by default).
      await prisma.memberAccessRole.create({ data: { memberId: ADMIN_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4690 Lodge", slug: "race-4690" } });
    }, 60_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      madeAtStripe = new Map();
      refundAsks = 0;
      await deleteBookingRows();
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

    it("the issue's sequence: a stalled attempt refunds and loses its close to the reaper, the next claim closes - one email, one alert, and a second run adds nothing", async () => {
      const operationId = await seedCapturedSupersededAsk();
      const frozenNow = new Date();
      // The attempt stalls on Stripe's answer past the stale threshold; the reaper hands its row back.
      stripeMakesRefunds(async () => {
        vi.setSystemTime(new Date(frozenNow.getTime() + 31 * 60_000));
        await reapStaleClaim(operationId);
      });
      try {
        // The stale attempt wakes: it records the refund and announces it, and its close matches nothing.
        expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(await rowNow(operationId)).toEqual({ status: "FAILED", attempts: 1 });
        expect(await announced()).toEqual(ONCE_EACH);

        // The next claim reads nothing outstanding and closes the row, saying nothing more.
        expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(await rowNow(operationId)).toEqual({ status: "SUCCEEDED", attempts: 2 });
      } finally {
        vi.setSystemTime(frozenNow);
      }

      expect(await announced()).toEqual(ONCE_EACH);
      expect(refundAsks).toBe(1);
      expect(await ledgerRefunds()).toEqual([{ stripeRefundId: "re_race_4690_1", amountCents: SUPERSEDED_CENTS }]);
      const email = await prisma.emailLog.findFirstOrThrow({ where: { bookingId: BOOKING_ID, templateName: MEMBER_TEMPLATE } });
      expect(email.id).toBe(`email:${MEMBER_TEMPLATE}:${operationId}`);

      // A second run: the row is closed, and the next claim's half finds it announced.
      expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("not-claimed");
      const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId } });
      await notice.reportUnannouncedSupersededPaymentRefund(row, CLUB_FORMAT_TEST);
      expect(await announced()).toEqual(ONCE_EACH);
    });

    /*
      #4699: the reclaiming runner sizes its refund on the ledger after its preflight records what
      Stripe lists. Listed, the stalled attempt's refund leaves nothing outstanding, so the runner
      asks for nothing and announces it as the row's own; only a list that lags it replays the key.
    */
    it.each([
      ["Stripe lists the stalled attempt's refund: its preflight records it, and it announces it with nothing left to ask", true, 1],
      ["Stripe's list lags: Stripe answers its replay with the stalled attempt's refund, and it announces it", false, 2],
    ])("the reclaiming runner gets there first - %s; the stalled attempt then sends nothing", async (_label, listed, asks) => {
      const operationId = await seedCapturedSupersededAsk();
      const frozenNow = new Date();
      let afterNextClaim: Awaited<ReturnType<typeof announced>> | undefined;
      // Stripe made the refund; its answer is lost to a stall, and the row is reclaimed meanwhile.
      stripeMakesRefunds(async () => {
        vi.setSystemTime(new Date(frozenNow.getTime() + 31 * 60_000));
        await reapStaleClaim(operationId);
        const listRefunds = stripeRaceHooks.listRefunds;
        if (!listed) stripeRaceHooks.listRefunds = async () => [];
        try {
          expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
        } finally {
          stripeRaceHooks.listRefunds = listRefunds;
        }
        afterNextClaim = await announced();
      });
      try {
        expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
      } finally {
        vi.setSystemTime(frozenNow);
      }

      // Had the stalled attempt never woken, the reclaiming runner alone sent the notice.
      expect(afterNextClaim).toEqual(ONCE_EACH);
      expect(await announced()).toEqual(ONCE_EACH);
      expect(await rowNow(operationId)).toEqual({ status: "SUCCEEDED", attempts: 2 });
      // Stripe made one refund, recorded once; a lagging list has both ask under the row's key.
      expect(refundAsks).toBe(asks);
      expect(await ledgerRefunds()).toEqual([{ stripeRefundId: "re_race_4690_1", amountCents: SUPERSEDED_CENTS }]);
      const alert = await prisma.emailLog.findFirstOrThrow({ where: { to: ADMIN_EMAIL, templateName: ADMIN_TEMPLATE }, select: { subject: true } });
      expect(alert.subject).toContain("Ada Proof");
    });

    it("the next claim's half: an attempt that recorded its refund and stalled before its notice - the next claim proves the refund the row's own and announces it before its close; the stalled attempt then sends nothing", async () => {
      const operationId = await seedCapturedSupersededAsk();
      const frozenNow = new Date();
      let afterNextClaim: Awaited<ReturnType<typeof announced>> | undefined;
      let rowAfterNextClaim: Awaited<ReturnType<typeof rowNow>> | undefined;
      stripeMakesRefunds(async () => {
        // The attempt records the refund Stripe made - the ledger writer it calls next - then stalls.
        await recordStripeRefundsAgainstTransaction({
          paymentId: PAYMENT_ID,
          paymentTransactionId: SUPERSEDED_TXN,
          refunds: [...madeAtStripe.values()],
          fallbackPaymentIntentId: SUPERSEDED_INTENT,
        });
        vi.setSystemTime(new Date(frozenNow.getTime() + 31 * 60_000));
        await reapStaleClaim(operationId);
        expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
        afterNextClaim = await announced();
        rowAfterNextClaim = await rowNow(operationId);
      });
      try {
        expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
      } finally {
        vi.setSystemTime(frozenNow);
      }

      // The next claim refunded nothing, announced the attempt's refund and closed the row.
      expect(refundAsks).toBe(1);
      expect(rowAfterNextClaim).toEqual({ status: "SUCCEEDED", attempts: 2 });
      expect(afterNextClaim).toEqual(ONCE_EACH);
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "REFUNDED" }, select: { amountCents: true } });
      expect(event.amountCents).toBe(SUPERSEDED_CENTS);
      // The stalled attempt woke and sent nothing more.
      expect(await announced()).toEqual(ONCE_EACH);
      expect(await ledgerRefunds()).toEqual([{ stripeRefundId: "re_race_4690_1", amountCents: SUPERSEDED_CENTS }]);
    });

    /*
      #4699: another door's refund Stripe lists but the ledger has not recorded yet. The resend
      preflight records it, and the refund is sized on the ledger after that: Stripe is asked only
      for what the charge still holds (this double refuses more, as Stripe does), or for nothing.
      Made before the row was raised: one made since that leaves something to ask holds the row
      instead (#4858, `superseded-refund-another-door-hold.realdb.test.ts`).
    */
    it.each([
      ["part of the capture: Stripe is asked only for the rest, and that is announced", 2_500, 1, ONCE_EACH],
      ["the whole capture: nothing is asked for, and the row closes with no notice", SUPERSEDED_CENTS, 0, NONE],
    ])("#4699: another door's refund Stripe lists but the ledger has not recorded, for %s", async (_label, cancelledCents, asks, notices) => {
      const operationId = await seedCapturedSupersededAsk();
      madeAtStripe.set("cancellation", {
        ...stripeRefund("re_race_4699_cancellation", cancelledCents, { bookingId: BOOKING_ID, reason: "cancellation" }),
        created: Math.floor(Date.UTC(2026, 5, 1) / 1000),
      });
      stripeMakesRefunds();
      const makeRefund = stripeRaceHooks.refund!;
      stripeRaceHooks.refund = async (args) => {
        const unrefunded = SUPERSEDED_CENTS - [...madeAtStripe.values()].reduce((sum, refund) => sum + refund.amount, 0);
        if (args.amountCents > unrefunded) throw new Error("Refund amount is greater than unrefunded amount on charge");
        return makeRefund(args);
      };

      expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(await rowNow(operationId)).toEqual({ status: "SUCCEEDED", attempts: 1 });
      expect(refundAsks).toBe(asks);
      const refunds = await ledgerRefunds();
      expect(refunds.reduce((sum, refund) => sum + refund.amountCents, 0)).toBe(SUPERSEDED_CENTS);
      expect(refunds).toContainEqual({ stripeRefundId: "re_race_4699_cancellation", amountCents: cancelledCents });
      expect(await announced()).toEqual(notices);
      if (asks > 0) {
        const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "REFUNDED" }, select: { amountCents: true } });
        expect(event.amountCents).toBe(SUPERSEDED_CENTS - cancelledCents);
      }
    });

    it("another door's refund (a cancellation's) brings the row to nothing outstanding: closed with no notice", async () => {
      const operationId = await seedCapturedSupersededAsk();
      // The cancellation door refunded the whole capture first, under its own metadata, and recorded it.
      madeAtStripe.set("cancellation", stripeRefund("re_race_4690_cancellation", SUPERSEDED_CENTS, { bookingId: BOOKING_ID, reason: "cancellation" }));
      await recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: SUPERSEDED_TXN,
        refunds: [...madeAtStripe.values()],
        fallbackPaymentIntentId: SUPERSEDED_INTENT,
      });
      stripeMakesRefunds();

      expect(await recovery.runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(await rowNow(operationId)).toEqual({ status: "SUCCEEDED", attempts: 1 });
      expect(refundAsks).toBe(0);
      expect(await announced()).toEqual(NONE);
      expect(await notice.supersededRefundReportSettled(operationId)).toBe(false);
    });
  },
);
