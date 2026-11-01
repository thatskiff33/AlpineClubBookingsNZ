/**
 * Real-PostgreSQL proof of #4646 (`INV-PAY-089`): a saved-card charge whose
 * answer was lost and whose capture was ASYNCHRONOUS is adopted by the attempt
 * id its metadata carries, and the booking settles exactly once.
 *
 * Stripe sends an asynchronous capture as `payment_intent.succeeded` with
 * `request: null`, and every redelivery of it carries `null` too. Before #4646
 * the webhook could link a lost-answer attempt row only by
 * `request.idempotency_key`, so this row was never adopted: the card was
 * charged, the booking stayed unpaid, and the attempt ended at
 * `attempt_key_expired` with the "could not match an app payment" alert
 * (`INV-INT-033`).
 *
 * EVERY STEP IS THE REAL CODE: the charge is the real charge-saved-method
 * route, whose off-session charge the harness's one `@/lib/stripe` double
 * makes fail without an answer (a dropped connection, so the attempt row stays
 * PENDING with no intent); the capture is the real webhook processor. Only
 * Stripe and the session are doubles.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`saved-card-async-capture-adopt-realdb-wiring.test.ts` pins the edge); it
 * owns and cleans its own `race-4646-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { resetStripeRaceHooks, stripeRaceHooks } from "@/lib/__tests__/support/stripe-race-double";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4646-owner";
const OFFICER_ID = "race-4646-officer";
const LODGE_ID = "race-4646-lodge";
const BOOKING_ID = "race-4646-booking";
const PAYMENT_ID = "race-4646-payment";
const CARD = "pm_race_4646";
const EVENT_PREFIX = "evt_race_4646_";
const INTENT_PREFIX = "pi_race_4646_";
// Future against the frozen suite clock (1 July 2026).
const CHECK_IN = new Date("2026-09-15T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-16T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-17T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;

let prisma: PrismaClient;
let chargeRoute: typeof import("@/app/api/payments/charge-saved-method/route");
let processStripeWebhookEvent: (typeof import("@/lib/stripe-webhook-service"))["processStripeWebhookEvent"];
let alertKey: (typeof import("@/lib/unrecognised-stripe-payment"))["unrecognisedStripePaymentAlertKey"];
let harnessRole: { restore: () => void } | undefined;
let sequence = 0;

async function clean(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ targetId: { in: [BOOKING_ID, PAYMENT_ID] } }, { memberId: { in: [OWNER_ID, OFFICER_ID] } }, { subjectMemberId: OWNER_ID }] },
  });
  await prisma.unrecognisedStripePayment.deleteMany({ where: { stripePaymentIntentId: { startsWith: INTENT_PREFIX } } });
  await prisma.alertCooldown.deleteMany({ where: { OR: [{ key: { contains: BOOKING_ID } }, { key: { contains: INTENT_PREFIX } }] } });
  await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: EVENT_PREFIX } } });
  await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: EVENT_PREFIX } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A PENDING booking held for a non-member guest, its card saved through a SetupIntent. */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PENDING",
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-07-08T00:00:00.000Z"),
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      bookingId: BOOKING_ID,
      firstName: "Visiting",
      lastName: "Friend",
      ageTier: "ADULT",
      isMember: false,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: PRICE_CENTS,
      nights: {
        create: [
          { stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
          { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
        ],
      },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: PRICE_CENTS,
      status: "PENDING",
      stripeCustomerId: "cus_race_4646",
      stripePaymentMethodId: CARD,
      stripeSetupIntentId: "seti_race_4646",
    },
  });
}

type SentCharge = { idempotencyKey: string; metadata: Record<string, string>; amountCents: number };

/**
 * The member presses "pay with my saved card"; Stripe takes the POST, but the
 * connection drops before its answer arrives, so the attempt row stays PENDING
 * with no intent. Returns what the POST sent, as Stripe now holds it.
 */
async function chargeWithLostAnswer(): Promise<{ sent: SentCharge; attemptRowId: string }> {
  const sent: SentCharge[] = [];
  stripeRaceHooks.charge = async (args) => {
    sent.push({ idempotencyKey: args.idempotencyKey!, metadata: { ...args.metadata }, amountCents: args.amountCents });
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  const response = await chargeRoute.POST(
    new Request("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: BOOKING_ID }),
    }) as never,
  );
  expect(response.status).toBeGreaterThanOrEqual(500);
  stripeRaceHooks.charge = null;
  expect(sent).toHaveLength(1);
  const [attempt] = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID } });
  expect(attempt).toMatchObject({ status: "PENDING", stripePaymentIntentId: null, reference: sent[0]!.idempotencyKey });
  expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PENDING");
  return { sent: sent[0]!, attemptRowId: attempt!.id };
}

