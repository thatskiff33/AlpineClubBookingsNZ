/**
 * Real-PostgreSQL proof of #4083 and #4096 (`INV-PAY-128`): a card refund Stripe
 * answered `failed` or `canceled` on a booking edit or a cancellation is still
 * owed, and its retry asks under a fresh key.
 *
 * What a mock can only imitate, run here against the database:
 *
 * - The edit door's enqueue is one row per booking edit: a second enqueue (a
 *   retry of the after-commit step) writes no second row, and never re-plans a
 *   row a worker has picked up - its plan, amount and prefix stand.
 * - The runner moves a refused slice to its next key ONLY on the attempt it
 *   holds: the write is fenced on PROCESSING and the claim's own
 *   `processingStartedAt`, so an attempt the stale reaper has since handed back
 *   (or one that already closed) moves nothing, and the generation never skips.
 * - "Refunds owed" (`openCardRefundOwedCents`, read through
 *   `netCollectedCardRefundSelect`) counts the queued row at what Stripe
 *   refused, keeps counting it through a second refusal, and stops once a
 *   refund of that slice is made after the row was raised.
 * - An approved refund request's row (#4102, #4117), raised after its attempt:
 *   its made slice is filled by its own refund id, and that refund fills no
 *   older row's slice of the same transaction and amount.
 * - The REAL `cancelBooking`, with a Stripe double answering the refund
 *   `failed`: the booking is cancelled, its pre-persisted refund row stays
 *   PENDING, re-planned to the refused slice on its next key, and "Refunds owed"
 *   counts it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4083-` fixtures. No Stripe call is made: the runner's refund is handed
 * to its seam, and the cancel's to the harness's one shared `@/lib/stripe`
 * double (`support/stripe-race-double.ts`), a pass-through unless hooked.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4083-member";
const LODGE_ID = "race-4083-lodge";
const BOOKING_ID = "race-4083-booking";
const PAYMENT_ID = "race-4083-payment";
const PRIMARY_TXN = "race-4083-txn-primary";
const ADDITIONAL_TXN = "race-4083-txn-additional";
const MODIFICATION_ID = "race-4083-mod";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const EDITED_AT = new Date("2026-06-20T00:00:00.000Z");
const RETRIED_AT = new Date("2026-06-20T00:10:00.000Z");

const PRIMARY_CENTS = 14_000;
const ADDITIONAL_CENTS = 6_000;
// A $100.00 edit refund: $60.00 made from the newer charge, $40.00 refused on the older one.
const MADE_CENTS = 6_000;
const REFUSED_CENTS = 4_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refused-refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refused-refund proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Refused-refund proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Refused-refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let enqueueBookingModificationRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueBookingModificationRefundRecovery"];
let refundPlanOrRetryRefusals: (typeof import("@/lib/refused-card-refund-retry"))["refundPlanOrRetryRefusals"];
let inlineRefundAfterAttempt: (typeof import("@/lib/refused-card-refund-retry"))["inlineRefundAfterAttempt"];
let keepRefusedPrePersistedRefundOwed: (typeof import("@/lib/refused-card-refund-retry"))["keepRefusedPrePersistedRefundOwed"];
let enqueueEditFinancialReviewRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueEditFinancialReviewRefundRecovery"];
let buildEditFinancialReviewRefundRecoveryIdempotencyKey: (typeof import("@/lib/payment-recovery-keys"))["buildEditFinancialReviewRefundRecoveryIdempotencyKey"];
let openCardRefundOwedByOperation: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedByOperation"];
let enqueueRefundRequestRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueRefundRequestRefundRecovery"];
let parseRefundAllocationPlan: (typeof import("@/lib/open-card-refund-owed"))["parseRefundAllocationPlan"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

const REFUSED_SLICE = { paymentTransactionId: PRIMARY_TXN, amountCents: REFUSED_CENTS };
/** Read refused at the door, so queued already on its next key. */
const QUEUED_SLICE = { ...REFUSED_SLICE, stripeKeySuffix: "refused1" };
const OPERATION_KEY = `payment_recovery_modification_refund_${MODIFICATION_ID}`;

// #4096: a second booking, cancelled for real.
const CANCEL_BOOKING_ID = "race-4083-cancel-booking";
const CANCEL_PAYMENT_ID = "race-4083-cancel-payment";
const CANCEL_TXN = "race-4083-cancel-txn";
const CANCEL_INTENT = "pi_race_4083_cancel";
const CANCEL_CENTS = 20_000;
const CANCEL_ADDITIONAL_TXN = "race-4083-cancel-txn-additional";
const CANCEL_ADDITIONAL_INTENT = "pi_race_4083_cancel_additional";

