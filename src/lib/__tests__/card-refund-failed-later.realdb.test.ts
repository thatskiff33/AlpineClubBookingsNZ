/**
 * Real-PostgreSQL proof of #4104 (`INV-PAY-128`): a card refund Stripe accepted
 * (`pending`) and failed later is owed again.
 *
 * What a mock can only imitate, run here against the database:
 *
 * - Each door's refund - the REAL `cancelBooking`'s, an edit's, an approved
 *   refund request's, the runner's - recorded `pending`, then reported failed by
 *   the webhook's recorder (`recordRefusedCardRefund`): the refunded total falls
 *   back, ONE new refund row owes exactly that refund on its own charge, and
 *   "Refunds owed" (`openCardRefundOwedCents`) counts it once - a closed door
 *   row beside it is not counted again.
 * - A replay of the event, and two deliveries at once, write one row and take
 *   the refund out of the total once (the Payment row lock and the guarded
 *   counted -> refused write).
 * - The event arriving before the door has recorded the refund: the door's own
 *   write, told `pending`, finds the row refused and keeps it owed.
 * - An unknown refund on an unknown payment writes nothing; a refund made by
 *   hand in the Stripe dashboard is taken out of the total but not re-sent.
 * - The new row's retry is a request Stripe has never seen, under its own key
 *   and reason; a retry that fails later too is raised dead, for Paid another way.
 * - A refund an open row marked made (#4083) re-plans that row onto its next
 *   key; one a worker holds is refused and the whole write rolls back.
 * - The payments cron's read-back finds a failure no event delivered.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4104-` fixtures. No Stripe call is made: refunds go through the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import type Stripe from "stripe";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4104-member";
const LODGE_ID = "race-4104-lodge";
const BOOKING_ID = "race-4104-booking";
const PAYMENT_ID = "race-4104-payment";
const TXN_ID = "race-4104-txn";
const INTENT_ID = "pi_race_4104";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_CENTS = 20_000;
const REFUND_CENTS = 4_000;
/** When the door's refund was made: before its row closed, after it was raised. */
const REFUNDED_AT_SECONDS = Math.floor(Date.parse("2026-06-20T00:00:05.000Z") / 1000);

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Failed-later refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run failed-later refund proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Failed-later refund proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Failed-later refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let reconcilePendingCardRefunds: (typeof import("@/lib/card-refund-status-sync"))["reconcilePendingCardRefunds"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let parseRefundAllocationPlan: (typeof import("@/lib/open-card-refund-owed"))["parseRefundAllocationPlan"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let deadCardRefundOperationWhere: (typeof import("@/lib/card-refund-paid-another-way"))["deadCardRefundOperationWhere"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

/** A Stripe refund as the webhook and the refund call carry it. */
function stripeRefund(id: string, status: string, metadata: Record<string, string> | null, amount = REFUND_CENTS): Stripe.Refund {
  return {
    id,
    object: "refund",
    amount,
    currency: "nzd",
    status,
    reason: "requested_by_customer",
    created: REFUNDED_AT_SECONDS,
    charge: "ch_race_4104",
    payment_intent: INTENT_ID,
    metadata,
  } as unknown as Stripe.Refund;
}

const failedLaterKey = (refundId: string) => `card_refund_failed_later_${refundId}`;
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
let markerFinishedAt: Date | null = null;

(RUN ? describe : describe.skip)(
  "a card refund Stripe accepted and failed later is owed again — real PostgreSQL (#4104)",
  { timeout: 30_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function setCutoff(at: Date) {
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${at} WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** The door's own write of the refund Stripe answered (`refundPaymentTransactions`). */
    const doorRecords = (refund: Stripe.Refund) =>
      recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, refunds: [refund], fallbackPaymentIntentId: INTENT_ID });

    const refundedTotal = async () =>
      (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents;

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    const failedLaterRows = () =>
      prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "card_refund_failed_later_" } } });

    /** A closed door row as the door leaves it: raised before the refund, closed after it. */
    async function closedDoorRow(idempotencyKey: string) {
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: INTENT_ID,
          amountCents: REFUND_CENTS,
          idempotencyKey,
          allocationPlan: [{ paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS }],
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          succeededAt: new Date("2026-06-20T00:00:10.000Z"),
          nextRetryAt: null,
        },
      });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund, reconcilePendingCardRefunds } = await import("@/lib/card-refund-status-sync"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ parseRefundAllocationPlan, openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ deadCardRefundOperationWhere } = await import("@/lib/card-refund-paid-another-way"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      // The cutoff marker (ops 8): finished well before these fixtures' refunds,
      // as on an install that took this release long ago; restored after.
      const [marker] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
      if (!marker) throw new Error(`The race database lacks ${CUTOFF_MIGRATION}: run prisma migrate deploy against it first.`);
      markerFinishedAt = marker.finished_at;
      await setCutoff(new Date("2026-01-01T00:00:00.000Z"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Failed",
          lastName: "Later",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4104 Lodge", slug: "race-4104" } });
      // One tier, all of it back: the real cancellation refunds the whole capture.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: INTENT_ID,
          transactions: {
            create: {
              id: TXN_ID,
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: INTENT_ID,
              amountCents: PAID_CENTS,
              status: "SUCCEEDED",
              createdAt: new Date("2026-05-01T00:00:00.000Z"),
            },
          },
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
      if (markerFinishedAt) await setCutoff(markerFinishedAt);
    });

    it.each([
      ["an edit's", { bookingId: BOOKING_ID, reason: "date_change_price_decrease" }, null],
      ["an approved refund request's", { bookingId: BOOKING_ID, reason: "refund_appeal_approved", refundRequestId: "rr-4104" }, "refund_request_refund_rr-4104"],
      ["the runner's", { bookingId: BOOKING_ID, reason: "booking_modification_refund_recovery" }, "payment_recovery_modification_refund_mod-4104"],
    ])("%s refund recorded pending then failed: taken back out once, owed once by one new row", async (_door, metadata, doorRowKey) => {
      if (doorRowKey) await closedDoorRow(doorRowKey);
      const refundId = `re_race_4104_${_door.length}`;
      await doorRecords(stripeRefund(refundId, "pending", metadata));
      expect(await refundedTotal()).toBe(REFUND_CENTS);
      expect(await owedNow()).toBe(0);

      expect(await recordRefusedCardRefund(stripeRefund(refundId, "failed", metadata))).toBe("recorded");
      expect(await refundedTotal()).toBe(0);
      const rows = await failedLaterRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "REFUND_BOOKING_MODIFICATION",
        status: "PENDING",
        attempts: 0,
        amountCents: REFUND_CENTS,
        paymentIntentId: INTENT_ID,
        idempotencyKey: failedLaterKey(refundId),
        stripeKeyPrefix: failedLaterKey(refundId),
      });
      // #4166: the door row that sent it, by its metadata, is recorded as its maker; with none, none.
      const doorRow = doorRowKey ? await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: doorRowKey } }) : null;
      expect(parseRefundAllocationPlan(rows[0]?.allocationPlan)).toEqual([{ paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, madeByOperationId: doorRow?.id ?? null }]);
      expect(await owedNow()).toBe(REFUND_CENTS);

      // The same event again: nothing more is written or taken out.
      expect(await recordRefusedCardRefund(stripeRefund(refundId, "failed", metadata))).toBe("recorded");
      expect(await failedLaterRows()).toHaveLength(1);
      expect(await refundedTotal()).toBe(0);
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    it("the REAL cancelBooking's refund, Stripe answering pending, then failing: the closed cancellation row stays closed and one new row owes it", async () => {
      stripeRaceHooks.refund = async (args) => ({
        ...stripeRefund("re_race_4104_cancel", "pending", args.metadata ?? null, args.amountCents),
        created: Math.floor(Date.now() / 1000),
      });
      const { cancelBooking } = await import("@/lib/booking-cancel");
      expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
      const cancellationRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}` },
      });
      expect(cancellationRow.status).toBe("SUCCEEDED");
      expect(await refundedTotal()).toBe(PAID_CENTS);
      expect(await owedNow()).toBe(0);

      const failed = { ...stripeRefund("re_race_4104_cancel", "failed", { bookingId: BOOKING_ID, reason: "cancellation" }, PAID_CENTS) };
      expect(await recordRefusedCardRefund(failed)).toBe("recorded");
      expect(await refundedTotal()).toBe(0);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: cancellationRow.id } })).status).toBe("SUCCEEDED");
      const rows = await failedLaterRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "PENDING", amountCents: PAID_CENTS, idempotencyKey: failedLaterKey("re_race_4104_cancel") });
      expect(await owedNow()).toBe(PAID_CENTS);
    }, 60_000);

    it("two deliveries at once take the refund out once and write one row", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "cancellation" };
      await doorRecords(stripeRefund("re_race_4104_twice", "pending", metadata));
      const failed = stripeRefund("re_race_4104_twice", "failed", metadata);
      await Promise.all([recordRefusedCardRefund(failed), recordRefusedCardRefund(failed), recordRefusedCardRefund(failed)]);
      expect(await failedLaterRows()).toHaveLength(1);
      expect(await refundedTotal()).toBe(0);
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    it("the event before the door's own write: the row is written refused, and the door, told pending, keeps it owed", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "date_change_price_decrease" };
      expect(await recordRefusedCardRefund(stripeRefund("re_race_4104_early", "failed", metadata))).toBe("recorded");
      expect(await failedLaterRows()).toHaveLength(0);
      expect(await refundedTotal()).toBe(0);

      await doorRecords(stripeRefund("re_race_4104_early", "pending", metadata));
      expect(await refundedTotal()).toBe(0);
      expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId: "re_race_4104_early" }, select: { status: true } })).toEqual({ status: "failed" });
      expect(await failedLaterRows()).toHaveLength(1);
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    it("an unknown refund on an unknown payment writes nothing; a dashboard refund is taken out but not re-sent", async () => {
      const stranger = { ...stripeRefund("re_race_4104_stranger", "failed", null), payment_intent: "pi_race_4104_unknown" } as Stripe.Refund;
      expect(await recordRefusedCardRefund(stranger)).toBe("not-a-card-payment");
      expect(await prisma.paymentRefund.findUnique({ where: { stripeRefundId: "re_race_4104_stranger" } })).toBeNull();

      await doorRecords(stripeRefund("re_race_4104_dashboard", "pending", null));
      expect(await refundedTotal()).toBe(REFUND_CENTS);
      await recordRefusedCardRefund(stripeRefund("re_race_4104_dashboard", "failed", null));
      expect(await refundedTotal()).toBe(0);
      expect(await failedLaterRows()).toHaveLength(0);
    });

    it("the retry asks under a key Stripe has never seen; one that fails later too is raised dead, for Paid another way", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "cancellation" };
      await doorRecords(stripeRefund("re_race_4104_first", "pending", metadata));
      await recordRefusedCardRefund(stripeRefund("re_race_4104_first", "failed", metadata));
      const [row] = await failedLaterRows();
      if (!row) throw new Error("no row raised");

      const asked: Array<{ idempotencyKey?: string; metadata?: Record<string, string> }> = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push({ idempotencyKey: args.idempotencyKey, metadata: args.metadata });
        return { ...stripeRefund("re_race_4104_retry", "pending", args.metadata ?? null, args.amountCents), created: Math.floor(Date.now() / 1000) };
      };
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(asked).toEqual([
        {
          idempotencyKey: `${failedLaterKey("re_race_4104_first")}_${TXN_ID}_${REFUND_CENTS}`,
          // #4510 (INV-PAY-147): the keyed slice's own key, as its evidence.
          metadata: {
            bookingId: BOOKING_ID,
            reason: "card_refund_failed_later",
            refundSliceKey: `${failedLaterKey("re_race_4104_first")}_${TXN_ID}_${REFUND_CENTS}`,
          },
        },
      ]);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SUCCEEDED");
      expect(await refundedTotal()).toBe(REFUND_CENTS);
      expect(await owedNow()).toBe(0);

      // The retry fails later too: owed, and never asked for again automatically.
      await recordRefusedCardRefund(stripeRefund("re_race_4104_retry", "failed", { bookingId: BOOKING_ID, reason: "card_refund_failed_later" }));
      const dead = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: failedLaterKey("re_race_4104_retry") } });
      expect(dead).toMatchObject({ status: "PENDING", attempts: 5, amountCents: REFUND_CENTS });
      expect(await prisma.paymentRecoveryOperation.count({ where: { id: dead.id, ...deadCardRefundOperationWhere } })).toBe(1);
      expect(await runPaymentRecoveryOperationNow(dead.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await refundedTotal()).toBe(0);
      expect(await owedNow()).toBe(REFUND_CENTS);
    }, 60_000);

    describe("a refund an open row marked made beside a refusal (#4083)", () => {
      const plan = [
        { paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, madeRefundId: "re_race_4104_made" },
        { paymentTransactionId: TXN_ID, amountCents: 1_000, stripeKeySuffix: "refused1" },
      ];
      const OPEN_KEY = "payment_recovery_modification_refund_mod-4104-open";
      const metadata = { bookingId: BOOKING_ID, reason: "date_change_price_decrease" };

      beforeEach(async () => {
        await prisma.paymentRecoveryOperation.create({
          data: {
            type: "REFUND_BOOKING_MODIFICATION",
            status: "FAILED",
            attempts: 1,
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            paymentIntentId: INTENT_ID,
            amountCents: REFUND_CENTS + 1_000,
            idempotencyKey: OPEN_KEY,
            stripeKeyPrefix: "mod_dates_refund_race-4104",
            allocationPlan: plan,
            createdAt: new Date("2026-06-20T00:00:00.000Z"),
            nextRetryAt: new Date("2026-06-20T00:10:00.000Z"),
          },
        });
        await doorRecords(stripeRefund("re_race_4104_made", "pending", metadata));
      });

      it("re-plans that row - the slice unmarked, on its next key, recording the failure - and raises no second row", async () => {
        expect(await owedNow()).toBe(1_000);
        await recordRefusedCardRefund(stripeRefund("re_race_4104_made", "failed", metadata));
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPEN_KEY } });
        expect(row).toMatchObject({ status: "FAILED", attempts: 1, amountCents: REFUND_CENTS + 1_000 });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, stripeKeySuffix: "refused1", failedRefundIds: ["re_race_4104_made"] },
          plan[1],
        ]);
        expect(await failedLaterRows()).toHaveLength(0);
        expect(await owedNow()).toBe(REFUND_CENTS + 1_000);
      });

      it("one a worker holds is refused, and nothing commits: the event is sent again", async () => {
        await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: OPEN_KEY }, data: { status: "PROCESSING", processingStartedAt: new Date() } });
        await expect(recordRefusedCardRefund(stripeRefund("re_race_4104_made", "failed", metadata))).rejects.toThrow(/mid-attempt/);
        // Rolled back whole: the refund still counts, the plan is untouched.
        expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId: "re_race_4104_made" }, select: { status: true } })).toEqual({ status: "pending" });
        expect(await refundedTotal()).toBe(REFUND_CENTS);
        expect(parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPEN_KEY } })).allocationPlan)).toEqual(plan);
      });
    });

    describe("an open row whose UNMARKED slice the refund filled (#4104 review, money 1 and concurrency A)", () => {
      const OPEN_KEY = "booking_cancel_refund_recovery_race-4104-booking";
      const metadata = { bookingId: BOOKING_ID, reason: "cancellation" };

      beforeEach(async () => {
        // A cancellation whose close was lost: open, claimed once, every slice made.
        await prisma.paymentRecoveryOperation.create({
          data: {
            type: "REFUND_BOOKING_MODIFICATION",
            status: "FAILED",
            attempts: 1,
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            paymentIntentId: INTENT_ID,
            amountCents: REFUND_CENTS,
            idempotencyKey: OPEN_KEY,
            allocationPlan: [{ paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS }],
            createdAt: new Date("2026-06-20T00:00:00.000Z"),
            nextRetryAt: new Date("2026-06-20T00:10:00.000Z"),
          },
        });
        await doorRecords(stripeRefund("re_race_4104_unmarked", "pending", metadata));
      });

      it("MUTATION: that row owes it again on its next key - one row, owed once - and a second observer writes nothing", async () => {
        expect(await owedNow()).toBe(0);
        await recordRefusedCardRefund(stripeRefund("re_race_4104_unmarked", "failed", metadata));
        expect(await failedLaterRows()).toHaveLength(0);
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPEN_KEY } });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, stripeKeySuffix: "refused1", failedRefundIds: ["re_race_4104_unmarked"] },
        ]);
        expect(await owedNow()).toBe(REFUND_CENTS);

        // A late charge.refunded snapshot still carrying it pending, then failed again (concurrency A).
        await doorRecords(stripeRefund("re_race_4104_unmarked", "pending", metadata));
        await recordRefusedCardRefund(stripeRefund("re_race_4104_unmarked", "failed", metadata));
        expect(await failedLaterRows()).toHaveLength(0);
        expect(parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPEN_KEY } })).allocationPlan)).toEqual([
          { paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, stripeKeySuffix: "refused1", failedRefundIds: ["re_race_4104_unmarked"] },
        ]);
        expect(await owedNow()).toBe(REFUND_CENTS);
        expect(await refundedTotal()).toBe(0);
      });

      it("a row no worker has claimed yet is left to its door: the failure is refused, and nothing commits", async () => {
        await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: OPEN_KEY }, data: { status: "PENDING", attempts: 0 } });
        await expect(recordRefusedCardRefund(stripeRefund("re_race_4104_unmarked", "failed", metadata))).rejects.toThrow(/not yet claimed/);
        expect(await refundedTotal()).toBe(REFUND_CENTS);
        expect(await failedLaterRows()).toHaveLength(0);
      });
    });

    it("MUTATION (concurrency B): the failure before the door writes its marks - one row of its own, the door's marked slice read filled - owed once", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "refund_appeal_approved", refundRequestId: "rr-4104-b" };
      // The refund request's inline attempt: A made (pending), B refused.
      await doorRecords(stripeRefund("re_race_4104_a", "pending", metadata));
      await doorRecords(stripeRefund("re_race_4104_b", "failed", metadata, 1_000));
      // Stripe fails A before the door writes its row.
      await recordRefusedCardRefund(stripeRefund("re_race_4104_a", "failed", metadata));
      expect(await failedLaterRows()).toHaveLength(1);
      // The door now writes its row: A marked made, B on its next key.
      const { enqueueRefundRequestRefundRecovery } = await import("@/lib/payment-recovery");
      await enqueueRefundRequestRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        refundRequestId: "rr-4104-b",
        amountCents: REFUND_CENTS + 1_000,
        allocationPlan: [
          { paymentTransactionId: TXN_ID, amountCents: REFUND_CENTS, madeRefundId: "re_race_4104_a" },
          { paymentTransactionId: TXN_ID, amountCents: 1_000, stripeKeySuffix: "refused1" },
        ],
      });
      // A once (its own row), B once (the door's row) - never A twice.
      expect(await owedNow()).toBe(REFUND_CENTS + 1_000);
    });

    it("MUTATION (ops 8): a refund Stripe created before the cutoff is raised dead, never re-sent", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "cancellation" };
      await doorRecords(stripeRefund("re_race_4104_backlog", "pending", metadata));
      await setCutoff(new Date("2026-06-21T00:00:00.000Z"));
      try {
        await recordRefusedCardRefund(stripeRefund("re_race_4104_backlog", "failed", metadata));
      } finally {
        await setCutoff(new Date("2026-01-01T00:00:00.000Z"));
      }
      const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: failedLaterKey("re_race_4104_backlog") } });
      expect(row).toMatchObject({ status: "PENDING", attempts: 5 });
      expect(await prisma.paymentRecoveryOperation.count({ where: { id: row.id, ...deadCardRefundOperationWhere } })).toBe(1);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    it("the REAL cancelBooking marks a slice made before a later one threw (money 1), so its later failure is that row's", async () => {
      const SECOND_TXN = "race-4104-txn-second";
      const SECOND_INTENT = "pi_race_4104_second";
      await prisma.paymentTransaction.update({ where: { id: TXN_ID }, data: { amountCents: PAID_CENTS - 6_000 } });
      await prisma.paymentTransaction.create({
        data: { id: SECOND_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: SECOND_INTENT, amountCents: 6_000, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      });
      // Newest first: the top-up's slice is made (pending), the primary's throws.
      stripeRaceHooks.refund = async (args) => {
        if (args.paymentIntentId !== SECOND_INTENT) throw new Error("Stripe timed out");
        return { ...stripeRefund("re_race_4104_partial", "pending", args.metadata ?? null, args.amountCents), payment_intent: SECOND_INTENT, created: Math.floor(Date.now() / 1000) };
      };
      const { cancelBooking } = await import("@/lib/booking-cancel");
      expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
      const key = `booking_cancel_refund_recovery_${BOOKING_ID}`;
      expect(parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: key } })).allocationPlan)).toEqual([
        { paymentTransactionId: SECOND_TXN, amountCents: 6_000, madeRefundId: "re_race_4104_partial" },
        { paymentTransactionId: TXN_ID, amountCents: PAID_CENTS - 6_000 },
      ]);
      // Claimed once and waiting: the made slice's later failure moves it on this row.
      await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: key }, data: { status: "FAILED", attempts: 1 } });
      await recordRefusedCardRefund({ ...stripeRefund("re_race_4104_partial", "failed", { bookingId: BOOKING_ID, reason: "cancellation" }, 6_000), payment_intent: SECOND_INTENT } as Stripe.Refund);
      expect(await failedLaterRows()).toHaveLength(0);
      expect(parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: key } })).allocationPlan)?.[0]).toEqual({
        paymentTransactionId: SECOND_TXN,
        amountCents: 6_000,
        stripeKeySuffix: "refused1",
        failedRefundIds: ["re_race_4104_partial"],
      });
    }, 60_000);

    it("the payments cron's read-back finds a failure no event delivered, and stamps one still pending", async () => {
      const metadata = { bookingId: BOOKING_ID, reason: "refund_appeal_approved", refundRequestId: "rr-4104" };
      await doorRecords(stripeRefund("re_race_4104_missed", "pending", metadata));
      await doorRecords(stripeRefund("re_race_4104_still", "pending", metadata, 1_000));
      // Read long ago, so the stamp is visible under the frozen test clock.
      const longAgo = new Date("2026-06-01T00:00:00.000Z");
      await prisma.paymentRefund.update({ where: { stripeRefundId: "re_race_4104_still" }, data: { updatedAt: longAgo } });

      const retrieveRefund = async (id: string) =>
        id === "re_race_4104_missed" ? stripeRefund(id, "failed", metadata) : stripeRefund(id, "pending", metadata, 1_000);
      const result = await reconcilePendingCardRefunds({ retrieveRefund: retrieveRefund as never });
      expect(result.moved).toBe(1);
      expect(await failedLaterRows()).toHaveLength(1);
      expect(await refundedTotal()).toBe(1_000);
      const after = await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId: "re_race_4104_still" } });
      expect(after.status).toBe("pending");
      expect(after.updatedAt.getTime()).toBeGreaterThan(longAgo.getTime());
    });
  },
);
