/**
 * Real-PostgreSQL proof of #4211 (`INV-PAY-043`, `INV-PAY-133`): a member pays
 * one booking three times (three stale tabs, three card intents). Exactly one
 * capture stays and the other two are refunded, whatever order the three
 * captures arrive in, and replaying every capture afterwards changes nothing.
 *
 * Before #4211, guard (c) of the #1992 duplicate-capture refund kept an
 * arriving capture whenever ANY other duplicate-capture refund existed on the
 * booking, so the third capture to arrive was kept, with no task or alert.
 *
 * Run through the REAL `markBookingPaymentSucceeded` from an unpaid booking:
 * the first capture to arrive settles it (`paid`), the next two are refunded
 * (`duplicate_capture_refunded`). The three card rows are written first, in
 * mint order, as the intents' PENDING rows, so the settling capture is not
 * always the oldest-inserted row. The admin-only history event of each refund
 * names the settling capture. A second capture whose refund failed at Stripe
 * stays SUCCEEDED while its refund is queued; guard (c) still never counts it
 * as the settlement, so the settling capture's redelivery keeps its money.
 *
 * The PAID claim records the capture that won it (`Payment.settledByTransactionId`,
 * owner decision 17 Oct 2026). A replay of that capture is kept beside anything
 * else holding money - a capture the old guard kept, a Xero bank receipt, a
 * superseded capture whose refund failed later - and a booking with no record
 * keeps the arriving capture and alerts the admins instead of refunding.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`third-duplicate-capture-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4211-` fixtures. No Stripe call is made: the refund goes
 * to the harness's one shared `@/lib/stripe` double.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4211-member";
const OFFICER_ID = "race-4211-officer";
const LODGE_ID = "race-4211-lodge";
const ROOM_ID = "race-4211-room";
const BOOKING_ID = "race-4211-booking";
const PAYMENT_ID = "race-4211-payment";
const PRICE_CENTS = 20_000;
// A stay well after the frozen today.
const NIGHT_1 = new Date("2027-08-01T00:00:00.000Z");
const NIGHT_2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");
const MINTED_AT = new Date("2026-06-15T00:00:00.000Z");

/** The three tabs' intents, in the order they were minted (and their rows inserted). */
const TABS = ["pi_race_4211_tab_a", "pi_race_4211_tab_b", "pi_race_4211_tab_c"] as const;

