/**
 * Real-PostgreSQL proof of #4488 (`INV-PAY-141`; owner, 11 Nov 2026): a card
 * refund's reversal never takes a refunded total below the bank cash a
 * COMPLETED card refund shortfall recorded - a cancel's or a capacity race's -
 * beside the "Paid another way" closes #4280 already counted.
 *
 * Proven here, each through the real writers:
 *
 * - Worked example 1 (`support/card-shortfall-late-refund-example.ts`): $200
 *   by card on A and $100 by bank on B, cancelled; the card refund dies, the
 *   shortfall's completion is refused until the card refund is closed, then
 *   the close ($200 on A) and the shortfall ($100 on B). The lost card refund
 *   arrives late, capped, and fails - delivered twice. A stays $200, B $100,
 *   the payment $300, nothing owed, and the audit finds nothing. Before #4488
 *   A fell to $100 and the payment to $200.
 * - Worked example 2, through the real capacity race: a $200 charge whose
 *   records already read $50 refunded refunds $150 by card and raises a $50
 *   shortfall to check; marked paid back (with its guarded correction), then a
 *   $50 dashboard refund recorded late and failed leaves the charge at $200,
 *   not $150.
 * - Shortfall cash on another charge counted once: a $120 part close on A, the
 *   $100 shortfall on B, a $70 dashboard refund on A recorded and failed - A
 *   returns to $120, not $190.
 * - Only a completed shortfall counts: open or dismissed, a $200 card refund
 *   that counted and then failed takes A to $0.
 * - The shortfall's completion and the failure racing on the Payment row, in
 *   both orders: completion first, both charges keep their bank cash; failure
 *   first, the close's $200 stays and the completion is refused while the
 *   failed-later row is unsettled.
 * - The capacity race's completion and its late dashboard refund queued on the
 *   race's Payment row (#5344): completion first, its guarded correction and
 *   its $50 land before the refund is recorded and fails, and the charge stays
 *   $200; failure first, the charge falls to its $150 of card refunds and the
 *   completion then places the $50 on it; and with the refund recorded ahead
 *   of the completion, the completion is refused (nothing to lower) and the
 *   failure leaves the charge at $150, the shortfall still open.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4488-` fixtures. No Stripe or Xero call is made: Stripe is the
 * harness's one shared double, and Xero is not connected.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { cardShortfallLateRefundExample, EXAMPLE_BANK_CENTS, EXAMPLE_CARD_CENTS, EXAMPLE_PRICE_CENTS } from "./support/card-shortfall-late-refund-example";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let auditRefundedTotalShortfalls: (typeof import("@/lib/refunded-total-shortfall-audit"))["auditRefundedTotalShortfalls"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
let example: ReturnType<typeof cardShortfallLateRefundExample>;

(RUN ? describe : describe.skip)(
  "a card refund's reversal keeps the bank cash a completed card refund shortfall recorded — real PostgreSQL (#4488)",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4488 shortfall reversal floor");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ auditRefundedTotalShortfalls } = await import("@/lib/refunded-total-shortfall-audit"));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4488-holder");
      observerClient = separate("race-4488-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      example = cardShortfallLateRefundExample(prisma, "race-4488", CLUB_FORMAT_TEST);
      await example.createFixtures();
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await example.seedPaidBooking();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await example.deleteFixtures();
    });

    // -------------------------------------------------------------- readings

    /** What "Refunds owed" reads for the payment's dead and held card refund rows. */
    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: example.ids.payment },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** Every card refund row on the booking other than the cancel's own. */
    const raisedRows = async () =>
      prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: example.ids.booking, id: { not: (await example.cardRefundRow()).id } },
        select: { idempotencyKey: true, amountCents: true, status: true, attempts: true },
      });
    /** #4210 (`INV-PAY-142`): the failure's row of its own, held - PENDING with its attempts spent, never re-sent automatically. */
    const rowOfItsOwn = (refundId: string, cents: number) =>
      expect.objectContaining({ idempotencyKey: `card_refund_failed_later_${refundId}`, amountCents: cents, status: "PENDING", attempts: 5 });

    async function auditFinding() {
      return (await auditRefundedTotalShortfalls()).findings.find((finding) => finding.paymentId === example.ids.payment) ?? null;
    }

    /** Steps 1 and 2 up to the close: cancelled, the card refund dead, the shortfall raised and still open. */
    async function cancelledWithCardRefundDead() {
      expect(await example.cancel()).toMatchObject({ status: 200, data: { ownCardRefund: { amountCents: EXAMPLE_CARD_CENTS, byHandCents: EXAMPLE_BANK_CENTS } } });
      expect(await example.shortfallTask()).toMatchObject({ status: "OPEN", amountCents: EXAMPLE_BANK_CENTS, paymentId: example.ids.payment });
      expect(await example.spendCardRefundRetries()).toMatchObject({ status: "FAILED", attempts: 5, nextRetryAt: null });
      expect(await example.mirrors()).toEqual({ payment: 0, a: 0, b: 0, retained: EXAMPLE_PRICE_CENTS });
    }

    // ------------------------------------------------------------ example 1

    it("example 1: the close and the shortfall stand when the lost card refund arrives late and fails, delivered twice - A $200, B $100, the payment $300", async () => {
      await cancelledWithCardRefundDead();
      // The card part is still owed: the shortfall cannot be marked paid back yet, and nothing moves.
      await expect(example.resolveShortfall()).rejects.toMatchObject({ status: 409 });
      expect(await example.mirrors()).toEqual({ payment: 0, a: 0, b: 0, retained: EXAMPLE_PRICE_CENTS });

      await example.closeCardRefund();
      await example.resolveShortfall();
      expect(await example.shortfallTask()).toMatchObject({ status: "COMPLETED", amountCents: EXAMPLE_BANK_CENTS });
      expect(await example.mirrors()).toEqual({ payment: EXAMPLE_PRICE_CENTS, a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, retained: 0 });
      expect(await owedNow()).toBe(0);

      const lost = await example.stripeRefund("re_race_4488_lost", EXAMPLE_CARD_CENTS, "pending");
      await example.syncCardCharge([lost]);
      // Capped: charge A cannot hold a second $200.
      expect(await example.mirrors()).toEqual({ payment: EXAMPLE_PRICE_CENTS, a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, retained: 0 });

      expect(await example.deliverFailure(lost)).toBe("recorded");
      // Before #4488: A fell to $100 (the close's $200 less B's $100) and the payment to $200.
      expect(await example.mirrors()).toEqual({ payment: EXAMPLE_PRICE_CENTS, a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, retained: 0 });
      // The failure's one held row (`INV-PAY-128`, #4210); "Refunds owed" reads nothing; the audit, on the same floor, nothing short.
      expect(await raisedRows()).toEqual([rowOfItsOwn(lost.id, EXAMPLE_CARD_CENTS)]);
      expect(await owedNow()).toBe(0);
      expect(await auditFinding()).toBeNull();

      // Delivered again: nothing moves, and still one row.
      expect(await example.deliverFailure(lost)).toBe("recorded");
      await example.syncCardCharge([{ ...lost, status: "failed" } as Stripe.Refund]);
      expect(await example.mirrors()).toEqual({ payment: EXAMPLE_PRICE_CENTS, a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, retained: 0 });
      expect(await raisedRows()).toEqual([rowOfItsOwn(lost.id, EXAMPLE_CARD_CENTS)]);
      expect(await owedNow()).toBe(0);
      expect(await auditFinding()).toBeNull();
    });

    it("shortfall cash on another charge is counted once: a $120 part close on A, the $100 shortfall on B, a $70 dashboard refund on A failed - A returns to $120, not $190", async () => {
      await cancelledWithCardRefundDead();
      await example.closeCardRefund(12_000);
      await example.resolveShortfall();
      expect(await example.mirrors()).toEqual({ payment: 22_000, a: 12_000, b: EXAMPLE_BANK_CENTS, retained: 8_000 });

      const dashboard = await example.stripeRefund("re_race_4488_dashboard", 7_000, "pending", { madeBy: null });
      await example.syncCardCharge([dashboard]);
      expect(await example.mirrors()).toEqual({ payment: 29_000, a: 19_000, b: EXAMPLE_BANK_CENTS, retained: 1_000 });
      await example.deliverFailure(dashboard);

      // The floor: the close's $120 and the shortfall's $100, less B's $100 already holding the shortfall.
      // Counted twice, the shortfall would have kept A at $190.
      expect(await example.mirrors()).toEqual({ payment: 22_000, a: 12_000, b: EXAMPLE_BANK_CENTS, retained: 8_000 });
      expect(await auditFinding()).toBeNull();
    });

    it("only a completed shortfall counts: with it still open, the lost card refund that counted and then failed takes A to nothing", async () => {
      await cancelledWithCardRefundDead();

      // The dead row's refund, made after all and recorded late: it fills the slice.
      const lost = await example.stripeRefund("re_race_4488_counted", EXAMPLE_CARD_CENTS, "pending");
      await example.syncCardCharge([lost]);
      expect(await example.mirrors()).toEqual({ payment: EXAMPLE_CARD_CENTS, a: EXAMPLE_CARD_CENTS, b: 0, retained: EXAMPLE_BANK_CENTS });
      await example.deliverFailure(lost);

      expect(await example.shortfallTask()).toMatchObject({ status: "OPEN" });
      expect(await example.mirrors()).toEqual({ payment: 0, a: 0, b: 0, retained: EXAMPLE_PRICE_CENTS });
    });

    // --------------------------------------------------- the capacity race

    describe("a capacity race's shortfall to check (example 2)", () => {
      const CAP = "race-4488-cap";
      const CAP_BOOKING = `${CAP}-booking`;
      const CAP_PAYMENT = `${CAP}-payment`;
      const CAP_TXN = `${CAP}-txn`;
      const CAP_INTENT = "pi_race_4488_cap";
      const CAP_GUESTS = [`${CAP}-g1`, `${CAP}-g2`];
      const CAP_CHARGE_CENTS = 20_000;
      const DRIFT_CENTS = 5_000;
      const CHECK_KEY = `cancel-card-shortfall:${CAP_BOOKING}:capacity-race:${CAP_INTENT}:check`;
      // After this database's refund ledger started (its migration runs at real time), as a live charge's is.
      const CHARGE_MADE_AT = new Date("2098-06-01T00:00:00.000Z");
      const REFUNDS_MADE_SECONDS = Math.floor(Date.UTC(2099, 0, 1) / 1000);
      const D1 = new Date("2027-08-01T00:00:00.000Z");
      const D2 = new Date("2027-08-02T00:00:00.000Z");
      const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

      async function cleanRace() {
        await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: `card-refund-cap-overflow:${CAP_TXN}:` } } });
        // The race's once-ever shortfall alert claim, so each case raises its own.
        const { capacityRaceRefundShortfallAlertKey } = await import("@/lib/capacity-race-refund-shortfall");
        await prisma.alertCooldown.deleteMany({ where: { key: capacityRaceRefundShortfallAlertKey(CAP_BOOKING) } });
        await prisma.auditLog.deleteMany({ where: { targetId: CAP_BOOKING } });
        await prisma.bookingEvent.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await releaseBookingJournalForTeardown(prisma, [CAP_BOOKING]);
        await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [CAP_PAYMENT, CAP_BOOKING] } } });
        await prisma.manualRefundTask.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await prisma.paymentRefund.deleteMany({ where: { paymentId: CAP_PAYMENT } });
        await prisma.paymentTransaction.deleteMany({ where: { paymentId: CAP_PAYMENT } });
        await prisma.payment.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await prisma.bookingGuest.deleteMany({ where: { bookingId: CAP_BOOKING } });
        await prisma.booking.deleteMany({ where: { id: CAP_BOOKING } });
      }

      beforeEach(cleanRace);
      afterAll(async () => {
        if (prisma) await cleanRace();
      });

      /**
       * A $200 booking awaiting its card payment at a lodge with no beds, so the
       * final capacity claim fails; its charge already reads $50 refunded with no
       * refund row behind it (the drift #4154's suite seeds the same way). Then
       * the card payment completes after the dates filled: Stripe refunds the
       * $150 the plan carries, and the void raises the $50 as a shortfall to check.
       */
      async function lostCapacityRace() {
        await prisma.booking.create({
          data: { id: CAP_BOOKING, memberId: example.ids.member, lodgeId: example.ids.lodge, checkIn: D1, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: CAP_CHARGE_CENTS, finalPriceCents: CAP_CHARGE_CENTS },
        });
        for (const id of CAP_GUESTS) {
          await prisma.bookingGuest.create({
            data: {
              id, bookingId: CAP_BOOKING, firstName: "Capacity", lastName: id, ageTier: "ADULT", isMember: true, stayStart: D1, stayEnd: CHECK_OUT, priceCents: 10_000,
              nights: { create: [{ stayDate: D1, priceCents: 5_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
            },
          });
        }
        await prisma.payment.create({
          data: { id: CAP_PAYMENT, bookingId: CAP_BOOKING, amountCents: CAP_CHARGE_CENTS, source: "STRIPE", status: "PENDING", stripePaymentIntentId: CAP_INTENT },
        });
        await prisma.paymentTransaction.create({
          data: { id: CAP_TXN, paymentId: CAP_PAYMENT, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: CAP_INTENT, amountCents: CAP_CHARGE_CENTS, refundedAmountCents: DRIFT_CENTS, status: "SUCCEEDED", createdAt: CHARGE_MADE_AT },
        });
        stripeRaceHooks.refund = async (args) => ({
          id: "re_race_4488_cap_card", object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded", reason: "requested_by_customer",
          created: REFUNDS_MADE_SECONDS, charge: "ch_race_4488_cap", payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
        });
        const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
        expect(
          (await markBookingPaymentSucceeded({ bookingId: CAP_BOOKING, paymentIntentId: CAP_INTENT, amountCents: CAP_CHARGE_CENTS, paymentMethodId: null, format: CLUB_FORMAT_TEST })).outcome,
        ).toBe("cancelled_refunded");
        const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: CHECK_KEY } });
        expect(task).toMatchObject({ status: "OPEN", amountCents: DRIFT_CENTS, paymentId: CAP_PAYMENT });
        // The card refund was added to the drifted total: the charge reads all of it refunded.
        expect(await charge()).toBe(CAP_CHARGE_CENTS);
        return task;
      }

      const charge = async () => (await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CAP_TXN }, select: { refundedAmountCents: true } })).refundedAmountCents;

      async function resolveCheck(taskId: string, resolution: "completed" | "dismissed") {
        const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
        return resolveManualRefundTask(
          resolution === "completed"
            ? { taskId, resolution, note: null, actingMemberId: example.ids.officer, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null }
            : { taskId, resolution, note: "Refunded in the Stripe dashboard (race 4488).", actingMemberId: example.ids.officer, recordedNightPrices: null },
          CLUB_FORMAT_TEST,
        );
      }

      /** A $50 refund made by hand in the Stripe dashboard. */
      const DASHBOARD_REFUND = {
        id: "re_race_4488_cap_dashboard", object: "refund", amount: DRIFT_CENTS, currency: "nzd", status: "pending", reason: "requested_by_customer",
        created: REFUNDS_MADE_SECONDS + 86_400, charge: "ch_race_4488_cap", payment_intent: CAP_INTENT, metadata: {},
      } as unknown as Stripe.Refund;

      /** The dashboard refund recorded late. It counts, and where the charge already reads all of it refunded it is capped. */
      async function recordDashboardRefund() {
        const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
        await recordStripeRefundsAgainstTransaction({ paymentId: CAP_PAYMENT, paymentTransactionId: CAP_TXN, refunds: [DASHBOARD_REFUND as never], store: prisma });
      }

      /** `refund.failed` for the dashboard refund - the webhook's recorder. */
      async function failDashboardRefund() {
        const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
        return recordRefusedCardRefund({ ...DASHBOARD_REFUND, status: "failed" } as Stripe.Refund);
      }

      /** A $50 refund made by hand in the Stripe dashboard, recorded late (capped: the charge reads all of it refunded), then failed. */
      async function dashboardRefundRecordedThenFailed() {
        await recordDashboardRefund();
        expect(await charge()).toBe(CAP_CHARGE_CENTS);
        expect(await failDashboardRefund()).toBe("recorded");
      }

      /** What Stripe says the race's charge has refunded, as the completion reads it before its transaction: the race's own $150. */
      function stripeShowsTheRaceRefundOnly() {
        stripeRaceHooks.get = async (id) => ({ id, object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_race_4488_cap", object: "charge", amount_refunded: CAP_CHARGE_CENTS - DRIFT_CENTS } });
      }

      it("marked paid back: $150 by card and $50 by bank went back, and the charge stays at $200 when a late dashboard refund fails", async () => {
        const task = await lostCapacityRace();
        stripeShowsTheRaceRefundOnly();
        await resolveCheck(task.id, "completed");
        // The guarded correction lowered the charge to its refund rows, then the completion put the $50 on it.
        expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "COMPLETED", amountCents: DRIFT_CENTS });
        expect(await charge()).toBe(CAP_CHARGE_CENTS);

        await dashboardRefundRecordedThenFailed();

        // Before #4488 the charge fell to its $150 of card refunds.
        expect(await charge()).toBe(CAP_CHARGE_CENTS);
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: CAP_PAYMENT }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CAP_CHARGE_CENTS });
      });

      it("only a completed shortfall counts: dismissed, the late dashboard refund's failure takes the charge down to its $150 of card refunds", async () => {
        const task = await lostCapacityRace();
        await resolveCheck(task.id, "dismissed");
        expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "DISMISSED" });

        await dashboardRefundRecordedThenFailed();

        expect(await charge()).toBe(CAP_CHARGE_CENTS - DRIFT_CENTS);
      });

      // ------------------------- the completion and the late dashboard refund, queued on the race's Payment row (#5344)

      /** How many times the guarded correction (#4154) lowered the race's charge. */
      const corrections = () => prisma.auditLog.count({ where: { targetId: CAP_BOOKING, action: "booking-payment.capacity-race.refunded-total-corrected" } });
      const racePaymentRefunded = async () => (await prisma.payment.findUniqueOrThrow({ where: { id: CAP_PAYMENT }, select: { refundedAmountCents: true } })).refundedAmountCents;
      const checkTask = (taskId: string) => prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, amountCents: true } });

      /** The least the charge may read: its card refunds still counted, plus the shortfall once completed (`INV-PAY-141`). */
      async function countedCardRefundsPlusCompletedShortfall(taskId: string) {
        const { isRecordedRefundStatus } = await import("@/lib/payment-transaction-status");
        const refunds = await prisma.paymentRefund.findMany({ where: { paymentTransactionId: CAP_TXN }, select: { amountCents: true, status: true } });
        const counted = refunds.filter((refund) => isRecordedRefundStatus(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
        const task = await checkTask(taskId);
        return counted + (task.status === "COMPLETED" ? (task.amountCents ?? 0) : 0);
      }

      it("completion first: its correction and its $50 land before the late dashboard refund is recorded and fails - the charge and the payment stay at $200", async () => {
        const task = await lostCapacityRace();
        stripeShowsTheRaceRefundOnly();

        const [completed, late] = await inOrder(() => resolveCheck(task.id, "completed"), () => dashboardRefundRecordedThenFailed(), CAP_PAYMENT);
        expect(completed.ok && late.ok).toBe(true);

        // The correction ran, so the completion read the charge before the dashboard refund was recorded on it:
        // recorded first, there is nothing to lower and the completion is refused (the third case).
        expect(await corrections()).toBe(1);
        expect(await checkTask(task.id)).toEqual({ status: "COMPLETED", amountCents: DRIFT_CENTS });
        expect(await charge()).toBe(CAP_CHARGE_CENTS);
        expect(await racePaymentRefunded()).toBe(CAP_CHARGE_CENTS);
        expect(await charge()).toBeGreaterThanOrEqual(await countedCardRefundsPlusCompletedShortfall(task.id));
      });

      it("failure first: the failed dashboard refund takes the charge to its $150 of card refunds, and the completion behind it places the $50 there - $200", async () => {
        const task = await lostCapacityRace();
        stripeShowsTheRaceRefundOnly();
        // Recorded before either writer starts: it counts, capped, so the charge still reads all of it refunded.
        await recordDashboardRefund();
        expect(await charge()).toBe(CAP_CHARGE_CENTS);

        const [failed, completed] = await inOrder(() => failDashboardRefund(), () => resolveCheck(task.id, "completed"), CAP_PAYMENT);
        expect(failed).toEqual({ ok: true, value: "recorded" });
        // Placed, not refused: the failure left the charge $50 of room, so the completion needed no correction.
        // Ahead of the failure it is refused (the next case).
        expect(completed.ok).toBe(true);
        expect(await corrections()).toBe(0);

        expect(await checkTask(task.id)).toEqual({ status: "COMPLETED", amountCents: DRIFT_CENTS });
        expect(await charge()).toBe(CAP_CHARGE_CENTS);
        expect(await racePaymentRefunded()).toBe(CAP_CHARGE_CENTS);
        expect(await charge()).toBeGreaterThanOrEqual(await countedCardRefundsPlusCompletedShortfall(task.id));
      });

      it("the dashboard refund already recorded, completion first: refused with nothing to lower, and the failure behind it takes the charge to its $150 of card refunds, no lower", async () => {
        const task = await lostCapacityRace();
        stripeShowsTheRaceRefundOnly();
        await recordDashboardRefund();
        expect(await charge()).toBe(CAP_CHARGE_CENTS);

        const [completed, failed] = await inOrder(() => resolveCheck(task.id, "completed"), () => failDashboardRefund(), CAP_PAYMENT);
        const { CAPACITY_RACE_CORRECTION_BLOCKED_REASON } = await import("@/lib/capacity-race-refunded-total-correction");
        // The charge's refund rows ($150 by card, $50 in the dashboard) account for all it reads refunded.
        expect(completed).toMatchObject({ ok: false, error: { status: 400, message: expect.stringContaining(CAPACITY_RACE_CORRECTION_BLOCKED_REASON["nothing-to-lower"]) } });
        expect(failed).toEqual({ ok: true, value: "recorded" });

        // The shortfall is still open, so it holds nothing up: the charge reads its card refunds still counted.
        expect(await corrections()).toBe(0);
        expect(await checkTask(task.id)).toEqual({ status: "OPEN", amountCents: DRIFT_CENTS });
        expect(await charge()).toBe(CAP_CHARGE_CENTS - DRIFT_CENTS);
        expect(await racePaymentRefunded()).toBe(CAP_CHARGE_CENTS - DRIFT_CENTS);
        expect(await charge()).toBeGreaterThanOrEqual(await countedCardRefundsPlusCompletedShortfall(task.id));
      });
    });

    // ---------------------------------------------------------------- races

    /** Hold a Payment row (example 1's unless told) on a third connection; the writers queue behind it. */
    async function holdPaymentRow(paymentId = example.ids.payment) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const holding = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const held = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${paymentId} FOR NO KEY UPDATE`;
          ready();
          await released;
        },
        { timeout: 20_000 },
      );
      await holding;
      return { release, held };
    }

    /** Wait until `count` backends of this database are blocked, whoever holds them up. */
    async function waitForBlocked(count: number, what: string) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
        if ((rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${what} to queue on the payment row.`);
    }

    /** Start `first`, wait until it queues on the held row, then `second`, and release them in that order. */
    async function inOrder<T, U>(first: () => Promise<T>, second: () => Promise<U>, paymentId = example.ids.payment) {
      const holder = await holdPaymentRow(paymentId);
      const settle = <V>(run: () => Promise<V>) =>
        run().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      let one: ReturnType<typeof settle<T>> | undefined;
      let two: ReturnType<typeof settle<U>> | undefined;
      try {
        one = settle(first);
        await waitForBlocked(1, "the first writer");
        two = settle(second);
        await waitForBlocked(2, "the second writer");
      } finally {
        // Released whatever happened (#5376 review): a writer that never queued then fails as itself, where a hold
        // left open showed up as the next hook's timeout. The writers already started finish before this returns.
        holder.release();
        await holder.held;
        await Promise.all([one, two]);
      }
      return [await one!, await two!] as const;
    }

    describe("the shortfall's completion and the late refund's failure racing on the Payment row", () => {
      async function closedWithLostRefundRecorded() {
        await cancelledWithCardRefundDead();
        await example.closeCardRefund();
        const lost = await example.stripeRefund("re_race_4488_race", EXAMPLE_CARD_CENTS, "pending");
        await example.syncCardCharge([lost]);
        expect(await example.mirrors()).toEqual({ payment: EXAMPLE_CARD_CENTS, a: EXAMPLE_CARD_CENTS, b: 0, retained: EXAMPLE_BANK_CENTS });
        return lost;
      }

      it("completion first: the failure reads the completed shortfall, and both charges keep their bank cash", async () => {
        const lost = await closedWithLostRefundRecorded();

        const [completed, failed] = await inOrder(() => example.resolveShortfall(), () => example.deliverFailure(lost));
        expect(completed.ok && failed.ok).toBe(true);

        expect(await example.mirrors()).toEqual({ payment: EXAMPLE_PRICE_CENTS, a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, retained: 0 });
        expect(await example.shortfallTask()).toMatchObject({ status: "COMPLETED", amountCents: EXAMPLE_BANK_CENTS });
        expect(await raisedRows()).toEqual([rowOfItsOwn(lost.id, EXAMPLE_CARD_CENTS)]);
        expect(await owedNow()).toBe(0);
        expect(await auditFinding()).toBeNull();
      });

      it("failure first: the close's $200 stays, and the completion is refused while the failed-later row is unsettled", async () => {
        const lost = await closedWithLostRefundRecorded();

        const [failed, completed] = await inOrder(() => example.deliverFailure(lost), () => example.resolveShortfall());
        expect(failed.ok).toBe(true);
        expect(completed).toMatchObject({ ok: false, error: { status: 409 } });

        expect(await example.mirrors()).toEqual({ payment: EXAMPLE_CARD_CENTS, a: EXAMPLE_CARD_CENTS, b: 0, retained: EXAMPLE_BANK_CENTS });
        expect(await example.shortfallTask()).toMatchObject({ status: "OPEN" });
        expect(await raisedRows()).toEqual([rowOfItsOwn(lost.id, EXAMPLE_CARD_CENTS)]);
        expect(await auditFinding()).toBeNull();
      });
    });
  },
);