(RUN ? describe : describe.skip)(
  "a card refund Stripe refused stays owed and is retried under a fresh key — real PostgreSQL (#4083)",
  { timeout: 20_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: "late-capture-approval-close-lost:" } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteCancelRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: CANCEL_BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [CANCEL_PAYMENT_ID, CANCEL_BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: CANCEL_PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: CANCEL_PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: CANCEL_PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: CANCEL_BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await deleteCancelRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function recordRefund(id: string, transactionId: string, amountCents: number, status: string, at: Date) {
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID,
          paymentTransactionId: transactionId,
          stripeRefundId: id,
          amountCents,
          currency: "nzd",
          status,
          stripeCreatedAt: at,
          createdAt: at,
        },
      });
    }

    async function owedNow(paymentId = PAYMENT_ID): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** The edit door's enqueue, exactly as `executeBookingModificationRefund` sends it. */
    async function queueRefusedSlice(
      plan: Array<{ paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string }> = [QUEUED_SLICE],
      amountCents = REFUSED_CENTS,
    ) {
      return enqueueBookingModificationRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        bookingModificationId: MODIFICATION_ID,
        amountCents,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
        allocationPlan: plan,
      });
    }

    const queuedRow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPERATION_KEY } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ enqueueBookingModificationRefundRecovery, enqueueRefundRequestRefundRecovery, enqueueEditFinancialReviewRefundRecovery } = await import("@/lib/payment-recovery"));
      ({ refundPlanOrRetryRefusals, inlineRefundAfterAttempt, keepRefusedPrePersistedRefundOwed } = await import("@/lib/refused-card-refund-retry"));
      ({ parseRefundAllocationPlan, openCardRefundOwedCents, openCardRefundOwedByOperation } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ buildEditFinancialReviewRefundRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Refused",
          lastName: "Refund",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4083 Lodge", slug: "race-4083" } });
      // #4096: one tier, all of it back, so the cancellation refunds the whole capture to the card.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: PRIMARY_CENTS + ADDITIONAL_CENTS - MADE_CENTS - REFUSED_CENTS,
          finalPriceCents: PRIMARY_CENTS + ADDITIONAL_CENTS - MADE_CENTS - REFUSED_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRIMARY_CENTS + ADDITIONAL_CENTS,
          // Only the made slice counts; the refused one sent nothing back.
          refundedAmountCents: MADE_CENTS,
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: PRIMARY_TXN,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_4083_primary",
          amountCents: PRIMARY_CENTS,
          status: "SUCCEEDED",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: ADDITIONAL_TXN,
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_4083_additional",
          amountCents: ADDITIONAL_CENTS,
          refundedAmountCents: MADE_CENTS,
          status: "REFUNDED",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      // The edit's refund as `refundPaymentTransactions` recorded it: one made, one refused.
      await recordRefund("re_race_4083_made", ADDITIONAL_TXN, MADE_CENTS, "succeeded", EDITED_AT);
      await recordRefund("re_race_4083_refused", PRIMARY_TXN, REFUSED_CENTS, "failed", EDITED_AT);
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    });

    it("an edit's made-but-unrecorded refund is marked by slice evidence after charge.refunded (#3984, #4510)", async () => {
      const { executeBookingModificationRefund } = await import("@/lib/booking-modification-settlement");
      const { syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions");
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      await deletePaymentRows();
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10000, source: "STRIPE", status: "SUCCEEDED" } });
      await prisma.paymentTransaction.create({ data: { id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE",
        stripePaymentIntentId: "pi_race_4083_primary", amountCents: 10000, status: "SUCCEEDED" } });
      const refunds = new Map<string, Stripe.Refund>();
      const keys: string[] = [];
      let restoreFault: (() => void) | undefined;
      resetStripeRaceHooks();
      stripeRaceHooks.refund = async (request) => {
        const key = request.idempotencyKey!;
        keys.push(key);
        if (!refunds.has(key)) refunds.set(key, { id: `re_race_3984_${refunds.size}`, amount: request.amountCents,
          currency: "nzd", status: "succeeded", payment_intent: request.paymentIntentId, charge: "ch_race_3984",
          created: 1782864000, metadata: request.metadata } as Stripe.Refund);
        if (keys.length === 1) {
          const fault = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("recording failed after Stripe succeeded"));
          restoreFault = () => fault.mockRestore();
        }
        return refunds.get(key);
      };
      try {
        const outcome = await executeBookingModificationRefund({ format: CLUB_FORMAT_TEST, bookingId: BOOKING_ID,
          result: { pendingRefundAmountCents: 8000, paymentId: PAYMENT_ID, bookingModificationId: MODIFICATION_ID, organiserChildRefund: null } as never,
          idempotencyKeyPrefix: `mod_dates_refund_${BOOKING_ID}`, failureMessage: "test refund failed", recoveryFailureMessage: "test enqueue failed" });
        restoreFault?.();
        expect(outcome.refundDestination).toBe("own_card_pending");
        expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
        const row = await queuedRow();
        expect(row.allocationPlan).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: 8000 }]);

        await syncRefundsFromStripeCharge({ stripeChargeId: "ch_race_3984", paymentIntentId: "pi_race_4083_primary",
          refundedAmountCents: 8000, refunds: [...refunds.values()] });
        expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: PRIMARY_TXN } })).refundedAmountCents).toBe(8000);
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(keys).toEqual([`mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}_${PRIMARY_TXN}_8000`]);
        expect((await queuedRow()).allocationPlan).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: 8000, madeRefundId: "re_race_3984_0" }]);
        expect([...refunds.values()].reduce((sum, refund) => sum + refund.amount, 0)).toBe(8000);
        expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
        expect((await queuedRow()).status).toBe("SUCCEEDED");
      } finally {
        restoreFault?.();
        resetStripeRaceHooks();
      }
    });

    it.each(["unchanged", "plan", "status", "claim"])("slice evidence is guarded by the real stored plan and runner claim: %s (#4510)", async (change) => {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const { refundSliceStripeIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      await queueRefusedSlice([REFUSED_SLICE]);
      const row = await queuedRow();
      const refund = { id: "re_race_4510", amount: REFUSED_CENTS, currency: "nzd", status: "succeeded",
        charge: "ch_race_4510", payment_intent: "pi_race_4083_primary", created: 1782604800,
        metadata: { bookingId: BOOKING_ID, reason: "date_change_price_decrease", refundSliceKey: refundSliceStripeIdempotencyKey(row.stripeKeyPrefix!, REFUSED_SLICE) },
      } as unknown as Stripe.Refund;
      resetStripeRaceHooks();
      stripeRaceHooks.listRefunds = async () => [refund];
      const send = vi.fn(async () => { throw new Error("a marked or lost-claim slice must never be sent"); });
      stripeRaceHooks.refund = send;
      const updateMany = prisma.paymentRecoveryOperation.updateMany.bind(prisma.paymentRecoveryOperation);
      const guardedWrite = vi.spyOn(prisma.paymentRecoveryOperation, "updateMany").mockImplementation((async (args: Parameters<typeof updateMany>[0]) => {
        if (args.data.allocationPlan && change !== "unchanged") {
          await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data:
            change === "plan" ? { allocationPlan: [{ ...REFUSED_SLICE, stripeKeySuffix: "refused1" }] } :
            change === "status" ? { status: "FAILED" } :
            { processingStartedAt: new Date("2026-07-01T00:00:01.000Z") },
          });
        }
        return updateMany(args);
      }) as unknown as typeof updateMany);
      try {
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe(change === "unchanged" ? "succeeded" : "failed");
        expect(send).not.toHaveBeenCalled();
        const after = await queuedRow();
        expect(after.allocationPlan).toEqual(change === "unchanged" ? [{ ...REFUSED_SLICE, madeRefundId: refund.id }] :
          change === "plan" ? [{ ...REFUSED_SLICE, stripeKeySuffix: "refused1" }] : [REFUSED_SLICE]);
        expect(await prisma.paymentRefund.count({ where: { stripeRefundId: refund.id } })).toBe(1);
      } finally {
        guardedWrite.mockRestore();
        resetStripeRaceHooks();
      }
    });

    it("a second enqueue of the edit's refusal writes no second row, and never re-plans a row a worker holds", async () => {
      expect(await owedNow()).toBe(0);

      expect(await queueRefusedSlice()).toMatchObject({ created: true });
      expect(await queueRefusedSlice()).toMatchObject({ created: false });
      const rows = await prisma.paymentRecoveryOperation.findMany({ where: { paymentId: PAYMENT_ID } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "REFUND_BOOKING_MODIFICATION",
        status: "PENDING",
        amountCents: REFUSED_CENTS,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
      });
      // Queued already on its next key: the runner's first attempt asks Stripe afresh.
      expect(parseRefundAllocationPlan(rows[0]?.allocationPlan)).toEqual([QUEUED_SLICE]);

      // A worker picks it up. A later enqueue with another plan and amount changes nothing.
      await prisma.paymentRecoveryOperation.update({
        where: { idempotencyKey: OPERATION_KEY },
        data: { status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-20T00:05:00.000Z") },
      });
      expect(await queueRefusedSlice([REFUSED_SLICE, { paymentTransactionId: ADDITIONAL_TXN, amountCents: 1 }], 4_001)).toMatchObject({ created: false });
      const held = await queuedRow();
      expect(held).toMatchObject({ status: "PROCESSING", amountCents: REFUSED_CENTS });
      expect(parseRefundAllocationPlan(held.allocationPlan)).toEqual([QUEUED_SLICE]);
    });

    it("Refunds owed counts what Stripe refused, through a second refusal, until a retry makes it", async () => {
      await queueRefusedSlice();
      // Raised after the edit's refunds were recorded, as the door raises it.
      await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: OPERATION_KEY }, data: { createdAt: new Date("2026-06-20T00:00:01.000Z") } });
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The runner's retry under `refused1` is refused again: not progress.
      await recordRefund("re_race_4083_refused_again", PRIMARY_TXN, REFUSED_CENTS, "canceled", RETRIED_AT);
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The next retry is made: the slice is filled, nothing is owed.
      await recordRefund("re_race_4083_retried", PRIMARY_TXN, REFUSED_CENTS, "succeeded", new Date("2026-06-20T00:20:00.000Z"));
      expect(await owedNow()).toBe(0);
    });

    // #4102, #4117 (money F1): an approved refund request raises its row AFTER
    // its inline attempt, so a refund that attempt made predates the row. The
    // row marks that slice with its refund, and "Refunds owed" fills it by that
    // id - so it is never counted owed here, and never taken as an OLDER open
    // row's unsent slice of the same transaction and amount.
    it("an approved refund request's row: its made slice, made before the row, is filled by its own refund and by nothing else", async () => {
      // An older open row with an unsent slice exactly like the made one.
      await queueRefusedSlice([{ paymentTransactionId: ADDITIONAL_TXN, amountCents: MADE_CENTS }], MADE_CENTS);
      await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: OPERATION_KEY }, data: { createdAt: new Date("2026-06-19T00:00:00.000Z") } });

      const made = { paymentTransactionId: ADDITIONAL_TXN, amountCents: MADE_CENTS };
      const answers = [
        { status: "succeeded", refundId: "re_race_4083_made", paymentIntentId: "pi_race_4083_additional" },
        { status: "failed", refundId: "re_race_4083_refused", paymentIntentId: "pi_race_4083_primary" },
      ];
      const read = inlineRefundAfterAttempt([made, REFUSED_SLICE], { refunds: answers });
      expect(read.plan).toEqual([{ ...made, madeRefundId: "re_race_4083_made" }, QUEUED_SLICE]);
      expect(
        await enqueueRefundRequestRefundRecovery({
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          refundRequestId: "race-4102-request",
          amountCents: MADE_CENTS + REFUSED_CENTS,
          allocationPlan: read.plan,
        }),
      ).toMatchObject({ created: true });
      const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: "refund_request_refund_race-4102-request" } });
      // Raised a second after the attempt's refunds were recorded, as the route raises it.
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { createdAt: new Date("2026-06-20T00:00:01.000Z") } });
      expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual(read.plan);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      const owed = openCardRefundOwedByOperation(payment);
      // Only the refused $40.00 is the request's to send.
      expect(owed.get(row.id)).toBe(REFUSED_CENTS);
      // The older row's $60.00 is still owed: the request's made refund is not its.
      const older = await queuedRow();
      expect(owed.get(older.id)).toBe(MADE_CENTS);
      expect(await owedNow()).toBe(MADE_CENTS + REFUSED_CENTS);
    });

    it("the runner moves a refused slice only on the attempt it holds, and never skips a generation", async () => {
      await queueRefusedSlice();
      const queued = await queuedRow();
      const claimedAt = new Date("2026-06-20T00:05:00.000Z");
      await prisma.paymentRecoveryOperation.update({
        where: { id: queued.id },
        data: { status: "PROCESSING", attempts: 1, processingStartedAt: claimedAt },
      });
      const held = (processingStartedAt: Date) => ({ id: queued.id, idempotencyKey: queued.idempotencyKey, bookingId: BOOKING_ID, paymentIntentId: queued.paymentIntentId, processingStartedAt });
      const refusedAnswer = (slice: { paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string }) => async () => ({
        refunds: [{ status: "failed", slice, refundId: "re_race_4083_runner", paymentIntentId: queued.paymentIntentId }],
      });
      const planNow = async () => parseRefundAllocationPlan((await queuedRow()).allocationPlan);
      const twice = { ...REFUSED_SLICE, stripeKeySuffix: "refused2" };

      // The attempt this worker holds: `refused1` is refused again, so it moves to `refused2`.
      await expect(
        refundPlanOrRetryRefusals({ operation: held(claimedAt), plan: [QUEUED_SLICE], format: CLUB_FORMAT_TEST, refund: refusedAnswer(QUEUED_SLICE) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);

      // A stale attempt (the reaper handed the row back and it was claimed again)
      // reads `refused2` refused too, but its fence misses: nothing moves.
      const reclaimedAt = new Date("2026-06-20T00:30:00.000Z");
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { processingStartedAt: reclaimedAt } });
      await expect(
        refundPlanOrRetryRefusals({ operation: held(claimedAt), plan: [twice], format: CLUB_FORMAT_TEST, refund: refusedAnswer(twice) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);

      // A closed row is never written, whoever reads a refusal.
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { status: "SUCCEEDED", succeededAt: RETRIED_AT } });
      await expect(
        refundPlanOrRetryRefusals({ operation: held(reclaimedAt), plan: [twice], format: CLUB_FORMAT_TEST, refund: refusedAnswer(twice) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);
    });

    // #4103 (`INV-PAY-130`): a door whose row is written BEFORE its attempt - here
    // the edit financial review's - re-plans that row on a refusal only while no
    // worker has touched it, and "Refunds owed" counts the refused slice.
    it("an edit review's pre-persisted row is re-planned on a refusal only while PENDING with no attempt, and counts as owed (#4103)", async () => {
      await enqueueEditFinancialReviewRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        taskId: "race-4103-task",
        amountCents: REFUSED_CENTS,
        allocationPlan: [REFUSED_SLICE],
      });
      const key = buildEditFinancialReviewRefundRecoveryIdempotencyKey("race-4103-task");
      const rowNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: key } });
      const refused = (slice: typeof REFUSED_SLICE) => ({
        refunds: [{ status: "failed", slice, refundId: "re_race_4103_refused", paymentIntentId: "pi_race_4083_primary" }],
      });

      const error = await keepRefusedPrePersistedRefundOwed({ bookingId: BOOKING_ID, idempotencyKey: key, attempt: refused(REFUSED_SLICE), format: CLUB_FORMAT_TEST });
      expect(error?.replanned).toBe(true);
      const moved = await rowNow();
      expect(moved).toMatchObject({ status: "PENDING", attempts: 0, amountCents: REFUSED_CENTS, lastError: error?.message });
      expect(parseRefundAllocationPlan(moved.allocationPlan)).toEqual([QUEUED_SLICE]);
      expect(openCardRefundOwedByOperation(
        await prisma.payment.findUniqueOrThrow({
          where: { id: PAYMENT_ID },
          select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
        }),
      ).get(moved.id)).toBe(REFUSED_CENTS);

      // A worker claims it. A replay of the door reads the refusal again and moves nothing.
      await prisma.paymentRecoveryOperation.update({ where: { id: moved.id }, data: { status: "PROCESSING", attempts: 1, processingStartedAt: RETRIED_AT } });
      const replay = await keepRefusedPrePersistedRefundOwed({ bookingId: BOOKING_ID, idempotencyKey: key, attempt: refused(REFUSED_SLICE), format: CLUB_FORMAT_TEST });
      expect(replay?.replanned).toBe(false);
      expect(parseRefundAllocationPlan((await rowNow()).allocationPlan)).toEqual([QUEUED_SLICE]);
    });

    // #4126: the late-capture approval's happy-path close claims only the row as
    // the approval left it - PENDING, never attempted, on the plan it sent
    // (`untouchedPrePersistedRowWhere`). Each case moves the row on in ONE of
    // those ways while the refund is in flight, so each clause is load-bearing
    // on its own; a close it wins writes the record exactly once.
    describe("the late-capture approval's inline close (#4126)", () => {
      const ROUTE = {
        kind: "late-capture-refund" as const,
        paymentId: PAYMENT_ID,
        paymentIntentId: "pi_race_4083_primary",
        captureKind: "modification" as const,
        bookingModificationId: null,
        allocation: [REFUSED_SLICE],
      };
      const MADE_REFUND = "re_race_4126_made";
      const RECORD_ACTION = "booking.payment.refunded_after_cancellation";
      let key: string;
      let approval: typeof import("@/lib/late-capture-refund-approval");

      const rowNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: key } });
      const lostCloseAlerts = async () =>
        (await prisma.alertCooldown.findMany({ where: { key: { startsWith: "late-capture-approval-close-lost:" } } })).map((row) => row.key);
      const records = () => prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: RECORD_ACTION } });
      const persist = () =>
        prisma.$transaction((tx) => approval.persistLateCaptureApprovalRefundDebt({ bookingId: BOOKING_ID, route: ROUTE, amountCents: REFUSED_CENTS, store: tx }));
      const approve = () =>
        approval.executeLateCaptureApprovalRefund({ bookingId: BOOKING_ID, taskId: "race-4126-task", actingMemberId: MEMBER_ID, route: ROUTE, amountCents: REFUSED_CENTS, format: CLUB_FORMAT_TEST });
      /** Stripe makes the refund - the same one for every ask under the same keys, as an idempotent replay answers. */
      const made = (args: { amountCents: number; paymentIntentId: string; metadata?: Record<string, string> }) => ({
        id: MADE_REFUND,
        object: "refund",
        amount: args.amountCents,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
        charge: "ch_race_4126",
        payment_intent: args.paymentIntentId,
        metadata: args.metadata ?? {},
      });
      /** While the refund is in flight, another writer moves the row on. */
      const movedMidFlight = (data: Parameters<typeof prisma.paymentRecoveryOperation.update>[0]["data"]) => {
        stripeRaceHooks.refund = async (args) => {
          await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: key }, data });
          return made(args);
        };
      };
      /** The record is written fire-and-forget (`logAudit`): wait for it, then for nothing more. */
      const settledRecords = async (expected: number) => {
        await vi.waitFor(async () => expect(await records()).toBe(expected), { timeout: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await records()).toBe(expected);
      };

      beforeAll(async () => {
        approval = await import("@/lib/late-capture-refund-approval");
        const { buildLateCaptureApprovalRefundRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
        key = buildLateCaptureApprovalRefundRecoveryIdempotencyKey(ROUTE.paymentIntentId);
      });

      beforeEach(async () => {
        resetStripeRaceHooks();
        await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
        await persist();
      });

      afterAll(async () => {
        resetStripeRaceHooks();
      });

      it("closes the row the approval left untouched, and writes the record once", async () => {
        stripeRaceHooks.refund = async (args) => made(args);
        expect(await approve()).toBe(MADE_REFUND);
        expect(await rowNow()).toMatchObject({ status: "SUCCEEDED", attempts: 0 });
        await settledRecords(1);
      });

      it("status: a second approval of a row already closed closes nothing and writes no second record", async () => {
        stripeRaceHooks.refund = async (args) => made(args);
        await approve();
        await settledRecords(1);
        // The row is SUCCEEDED, still attempts 0, on the same plan: only the status clause holds it.
        await approve();
        await settledRecords(1);
      });

      it("attempts: a row tried and handed back PENDING mid-flight is left to the runner", async () => {
        movedMidFlight({ attempts: 1 });
        await approve();
        expect(await rowNow()).toMatchObject({ status: "PENDING", attempts: 1, succeededAt: null });
        await settledRecords(0);
        expect(await lostCloseAlerts()).toEqual([]);
      });

      // A re-plan of this row moves a slice only after Stripe refused it, so it
      // cannot follow an approval whose every slice was made; one is forced here
      // to prove the plan clause holds the close off on its own. The row is then
      // untouched but not closable: the anomaly is alerted, not closed.
      it("plan: a row whose plan changed mid-flight is not closed", async () => {
        movedMidFlight({ allocationPlan: [QUEUED_SLICE] });
        await approve();
        expect(await rowNow()).toMatchObject({ status: "PENDING", attempts: 0, succeededAt: null });
        expect(parseRefundAllocationPlan((await rowNow()).allocationPlan)).toEqual([QUEUED_SLICE]);
        await settledRecords(0);
        // Claimed once for the row (held for a day: the fixture has no admin to receive it).
        expect(await lostCloseAlerts()).toEqual([`late-capture-approval-close-lost:${(await rowNow()).id}`]);
      });

      it("a row the runner really claimed mid-flight is not closed by the approval; the runner's replay closes it and writes the record once", async () => {
        // As `claimPaymentRecoveryOperation` writes it - an attempt since abandoned, so the runner's stale sweep hands it back.
        movedMidFlight({ status: "PROCESSING", attempts: { increment: 1 }, processingStartedAt: new Date("2026-06-01T00:00:00.000Z") });
        await approve();
        expect(await rowNow()).toMatchObject({ status: "PROCESSING", attempts: 1, succeededAt: null });
        await settledRecords(0);
        expect(await lostCloseAlerts()).toEqual([]);

        // Preflight adopts Stripe's slice evidence; no refund is sent again.
        const asked: Array<string | undefined> = [];
        stripeRaceHooks.refund = async (args) => {
          asked.push(args.idempotencyKey);
          return made(args);
        };
        const { processPaymentRecoveryOperations } = await import("@/lib/payment-recovery");
        await processPaymentRecoveryOperations({ limit: 50 });
        expect(asked).toEqual([]);
        expect(await rowNow()).toMatchObject({ status: "SUCCEEDED", allocationPlan: [{ ...REFUSED_SLICE, madeRefundId: MADE_REFUND }] });
        await settledRecords(1);
        const [record] = await prisma.auditLog.findMany({ where: { targetId: BOOKING_ID, action: RECORD_ACTION } });
        expect(JSON.parse(record!.details ?? "{}")).toMatchObject({ refundId: MADE_REFUND, amountCents: REFUSED_CENTS });
      });
    });

    // #4144: the other four pre-persisted doors close their row while it is open
    // and still on the plan the door sent (`sentPlanRowWhere`). The window: the
    // door's refund is made, the runner claims the row and its attempt fails, a
    // refund Stripe failed later re-plans the row (`card-refund-failed-later.ts`
    // moves the slice to its next key and names the failure), and only then does
    // the door's close run. Each door's own close, on its own row: a re-planned
    // row is left open and owed, an untouched or runner-held one on the same plan
    // is closed, and a closed one is not closed twice.
    describe("the pre-persisted doors' inline close (#4144)", () => {
      const TASK_ID = "race-4144-task";
      const INTENT = "pi_race_4083_primary";
      const PLAN = [
        { paymentTransactionId: PRIMARY_TXN, amountCents: REFUSED_CENTS },
        { paymentTransactionId: ADDITIONAL_TXN, amountCents: MADE_CENTS },
      ];
      const PLAN_CENTS = REFUSED_CENTS + MADE_CENTS;
      let recovery: typeof import("@/lib/payment-recovery");
      let keys: typeof import("@/lib/payment-recovery-keys");
      let events: typeof import("@/lib/booking-events");

      const refundedEvents = () => prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, type: "REFUNDED" } });
      /** As the failed-later writer leaves it: tried, a retry due, the failed slice on its next key naming the failure. */
      const failedLaterReplan = () => ({
        status: "FAILED" as const,
        attempts: 1,
        nextRetryAt: new Date("2026-07-01T01:00:00.000Z"),
        allocationPlan: [{ ...PLAN[0]!, stripeKeySuffix: "refused1", failedRefundIds: ["re_race_4144_failed_later"] }, PLAN[1]!],
      });
      /** As `claimPaymentRecoveryOperation` leaves it, on the same plan. */
      const runnerClaim = () => ({ status: "PROCESSING" as const, attempts: 1, processingStartedAt: new Date("2026-07-01T00:00:00.000Z") });

      type Door = { name: string; key: () => string; enqueue: () => Promise<unknown>; close: () => Promise<number> };
      const doors: Door[] = [
        {
          name: "the cancellation",
          key: () => keys.buildBookingCancellationRefundIdempotencyKey(BOOKING_ID),
          enqueue: () => recovery.enqueueBookingCancellationRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: PLAN_CENTS, allocationPlan: PLAN }),
          close: async () => (await recovery.markBookingCancellationRefundRecoverySucceeded({ idempotencyKey: keys.buildBookingCancellationRefundIdempotencyKey(BOOKING_ID), sentPlan: PLAN })).count,
        },
        {
          name: "the edit financial review",
          key: () => keys.buildEditFinancialReviewRefundRecoveryIdempotencyKey(TASK_ID),
          enqueue: () => recovery.enqueueEditFinancialReviewRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, taskId: TASK_ID, amountCents: PLAN_CENTS, allocationPlan: PLAN }),
          close: async () => (await recovery.markEditFinancialReviewRefundRecoverySucceeded({ idempotencyKey: keys.buildEditFinancialReviewRefundRecoveryIdempotencyKey(TASK_ID), sentPlan: PLAN })).count,
        },
        {
          name: "the duplicate capture",
          key: () => keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_ID, INTENT),
          enqueue: () => recovery.enqueueDuplicateCaptureRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: INTENT, amountCents: PLAN_CENTS, allocationPlan: PLAN }),
          close: async () => (await recovery.markDuplicateCaptureRefundRecoverySucceeded({ idempotencyKey: keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_ID, INTENT), sentPlan: PLAN })).count,
        },
        {
          // #4125: the close and its REFUNDED event commit together, the event only when this close moved the row.
          name: "the capacity race",
          key: () => keys.buildCapacityClaimFailedRefundRecoveryIdempotencyKey(BOOKING_ID, INTENT),
          enqueue: () => recovery.enqueueCapacityClaimFailedRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: INTENT, amountCents: PLAN_CENTS, allocationPlan: PLAN }),
          close: async () =>
            (await events.closeCapacityRaceRefundRecordingEvent({ bookingId: BOOKING_ID, amountCents: PLAN_CENTS, actorMemberId: MEMBER_ID }, async (tx) =>
              (await recovery.markCapacityClaimFailedRefundRecoverySucceeded({ idempotencyKey: keys.buildCapacityClaimFailedRefundRecoveryIdempotencyKey(BOOKING_ID, INTENT), sentPlan: PLAN, store: tx })).count === 1))
              ? 1
              : 0,
        },
      ];

      beforeAll(async () => {
        recovery = await import("@/lib/payment-recovery");
        keys = await import("@/lib/payment-recovery-keys");
        events = await import("@/lib/booking-events");
      });

      beforeEach(async () => {
        await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      });

      afterAll(async () => {
        await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      });

      describe.each(doors)("$name", (door) => {
        const rowNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: door.key() } });
        const isCapacityRace = door.name === "the capacity race";

        beforeEach(async () => {
          await door.enqueue();
          expect(parseRefundAllocationPlan((await rowNow()).allocationPlan)).toEqual(PLAN);
        });

        it("closes the row it left untouched, once", async () => {
          expect(await door.close()).toBe(1);
          expect(await rowNow()).toMatchObject({ status: "SUCCEEDED", attempts: 0 });
          // status: a second close of a row already closed closes nothing, so writes no second record.
          expect(await door.close()).toBe(0);
          expect(await refundedEvents()).toBe(isCapacityRace ? 1 : 0);
        });

        it("closes a row the runner holds on the same plan - its replay is answered with this refund, and its own close then records nothing", async () => {
          await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: door.key() }, data: runnerClaim() });
          expect(await door.close()).toBe(1);
          expect(await rowNow()).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
          expect(await refundedEvents()).toBe(isCapacityRace ? 1 : 0);
        });

        it("plan: leaves open a row the runner tried and a failed-later refund re-planned - still owed, and recorded by nobody", async () => {
          const replanned = failedLaterReplan();
          await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: door.key() }, data: replanned });
          expect(await door.close()).toBe(0);
          expect(await rowNow()).toMatchObject({ status: "FAILED", attempts: 1, succeededAt: null, nextRetryAt: replanned.nextRetryAt });
          expect(parseRefundAllocationPlan((await rowNow()).allocationPlan)).toEqual(replanned.allocationPlan);
          expect(await refundedEvents()).toBe(0);
        });
      });

      // One door end to end, through its real close and lost-close read-back: the
      // re-plan lands while Stripe makes the refund, as in the window above.
      describe("the edit financial review's door, the row moved while its refund is in flight", () => {
        const ROUTE = { paymentId: PAYMENT_ID, allocation: [REFUSED_SLICE], refundCents: REFUSED_CENTS };
        const ALERT_KEY = "edit-review-close-lost:";
        const rowNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: keys.buildEditFinancialReviewRefundRecoveryIdempotencyKey(TASK_ID) } });
        const lostCloseAlerts = async () => (await prisma.alertCooldown.findMany({ where: { key: { startsWith: ALERT_KEY } } })).map((row) => row.key);
        const refund = async () => {
          const { executeEditReviewCardRefund } = await import("@/lib/edit-financial-review-card-refund");
          return executeEditReviewCardRefund({ bookingId: BOOKING_ID, taskId: TASK_ID, actingMemberId: MEMBER_ID, route: ROUTE, format: CLUB_FORMAT_TEST });
        };
        const movedMidFlight = (data: Parameters<typeof prisma.paymentRecoveryOperation.update>[0]["data"]) => {
          stripeRaceHooks.refund = async (args) => {
            await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: keys.buildEditFinancialReviewRefundRecoveryIdempotencyKey(TASK_ID) }, data });
            return {
              id: "re_race_4144_made",
              object: "refund",
              amount: args.amountCents,
              currency: "nzd",
              status: "succeeded",
              reason: "requested_by_customer",
              created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
              charge: "ch_race_4144",
              payment_intent: args.paymentIntentId,
              metadata: args.metadata ?? {},
            };
          };
        };

        beforeEach(async () => {
          resetStripeRaceHooks();
          await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: ALERT_KEY } } });
          await recovery.enqueueEditFinancialReviewRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, taskId: TASK_ID, amountCents: REFUSED_CENTS, allocationPlan: ROUTE.allocation });
        });

        afterAll(async () => {
          resetStripeRaceHooks();
          await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: ALERT_KEY } } });
        });

        it("a failed-later re-plan after the runner tried it: the row stays open and owed, logged, not alerted", async () => {
          const replanned = { ...failedLaterReplan(), allocationPlan: [{ ...REFUSED_SLICE, stripeKeySuffix: "refused1", failedRefundIds: ["re_race_4144_failed_later"] }] };
          movedMidFlight(replanned);
          expect(await refund()).toBe("re_race_4144_made");
          expect(await rowNow()).toMatchObject({ status: "FAILED", attempts: 1, succeededAt: null });
          expect(parseRefundAllocationPlan((await rowNow()).allocationPlan)).toEqual(replanned.allocationPlan);
          expect(await lostCloseAlerts()).toEqual([]);
        });

        it("a runner claim on the same plan: the door closes it", async () => {
          movedMidFlight(runnerClaim());
          expect(await refund()).toBe("re_race_4144_made");
          expect(await rowNow()).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
          expect(await lostCloseAlerts()).toEqual([]);
        });

        // Nothing should move an untouched row's plan while its refund is made;
        // one is forced here: the close holds off, and the anomaly is alerted once for the row.
        it("a plan moved on a row still untouched: not closed, and alerted once for the row", async () => {
          movedMidFlight({ allocationPlan: [QUEUED_SLICE] });
          expect(await refund()).toBe("re_race_4144_made");
          expect(await rowNow()).toMatchObject({ status: "PENDING", attempts: 0, succeededAt: null });
          expect(await lostCloseAlerts()).toEqual([`${ALERT_KEY}${(await rowNow()).id}`]);
        });
      });
    });

    // #4103 (`INV-PAY-130`): the superseded-payment runner's row carries no plan
    // until Stripe refuses it; the refusal writes a one-slice plan on its next key,
    // on the attempt held, and "Refunds owed" keeps counting it as that slice.
    it("a superseded payment's refusal moves to a one-slice plan on the attempt held, still owed (#4103)", async () => {
      const claimedAt = new Date("2026-06-20T00:05:00.000Z");
      const row = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_SUPERSEDED_PAYMENT",
          status: "PROCESSING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: "pi_race_4083_primary",
          paymentTransactionId: PRIMARY_TXN,
          amountCents: REFUSED_CENTS,
          idempotencyKey: "payment_recovery_refund_race-4103-superseded",
          attempts: 1,
          processingStartedAt: claimedAt,
          nextRetryAt: claimedAt,
        },
      });
      const owed = async () =>
        openCardRefundOwedByOperation(
          await prisma.payment.findUniqueOrThrow({
            where: { id: PAYMENT_ID },
            select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
          }),
        ).get(row.id);
      expect(await owed()).toBe(REFUSED_CENTS);

      await expect(
        refundPlanOrRetryRefusals({
          operation: { id: row.id, idempotencyKey: row.idempotencyKey, bookingId: BOOKING_ID, paymentIntentId: row.paymentIntentId, processingStartedAt: claimedAt },
          plan: [REFUSED_SLICE],
          format: CLUB_FORMAT_TEST,
          refund: async () => ({ refunds: [{ status: "canceled", slice: REFUSED_SLICE, refundId: "re_race_4103_superseded", paymentIntentId: row.paymentIntentId }] }),
        }),
      ).rejects.toThrow(/still owed/);
      const after = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("PROCESSING");
      expect(parseRefundAllocationPlan(after.allocationPlan)).toEqual([QUEUED_SLICE]);
      expect(await owed()).toBe(REFUSED_CENTS);
    });

    describe("the REAL cancelBooking, Stripe answering the card refund refused (#4096)", () => {
      beforeEach(async () => {
        resetStripeRaceHooks();
        await deleteCancelRows();
        await prisma.booking.create({
          data: {
            id: CANCEL_BOOKING_ID,
            memberId: MEMBER_ID,
            lodgeId: LODGE_ID,
            checkIn: NIGHT,
            checkOut: CHECK_OUT,
            status: "PAID",
            totalPriceCents: CANCEL_CENTS,
            finalPriceCents: CANCEL_CENTS,
          },
        });
        await prisma.payment.create({
          data: {
            id: CANCEL_PAYMENT_ID,
            bookingId: CANCEL_BOOKING_ID,
            amountCents: CANCEL_CENTS,
            source: "STRIPE",
            status: "SUCCEEDED",
            stripePaymentIntentId: CANCEL_INTENT,
            transactions: {
              create: {
                id: CANCEL_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: CANCEL_INTENT,
                amountCents: CANCEL_CENTS,
                status: "SUCCEEDED",
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
            },
          },
        });
      });

      afterAll(async () => {
        resetStripeRaceHooks();
      });

      it.each(["failed", "canceled"])("Stripe answers %s: the booking is cancelled and its refund stays owed, re-planned on a fresh key", async (status) => {
        const asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];
        stripeRaceHooks.refund = async (args) => {
          asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
          return {
            id: `re_race_4083_cancel_${status}`,
            object: "refund",
            amount: args.amountCents,
            currency: "nzd",
            status,
            reason: "requested_by_customer",
            created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
            charge: "ch_race_4083_cancel",
            payment_intent: args.paymentIntentId,
            metadata: args.metadata ?? {},
          };
        };
        const { cancelBooking } = await import("@/lib/booking-cancel");

        const result = await cancelBooking(CANCEL_BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");

        expect(result.status).toBe(200);
        expect(asked).toEqual([{ idempotencyKey: `booking_cancel_refund_${CANCEL_BOOKING_ID}_${CANCEL_TXN}_${CANCEL_CENTS}`, amountCents: CANCEL_CENTS }]);
        expect(await prisma.booking.findUniqueOrThrow({ where: { id: CANCEL_BOOKING_ID }, select: { status: true } })).toEqual({ status: "CANCELLED" });
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
          where: { idempotencyKey: `booking_cancel_refund_recovery_${CANCEL_BOOKING_ID}` },
        });
        expect(row).toMatchObject({
          status: "PENDING",
          attempts: 0,
          amountCents: CANCEL_CENTS,
          lastError: "Stripe refused $200.00 of this card refund (failed or cancelled), so that $200.00 did not go back and is still owed.",
        });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: CANCEL_TXN, amountCents: CANCEL_CENTS, stripeKeySuffix: "refused1" },
        ]);
        // Recorded, not counted: nothing went back, and the whole refund is owed.
        expect(await prisma.paymentRefund.findMany({ where: { paymentId: CANCEL_PAYMENT_ID }, select: { status: true } })).toEqual([{ status }]);
        expect(await owedNow(CANCEL_PAYMENT_ID)).toBe(CANCEL_CENTS);
      }, 60_000);

      it("one charge refunded, the other refused: the made slice stays in the plan, marked; the amount stays the plan's; only the refused part is owed", async () => {
        // A $60.00 top-up on the $200.00 booking, refunded first (newest first).
        await prisma.paymentTransaction.update({ where: { id: CANCEL_TXN }, data: { amountCents: CANCEL_CENTS - 6_000 } });
        await prisma.paymentTransaction.create({
          data: {
            id: CANCEL_ADDITIONAL_TXN,
            paymentId: CANCEL_PAYMENT_ID,
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: CANCEL_ADDITIONAL_INTENT,
            amountCents: 6_000,
            status: "SUCCEEDED",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        });
        stripeRaceHooks.refund = async (args) => ({
          id: `re_race_4083_${args.paymentIntentId}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: args.paymentIntentId === CANCEL_ADDITIONAL_INTENT ? "succeeded" : "failed",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        });
        const { cancelBooking } = await import("@/lib/booking-cancel");

        expect((await cancelBooking(CANCEL_BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);

        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
          where: { idempotencyKey: `booking_cancel_refund_recovery_${CANCEL_BOOKING_ID}` },
        });
        expect(row).toMatchObject({ status: "PENDING", amountCents: CANCEL_CENTS });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: CANCEL_ADDITIONAL_TXN, amountCents: 6_000, madeRefundId: `re_race_4083_${CANCEL_ADDITIONAL_INTENT}` },
          { paymentTransactionId: CANCEL_TXN, amountCents: CANCEL_CENTS - 6_000, stripeKeySuffix: "refused1" },
        ]);
        // The made $60.00 fills its marked slice; the refused $140.00 is owed.
        expect(await owedNow(CANCEL_PAYMENT_ID)).toBe(CANCEL_CENTS - 6_000);
      }, 60_000);
    });
  },
);
