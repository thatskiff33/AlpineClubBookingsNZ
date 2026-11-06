/**
 * Real-PostgreSQL proof of #4131 (`INV-PAY-106`, `INV-PAY-110`): the booking's
 * own payment captured after its booking was cancelled is refunded from ITS OWN
 * charge, never from a fee the cancel kept on another of the booking's charges.
 *
 * The REAL webhook processor (`processStripeWebhookEvent`) handles Stripe's
 * `payment_intent.succeeded` for the late capture on a cancelled booking whose
 * card was charged twice: the first intent stalled at checkout (its row is the
 * OLDER one), a second paid, and the cancel refunded all of the second but a
 * kept fee. Then:
 *
 * - The one refund asked of Stripe is on the late capture, for all of it, and
 *   the kept fee is untouched; the payment's refund-note gap - the nightly
 *   self-heal's reader - finds nothing to raise.
 * - A capture already part refunded on its own row is refunded only for what
 *   it holds.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4131-` fixtures. No Stripe call is made: refunds go through the
 * harness's one shared `@/lib/stripe` double
 * (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import type Stripe from "stripe";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4131-member";
const LODGE_ID = "race-4131-lodge";
const BOOKING_ID = "race-4131-booking";
const PAYMENT_ID = "race-4131-payment";
const LATE_TXN = "race-4131-txn-late";
const PAID_TXN = "race-4131-txn-paid";
const LATE_INTENT = "pi_race_4131_late";
const PAID_INTENT = "pi_race_4131_paid";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_CENTS = 30_000;
const KEPT_FEE_CENTS = 5_000;
const LATE_CENTS = 24_000;
const KEY_PREFIX = `late_cancel_refund_${BOOKING_ID}_${LATE_INTENT}`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let webhook: typeof import("@/lib/stripe-webhook-service");
let readRefundCreditNoteGap: (typeof import("@/lib/xero-admin-health"))["readRefundCreditNoteGap"];
let eventSequence = 0;

/** A Stripe refund as the refund call and the refund list carry it. */
function stripeRefund(
  id: string,
  paymentIntentId: string,
  amount: number,
  metadata: Record<string, string> | null,
  status = "succeeded",
): Stripe.Refund {
  return {
    id,
    object: "refund",
    amount,
    currency: "nzd",
    status,
    reason: "requested_by_customer",
    created: Math.floor(Date.parse("2026-06-25T00:00:00.000Z") / 1000),
    charge: `ch_${paymentIntentId}`,
    payment_intent: paymentIntentId,
    metadata,
  } as unknown as Stripe.Refund;
}