const permutations = (items: readonly string[]): string[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
      );

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a third card capture on one booking is refunded too: exactly one stays, in any arrival order - real PostgreSQL (#4211)",
  { timeout: 120_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4211_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4211_" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
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
          id: `re_race_4211_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_race_4211_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

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

    /** Everything a replay could change, read in one place. */
    async function snapshot() {
      const [booking, payment, transactions, operations, refunds, events] = await Promise.all([
        prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } }),
        prisma.payment.findUniqueOrThrow({
          where: { id: PAYMENT_ID },
          select: { status: true, amountCents: true, refundedAmountCents: true },
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

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Third duplicate capture proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Three",
            lastName: "Tabs",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4211 Lodge", slug: "race-4211" } });
      await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 4211 Room" } });
      await prisma.lodgeBed.createMany({
        data: Array.from({ length: 4 }, (_, index) => ({
          id: `race-4211-bed-${index}`,
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
            firstName: "Three",
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
          stripePaymentIntentId: TABS[TABS.length - 1],
        },
      });
      // Each tab minted its intent, so each has its PENDING row, in mint order.
      for (const paymentIntentId of TABS) {
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
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it.each(permutations(TABS).map((order) => [order.join(" -> "), order] as const))(
      "arrival order %s: the first settles, the other two are refunded once each and name it, and replaying all three changes nothing",
      async (_label, order) => {
        const asked = stripeMakesRefunds();
        const [settling, ...duplicates] = order as [string, ...string[]];

        const outcomes = [];
        for (const paymentIntentId of order) outcomes.push((await arrive(paymentIntentId)).outcome);

        expect(outcomes).toEqual(["paid", "duplicate_capture_refunded", "duplicate_capture_refunded"]);
        expect(asked, "Stripe is asked to refund each later capture once").toEqual(duplicates);
        const settled = await snapshot();
        expect(settled.booking.status).toBe("PAID");
        expect(await recordedSettlerIntent(), "the PAID claim records the capture that won it").toBe(settling);
        expect(
          settled.transactions.map((row) => [row.stripePaymentIntentId, row.status]),
          "exactly one capture stays",
        ).toEqual(
          [...TABS].map((paymentIntentId) => [paymentIntentId, paymentIntentId === settling ? "SUCCEEDED" : "REFUNDED"]),
        );
        expect(settled.operations.map((operation) => [operation.idempotencyKey, operation.status])).toEqual(
          [...duplicates].sort().map((paymentIntentId) => [`duplicate_capture_${BOOKING_ID}_${paymentIntentId}`, "SUCCEEDED"]),
        );
        expect(settled.refunds.map((refund) => refund.amountCents)).toEqual([PRICE_CENTS, PRICE_CENTS]);

        // The admin-only history: one REFUNDED event per refunded capture, each
        // naming the capture that settled the booking.
        const refundEvents = await prisma.bookingEvent.findMany({
          where: { bookingId: BOOKING_ID, type: "REFUNDED" },
          select: { snapshot: true },
        });
        const named = refundEvents.map(
          (event) => event.snapshot as { duplicatePaymentIntentId?: string; settledPaymentIntentId?: string | null },
        );
        expect(named.map((event) => event.duplicatePaymentIntentId).sort()).toEqual([...duplicates].sort());
        expect(named.map((event) => event.settledPaymentIntentId)).toEqual([settling, settling]);

        // Every capture's webhook redelivered, in another order: nothing moves.
        const replays = [];
        for (const paymentIntentId of [...order].reverse()) replays.push((await arrive(paymentIntentId)).outcome);

        expect(replays).toEqual(["already_paid", "already_paid", "already_paid"]);
        expect(asked, "no refund is asked for again").toEqual(duplicates);
        expect(await snapshot()).toEqual(settled);
      },
    );

    it.each([1, 2, 3])(
      "three captures arriving at once leave exactly one, and three simultaneous replays change nothing (round %s)",
      async () => {
        const asked = stripeMakesRefunds();
        const outcomes = await Promise.all(TABS.map(async (paymentIntentId) => (await arrive(paymentIntentId)).outcome));
        expect([...outcomes].sort()).toEqual(["duplicate_capture_refunded", "duplicate_capture_refunded", "paid"]);
        expect(asked, "Stripe is asked to refund the two later captures once each").toHaveLength(2);
        const settled = await snapshot();
        expect(settled.transactions.filter((row) => row.status === "SUCCEEDED"), "exactly one capture stays").toHaveLength(1);
        expect(settled.operations.map((operation) => operation.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);

        const replays = await Promise.all(TABS.map(async (paymentIntentId) => (await arrive(paymentIntentId)).outcome));
        expect(replays).toEqual(["already_paid", "already_paid", "already_paid"]);
        expect(asked, "no refund is asked for again").toHaveLength(2);
        expect(await snapshot()).toEqual(settled);
      },
    );

    it("a saved-card charge recorded SUCCEEDED on its attempt row before it reaches the settlement is still refunded when another capture already settled the booking", async () => {
      // The #1967 split-child window: the member's link intent settles the
      // booking, then the cron's saved-card charge captures. Every saved-card
      // path (`cron-confirm-pending`, `charge-saved-method`,
      // `confirm-pending-guests`, the webhook's attempt adoption) records the
      // capture on its attempt row in its own committed write
      // (`settleSavedCardChargeAttempt`) BEFORE `markBookingPaymentSucceeded`.
      // So "the arriving row was already SUCCEEDED" does not mean the capture
      // was judged and kept before: it must still be refunded here.
      const asked = stripeMakesRefunds();
      const [settling] = TABS;
      const savedCardIntent = "pi_race_4211_saved_card";
      const attempt = await prisma.paymentTransaction.create({
        data: {
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          amountCents: PRICE_CENTS,
          status: "PENDING",
          reason: "race_4211_saved_card_attempt",
        },
        select: { id: true },
      });

      expect((await arrive(settling)).outcome).toBe("paid");
      const { settleSavedCardChargeAttempt } = await import("@/lib/saved-card-charge-settle");
      const recorded = await settleSavedCardChargeAttempt({
        attemptRowId: attempt.id,
        paymentId: PAYMENT_ID,
        paymentIntent: { id: savedCardIntent, status: "succeeded", amount: PRICE_CENTS, payment_method: null },
      });
      expect(recorded).toMatchObject({ ledgerStatus: "SUCCEEDED", moved: true });

      expect((await arrive(savedCardIntent)).outcome).toBe("duplicate_capture_refunded");
      expect(asked).toEqual([savedCardIntent]);
      const after = await snapshot();
      expect(
        after.transactions
          .filter((row) => row.status !== "PENDING")
          .map((row) => [row.stripePaymentIntentId, row.status]),
      ).toEqual([
        [savedCardIntent, "REFUNDED"],
        [settling, "SUCCEEDED"],
      ]);
    });

    /** A capture whose money is held without any duplicate-capture refund owning it. */
    async function holdUnowned(paymentIntentId: string) {
      await prisma.paymentTransaction.updateMany({
        where: { paymentId: PAYMENT_ID, stripePaymentIntentId: paymentIntentId },
        data: { status: "SUCCEEDED" },
      });
    }

    /** The aggregate the ledger writers keep, after a fixture wrote rows directly. */
    async function reconcile() {
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    }

    it.each([
      {
        label: "(a) a third capture the pre-#4211 guard kept",
        arrange: async () => holdUnowned(TABS[2]),
      },
      {
        label: "(b) a Xero bank receipt recorded after the card paid (#3638)",
        arrange: async () => {
          await prisma.paymentTransaction.create({
            data: {
              paymentId: PAYMENT_ID,
              kind: "PRIMARY",
              source: "INTERNET_BANKING",
              amountCents: PRICE_CENTS,
              status: "SUCCEEDED",
              reason: "xero_invoice_paid_reconciliation",
            },
          });
        },
      },
      {
        label: "(c) a superseded capture whose refund failed later (#4227)",
        arrange: async () => {
          const superseded = await prisma.paymentTransaction.findFirstOrThrow({
            where: { paymentId: PAYMENT_ID, stripePaymentIntentId: TABS[1] },
            select: { id: true },
          });
          await holdUnowned(TABS[1]);
          // Its superseded refund went through, then Stripe failed it: the
          // operation is finished, so nothing live owns the capture any more.
          await prisma.paymentRecoveryOperation.create({
            data: {
              type: "REFUND_SUPERSEDED_PAYMENT",
              status: "SUCCEEDED",
              bookingId: BOOKING_ID,
              paymentId: PAYMENT_ID,
              paymentTransactionId: superseded.id,
              paymentIntentId: TABS[1],
              amountCents: PRICE_CENTS,
              idempotencyKey: `race-4211-superseded-${TABS[1]}`,
            },
          });
        },
      },
    ])("$label holds money beside the recorded settler: a replay of the settler is kept and nothing is refunded", async ({ arrange }) => {
      const asked = stripeMakesRefunds();
      const [settling] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      await arrange();
      await reconcile();
      const before = await snapshot();

      expect((await arrive(settling)).outcome).toBe("already_paid");
      expect(asked, "nothing is refunded").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await recordedSettlerIntent()).toBe(settling);
      // Known, not merely kept: no "check by hand" alert is raised for it.
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(0);
    });

    let webhookEventSequence = 0;
    /** Stripe's `payment_intent.succeeded` through the REAL webhook processor, stale-amount check included. */
    async function deliverWebhook(paymentIntentId: string) {
      webhookEventSequence += 1;
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const event = {
        id: `evt_race_4211_${webhookEventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: PRICE_CENTS,
            currency: "nzd",
            status: "succeeded",
            payment_method: "pm_race_4211",
            metadata: { bookingId: BOOKING_ID },
            latest_charge: null,
          },
        },
      } as unknown as import("stripe").Stripe.Event;
      return processStripeWebhookEvent(event);
    }

    it("a change fee recorded after the settle: a duplicate's webhook at the old amount passes the stale-amount check and is refunded in full, the settler kept", async () => {
      const asked = stripeMakesRefunds();
      const [settling, duplicate] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      // A later correction records a fee on the payment, so the booking now owes more.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });

      // On a PAID booking the webhook hands the capture to the settle rather
      // than refusing it as a stale intent (a 500 and a mismatch alert on every retry).
      const delivered = await deliverWebhook(duplicate);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(200);
      expect(asked).toEqual([duplicate]);
      const after = await snapshot();
      expect(after.refunds.map((refund) => refund.amountCents)).toEqual([PRICE_CENTS]);
      expect(
        after.transactions.filter((row) => row.status !== "PENDING").map((row) => [row.stripePaymentIntentId, row.status]),
      ).toEqual([
        [settling, "SUCCEEDED"],
        [duplicate, "REFUNDED"],
      ]);
      expect(await recordedSettlerIntent()).toBe(settling);
    });

    /** The superseded machinery's state for one capture: its row SUCCEEDED after a cancel handed it to a refund. */
    async function handedOffToSupersededRefund(paymentIntentId: string, refundStatus: "PENDING" | "SUCCEEDED") {
      const row = await prisma.paymentTransaction.findFirstOrThrow({
        where: { paymentId: PAYMENT_ID, stripePaymentIntentId: paymentIntentId },
        select: { id: true },
      });
      await holdUnowned(paymentIntentId);
      const base = { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentTransactionId: row.id, paymentIntentId, amountCents: PRICE_CENTS };
      await prisma.paymentRecoveryOperation.create({
        data: { ...base, type: "CANCEL_PAYMENT_INTENT", status: "SUCCEEDED", idempotencyKey: `race-4211-cancel-${paymentIntentId}` },
      });
      const refund = await prisma.paymentRecoveryOperation.create({
        data: { ...base, type: "REFUND_SUPERSEDED_PAYMENT", status: refundStatus, idempotencyKey: `race-4211-superseded-${paymentIntentId}` },
        select: { id: true },
      });
      return { transactionId: row.id, refundOperationId: refund.id };
    }

    it("#4283: a superseded capture's success redelivered after its cancel handed it to a live refund reaches the settle and is not refunded on top", async () => {
      const asked = stripeMakesRefunds();
      const [settling, superseded] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      await handedOffToSupersededRefund(superseded, "PENDING");
      await reconcile();
      const before = await snapshot();

      // The cancel operation completed with the handoff, so the webhook no
      // longer diverts this intent: it reaches markBookingPaymentSucceeded.
      const delivered = await deliverWebhook(superseded);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(200);
      expect(asked, "only the superseded machinery refunds it").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(
        await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "duplicate_capture_" } } }),
      ).toBe(0);
    });

    it("#4283 review: a capture whose cancel is DEAD (handed to nobody), redelivered, is refunded as a duplicate", async () => {
      const asked = stripeMakesRefunds();
      const [settling, superseded] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      const row = await prisma.paymentTransaction.findFirstOrThrow({
        where: { paymentId: PAYMENT_ID, stripePaymentIntentId: superseded },
        select: { id: true },
      });
      await holdUnowned(superseded);
      // Out of retries: the runner will never hand this capture to a refund.
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CANCEL_PAYMENT_INTENT",
          status: "FAILED",
          attempts: 5,
          nextRetryAt: null,
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: row.id,
          paymentIntentId: superseded,
          amountCents: PRICE_CENTS,
          idempotencyKey: `race-4211-cancel-dead-${superseded}`,
        },
      });
      await reconcile();

      expect((await arrive(superseded)).outcome).toBe("duplicate_capture_refunded");
      expect(asked).toEqual([superseded]);
    });

    it("#4227/#4283 review: a superseded capture owed back in full after a failed-later refund, redelivered, is not refunded on top", async () => {
      const asked = stripeMakesRefunds();
      const [settling, superseded] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      const { transactionId, refundOperationId } = await handedOffToSupersededRefund(superseded, "SUCCEEDED");
      const { CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } = await import("@/lib/payment-recovery-keys");
      const key = `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}re_race_4211_superseded_again`;
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          status: "PENDING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: superseded,
          amountCents: PRICE_CENTS,
          idempotencyKey: key,
          stripeKeyPrefix: key,
          allocationPlan: [{ paymentTransactionId: transactionId, amountCents: PRICE_CENTS, madeByOperationId: refundOperationId }],
        },
      });
      await reconcile();
      const before = await snapshot();

      const delivered = await deliverWebhook(superseded);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(200);
      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(
        await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "duplicate_capture_" } } }),
      ).toBe(0);
    });

    it("#4227: with no record, a superseded capture whose refund failed later and is owed back in full is not 'another payment holding money': no false alert", async () => {
      const asked = stripeMakesRefunds();
      const [settling, superseded] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      const { transactionId, refundOperationId } = await handedOffToSupersededRefund(superseded, "SUCCEEDED");
      // Stripe failed that refund later; the club owes it again on an open row.
      const { CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } = await import("@/lib/payment-recovery-keys");
      const key = `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}re_race_4211_superseded`;
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          status: "PENDING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: superseded,
          amountCents: PRICE_CENTS,
          idempotencyKey: key,
          stripeKeyPrefix: key,
          allocationPlan: [{ paymentTransactionId: transactionId, amountCents: PRICE_CENTS, madeByOperationId: refundOperationId }],
        },
      });
      await reconcile();
      const before = await snapshot();

      expect((await arrive(settling)).outcome).toBe("already_paid");
      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } }), "no 'paid twice' alert").toBe(0);

      // Non-vacuity: once nothing owes it back, the same capture is money held twice again.
      await prisma.paymentRecoveryOperation.deleteMany({ where: { idempotencyKey: key } });
      expect((await arrive(settling)).outcome).toBe("duplicate_capture_kept");
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(1);
    });

    it("(a) the kept third capture's own replay is refunded against the recorded settler", async () => {
      const asked = stripeMakesRefunds();
      const [settling, , third] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      await holdUnowned(third);

      expect((await arrive(third)).outcome).toBe("duplicate_capture_refunded");
      expect(asked).toEqual([third]);
      expect((await arrive(settling)).outcome).toBe("already_paid");
      expect(asked).toEqual([third]);
    });

    it("a booking paid before the record existed: a replay beside another capture holding money is kept, nothing is refunded, and the admins are alerted once a day", async () => {
      const asked = stripeMakesRefunds();
      const [settling, , third] = TABS;
      expect((await arrive(settling)).outcome).toBe("paid");
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await holdUnowned(third);
      await reconcile();
      const before = await snapshot();

      for (const paymentIntentId of [settling, third, settling]) {
        expect((await arrive(paymentIntentId)).outcome).toBe("duplicate_capture_kept");
      }
      expect(asked, "nothing is refunded automatically").toEqual([]);
      expect(await snapshot()).toEqual(before);
      // One alert window claimed per kept capture, however often it replays.
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } }))
          .map((row) => row.key)
          .sort(),
      ).toEqual([
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${settling}`,
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${third}`,
      ]);
    });

    it("the second capture's refund fails at Stripe and stays queued: the third is still refunded, the settling capture's replay keeps its money, and the second's replay finishes its own refund", async () => {
      const [settling, second, third] = TABS;
      const asked: string[] = [];
      const makes = stripeMakesRefunds();
      const makeRefund = stripeRaceHooks.refund!;
      let stripeDown = true;
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.paymentIntentId);
        if (stripeDown && args.paymentIntentId === second) throw new Error("Stripe is unavailable (503)");
        return makeRefund(args);
      };

      expect((await arrive(settling)).outcome).toBe("paid");
      expect((await arrive(second)).outcome).toBe("duplicate_capture_refund_failed");
      // The second capture still holds its money, and its refund is queued.
      expect(
        await prisma.paymentTransaction.findFirstOrThrow({
          where: { paymentId: PAYMENT_ID, stripePaymentIntentId: second },
          select: { status: true },
        }),
      ).toEqual({ status: "SUCCEEDED" });
      expect((await arrive(third)).outcome).toBe("duplicate_capture_refunded");
      // Guard (c): the settling capture's redelivery finds the second capture
      // still SUCCEEDED, but a duplicate-capture refund owns it.
      expect((await arrive(settling)).outcome).toBe("already_paid");
      expect(asked).toEqual([second, third]);

      stripeDown = false;
      expect((await arrive(second)).outcome).toBe("duplicate_capture_refunded");
      expect(asked, "the second's replay re-sends only its own refund").toEqual([second, third, second]);
      expect(makes).toEqual([third, second]);

      const settled = await snapshot();
      expect(settled.transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [settling, "SUCCEEDED"],
        [second, "REFUNDED"],
        [third, "REFUNDED"],
      ]);
      expect(settled.operations.map((operation) => [operation.idempotencyKey, operation.status])).toEqual([
        [`duplicate_capture_${BOOKING_ID}_${second}`, "SUCCEEDED"],
        [`duplicate_capture_${BOOKING_ID}_${third}`, "SUCCEEDED"],
      ]);
      const refundEvents = await prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUNDED" },
        select: { snapshot: true },
      });
      expect(
        refundEvents.map((event) => (event.snapshot as { settledPaymentIntentId?: string | null }).settledPaymentIntentId),
      ).toEqual([settling, settling]);
    });
  },
);
