/**
 * Real-PostgreSQL proof of #4147: the booking-ledger census reads a capacity
 * race's cancel by its own refund rows and by what its snapshot says it owes
 * back, through the REAL capacity race (`markBookingPaymentSucceeded` losing
 * the capacity claim), the REAL back-post that confirms it on the ledger
 * (`runBookingLedgerBackPost`), the REAL recovery runner
 * (`runPaymentRecoveryOperationNow`) and the census's own store
 * (`readBookingLedgerCensusRow`).
 *
 * - The capacity race's refund still being sent: the back-post can post the
 *   booking, its PRICE is `IN_FLIGHT_REFUND` for the whole charge - before
 *   #4147 the census also read the charge as planned short and refused it -
 *   and once the runner makes the refund, every identity agrees.
 * - The refund made inline: the back-post posts it and every identity agrees.
 * - Either way the store hands the census the snapshot's capacity-race
 *   figures (`cancellation.capacityRace`), and a dead refund row disagrees.
 *
 * A plan short of the charge (mirror-vs-ledger drift) cannot be made through
 * the real writers here: the unit suite proves it, and the empty plan, on lines
 * the real planners wrote (`booking-ledger-projection-census.test.ts`).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4147-` fixtures. No Stripe call is made: the refund goes to the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4147-member";
const LODGE_ID = "race-4147-lodge";
const BOOKING_ID = "race-4147-booking";
const GUESTS = ["race-4147-g1", "race-4147-g2"];
const INTENT = "pi_race_4147";
const CHARGE_CENTS = 20_000;
// A stay well after today.
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Capacity-race census proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run capacity-race census proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Capacity-race census proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Capacity-race census proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let markBookingPaymentSucceeded: (typeof import("@/lib/payment-reconciliation"))["markBookingPaymentSucceeded"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let runBookingLedgerBackPost: (typeof import("@/lib/booking-ledger-back-post"))["runBookingLedgerBackPost"];
let readBookingLedgerCensusRow: (typeof import("@/lib/booking-ledger-projection-census-store"))["readBookingLedgerCensusRow"];
let evaluateBookingLedgerIdentities: (typeof import("@/lib/booking-ledger-projection-census"))["evaluateBookingLedgerIdentities"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "the ledger census reads a capacity race's cancel by its own refund rows — real PostgreSQL (#4147)",
  { timeout: 60_000 },
  () => {
    async function clean(): Promise<void> {
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      const payments = await prisma.payment.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      const paymentIds = payments.map((payment) => payment.id);
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, ...paymentIds] } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    /** A $200 booking - two guests, two nights at $50 - awaiting its card payment. This lodge has no beds, so the claim fails. */
    async function seedBooking(): Promise<void> {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: CHARGE_CENTS, finalPriceCents: CHARGE_CENTS },
      });
      for (const id of GUESTS) {
        await prisma.bookingGuest.create({
          data: {
            id,
            bookingId: BOOKING_ID,
            firstName: "Census",
            lastName: id,
            ageTier: "ADULT",
            isMember: true,
            stayStart: D1,
            stayEnd: CHECK_OUT,
            priceCents: 10_000,
            nights: { create: [{ stayDate: D1, priceCents: 5_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
          },
        });
      }
    }

    /** Stripe makes every refund it is asked for, or (`unreachable`) cannot be reached. */
    function stripeRefunds(answer: "make" | "unreachable") {
      stripeRaceHooks.refund = async (args) => {
        if (answer === "unreachable") throw new Error("race-4147: Stripe unreachable");
        return {
          id: `re_race_4147_${args.idempotencyKey ?? "one"}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4147",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
    }

    /** The card payment completing after the dates filled. */
    async function capacityRace() {
      return markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: INTENT, amountCents: CHARGE_CENTS, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    }

    async function judged() {
      const row = await readBookingLedgerCensusRow(prisma, BOOKING_ID);
      const evaluation = evaluateBookingLedgerIdentities(row!);
      return {
        row: row!,
        price: evaluation.identities.find((each) => each.identity === "PRICE")!,
        disagreements: evaluation.identities.filter((each) => each.status === "DISAGREE").map((each) => each.identity),
        coverage: evaluation.coverage,
        integrity: evaluation.integrity,
      };
    }

    async function backPost(apply: boolean) {
      const run = await runBookingLedgerBackPost({ client: prisma, apply, bookingIds: [BOOKING_ID] });
      return run.outcomes[0]!;
    }

    const raceRow = () => prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "capacity_claim_failed_refund_recovery_" } } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ runBookingLedgerBackPost } = await import("@/lib/booking-ledger-back-post"));
      ({ readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store"));
      ({ evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Capacity", lastName: "Census", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4147 Lodge", slug: "race-4147" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await clean();
      await seedBooking();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("the refund still being sent: the back-post posts it as IN_FLIGHT_REFUND, and once the runner makes it every identity agrees", async () => {
      stripeRefunds("unreachable");
      expect((await capacityRace()).outcome).not.toBe("paid");
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).toEqual({ status: "CANCELLED" });
      const pending = await raceRow();
      expect(pending).toMatchObject({ amountCents: CHARGE_CENTS });
      expect(pending.status).not.toBe("SUCCEEDED");

      // What the store hands the census from the real CANCELLED snapshot.
      const before = await judged();
      expect(before.row.cancellation).toEqual({ refundMethod: "card", settledAmountCents: CHARGE_CENTS, keptCents: null, capacityRace: { paidAmountCents: CHARGE_CENTS, retainedAmountCents: 0 } });
      // Never confirmed on the ledger: the back-post's to confirm.
      expect(before.coverage).toContain("NOT_CONFIRMED_ON_LEDGER");

      // The dry run and the apply judge the booking by the census: it posts, a class to acknowledge.
      expect(await backPost(false)).toMatchObject({ kind: "POSTED", classes: ["IN_FLIGHT_REFUND"] });
      expect(await backPost(true)).toMatchObject({ kind: "POSTED", classes: ["IN_FLIGHT_REFUND"] });
      const posted = await judged();
      expect(posted.price).toMatchObject({ status: "CLASSIFIED", deltaCents: CHARGE_CENTS, explainedBy: [{ name: "IN_FLIGHT_REFUND", cents: CHARGE_CENTS }] });
      expect(posted.disagreements).toEqual([]);
      expect(posted.coverage).toEqual([]);
      expect(posted.integrity).toEqual([]);

      // Its retry comes due and Stripe makes it.
      stripeRefunds("make");
      await prisma.paymentRecoveryOperation.update({ where: { id: pending.id }, data: { nextRetryAt: new Date("2020-01-01T00:00:00.000Z") } });
      expect(await runPaymentRecoveryOperationNow(pending.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      const made = await judged();
      expect(made.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(made.disagreements).toEqual([]);
      expect(made.integrity).toEqual([]);
    });

    it("the refund row dead (retries spent) disagrees: nothing will send it", async () => {
      stripeRefunds("unreachable");
      await capacityRace();
      expect(await backPost(true)).toMatchObject({ kind: "POSTED" });
      const pending = await raceRow();
      await prisma.paymentRecoveryOperation.update({ where: { id: pending.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null, lastError: "card closed" } });
      expect((await judged()).price).toMatchObject({ status: "DISAGREE", deltaCents: CHARGE_CENTS, explainedBy: [] });
    });

    it("the refund made inline: the back-post posts it and every identity agrees", async () => {
      stripeRefunds("make");
      expect((await capacityRace()).outcome).toBe("cancelled_refunded");
      expect((await raceRow()).status).toBe("SUCCEEDED");

      expect(await backPost(true)).toMatchObject({ kind: "POSTED", classes: [] });
      const result = await judged();
      expect(result.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(result.disagreements).toEqual([]);
      expect(result.coverage).toEqual([]);
      expect(result.integrity).toEqual([]);
    });
  },
);