(RUN ? describe : describe.skip)(
  "a late capture is refunded from its own charge, never a fee kept on another - real PostgreSQL (#4131)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4131_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4131_" } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * The cancelled booking: the stalled intent's row (attached at checkout, so
     * OLDER), the charge that paid with all but the kept fee refunded at cancel,
     * that refund's row, and its credit note linked in Xero.
     */
    async function seed({ lateRefundedCents = 0 }: { lateRefundedCents?: number } = {}) {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS + lateRefundedCents,
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
          stripePaymentIntentId: PAID_INTENT,
          xeroInvoiceId: "inv-race-4131",
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          transactions: {
            create: [
              {
                id: LATE_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: LATE_INTENT,
                amountCents: LATE_CENTS,
                refundedAmountCents: lateRefundedCents,
                status: "PROCESSING",
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
              {
                id: PAID_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: PAID_INTENT,
                amountCents: PAID_CENTS,
                refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS,
                status: "PARTIALLY_REFUNDED",
                createdAt: new Date("2026-05-02T00:00:00.000Z"),
              },
            ],
          },
        },
      });
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID,
          paymentTransactionId: PAID_TXN,
          stripeRefundId: "re_race_4131_cancel",
          stripePaymentIntentId: PAID_INTENT,
          amountCents: PAID_CENTS - KEPT_FEE_CENTS,
          currency: "nzd",
          status: "succeeded",
          stripeCreatedAt: new Date("2026-05-20T00:00:00.000Z"),
        },
      });
      if (lateRefundedCents > 0) {
        await prisma.paymentRefund.create({
          data: {
            paymentId: PAYMENT_ID,
            paymentTransactionId: LATE_TXN,
            stripeRefundId: "re_race_4131_dashboard",
            stripePaymentIntentId: LATE_INTENT,
            amountCents: lateRefundedCents,
            currency: "nzd",
            status: "succeeded",
            stripeCreatedAt: new Date("2026-06-24T00:00:00.000Z"),
          },
        });
      }
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment",
          localId: PAYMENT_ID,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn-race-4131-cancel",
          role: "REFUND_CREDIT_NOTE",
          metadata: { amountCents: PAID_CENTS - KEPT_FEE_CENTS, invoiceId: "inv-race-4131" },
        },
      });
    }

    /** Stripe's `payment_intent.succeeded` for the late capture - the real webhook processor. */
    async function deliverLateCapture() {
      eventSequence += 1;
      const event = {
        id: `evt_race_4131_${eventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: {
          object: {
            id: LATE_INTENT,
            object: "payment_intent",
            amount: LATE_CENTS,
            currency: "nzd",
            status: "succeeded",
            payment_method: "pm_race_4131",
            metadata: { bookingId: BOOKING_ID },
            latest_charge: null,
          },
        },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    /** Every refund the handler asks Stripe for, answered as made. */
    function answerRefunds() {
      const asked: Array<{ paymentIntentId: string; amountCents: number; idempotencyKey?: string }> = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push({ paymentIntentId: args.paymentIntentId, amountCents: args.amountCents, idempotencyKey: args.idempotencyKey });
        return stripeRefund(`re_race_4131_${asked.length}`, args.paymentIntentId, args.amountCents, args.metadata ?? null);
      };
      return asked;
    }

    const transaction = (id: string) =>
      prisma.paymentTransaction.findUniqueOrThrow({ where: { id }, select: { refundedAmountCents: true, status: true } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "late-capture own-charge refund"); // the one shared guard (INV-SSOT-001)
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      webhook = await import("@/lib/stripe-webhook-service");
      ({ readRefundCreditNoteGap } = await import("@/lib/xero-admin-health"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Own",
          lastName: "Charge",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4131 Lodge", slug: "race-4131" } });
    }, 120_000); // cold import of the webhook module graph

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("refunds the whole capture from its own charge, leaves the kept fee alone, and leaves the self-heal nothing to raise", async () => {
      await seed();
      const asked = answerRefunds();

      expect((await deliverLateCapture()).init?.status ?? 200).toBe(200);

      expect(asked).toEqual([{ paymentIntentId: LATE_INTENT, amountCents: LATE_CENTS, idempotencyKey: `${KEY_PREFIX}_${LATE_TXN}_${LATE_CENTS}` }]);
      expect(await transaction(LATE_TXN)).toEqual({ refundedAmountCents: LATE_CENTS, status: "REFUNDED" });
      expect((await transaction(PAID_TXN)).refundedAmountCents).toBe(PAID_CENTS - KEPT_FEE_CENTS);
      // The automatic record made the intent a known late capture, so its
      // refund is outside the note-eligible cash and nothing is uncovered.
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { id: true, bookingId: true, refundedAmountCents: true },
      });
      expect((await readRefundCreditNoteGap(payment)).uncoveredCents).toBe(0);
    });

    it("refunds a capture already part refunded on its own row only for what it holds", async () => {
      await seed({ lateRefundedCents: 4_000 });
      const asked = answerRefunds();

      expect((await deliverLateCapture()).init?.status ?? 200).toBe(200);

      expect(asked).toEqual([
        { paymentIntentId: LATE_INTENT, amountCents: LATE_CENTS - 4_000, idempotencyKey: `${KEY_PREFIX}_${LATE_TXN}_${LATE_CENTS - 4_000}` },
      ]);
      expect((await transaction(PAID_TXN)).refundedAmountCents).toBe(PAID_CENTS - KEPT_FEE_CENTS);
      expect((await transaction(LATE_TXN)).refundedAmountCents).toBe(LATE_CENTS);
    });
  },
);
