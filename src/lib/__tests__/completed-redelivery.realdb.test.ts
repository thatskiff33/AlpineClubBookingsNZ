/**
 * Real-PostgreSQL proof of #4285 (`INV-PAY-043`): a card capture's success
 * arriving on a booking the completion cron has since moved PAID -> COMPLETED.
 *
 * Before #4285 the settle threw "Booking is not payable from status COMPLETED"
 * for every such capture, so Stripe's redelivery of the capture that paid for
 * the stay answered 500 and was retried for up to three days. A COMPLETED
 * booking is a PAID one whose stay has ended: the recorded settler (or, paid
 * before the record existed, the booking's only capture) answers
 * `already_paid`, and any other capture meets the same duplicate-capture guard
 * as on a PAID booking.
 *
 * Every step runs through the real writers: the card settles through
 * `processStripeWebhookEvent`, the booking completes through the real
 * `completeBookings` cron, and the redelivery is another
 * `payment_intent.succeeded` through `processStripeWebhookEvent`. The only
 * fixture writes are the booking itself, the intents' PENDING rows each tab
 * minted, a change fee recorded on the payment after the stay (as a later
 * correction would), the second tab's capture set SUCCEEDED by hand for a
 * booking paid before #4211, and for such a booking clearing the record the
 * draining colour never wrote. An officer's refund in the Stripe dashboard and
 * Stripe's decline and cancel arrive as `charge.refunded`,
 * `payment_intent.payment_failed` and `payment_intent.canceled` through the same
 * webhook processor, and the deploy query (`docs/UPGRADING.md`, #4285) runs
 * exactly as the doc prints it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`completed-redelivery-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4285-` fixtures. No Stripe call is made: the refund goes
 * to the harness's one shared `@/lib/stripe` double.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4285-member";
const OFFICER_ID = "race-4285-officer";
const LODGE_ID = "race-4285-lodge";
const ROOM_ID = "race-4285-room";
const BOOKING_ID = "race-4285-booking";
const PAYMENT_ID = "race-4285-payment";
const PRICE_CENTS = 20_000;
// A stay that ended before the frozen today (2026-07-01), so the real
// completion cron moves the paid booking to COMPLETED.
const NIGHT_1 = new Date("2026-06-20T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-21T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-22T00:00:00.000Z");
const MINTED_AT = new Date("2026-06-10T00:00:00.000Z");

/** The settling capture and a second tab's capture, in mint order. */
const SETTLING = "pi_race_4285_settling";
const OTHER = "pi_race_4285_other";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a card capture's success arriving on a COMPLETED booking - real PostgreSQL (#4285)",
  { timeout: 120_000 },
  () => {
    let webhookEventSequence = 0;

    async function deleteBookingRows() {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4285_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4285_" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      // A cancel refunded as account credit (#4285 review 6) leaves the member a credit.
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** Stripe makes every refund it is asked for, recording the intents asked. */
    function stripeMakesRefunds(): string[] {
      const asked: string[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.paymentIntentId);
        return {
          id: `re_race_4285_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_race_4285_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    /** Stripe's `payment_intent.succeeded` for one intent, through the real webhook processor; a fresh event id each time. */
    async function deliverWebhook(paymentIntentId: string, type = "payment_intent.succeeded", idempotencyKey?: string) {
      webhookEventSequence += 1;
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const event = {
        id: `evt_race_4285_${webhookEventSequence}`,
        object: "event",
        type,
        request: idempotencyKey ? { id: "req_race_4285", idempotency_key: idempotencyKey } : null,
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: PRICE_CENTS,
            currency: "nzd",
            status: type === "payment_intent.succeeded" ? "succeeded" : type === "payment_intent.canceled" ? "canceled" : "requires_payment_method",
            payment_method: "pm_race_4285",
            metadata: { bookingId: BOOKING_ID },
            latest_charge: null,
            cancellation_reason: null,
            last_payment_error: null,
          },
        },
      } as unknown as import("stripe").Stripe.Event;
      return processStripeWebhookEvent(event);
    }

    async function answeredWith(paymentIntentId: string, type: string) {
      return (await deliverWebhook(paymentIntentId, type)).init?.status ?? 200;
    }

    async function expectAnswered(paymentIntentId: string, status: number) {
      const delivered = await deliverWebhook(paymentIntentId);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(status);
    }

    /** An officer refunds a card payment by hand in the Stripe dashboard: Stripe's `charge.refunded`, through the real webhook processor. */
    async function chargeRefundedInStripe(paymentIntentId: string) {
      webhookEventSequence += 1;
      const refund = {
        id: `re_race_4285_dashboard_${paymentIntentId}`,
        object: "refund",
        amount: PRICE_CENTS,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
        charge: `ch_race_4285_${paymentIntentId}`,
        payment_intent: paymentIntentId,
        metadata: {},
      };
      stripeRaceHooks.listChargeRefunds = async () => [refund];
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const delivered = await processStripeWebhookEvent({
        id: `evt_race_4285_${webhookEventSequence}`,
        object: "event",
        type: "charge.refunded",
        request: null,
        data: {
          object: {
            id: `ch_race_4285_${paymentIntentId}`,
            object: "charge",
            payment_intent: paymentIntentId,
            amount: PRICE_CENTS,
            amount_refunded: PRICE_CENTS,
            refunds: { data: [refund] },
          },
        },
      } as unknown as import("stripe").Stripe.Event);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(200);
    }

    /** The settle itself, for its outcome (the webhook only answers 200 or 500). */
    async function arrive(paymentIntentId: string) {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      return markBookingPaymentSucceeded({
        bookingId: BOOKING_ID,
        paymentIntentId,
        amountCents: PRICE_CENTS,
        paymentMethodId: null,
        format: CLUB_FORMAT_TEST,
      });
    }

    /** Settle by card through the webhook, then complete the stay through the real cron. */
    async function settleAndComplete() {
      await expectAnswered(SETTLING, 200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PAID");
      const { completeBookings } = await import("@/lib/cron-complete-bookings");
      expect((await completeBookings()).completedBookingIds).toContain(BOOKING_ID);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("COMPLETED");
    }

    /** Everything a redelivery could change, read in one place. */
    async function snapshot() {
      const [booking, payment, transactions, operations, refunds, events] = await Promise.all([
        prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } }),
        prisma.payment.findUniqueOrThrow({
          where: { id: PAYMENT_ID },
          select: { status: true, amountCents: true, refundedAmountCents: true, settledByTransactionId: true },
        }),
        prisma.paymentTransaction.findMany({
          where: { paymentId: PAYMENT_ID },
          orderBy: { stripePaymentIntentId: "asc" },
          select: { stripePaymentIntentId: true, status: true, amountCents: true, refundedAmountCents: true },
        }),
        prisma.paymentRecoveryOperation.findMany({
          where: { bookingId: BOOKING_ID },
          orderBy: { idempotencyKey: "asc" },
          select: { idempotencyKey: true, status: true, amountCents: true },
        }),
        prisma.paymentRefund.findMany({
          where: { paymentId: PAYMENT_ID },
          orderBy: { stripeRefundId: "asc" },
          select: { stripeRefundId: true, amountCents: true, status: true },
        }),
        prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } }),
      ]);
      return { booking, payment, transactions, operations, refunds, events };
    }

    /** The intent of the row `Payment.settledByTransactionId` names (#4211). */
    async function recordedSettlerIntent() {
      const { settledByTransactionId } = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { settledByTransactionId: true },
      });
      if (!settledByTransactionId) return null;
      return (
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { id: settledByTransactionId },
          select: { stripePaymentIntentId: true },
        })
      ).stripePaymentIntentId;
    }

    /** The refund credit notes queued for the payment - the refund-note queue only (#4322). */
    const refundNotesQueued = () =>
      prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } });

    /** The logger's error calls, restored after each case even when one fails (no leak into the next case). */
    const loggerSpies: Array<{ mockRestore: () => void }> = [];
    async function spyOnLoggedErrors() {
      const spy = vi.spyOn((await import("@/lib/logger")).default, "error");
      loggerSpies.push(spy);
      return spy;
    }

    /** What the kept-capture alert logged, read for its reason (no email is sent in the harness). */
    function keptAlertReasons(spy: { mock: { calls: unknown[][] } }) {
      return spy.mock.calls
        .map(([context]) => context as { reason?: string; paymentIntentId?: string })
        .filter((context) => context && typeof context === "object" && "reason" in context && context.paymentIntentId)
        .map((context) => [context.paymentIntentId, context.reason]);
    }

    /** A booking paid before #4211 (or by the draining colour): no record of its settler. */
    async function clearRecordedSettler() {
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "COMPLETED redelivery proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Finished",
            lastName: "Stay",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4285 Lodge", slug: "race-4285" } });
      await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 4285 Room" } });
      await prisma.lodgeBed.createMany({
        data: Array.from({ length: 4 }, (_, index) => ({
          id: `race-4285-bed-${index}`,
          roomId: ROOM_ID,
          name: `Bed ${index}`,
          bedType: "SINGLE" as const,
        })),
      });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      await prisma.booking.create({
        // Admitted by an officer over capacity (#1771), so the settle's capacity
        // check passes on a lodge this suite gives no capacity setting.
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT_1,
          checkOut: CHECK_OUT,
          status: "PAYMENT_PENDING",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
          capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
          capacityOverriddenByMemberId: OFFICER_ID,
        },
      });
      for (const guest of ["g1", "g2"]) {
        await prisma.bookingGuest.create({
          data: {
            id: `${BOOKING_ID}-${guest}`,
            bookingId: BOOKING_ID,
            firstName: "Finished",
            lastName: guest,
            ageTier: "ADULT",
            isMember: true,
            stayStart: NIGHT_1,
            stayEnd: CHECK_OUT,
            priceCents: PRICE_CENTS / 2,
            nights: {
              create: [
                { stayDate: NIGHT_1, priceCents: PRICE_CENTS / 4, priceSource: "SOLD" },
                { stayDate: NIGHT_2, priceCents: PRICE_CENTS / 4, priceSource: "SOLD" },
              ],
            },
          },
        });
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          source: "STRIPE",
          status: "PENDING",
          stripePaymentIntentId: OTHER,
        },
      });
      // Each tab minted its intent, so each has its PENDING row, in mint order.
      for (const paymentIntentId of [SETTLING, OTHER]) {
        await prisma.paymentTransaction.create({
          data: {
            paymentId: PAYMENT_ID,
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: paymentIntentId,
            amountCents: PRICE_CENTS,
            status: "PENDING",
            createdAt: MINTED_AT,
          },
        });
      }
    });

    afterEach(() => {
      resetStripeRaceHooks();
      for (const spy of loggerSpies.splice(0)) spy.mockRestore();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("the recorded settler's redelivery on a COMPLETED booking answers already paid and changes nothing", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      expect(await recordedSettlerIntent()).toBe(SETTLING);
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked, "nothing is refunded").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(before.booking.status).toBe("COMPLETED");
    });

    it("a booking paid before the record existed: its only capture's redelivery answers already paid, with no alert", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(0);
    });

    it("another capture on a COMPLETED booking is refunded as a duplicate, the settler kept and the booking still COMPLETED; its replay changes nothing", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      const after = await snapshot();
      expect(after.booking.status).toBe("COMPLETED");
      expect(after.transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "REFUNDED"],
        [SETTLING, "SUCCEEDED"],
      ]);
      expect(after.operations.map((operation) => [operation.idempotencyKey, operation.status])).toEqual([
        [`duplicate_capture_${BOOKING_ID}_${OTHER}`, "SUCCEEDED"],
      ]);
      expect(await recordedSettlerIntent()).toBe(SETTLING);

      // Both captures redelivered again: nothing moves.
      await expectAnswered(OTHER, 200);
      await expectAnswered(SETTLING, 200);
      expect(asked, "no refund is asked for again").toEqual([OTHER]);
      expect(await snapshot()).toEqual(after);
    });

    it("a change fee recorded after the stay: another capture's webhook at the old amount is refunded in full, not refused as a stale intent", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // A later correction records a fee on the payment, so the booking now owes more.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      const after = await snapshot();
      expect(after.refunds.map((refund) => refund.amountCents)).toEqual([PRICE_CENTS]);
      expect(after.transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "REFUNDED"],
        [SETTLING, "SUCCEEDED"],
      ]);
    });

    /** The UPGRADING deploy query, as an operator runs it: the booking ids it lists. */
    async function deployQueryLists() {
      const { completedRedeliveryDeployQuery } = await import("./support/completed-redelivery-deploy-query");
      const rows = await prisma.$queryRawUnsafe<Array<{ bookingId: string }>>(completedRedeliveryDeployQuery());
      return rows.map((row) => row.bookingId).filter((id) => id === BOOKING_ID);
    }

    it("the deploy query lists a finished stay whose second card payment may have captured, until the app refunds it", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // The second tab's success, refused before #4285, never wrote its row: still PENDING.
      expect(await deployQueryLists()).toEqual([BOOKING_ID]);

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      expect(await deployQueryLists(), "a refunded, duplicate-owned capture is not listed").toEqual([]);
    });

    it("#4285 review F5: a declined intent stays listed (it can still be paid); one Stripe cancelled is not", async () => {
      await settleAndComplete();

      expect(await answeredWith(OTHER, "payment_intent.payment_failed")).toBe(200);
      expect((await snapshot()).transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "FAILED"],
        [SETTLING, "SUCCEEDED"],
      ]);
      expect(await deployQueryLists(), "a declined first try the member may then have paid").toEqual([BOOKING_ID]);

      expect(await answeredWith(OTHER, "payment_intent.canceled")).toBe(200);
      // The webhook's audit entry is written after its answer.
      await vi.waitFor(async () => {
        expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking.payment.canceled" } })).toBe(1);
      });
      expect(await deployQueryLists(), "an intent Stripe cancelled cannot be paid").toEqual([]);
    });

    it("#4285 review F3: a booking paid before the record existed, its only capture replayed after a fee raised what it owes: a replay, already paid, no alert", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(0);
    });

    it("#4285 review F3: no record and nothing else holding money (the only payment refunded in Stripe): a second tab's payment the app never recorded is kept and the admins told", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      await chargeRefundedInStripe(SETTLING);
      expect((await snapshot()).transactions.find((row) => row.stripePaymentIntentId === SETTLING)?.status).toBe("REFUNDED");
      const logged = await spyOnLoggedErrors();

      await expectAnswered(OTHER, 200);
      expect(keptAlertReasons(logged), "the alert names the payment new").toEqual([[OTHER, "new-capture"]]);
      expect(await owedMarkers(), "delivered, so no longer owed").toEqual([]);

      expect(asked, "nothing is refunded automatically").toEqual([]);
      const after = await snapshot();
      expect(after.booking.status).toBe("COMPLETED");
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("SUCCEEDED");
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } })).map((row) => row.key),
        "the kept-capture alert's once-a-day claim",
      ).toEqual([`duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`]);

      // Its replay is now a replay: kept quietly, no second alert window.
      expect((await arrive(OTHER)).outcome).toBe("already_paid");
    });

    it("#4285 review F1/F2: a booking the deploy query lists (no record): a resend is kept and alerted, never refunded; the officer's refund in Stripe is recorded and queues a credit note", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      expect(await deployQueryLists()).toEqual([BOOKING_ID]);

      // Step 1: the event resent from Stripe.
      await expectAnswered(OTHER, 200);
      expect(asked, "a resend refunds nothing: there is no record of which payment settled the booking").toEqual([]);
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } })).map((row) => row.key),
      ).toEqual([`duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`]);
      expect(await deployQueryLists(), "still listed until someone refunds it").toEqual([BOOKING_ID]);

      // Step 2: refunded by hand in the Stripe dashboard.
      const notesBefore = await refundNotesQueued();
      await chargeRefundedInStripe(OTHER);
      const after = await snapshot();
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("REFUNDED");
      expect(after.refunds.map((refund) => refund.stripeRefundId)).toEqual([`re_race_4285_dashboard_${OTHER}`]);
      expect(await refundNotesQueued(), "a refund credit note is queued (#4322)").toBe(notesBefore + 1);
      expect(await deployQueryLists()).toEqual([]);
    });

    it("#4285 review F2: refunded by hand in Stripe with no resend, the app still records the refund and queues a credit note", async () => {
      await settleAndComplete();
      await clearRecordedSettler();
      const notesBefore = await refundNotesQueued();

      await chargeRefundedInStripe(OTHER);

      const after = await snapshot();
      expect(after.refunds.map((refund) => refund.stripeRefundId)).toEqual([`re_race_4285_dashboard_${OTHER}`]);
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("REFUNDED");
      expect(await refundNotesQueued()).toBe(notesBefore + 1);
      expect(await deployQueryLists()).toEqual([]);
    });

    it("a booking paid before the record existed, another capture holding money: the arriving capture is kept, nothing refunded, and the admins alerted", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // The other tab's capture is recorded too, before the record existed.
      await prisma.paymentTransaction.updateMany({
        where: { paymentId: PAYMENT_ID, stripePaymentIntentId: OTHER },
        data: { status: "SUCCEEDED" },
      });
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      await clearRecordedSettler();
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(OTHER)).outcome).toBe("duplicate_capture_kept");

      expect(asked, "nothing is refunded automatically").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } }))
          .map((row) => row.key)
          .sort(),
      ).toEqual([
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`,
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${SETTLING}`,
      ]);
    });

    /** The owed new-capture alert markers on this booking (#4285 review). */
    const owedMarkers = async () =>
      (await prisma.alertCooldown.findMany({ where: { key: { startsWith: `duplicate-capture-new-capture-owed:${BOOKING_ID}:` } }, select: { key: true } })).map((row) => row.key);

    /**
     * A booking PAID at $0 with no recorded settler, as the cron's zero-dollar
     * branch leaves it, holding the lost-response saved-card attempt the lens's
     * probe used: PENDING, no intent id, the attempt's key on `reference`.
     */
    async function zeroDollarBookingWithLostAttempt() {
      const ATTEMPT_ROW = "race4285attemptrow";
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID", totalPriceCents: 0, finalPriceCents: 0 } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 0, status: "SUCCEEDED", stripePaymentIntentId: null } });
      const { savedCardChargeIdempotencyKey } = await import("@/lib/saved-card-charge-key");
      const key = savedCardChargeIdempotencyKey(BOOKING_ID, ATTEMPT_ROW);
      await prisma.paymentTransaction.create({
        data: { id: ATTEMPT_ROW, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", amountCents: PRICE_CENTS, status: "PENDING", reference: key, createdAt: MINTED_AT },
      });
      return key;
    }

    it("#4285 review F1: a lost-response saved-card capture the webhook adopts on a $0 booking is new money: kept and the admins told, never kept silently", async () => {
      const asked = stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      const logged = await spyOnLoggedErrors();

      expect((await deliverWebhook(OTHER, "payment_intent.succeeded", key)).init?.status ?? 200).toBe(200);

      expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture"]]);
      expect(asked, "nothing is refunded automatically").toEqual([]);
      expect((await snapshot()).transactions).toEqual([
        { stripePaymentIntentId: OTHER, status: "SUCCEEDED", amountCents: PRICE_CENTS, refundedAmountCents: 0 },
      ]);
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } })).map((row) => row.key),
      ).toEqual([`duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`]);
      expect(await owedMarkers()).toEqual([]);

      // F4: once the stay completes, the deploy query lists such a lone stray capture.
      const { completeBookings } = await import("@/lib/cron-complete-bookings");
      expect((await completeBookings()).completedBookingIds).toContain(BOOKING_ID);
      expect(await deployQueryLists()).toEqual([BOOKING_ID]);
    });

    /** The state a crash right after the settle's commit leaves: the alert owed, never claimed or sent. */
    async function crashedBeforeTheAlert() {
      const { recordNewCaptureAlertOwed } = await import("@/lib/duplicate-capture-guard");
      await prisma.alertCooldown.deleteMany({ where: { key: `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}` } });
      await recordNewCaptureAlertOwed(prisma, { bookingId: BOOKING_ID, paymentIntentId: OTHER, now: new Date("2026-06-30T20:00:00.000Z") });
      expect(await owedMarkers()).toEqual([`duplicate-capture-new-capture-owed:${BOOKING_ID}:${OTHER}`]);
    }

    it("#4285 review F2: an alert lost to a crash after the commit is sent by the capture's next arrival, though it reads as a replay", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      const logged = await spyOnLoggedErrors();

      await expectAnswered(OTHER, 200);

      expect(keptAlertReasons(logged), "re-alerted while owed").toEqual([[OTHER, "new-capture"]]);
      expect(await owedMarkers(), "delivered, so no longer owed").toEqual([]);
      expect(await prisma.alertCooldown.count({ where: { key: `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}` } })).toBe(1);

      // Delivered: the next arrival is a quiet replay.
      expect((await arrive(OTHER)).outcome).toBe("already_paid");
    });

    it("#4285 review F2: with no further arrival, the payments cron's drain sends the owed alert an hour on and clears it", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");

      // Not yet due: the post-commit alert goes first.
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T20:30:00.000Z"))).toMatchObject({ sent: 0 });
      expect(await owedMarkers()).toHaveLength(1);

      const logged = await spyOnLoggedErrors();
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture"]]);
      expect(await owedMarkers()).toEqual([]);
    });

    /** Move the stay to after the frozen today, so the booking can still be cancelled. */
    async function moveStayToFuture(guestPriceCents = 0) {
      const N1 = new Date("2027-08-01T00:00:00.000Z"), N2 = new Date("2027-08-02T00:00:00.000Z"), OUT = new Date("2027-08-03T00:00:00.000Z");
      // The database holds a booking's range around its guests' ranges, so the guests go first.
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { checkIn: N1, checkOut: OUT } });
      for (const guest of ["g1", "g2"]) {
        await prisma.bookingGuest.create({
          data: {
            id: `${BOOKING_ID}-${guest}`,
            bookingId: BOOKING_ID,
            firstName: "Finished",
            lastName: guest,
            ageTier: "ADULT",
            isMember: true,
            stayStart: N1,
            stayEnd: OUT,
            priceCents: guestPriceCents,
            nights: {
              create: [
                { stayDate: N1, priceCents: guestPriceCents / 2, priceSource: "SOLD" },
                { stayDate: N2, priceCents: guestPriceCents / 2, priceSource: "SOLD" },
              ],
            },
          },
        });
      }
    }

    it("#4285 review F3: a booking cancelled after its stray capture was kept: the cancel's refund (at most its $0 worth) leaves the payment held, and the drain tells it as closed rather than clearing it", async () => {
      const asked = stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await moveStayToFuture();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();

      const { cancelBooking } = await import("@/lib/booking-cancel");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      await cancelBooking(BOOKING_ID, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      const cancelled = await snapshot();
      expect(cancelled.booking.status).toBe("CANCELLED");
      expect(asked, "the cancel refunds at most the booking's worth: nothing of the stray capture").toEqual([]);
      expect(cancelled.transactions.find((row) => row.stripePaymentIntentId === OTHER)).toMatchObject({ status: "SUCCEEDED", refundedAmountCents: 0 });
      expect(await owedMarkers(), "still owed").toHaveLength(1);

      const logged = await spyOnLoggedErrors();
      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture-closed"]]);
      expect(await owedMarkers()).toEqual([]);
    });

    it("#4285 review F4: once another payment holds money, the drain tells the owed alert as a later payment, never 'nothing else holds money'", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      // A second card payment recorded since, on the same payment.
      await prisma.paymentTransaction.create({
        data: { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: SETTLING, amountCents: PRICE_CENTS, status: "SUCCEEDED", createdAt: MINTED_AT },
      });

      const logged = await spyOnLoggedErrors();
      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture-later-payment"]]);
      expect(await owedMarkers()).toEqual([]);
    });

    it("#4285 review F2: a credit-paid booking worth $200 cancelled at a 50% tier: the cancel's newest-first card refund takes part of the stray capture, and the drain tells what it still holds", async () => {
      const asked = stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      // Paid in full with account credit: worth $200, no cash.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: PRICE_CENTS } });
      await moveStayToFuture(PRICE_CENTS / 2);
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      try {
        await deliverWebhook(OTHER, "payment_intent.succeeded", key);
        await crashedBeforeTheAlert();

        const { cancelBooking } = await import("@/lib/booking-cancel");
        const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
        await cancelBooking(BOOKING_ID, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
        const cancelled = await snapshot();
        expect(cancelled.booking.status).toBe("CANCELLED");
        const stray = cancelled.transactions.find((row) => row.stripePaymentIntentId === OTHER)!;
        expect(asked, "the cancel's card refund went to the stray capture, the only card payment").toEqual([OTHER]);
        expect(stray.refundedAmountCents).toBeGreaterThan(0);
        expect(stray.refundedAmountCents).toBeLessThan(PRICE_CENTS);
        expect(stray.status).toBe("PARTIALLY_REFUNDED");

        // The amount the alert shows (what the capture still holds) is pinned by the drain's unit test.
        const logged = await spyOnLoggedErrors();
        const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
        expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
        expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture-closed"]]);
        // #4285 review 7 F1: the cancel's card refund row SUCCEEDED, so the alert says it was sent.
        expect(await prisma.paymentRecoveryOperation.findUnique({ where: { idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}` }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
        const [context] = logged.mock.calls.map(([each]) => each as { cancellationRefund?: unknown }).filter((each) => each && typeof each === "object" && "cancellationRefund" in each);
        expect(context?.cancellationRefund).toEqual({ method: "card", card: { amount: expect.stringContaining("100"), standing: "sent" }, byBank: null, toCheck: null });
        expect(await owedMarkers()).toEqual([]);
      } finally {
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      }
    });

    /** The kept-capture alert's logged context (#4285 review 6: it carries what the capture still holds). */
    function keptAlertContexts(spy: { mock: { calls: unknown[][] } }) {
      return spy.mock.calls
        .map(([context]) => context as Record<string, unknown>)
        .filter((context) => context && typeof context === "object" && "reason" in context && context.paymentIntentId);
    }

    it("#4285 review 8 F1: the cancel's card refund Stripe failed later is owed again, and the drain says it was not sent", async () => {
      // Stripe makes the refund, keeping what it answered so it can fail it later.
      const made: import("stripe").Stripe.Refund[] = [];
      stripeRaceHooks.refund = async (args) => {
        const refund = {
          id: `re_race_4285_failing_${made.length + 1}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_race_4285_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        } as unknown as import("stripe").Stripe.Refund;
        made.push(refund);
        return refund;
      };
      const key = await zeroDollarBookingWithLostAttempt();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: PRICE_CENTS } });
      await moveStayToFuture(PRICE_CENTS / 2);
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      try {
        await deliverWebhook(OTHER, "payment_intent.succeeded", key);
        await crashedBeforeTheAlert();
        const { cancelBooking } = await import("@/lib/booking-cancel");
        const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
        await cancelBooking(BOOKING_ID, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
        expect(made, "the cancel's card refund was made").toHaveLength(1);
        expect(await prisma.paymentRecoveryOperation.findUnique({ where: { idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}` }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });

        // Stripe fails it later, through the real refund-failed writer: a row of its own owes it again.
        const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
        expect(await recordRefusedCardRefund({ ...made[0]!, status: "failed" } as import("stripe").Stripe.Refund)).toBe("recorded");
        expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, idempotencyKey: `card_refund_failed_later_${made[0]!.id}` } })).toBe(1);

        const logged = await spyOnLoggedErrors();
        const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
        expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
        expect(keptAlertContexts(logged)).toEqual([
          expect.objectContaining({
            paymentIntentId: OTHER,
            reason: "new-capture-closed",
            // The failed refund went back on the card: the capture holds all of it again.
            amountCents: PRICE_CENTS,
            cancellationRefund: { method: "card", card: { amount: expect.stringContaining("100"), standing: "not-sent" }, byBank: null, toCheck: null },
          }),
        ]);
      } finally {
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      }
    });

    /** A second card payment captured on the payment since the stray one, beside it. */
    const secondCapture = () =>
      prisma.paymentTransaction.create({
        data: { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: SETTLING, amountCents: PRICE_CENTS, status: "SUCCEEDED", createdAt: MINTED_AT },
      });

    it("#4285 review 6 F1: a capture behind a cancel the recovery runner gave up on still holds money: the drain names it, never 'nothing else holds money'", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      await secondCapture();
      // Its cancel is dead (attempts spent, no retry): it hands the money to nobody.
      await prisma.paymentRecoveryOperation.create({
        data: { type: "CANCEL_PAYMENT_INTENT", status: "FAILED", attempts: 5, nextRetryAt: null, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: SETTLING, amountCents: PRICE_CENTS, idempotencyKey: `race-4285-dead-cancel-${SETTLING}` },
      });
      // The refund-safety reading still sets it aside; the telling reading does not.
      const { readOtherSettledCaptureWhere } = await import("@/lib/duplicate-capture-guard");
      const reading = await readOtherSettledCaptureWhere(prisma, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: OTHER });
      expect(reading.supersededOwned).toContain(SETTLING);
      expect(await prisma.paymentTransaction.count({ where: reading.where })).toBe(0);
      expect(await prisma.paymentTransaction.count({ where: await reading.readTellingWhere() })).toBe(1);

      const logged = await spyOnLoggedErrors();
      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertContexts(logged)).toEqual([
        expect.objectContaining({ paymentIntentId: OTHER, reason: "new-capture-later-payment", otherPaymentIntentId: SETTLING, amountCents: PRICE_CENTS }),
      ]);
      expect(await owedMarkers()).toEqual([]);
    });

    /** A dead cancel (attempts spent, no retry) on the second capture: it hands the money to nobody. */
    const deadCancelOn = (paymentIntentId: string) =>
      prisma.paymentRecoveryOperation.create({
        data: { type: "CANCEL_PAYMENT_INTENT", status: "FAILED", attempts: 5, nextRetryAt: null, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId, amountCents: PRICE_CENTS, idempotencyKey: `race-4285-dead-cancel-${paymentIntentId}` },
      });

    it("#4285 review 7 F2: the settle's own alert, beside a capture behind a dead cancel, keeps the new capture and names that one - never 'no other payment'", async () => {
      const asked = stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await secondCapture();
      await deadCancelOn(SETTLING);
      const logged = await spyOnLoggedErrors();

      expect((await deliverWebhook(OTHER, "payment_intent.succeeded", key)).init?.status ?? 200).toBe(200);

      expect(asked, "the verdict stays on the refund-safety reading: nothing refunded").toEqual([]);
      expect(keptAlertContexts(logged)).toEqual([
        expect.objectContaining({ paymentIntentId: OTHER, reason: "new-capture", otherPaymentIntentId: SETTLING, amountCents: PRICE_CENTS }),
      ]);
    });

    it("#4285 review 7 F6: a capture whose duplicate-capture refund Stripe failed later is named while nothing owes it again, and not once an open row owes it back in full", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      const settling = await secondCapture();
      const { buildDuplicateCaptureRefundRecoveryIdempotencyKey, CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } = await import("@/lib/payment-recovery-keys");
      // Its duplicate-capture refund closed SUCCEEDED, and Stripe failed that refund later: the capture holds it all again.
      const duplicateRefund = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION", status: "SUCCEEDED", attempts: 1, nextRetryAt: null, bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: SETTLING, amountCents: PRICE_CENTS, idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_ID, SETTLING),
          allocationPlan: [{ paymentTransactionId: settling.id, amountCents: PRICE_CENTS }],
        },
      });
      const { readOtherSettledCaptureWhere } = await import("@/lib/duplicate-capture-guard");
      const read = () => readOtherSettledCaptureWhere(prisma, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: OTHER });
      const reading = await read();
      expect(reading.duplicateRefundIntentIds).toEqual([SETTLING]);
      expect(await prisma.paymentTransaction.count({ where: reading.where }), "never a settlement candidate").toBe(0);
      expect(await prisma.paymentTransaction.count({ where: await reading.readTellingWhere() }), "nothing owes it again: it holds money").toBe(1);

      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
      const logged = await spyOnLoggedErrors();
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertContexts(logged)).toEqual([
        expect.objectContaining({ paymentIntentId: OTHER, reason: "new-capture-later-payment", otherPaymentIntentId: SETTLING }),
      ]);

      // The club owes it again: an open failed-later row on its intent asks for all it holds.
      const failedLaterKey = `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}re_race_4285_duplicate`;
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION", status: "PENDING", attempts: 0, nextRetryAt: new Date("2026-06-30T00:00:00.000Z"), bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: SETTLING, amountCents: PRICE_CENTS, idempotencyKey: failedLaterKey, stripeKeyPrefix: failedLaterKey,
          allocationPlan: [{ paymentTransactionId: settling.id, amountCents: PRICE_CENTS, madeByOperationId: duplicateRefund.id }],
        },
      });
      expect(await prisma.paymentTransaction.count({ where: await (await read()).readTellingWhere() }), "owed back in full: its refund machinery holds it").toBe(0);
      await crashedBeforeTheAlert();
      logged.mockClear();
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertContexts(logged)).toEqual([expect.objectContaining({ paymentIntentId: OTHER, reason: "new-capture", otherPaymentIntentId: null })]);
    });

    it("#4285 review 6 F4: an in-flight operation that refunds nothing (an additional-payment charge) never holds the owed alert back", async () => {
      stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await deliverWebhook(OTHER, "payment_intent.succeeded", key);
      await crashedBeforeTheAlert();
      await prisma.paymentRecoveryOperation.create({
        data: { type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: "PENDING", attempts: 0, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: "pi_race_4285_review_charge", amountCents: 1_000, idempotencyKey: "race-4285-review-charge" },
      });

      const logged = await spyOnLoggedErrors();
      const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
      expect(keptAlertReasons(logged)).toEqual([[OTHER, "new-capture"]]);

      // A card refund not yet planned does hold it back: it may take from this capture.
      await crashedBeforeTheAlert();
      await prisma.paymentRecoveryOperation.create({
        data: { type: "REFUND_BOOKING_MODIFICATION", status: "PENDING", attempts: 0, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentIntentId: OTHER, amountCents: 1_000, idempotencyKey: "race-4285-unplanned-refund" },
      });
      expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 0 });
      expect(await owedMarkers()).toHaveLength(1);
    });

    it("#4285 review 6 F2: a credit-paid booking worth $200 cancelled at a 50% tier with a credit refund: the card still holds all of the stray capture, though the ledger marks part refunded, and the alert names the credit refund", async () => {
      const asked = stripeMakesRefunds();
      const key = await zeroDollarBookingWithLostAttempt();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: PRICE_CENTS } });
      await moveStayToFuture(PRICE_CENTS / 2);
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      try {
        await deliverWebhook(OTHER, "payment_intent.succeeded", key);
        await crashedBeforeTheAlert();

        const { cancelBooking } = await import("@/lib/booking-cancel");
        const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
        await cancelBooking(BOOKING_ID, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
        const cancelled = await snapshot();
        expect(cancelled.booking.status).toBe("CANCELLED");
        expect(asked, "a credit refund never touches the card").toEqual([]);
        expect(cancelled.refunds, "no card refund recorded").toEqual([]);
        // The ledger places the credit refund on the capture (`applyLocalRefundAllocation`), though the card still holds it all.
        const stray = cancelled.transactions.find((row) => row.stripePaymentIntentId === OTHER)!;
        expect(stray.refundedAmountCents).toBeGreaterThan(0);

        const logged = await spyOnLoggedErrors();
        const { drainOwedNewCaptureAlerts } = await import("@/lib/duplicate-capture-kept-alert-drain");
        expect(await drainOwedNewCaptureAlerts(new Date("2026-06-30T21:30:00.000Z"))).toMatchObject({ sent: 1 });
        expect(keptAlertContexts(logged)).toEqual([
          expect.objectContaining({
            paymentIntentId: OTHER,
            reason: "new-capture-closed",
            amountCents: PRICE_CENTS,
            cancellationRefund: { method: "credit", amount: expect.stringContaining("100") },
          }),
        ]);
      } finally {
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      }
    });
  },
);
