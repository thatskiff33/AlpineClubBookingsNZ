/**
 * Real-PostgreSQL proof of #4911 (`INV-PAY-154`): a paid cancel of a booking
 * whose card capture the cardholder disputes issues no card refund and no
 * account credit, and hands the whole refund due to the treasurer.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `cancelBooking`, which reads the `StripeDispute` record in its claim:
 *
 * - A lost dispute, then a cancel choosing account credit: no `MemberCredit`
 *   row, no refund taken off the payment, and ONE `CANCELLED_BOOKING_HAND_BACK`
 *   task for the refund due whose reason names the dispute.
 * - A lost dispute, then a cancel choosing a card refund: no Stripe refund
 *   call, no recovery operation queued, and the same one task.
 * - A won dispute restores the normal path: a credit cancel credits the
 *   member's account and raises no task.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4911-` fixtures. No Stripe call is made: a refund would go to the
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

const MEMBER_ID = "race-4911-member";
const LODGE_ID = "race-4911-lodge";
const BOOKING_ID = "race-4911-booking";
const PAYMENT_ID = "race-4911-payment";
const CARD_TXN = "race-4911-txn-card";
const INTENT = "pi_race_4911";
const DISPUTE_ID = "dp_race_4911";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PRICE_CENTS = 20_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Stripe dispute cancel proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run Stripe dispute cancel proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Stripe dispute cancel proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Stripe dispute cancel proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a disputed card capture is never refunded or credited by a cancel - real PostgreSQL (#4911)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      const credits = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { id: true } });
      await prisma.xeroSyncOperation.deleteMany({
        where: { localId: { in: [PAYMENT_ID, BOOKING_ID, ...credits.map((credit) => credit.id)] } },
      });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.stripeDispute.deleteMany({ where: { stripeDisputeId: DISPUTE_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function cancel(method: "card" | "credit") {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      return cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, method);
    }

    async function recordDispute(status: "LOST" | "WON") {
      const opened = new Date("2026-06-20T00:00:00.000Z");
      await prisma.stripeDispute.create({
        data: {
          stripeDisputeId: DISPUTE_ID,
          stripeChargeId: "ch_race_4911",
          stripePaymentIntentId: INTENT,
          paymentTransactionId: CARD_TXN,
          paymentId: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          currency: "nzd",
          reason: "fraudulent",
          status,
          stripeStatus: status === "LOST" ? "lost" : "won",
          stripeCreatedAt: opened,
          lastEventCreatedAt: opened,
          stripeEventId: "evt_race_4911",
        },
      });
    }

    /** The cancel hands the whole refund due to the treasurer, naming the dispute, and moves no money. */
    async function expectHandedToTreasurer() {
      expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } })).toBe(0);
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } }))
        .toEqual({ refundedAmountCents: 0 });
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        status: "OPEN",
        paymentId: PAYMENT_ID,
        amountCents: PRICE_CENTS,
        raisedAmountCents: PRICE_CENTS,
      });
      expect(tasks[0]!.reason).toContain(DISPUTE_ID);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } }))
        .toEqual({ status: "CANCELLED" });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Disputed",
          lastName: "Card",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4911 Lodge", slug: "race-4911" } });
      // One tier, all of it back: the cancellation's refund is the whole $200.00.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: INTENT,
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: CARD_TXN,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: INTENT,
          amountCents: PRICE_CENTS,
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

    it("a lost dispute, then a cancel choosing credit: no credit, and one treasurer task naming the dispute", async () => {
      await recordDispute("LOST");

      const result = await cancel("credit");

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { refundMethod: "manual", refundDisputed: true, refundAmountCents: PRICE_CENTS } });
      await expectHandedToTreasurer();
    });

    it("a lost dispute, then a cancel choosing a card refund: no Stripe refund, and one treasurer task naming the dispute", async () => {
      await recordDispute("LOST");
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        throw new Error("a disputed capture must never reach Stripe's refund call");
      };

      const result = await cancel("card");

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { refundMethod: "manual", refundDisputed: true, refundAmountCents: PRICE_CENTS } });
      expect(asked).toEqual([]);
      await expectHandedToTreasurer();
    });

    it("a won dispute restores the normal path: a credit cancel credits the account and raises no task", async () => {
      await recordDispute("WON");

      const result = await cancel("credit");

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { refundMethod: "credit" } });
      expect(result).not.toMatchObject({ data: { refundDisputed: true } });
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      const credits = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { amountCents: true } });
      expect(credits.reduce((sum, credit) => sum + credit.amountCents, 0)).toBe(PRICE_CENTS);
    });
  },
);