/** Stripe's `payment_intent.succeeded` for the intent that POST made, through the real webhook processor. */
function succeededEvent(paymentIntentId: string, sent: SentCharge, request: Stripe.Event["request"] = null, eventId?: string): Stripe.Event {
  sequence += 1;
  return {
    id: eventId ?? `${EVENT_PREFIX}${sequence}`,
    object: "event",
    type: "payment_intent.succeeded",
    livemode: false,
    created: Date.parse("2026-06-30T20:00:00.000Z") / 1000,
    request,
    data: {
      object: {
        id: paymentIntentId,
        object: "payment_intent",
        amount: sent.amountCents,
        amount_received: sent.amountCents,
        currency: "nzd",
        created: Date.parse("2026-06-30T20:00:00.000Z") / 1000,
        status: "succeeded",
        payment_method: CARD,
        latest_charge: `ch_${paymentIntentId}`,
        description: null,
        metadata: sent.metadata,
      },
    },
  } as unknown as Stripe.Event;
}

async function deliver(event: Stripe.Event): Promise<number> {
  const result = await processStripeWebhookEvent(event);
  return result.init?.status ?? 200;
}

async function expectSettledOnce(paymentIntentId: string, attemptRowId: string): Promise<void> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { status: true, payment: { select: { status: true, amountCents: true, settledByTransactionId: true } } },
  });
  expect(booking).toEqual({ status: "PAID", payment: { status: "SUCCEEDED", amountCents: PRICE_CENTS, settledByTransactionId: attemptRowId } });
  const rows = await prisma.paymentTransaction.findMany({
    where: { paymentId: PAYMENT_ID },
    select: { id: true, status: true, stripePaymentIntentId: true, amountCents: true },
  });
  expect(rows).toEqual([{ id: attemptRowId, status: "SUCCEEDED", stripePaymentIntentId: paymentIntentId, amountCents: PRICE_CENTS }]);
  // Nothing was called unmatched, and nothing is being handed back.
  expect(await prisma.unrecognisedStripePayment.count({ where: { stripePaymentIntentId: paymentIntentId } })).toBe(0);
  expect(await prisma.alertCooldown.count({ where: { key: alertKey(paymentIntentId) } })).toBe(0);
  expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
}

