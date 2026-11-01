/**
 * Real-PostgreSQL proof of #4125: the capacity race's card refund, made by the
 * recovery runner after the inline attempt failed, is recorded - a REFUNDED
 * booking event, so the member's history stops reading "on its way" - once,
 * for what the frozen plan refunded; and the booking page's read of the row
 * says where a refund no event records stands.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `enqueueCapacityClaimFailedRefundRecovery`, `runPaymentRecoveryOperationNow`
 * and `readCancelledCardRefund`:
 *
 * - The runner's replay makes the refund and writes ONE REFUNDED event for the
 *   plan's total; the inline close then closes nothing (count 0), and a second
 *   run claims nothing, so neither writes a second.
 * - The inline door closing the row while a worker is still sending it (the
 *   close lands inside the refund call): the worker's close finds the row
 *   closed and writes no event - the inline close owns it.
 * - The close and the event commit together: an event insert the database
 *   refuses rolls the close back, the row stays open, and the next run closes
 *   it and records it once.
 * - The row's state for the narrative, by the real `startsWith` read: still
 *   being sent, dead (retries spent) - which the narrative says the club will
 *   follow up - and made.
 * - #4145: a dead row closed "Paid another way" after one slice was made
 *   (`closeCardRefundPaidAnotherWay`): that slice is recorded once, as the
 *   capacity race's event, dated by Stripe's refund and marked as the close's.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4125-` fixtures. No Stripe call is made: the refund goes to the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4125-member";
const LODGE_ID = "race-4125-lodge";
const BOOKING_ID = "race-4125-booking";
const PAYMENT_ID = "race-4125-payment";
const TXN_ID = "race-4125-txn";
const INTENT = "pi_race_4125";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const CHARGE_CENTS = 12_000;
// The ledger showed less refundable than the charge at the claim: the plan, and so the refund, is this.
const PLANNED_CENTS = 9_000;
/** The plan the claim froze, and so the plan the inline door sends. */
const PLAN = [{ paymentTransactionId: TXN_ID, amountCents: PLANNED_CENTS }];
const ROW_KEY = `capacity_claim_failed_refund_recovery_${BOOKING_ID}_${INTENT}`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Capacity-race refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run capacity-race refund proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Capacity-race refund proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Capacity-race refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let enqueueCapacityClaimFailedRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueCapacityClaimFailedRefundRecovery"];
let markCapacityClaimFailedRefundRecoverySucceeded: (typeof import("@/lib/payment-recovery"))["markCapacityClaimFailedRefundRecoverySucceeded"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let readCancelledCardRefund: (typeof import("@/lib/cancel-card-refund-shortfall-status"))["readCancelledCardRefund"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
/** Where the row stands, as the page reads it. */
const readCancelledCardRefundState = async (bookingId: string) => (await readCancelledCardRefund(bookingId)).cardRefundState;
let CAPACITY_RACE_REFUND_EVENT_REASON: (typeof import("@/lib/booking-events"))["CAPACITY_RACE_REFUND_EVENT_REASON"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "the capacity race's refund made by the recovery runner is recorded once — real PostgreSQL (#4125)",
  { timeout: 20_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** Stripe makes every refund it is asked for, counting the asks. */
    function stripeMakesRefunds(during?: () => Promise<void>) {
      const asked = { count: 0 };
      stripeRaceHooks.refund = async (args) => {
        asked.count += 1;
        await during?.();
        // Stripe answers a repeated key with the refund it already made.
        return {
          id: `re_race_4125_${args.idempotencyKey ?? asked.count}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4125",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    /** The capacity claim's enqueue, as `markBookingPaymentSucceeded`'s claim transaction sends it. */
    async function queueCapacityRaceRefund() {
      await enqueueCapacityClaimFailedRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        paymentIntentId: INTENT,
        amountCents: PLANNED_CENTS,
        allocationPlan: PLAN,
      });
      return prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: ROW_KEY },
      });
    }

    const refundedEvents = () =>
      prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUNDED" },
        select: { amountCents: true, reason: true, actorMemberId: true },
      });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ enqueueCapacityClaimFailedRefundRecovery, markCapacityClaimFailedRefundRecoverySucceeded, runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ readCancelledCardRefund } = await import("@/lib/cancel-card-refund-shortfall-status"));
      ({ closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way"));
      ({ CAPACITY_RACE_REFUND_EVENT_REASON } = await import("@/lib/booking-events"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Capacity",
          lastName: "Race",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4125 Lodge", slug: "race-4125" } });
      // Cancelled by the capacity claim: the dates filled up while the payment went through.
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: CHARGE_CENTS,
          finalPriceCents: CHARGE_CENTS,
        },
      });
      // #4145: the real "paid another way" close loads cold here too: past the 10s default under load.
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: CHARGE_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: INTENT },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: TXN_ID,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: INTENT,
          amountCents: CHARGE_CENTS,
          status: "SUCCEEDED",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("the runner's replay records ONE REFUNDED event for the plan's total; a later inline close or run writes none", async () => {
      const asked = stripeMakesRefunds();
      const row = await queueCapacityRaceRefund();
      // The inline attempt failed, so the row is still being sent.
      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("on-its-way");
      expect(await refundedEvents()).toEqual([]);

      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(asked.count).toBe(1);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      expect(await refundedEvents()).toEqual([{ amountCents: PLANNED_CENTS, reason: CAPACITY_RACE_REFUND_EVENT_REASON, actorMemberId: null }]);

      // The inline door's close, arriving late, closes nothing - so it records nothing.
      expect(await markCapacityClaimFailedRefundRecoverySucceeded({ idempotencyKey: ROW_KEY, sentPlan: PLAN })).toEqual({ count: 0 });
      // A second run claims nothing.
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await refundedEvents()).toHaveLength(1);
      expect(asked.count).toBe(1);

      // Made, and recorded: the narrative reads the event; the row reads made.
      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("settled");
    });

    it("the inline close landing while a worker sends the refund: the worker's close finds it closed and writes no event", async () => {
      const row = await queueCapacityRaceRefund();
      stripeMakesRefunds(async () => {
        // The inline door's refund, answered by the same Stripe key, closes the row first.
        expect(await markCapacityClaimFailedRefundRecoverySucceeded({ idempotencyKey: ROW_KEY, sentPlan: PLAN })).toEqual({ count: 1 });
      });

      await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);

      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      // The inline close was the one that moved it, so the event is the inline door's to write.
      expect(await refundedEvents()).toEqual([]);
    });

    it("an event insert the database refuses rolls the close back: the row stays open, and the next run closes it and records it once", async () => {
      const asked = stripeMakesRefunds();
      const row = await queueCapacityRaceRefund();
      // Every REFUNDED insert for this booking is refused while the trigger stands.
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION race_4125_refuse_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'race-4125: event refused'; END $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER race_4125_refuse_event BEFORE INSERT ON "BookingEvent" FOR EACH ROW WHEN (NEW."bookingId" = '${BOOKING_ID}') EXECUTE FUNCTION race_4125_refuse_event()`,
      );
      try {
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("failed");
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4125_refuse_event ON "BookingEvent"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4125_refuse_event()`);
      }
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).status).not.toBe("SUCCEEDED");
      expect(await refundedEvents()).toEqual([]);

      // Its retry comes due. #4510 (INV-PAY-147): Stripe lists the refund with
      // this slice's key as its evidence, so the runner adopts it and asks Stripe
      // nothing more, and the close and event commit.
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { nextRetryAt: new Date("2020-01-01T00:00:00.000Z") } });
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(asked.count).toBe(1);
      expect(await refundedEvents()).toEqual([{ amountCents: PLANNED_CENTS, reason: CAPACITY_RACE_REFUND_EVENT_REASON, actorMemberId: null }]);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
    });

    it("#4145: a dead row closed \"Paid another way\" after one slice was made records that slice once, as the capacity race's event dated by Stripe's refund", async () => {
      // Two slices on the charge: Stripe makes the $60.00 one and refuses to answer for the $30.00 one.
      const plan = [
        { paymentTransactionId: TXN_ID, amountCents: 6_000 },
        { paymentTransactionId: TXN_ID, amountCents: 3_000 },
      ];
      stripeRaceHooks.refund = async (args) => {
        if (args.amountCents === 3_000) throw new Error("Stripe is unavailable (503)");
        return {
          id: `re_race_4125_${args.idempotencyKey}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          // Stripe's own time, a day past the app's frozen clock: the event is dated by this, not by the app's record.
          created: Math.floor(Date.UTC(2026, 6, 2) / 1000),
          charge: "ch_race_4125",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      await enqueueCapacityClaimFailedRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: INTENT, amountCents: PLANNED_CENTS, allocationPlan: plan });
      const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: ROW_KEY } });
      await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
      expect(await refundedEvents()).toEqual([]);
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });

      await closeCardRefundPaidAnotherWay({
        operationId: row.id,
        amountCents: 3_000,
        paidBack: "full",
        expectedOwedCents: 3_000,
        note: "Bank transfer, ref RACE 4125",
        actingMemberId: MEMBER_ID,
      });

      const events = await prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUNDED" },
        select: { amountCents: true, reason: true, actorMemberId: true, occurredAt: true, snapshot: true },
      });
      expect(events).toEqual([
        {
          amountCents: 6_000,
          reason: CAPACITY_RACE_REFUND_EVENT_REASON,
          actorMemberId: null,
          occurredAt: new Date("2026-07-02T00:00:00.000Z"),
          snapshot: { kind: "card_refund_made_before_paid_another_way" },
        },
      ]);
      expect(await readCancelledCardRefund(BOOKING_ID)).toEqual({ cardRefundState: "paid-another-way", cardRefundPlanCents: PLANNED_CENTS, cardRefundClose: { paidBackCents: 3_000, unpaidCents: 0, madeCents: 6_000 } });
    });

    it("a dead row reads as stalled - never on its way - and a row of another booking is not read", async () => {
      const row = await queueCapacityRaceRefund();
      await prisma.paymentRecoveryOperation.update({
        where: { id: row.id },
        data: { status: "FAILED", attempts: 5, nextRetryAt: null, lastError: "card closed" },
      });

      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("stalled");
      // A booking whose id is a prefix of this one's never reads its rows: the read's trailing underscore keeps them apart.
      expect(await readCancelledCardRefundState(BOOKING_ID.slice(0, -1))).toBeUndefined();
    });
  },
);
