/**
 * Real-PostgreSQL proof of #4993 (`INV-PAY-151`): a saved-card claim stranded
 * CONFIRMED by an interrupted charge is handed back to PENDING by
 * `recoverStaleSavedCardClaims`, and never while its money is captured.
 *
 * The stranded state is the real one: the real charge-saved-method route makes
 * its claim and sends the off-session charge, whose answer the harness's
 * `@/lib/stripe` double drops, leaving the attempt row PENDING with no intent.
 * The process is then modelled as having stopped before its compensating
 * release ran: the booking is put back CONFIRMED with a claim marker older than
 * the recovery age. The capture is the real adoption
 * (`adoptSavedCardChargeAttemptForIntent`) and the real webhook processor.
 *
 * Recovery's locked re-read holds global `lock(1)` and the lodge key; the
 * adoption takes only the Payment lock, so the two genuinely interleave. Either
 * order is safe: recovery sees the captured row and leaves the booking, or it
 * hands the booking back first and the capture settles it from PENDING. The
 * attempt row is never re-minted and no money is refunded.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`saved-card-claim-recovery-realdb-wiring.test.ts` pins the edge); it owns
 * and cleans its own `race-4993-` fixtures.
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

const OWNER_ID = "race-4993-owner";
const OFFICER_ID = "race-4993-officer";
const LODGE_ID = "race-4993-lodge";
const BOOKING_ID = "race-4993-booking";
const PAYMENT_ID = "race-4993-payment";
const CARD = "pm_race_4993";
const EVENT_PREFIX = "evt_race_4993_";
const INTENT_PREFIX = "pi_race_4993_";
// Future against the frozen suite clock (1 July 2026).
const CHECK_IN = new Date("2026-09-15T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-16T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-17T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;

let prisma: PrismaClient;
let chargeRoute: typeof import("@/app/api/payments/charge-saved-method/route");
let recoverStaleSavedCardClaims: (typeof import("@/lib/saved-card-charge-claim"))["recoverStaleSavedCardClaims"];
let processStripeWebhookEvent: (typeof import("@/lib/stripe-webhook-service"))["processStripeWebhookEvent"];
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
      stripeCustomerId: "cus_race_4993",
      stripePaymentMethodId: CARD,
      stripeSetupIntentId: "seti_race_4993",
    },
  });
}

type SentCharge = { idempotencyKey: string; metadata: Record<string, string>; amountCents: number };

/**
 * The member presses "pay with my saved card"; Stripe takes the POST, but the
 * connection drops before its answer arrives, so the attempt row stays PENDING
 * with no intent. Returns what the POST sent, as Stripe now holds it. Run a
 * second time over the same row, the route replays it rather than minting.
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
  const { savedCardChargeIdempotencyKey } = await import("@/lib/saved-card-charge-key");
  expect(sent[0]!.idempotencyKey).toBe(savedCardChargeIdempotencyKey(BOOKING_ID, attempt!.id));
  expect(sent[0]!.metadata).toEqual({ bookingId: BOOKING_ID, memberId: OWNER_ID, savedCardAttemptId: attempt!.id });
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

/**
 * The process stopped after Stripe took the POST and before the compensating
 * release ran: the booking is still claimed, its marker `ageMs` old.
 */
async function strandClaim(ageMs: number): Promise<{ sent: SentCharge; attemptRowId: string; marker: Date }> {
  const lost = await chargeWithLostAnswer();
  const marker = new Date(Date.now() - ageMs);
  await prisma.booking.update({
    where: { id: BOOKING_ID },
    data: { status: "CONFIRMED", savedCardClaimAt: marker, nonMemberHoldUntil: null },
  });
  return { ...lost, marker };
}

async function adopt(sent: SentCharge, paymentIntentId: string) {
  const { adoptSavedCardChargeAttemptForIntent } = await import("@/lib/saved-card-charge-settle");
  const { memberMoneyTestContext } = await import("./support/member-money-fixtures");
  return adoptSavedCardChargeAttemptForIntent({
    journal: memberMoneyTestContext(),
    paymentIntent: { id: paymentIntentId, status: "succeeded", amount: sent.amountCents, payment_method: CARD, created: 1_782_864_000 },
    bookingId: BOOKING_ID,
    idempotencyKey: null,
    metadata: sent.metadata,
  });
}

async function bookingState() {
  return prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { status: true, savedCardClaimAt: true, nonMemberHoldUntil: true },
  });
}

async function expectPaidOnce(paymentIntentId: string, attemptRowId: string): Promise<void> {
  expect(await bookingState()).toMatchObject({ status: "PAID", savedCardClaimAt: null });
  const rows = await prisma.paymentTransaction.findMany({
    where: { paymentId: PAYMENT_ID },
    select: { id: true, status: true, stripePaymentIntentId: true },
  });
  expect(rows).toEqual([{ id: attemptRowId, status: "SUCCEEDED", stripePaymentIntentId: paymentIntentId }]);
}