(RUN ? describe : describe.skip)(
  "a saved-card charge whose answer was lost and whose capture was asynchronous - real PostgreSQL (#4646, INV-PAY-089)",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Saved-card asynchronous capture adoption");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      chargeRoute = await import("@/app/api/payments/charge-saved-method/route");
      ({ processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service"));
      ({ unrecognisedStripePaymentAlertKey: alertKey } = await import("@/lib/unrecognised-stripe-payment"));

      await clean();
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
      for (const [id, firstName, role] of [
        [OWNER_ID, "Owner", Role.USER],
        [OFFICER_ID, "Officer", Role.ADMIN],
      ] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName, lastName: "Proof", ageTier: "ADULT", canLogin: true, role },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4646 Lodge", slug: "race-4646" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    }, 120_000); // cold imports of the route's and the webhook's module graphs

    beforeEach(async () => {
      await clean();
      resetStripeRaceHooks();
      // A refund here would be a second capture being handed back: none may be asked for.
      stripeRaceHooks.refund = async () => {
        throw new Error("no refund may be made: the capture is this booking's one payment");
      };
      // An officer presses "charge the saved card" (the route takes the cron or an administrator).
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: [{ role: "ADMIN" }], canLogin: true } };
      await seed();
    });

    afterEach(() => {
      resetStripeRaceHooks();
      raceSession.current = null;
    });

    afterAll(async () => {
      try {
        resetStripeRaceHooks();
        raceSession.current = null;
        if (!prisma) return;
        await clean();
        await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
        await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
        await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
      } finally {
        harnessRole?.restore();
      }
    });

    it("the lost POST sent the attempt's own key and named its row in the metadata", async () => {
      const { sent, attemptRowId } = await chargeWithLostAnswer();
      const { savedCardChargeIdempotencyKey } = await import("@/lib/saved-card-charge-key");

      expect(sent.idempotencyKey).toBe(savedCardChargeIdempotencyKey(BOOKING_ID, attemptRowId));
      expect(sent.metadata).toEqual({ bookingId: BOOKING_ID, memberId: OWNER_ID, savedCardAttemptId: attemptRowId });
    });

    it("the asynchronous capture (request null) adopts the row and settles the booking once; a redelivery and a replay add nothing, and nothing is called unmatched", async () => {
      const { sent, attemptRowId } = await chargeWithLostAnswer();
      const intent = `${INTENT_PREFIX}async`;
      const capture = succeededEvent(intent, sent);

      expect(await deliver(capture)).toBe(200);
      await expectSettledOnce(intent, attemptRowId);

      // Stripe's redelivery of the same event, and a resend from the dashboard (a new event id): both null `request`.
      expect(await deliver(capture)).toBe(200);
      expect(await deliver(succeededEvent(intent, sent))).toBe(200);
      await expectSettledOnce(intent, attemptRowId);
    });

    it("a capture Stripe attributes to the request (its key) and the asynchronous one (no key) racing for the same row: one adoption wins and the booking settles once", async () => {
      const { sent, attemptRowId } = await chargeWithLostAnswer();
      const intent = `${INTENT_PREFIX}race`;
      const byKey = succeededEvent(intent, sent, { id: "req_race_4646", idempotency_key: sent.idempotencyKey });
      const byMetadata = succeededEvent(intent, sent);

      expect(await Promise.all([deliver(byKey), deliver(byMetadata)])).toEqual([200, 200]);

      await expectSettledOnce(intent, attemptRowId);
    });

    it("the two adoptions themselves, run at once: exactly one writes the capture as new money, the other writes nothing", async () => {
      const { sent, attemptRowId } = await chargeWithLostAnswer();
      const { adoptSavedCardChargeAttemptForIntent } = await import("@/lib/saved-card-charge-settle");
      const paymentIntent = { id: `${INTENT_PREFIX}adopt_race`, status: "succeeded" as const, amount: sent.amountCents, payment_method: CARD };

      const outcomes = await Promise.all([
        adoptSavedCardChargeAttemptForIntent({ paymentIntent, bookingId: BOOKING_ID, idempotencyKey: sent.idempotencyKey, metadata: sent.metadata }),
        adoptSavedCardChargeAttemptForIntent({ paymentIntent, bookingId: BOOKING_ID, idempotencyKey: null, metadata: sent.metadata }),
      ]);

      // The loser either found the row already holding the intent (null), or
      // claimed it under the Payment lock and lost (moved: false).
      expect(outcomes.filter((outcome) => outcome?.newlyCaptured === true)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome?.moved === true)).toHaveLength(1);
      const row = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: attemptRowId } });
      expect(row).toMatchObject({ status: "SUCCEEDED", stripePaymentIntentId: paymentIntent.id });
      expect(await prisma.paymentTransaction.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
    });

    it("the stated limit: an attempt minted before #4646 sent no attempt id, so its asynchronous capture is still alerted as unmatched, once", async () => {
      const { sent, attemptRowId } = await chargeWithLostAnswer();
      // As the old code minted it: the key without its #4646 ending, the metadata without the row.
      const { savedCardAttemptId: _dropped, ...oldMetadata } = sent.metadata;
      await prisma.paymentTransaction.update({ where: { id: attemptRowId }, data: { reference: sent.idempotencyKey.replace(/_v2$/, "") } });
      const intent = `${INTENT_PREFIX}pre_4646`;
      const capture = succeededEvent(intent, { ...sent, metadata: oldMetadata });

      expect(await deliver(capture)).toBe(200);
      expect(await deliver(succeededEvent(intent, { ...sent, metadata: oldMetadata }))).toBe(200);

      expect(await prisma.unrecognisedStripePayment.findMany({ where: { stripePaymentIntentId: intent }, select: { reason: true, bookingId: true } })).toEqual([
        { reason: "APP_INTENT_NO_TRANSACTION", bookingId: BOOKING_ID },
      ]);
      expect(await prisma.alertCooldown.count({ where: { key: alertKey(intent) } })).toBe(1);
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: attemptRowId } })).toMatchObject({ status: "PENDING", stripePaymentIntentId: null });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PENDING");
    });
  },
);