const AN_HOUR = 60 * 60 * 1000;

(RUN ? describe : describe.skip)(
  "a saved-card claim stranded CONFIRMED is recovered, never while its money is captured - real PostgreSQL (#4993, INV-PAY-151)",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Saved-card claim recovery");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      chargeRoute = await import("@/app/api/payments/charge-saved-method/route");
      ({ recoverStaleSavedCardClaims } = await import("@/lib/saved-card-charge-claim"));
      ({ processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service"));

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
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4993 Lodge", slug: "race-4993" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    }, 120_000); // cold imports of the route's and the webhook's module graphs

    beforeEach(async () => {
      await clean();
      resetStripeRaceHooks();
      stripeRaceHooks.refund = async () => {
        throw new Error("no refund may be made: the capture is this booking's one payment");
      };
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

    it("the route stamps the claim and its release clears it", async () => {
      let claimed: { status: string; savedCardClaimAt: Date | null } | null = null;
      stripeRaceHooks.charge = async () => {
        claimed = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true, savedCardClaimAt: true } });
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      };
      await chargeRoute.POST(
        new Request("http://localhost/api/payments/charge-saved-method", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookingId: BOOKING_ID }),
        }) as never,
      );
      expect(claimed).toMatchObject({ status: "CONFIRMED", savedCardClaimAt: expect.any(Date) });
      expect(await bookingState()).toMatchObject({ status: "PENDING", savedCardClaimAt: null });
    });

    it("hands a stranded claim back once, its hold the marker, the attempt row untouched; a second run finds nothing", async () => {
      const { attemptRowId, sent, marker } = await strandClaim(AN_HOUR);

      expect(await recoverStaleSavedCardClaims(new Date())).toEqual({ recoveredBookingIds: [BOOKING_ID], failedBookingIds: [] });
      expect(await bookingState()).toEqual({ status: "PENDING", savedCardClaimAt: null, nonMemberHoldUntil: marker });
      const rows = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID } });
      expect(rows).toEqual([expect.objectContaining({ id: attemptRowId, status: "PENDING", stripePaymentIntentId: null, reference: sent.idempotencyKey })]);
      expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking.saved_card_claim_recovered" } })).toBe(1);

      expect(await recoverStaleSavedCardClaims(new Date())).toEqual({ recoveredBookingIds: [], failedBookingIds: [] });
    });

    it("leaves a young claim, and a claim whose money is captured, CONFIRMED", async () => {
      const { sent } = await strandClaim(60 * 1000);
      expect(await recoverStaleSavedCardClaims(new Date())).toEqual({ recoveredBookingIds: [], failedBookingIds: [] });
      expect(await bookingState()).toMatchObject({ status: "CONFIRMED", savedCardClaimAt: expect.any(Date) });

      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { savedCardClaimAt: new Date(Date.now() - AN_HOUR) } });
      expect(await adopt(sent, `${INTENT_PREFIX}captured`)).toMatchObject({ newlyCaptured: true });
      expect(await recoverStaleSavedCardClaims(new Date())).toEqual({ recoveredBookingIds: [], failedBookingIds: [] });
      expect(await bookingState()).toMatchObject({ status: "CONFIRMED", savedCardClaimAt: expect.any(Date) });
    });

    it("recovery racing the capture's adoption: one order or the other, never a second row or a refund, and the capture settles the booking once", async () => {
      const { sent, attemptRowId } = await strandClaim(AN_HOUR);
      const intent = `${INTENT_PREFIX}race`;

      const [recovery, adoption] = await Promise.all([recoverStaleSavedCardClaims(new Date()), adopt(sent, intent)]);

      expect(recovery.failedBookingIds).toEqual([]);
      expect(adoption).toMatchObject({ newlyCaptured: true });
      const raced = await bookingState();
      if (recovery.recoveredBookingIds.length === 1) {
        // Recovery committed first: handed back, the capture now awaits promotion from PENDING.
        expect(raced).toMatchObject({ status: "PENDING", savedCardClaimAt: null });
      } else {
        // The adoption committed first: recovery saw the captured row and left the claim.
        expect(raced).toMatchObject({ status: "CONFIRMED", savedCardClaimAt: expect.any(Date) });
      }

      expect(await deliver(succeededEvent(intent, sent))).toBe(200);
      await expectPaidOnce(intent, attemptRowId);
      expect(await recoverStaleSavedCardClaims(new Date())).toEqual({ recoveredBookingIds: [], failedBookingIds: [] });
    });
  },
);
