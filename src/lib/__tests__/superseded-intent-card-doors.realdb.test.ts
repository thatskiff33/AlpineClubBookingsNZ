/**
 * Real-PostgreSQL proof for #4300 (`INV-PAY-138`): a card intent an edit
 * superseded never settles the booking - not through the member's confirm
 * call, the pay step's reload, the `/pay` link's reload, the Stripe webhook
 * after the cancel worker has already handed the capture to its refund, nor
 * the settle itself under lock(1) (the saved-card doors' path) - and neither
 * reuse arm hands its secret out again once the price is back at its amount.
 *
 * The superseded-intent machinery refunds such a capture
 * (`REFUND_SUPERSEDED_PAYMENT`). Before #4300 only the webhook's first look
 * diverted it (`queueSupersededPaymentIntentRefundRecovery`, which found a live
 * CANCEL_PAYMENT_INTENT row only); the other doors settled the booking with it
 * and the machinery then refunded it, leaving the booking PAID with no money.
 *
 * EVERY STEP IS THE REAL CODE: the pay step is the `create-payment-intent`
 * route, the confirm is the `confirm-payment` route, the link is the
 * `/api/pay/<token>/payment-intent` route, the edits are `modifyBookingBatch`,
 * Stripe's success event goes through `processStripeWebhookEvent`, and the
 * recovery worker is `runPaymentRecoveryOperationNow`. Only Stripe is a double
 * (the harness's one `@/lib/stripe` double, an in-memory intent store in which
 * a capture is something the test does), and the session is the harness's one
 * `@/lib/auth` double. The booking's price moves away from the intent and back
 * (an officer adds a guest, then removes them), so the old intent's amount is
 * right again when its capture comes back; the edit's inline cancel either
 * meets a Stripe outage, so the row waits for its retry and the old tab
 * can still be confirmed. (Without the outage the inline cancel kills the old
 * intent at once; a capture that beats it hands itself to its refund while the
 * price is still away, and the next edit then treats the booking as paid.)
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4300-` fixtures.
 */
import { PaymentRecoveryOperationStatus, PaymentRecoveryOperationType, Role, type PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
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

const OWNER_ID = "race-4300-owner";
const OFFICER_ID = "race-4300-officer";
const LODGE_ID = "race-4300-lodge";
const SEASON_ID = "race-4300-season";
const BOOKING_ID = "race-4300-booking";
const GUEST_ID = "race-4300-guest";
const GUEST_2_ID = "race-4300-guest-2";
// Future against the frozen suite clock (1 July 2026), beyond every fee tier.
const CHECK_IN = new Date("2026-09-15T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-16T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-17T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const GUEST_CENTS = 2 * NIGHT_CENTS;
const PRICE_CENTS = 2 * GUEST_CENTS;
const ADDED_GUEST = { firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false } as const;

type FakeIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  latest_charge: string | null;
};

/** Stripe, in memory. */
const stripe = {
  intents: new Map<string, FakeIntent>(),
  byKey: new Map<string, string>(),
  refunds: [] as Array<{ id: string; paymentIntentId: string; amountCents: number }>,
  sequence: 0,
  /** The next cancel throws, as a Stripe outage would. */
  failCancel: false,
};

let prisma: PrismaClient;
let payRoute: typeof import("@/app/api/payments/create-payment-intent/route");
let confirmRoute: typeof import("@/app/api/bookings/[id]/confirm-payment/route");
let linkRoute: typeof import("@/app/api/pay/[token]/payment-intent/route");
let webhook: typeof import("@/lib/stripe-webhook-service");
let editService: typeof import("@/lib/booking-batch-modification-service");
let recovery: typeof import("@/lib/payment-recovery");
let clubTimeServer: typeof import("@/lib/club-time/server");
let actionTokens: typeof import("@/lib/action-tokens");
let chargeCurrency: typeof import("@/lib/stripe-charge-currency");
let webhookEventSequence = 0;

async function clean(): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ targetId: BOOKING_ID }, { memberId: { in: [OWNER_ID, OFFICER_ID] } }, { subjectMemberId: OWNER_ID }] },
  });
  await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4300_" } } });
  await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4300_" } } });
  await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, ...(payment ? [payment.id] : [])] } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentLink.deleteMany({ where: { bookingId: BOOKING_ID } });
  if (payment) {
    await prisma.paymentRefund.deleteMany({ where: { paymentId: payment.id } });
    await prisma.payment.update({ where: { id: payment.id }, data: { settledByTransactionId: null } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: payment.id } });
    await prisma.payment.deleteMany({ where: { id: payment.id } });
  }
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A PAYMENT_PENDING booking, two guests for two nights at the season's rate, nothing paid. */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  for (const [id, firstName] of [
    [GUEST_ID, "Original"],
    [GUEST_2_ID, "Second"],
  ] as const) {
    await prisma.bookingGuest.create({
      data: {
        id,
        bookingId: BOOKING_ID,
        firstName,
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
        priceCents: GUEST_CENTS,
        nights: {
          create: [
            { stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
            { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
}

function installStripe(): void {
  stripeRaceHooks.customer = async () => ({ id: "cus_race_4300", object: "customer", metadata: {} });
  stripeRaceHooks.create = async (args) => {
    const known = args.idempotencyKey ? stripe.byKey.get(args.idempotencyKey) : undefined;
    if (known) return { ...stripe.intents.get(known)! };
    stripe.sequence += 1;
    const id = `pi_race_4300_${stripe.sequence}`;
    stripe.intents.set(id, {
      id,
      object: "payment_intent",
      amount: args.amountCents,
      currency: chargeCurrency.stripeChargeCurrency(args.format),
      status: "requires_payment_method",
      client_secret: `${id}_secret`,
      payment_method: null,
      metadata: args.metadata ?? {},
      latest_charge: null,
    });
    if (args.idempotencyKey) stripe.byKey.set(args.idempotencyKey, id);
    return { ...stripe.intents.get(id)! };
  };
  stripeRaceHooks.get = async (id) => {
    const intent = stripe.intents.get(id);
    if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
    return { ...intent };
  };
  stripeRaceHooks.cancel = async (id) => {
    if (stripe.failCancel) {
      stripe.failCancel = false;
      throw new Error("fake Stripe: connection reset");
    }
    const intent = stripe.intents.get(id);
    if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
    if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
    intent.status = "canceled";
    return { paymentIntent: { ...intent }, canceled: true };
  };
  stripeRaceHooks.refund = async (args) => {
    const id = `re_race_4300_${stripe.refunds.length + 1}`;
    stripe.refunds.push({ id, paymentIntentId: args.paymentIntentId, amountCents: args.amountCents ?? 0 });
    return {
      id,
      object: "refund",
      amount: args.amountCents,
      currency: "nzd",
      status: "succeeded",
      reason: "requested_by_customer",
      created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
      charge: `ch_${args.paymentIntentId}`,
      payment_intent: args.paymentIntentId,
      metadata: args.metadata ?? {},
    };
  };
}

/** The member (or a payer holding the link) confirms the intent in a tab still holding its secret. */
function capture(intentId: string): void {
  const intent = stripe.intents.get(intentId);
  if (!intent) throw new Error(`no intent ${intentId}`);
  if (intent.status === "canceled" || intent.status === "succeeded") {
    throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
  }
  intent.status = "succeeded";
  intent.payment_method = "pm_race_4300";
  intent.latest_charge = `ch_${intentId}`;
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The member opens (or reloads) the pay step: the real route. */
async function payStep() {
  const { NextRequest } = await import("next/server");
  return json(
    await payRoute.POST(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: BOOKING_ID }),
      }),
    ),
  );
}

/** The member's browser reports Stripe's success: the real confirm route. */
async function confirm(paymentIntentId: string) {
  const { NextRequest } = await import("next/server");
  return json(
    await confirmRoute.POST(
      new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/confirm-payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      }),
      { params: Promise.resolve({ id: BOOKING_ID }) },
    ),
  );
}

/** A live `/pay` link for the booking (its token; the link row is the fixture, no money). */
async function issueLink(): Promise<string> {
  const { token, tokenHash } = actionTokens.issueActionToken();
  await prisma.paymentLink.create({ data: { bookingId: BOOKING_ID, tokenHash, expiresAt: CHECK_OUT } });
  return token;
}

/** The payer opens (or reloads) the `/pay` link: the real route. */
async function linkStep(token: string) {
  const { NextRequest } = await import("next/server");
  return json(
    await linkRoute.POST(
      new NextRequest(`http://localhost/api/pay/${token}/payment-intent`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.43" },
      }),
      { params: Promise.resolve({ token }) },
    ),
  );
}

/** An officer's edit through the real batch door. */
async function edit(input: Record<string, unknown>) {
  return editService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

/** The officer adds a guest (the old intent is superseded), then takes them off again (its amount is right again). */
async function editAwayAndBack(): Promise<void> {
  await edit({ addGuests: [ADDED_GUEST] });
  const added = await prisma.bookingGuest.findFirstOrThrow({ where: { bookingId: BOOKING_ID, firstName: ADDED_GUEST.firstName } });
  await edit({ removeGuestIds: [added.id] });
  expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).finalPriceCents).toBe(PRICE_CENTS);
}

/** Stripe's `payment_intent.succeeded`: the real webhook processor. */
async function deliverSucceededWebhook(intentId: string) {
  webhookEventSequence += 1;
  const event = {
    id: `evt_race_4300_${webhookEventSequence}`,
    object: "event",
    type: "payment_intent.succeeded",
    request: null,
    data: { object: { ...stripe.intents.get(intentId)! } },
  } as unknown as Stripe.Event;
  return webhook.processStripeWebhookEvent(event);
}

/** The recovery worker, after its retry backoff: every open row on the booking, until none is left to run. */
async function drainRecovery(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    const open = await prisma.paymentRecoveryOperation.findMany({
      where: { bookingId: BOOKING_ID, status: { in: [PaymentRecoveryOperationStatus.PENDING, PaymentRecoveryOperationStatus.FAILED] } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (open.length === 0) return;
    // Time passes: the backoff a Stripe outage set is over.
    await prisma.paymentRecoveryOperation.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: { nextRetryAt: new Date(Date.now() - 1_000) },
    });
    for (const row of open) await recovery.runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
  }
  throw new Error("recovery did not settle in six passes");
}

/** The cancel worker's retry after the outage's backoff, alone: the capture beat it, so it hands the capture to its refund. */
async function runCancelWorker(intentId: string): Promise<void> {
  const cancel = await prisma.paymentRecoveryOperation.findFirstOrThrow({
    where: { bookingId: BOOKING_ID, paymentIntentId: intentId, type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT },
    select: { id: true },
  });
  await prisma.paymentRecoveryOperation.update({ where: { id: cancel.id }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
  expect(await recovery.runPaymentRecoveryOperationNow(cancel.id, CLUB_FORMAT_TEST)).toBe("succeeded");
}

/** The superseded-intent rows on one intent, cancel first (rows written in one frozen instant tie on `createdAt`). */
async function supersededOperations(intentId: string) {
  const rows = await prisma.paymentRecoveryOperation.findMany({
    where: { bookingId: BOOKING_ID, paymentIntentId: intentId },
    select: { type: true, status: true },
  });
  return rows.sort((a, b) => a.type.localeCompare(b.type));
}

/** What the booking says, against what Stripe holds. */
async function money() {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
  const capturedCents = [...stripe.intents.values()].filter((intent) => intent.status === "succeeded").reduce((sum, intent) => sum + intent.amount, 0);
  const refundedCents = stripe.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  return { status: booking.status, capturedCents, refundedCents, heldCents: capturedCents - refundedCents };
}

/** The money law #4300 is about: a PAID booking holds its price, never nothing. */
async function expectNeverPaidWithoutMoney(): Promise<void> {
  const state = await money();
  if (state.status === "PAID") expect(state.heldCents, JSON.stringify(state)).toBe(PRICE_CENTS);
}

/** The superseded intent went back to the member in full, and the booking still waits for its money. */
async function expectSupersededCaptureRefunded(intentId: string): Promise<void> {
  expect(stripe.refunds).toEqual([expect.objectContaining({ paymentIntentId: intentId, amountCents: PRICE_CENTS })]);
  expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
  expect(await supersededOperations(intentId)).toEqual([
    { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.SUCCEEDED },
    { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: PaymentRecoveryOperationStatus.SUCCEEDED },
  ]);
}

/** The member pays again on a fresh intent, and that one settles the booking. */
async function expectFreshPaymentSettles(fresh: { status: number; body: Record<string, unknown> }, superseded: string, settle: (id: string) => Promise<unknown>) {
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  const freshIntent = fresh.body.paymentIntentId as string;
  expect(freshIntent).toBeDefined();
  expect(freshIntent).not.toBe(superseded);
  expect(stripe.intents.get(freshIntent)!.amount).toBe(PRICE_CENTS);
  capture(freshIntent);
  await settle(freshIntent);
  await drainRecovery();
  expect(await money()).toMatchObject({ status: "PAID", heldCents: PRICE_CENTS });
}

(RUN ? describe : describe.skip)("a superseded card capture never settles its booking, nor is its intent handed out again, on PostgreSQL (#4300, INV-PAY-138)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Superseded-intent card doors");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    payRoute = await import("@/app/api/payments/create-payment-intent/route");
    confirmRoute = await import("@/app/api/bookings/[id]/confirm-payment/route");
    linkRoute = await import("@/app/api/pay/[token]/payment-intent/route");
    webhook = await import("@/lib/stripe-webhook-service");
    editService = await import("@/lib/booking-batch-modification-service");
    recovery = await import("@/lib/payment-recovery");
    clubTimeServer = await import("@/lib/club-time/server");
    actionTokens = await import("@/lib/action-tokens");
    chargeCurrency = await import("@/lib/stripe-charge-currency");

    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4300 Lodge", slug: "race-4300" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 },
      ],
    });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 4300 spring",
        type: "WINTER",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        membershipTypeRates: {
          create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
          ],
        },
      },
    });
  }, 120_000); // cold imports of the route, edit, webhook and recovery module graphs

  beforeEach(async () => {
    await clean();
    stripe.intents.clear();
    stripe.byKey.clear();
    stripe.refunds = [];
    stripe.failCancel = false;
    installStripe();
    raceSession.current = { user: { id: OWNER_ID, role: "USER", accessRoles: [], canLogin: true } };
    await seed();
  });

  afterEach(() => {
    resetStripeRaceHooks();
    raceSession.current = null;
  });

  afterAll(async () => {
    resetStripeRaceHooks();
    raceSession.current = null;
    if (!prisma) return;
    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
  });

  /** The pay step mints the intent the edit then supersedes. */
  async function mintOnPayStep(): Promise<string> {
    const minted = await payStep();
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    expect(minted.body.chargedAmountCents).toBe(PRICE_CENTS);
    return minted.body.paymentIntentId as string;
  }

  it("the confirm door: Stripe was down for the edit's cancel, and the old tab's capture is confirmed after the price came back", async () => {
    const superseded = await mintOnPayStep();
    stripe.failCancel = true;
    await editAwayAndBack();
    expect((await supersededOperations(superseded))[0]).toMatchObject({ type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT });
    capture(superseded);

    const confirmed = await confirm(superseded);
    await deliverSucceededWebhook(superseded);
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    expect(confirmed.status).toBe(409);
    expect(confirmed.body).toMatchObject({ code: "SUPERSEDED_CARD_PAYMENT_REFUNDING", paymentRefunding: true, repaymentRequired: true });
    await expectSupersededCaptureRefunded(superseded);
    await expectFreshPaymentSettles(await payStep(), superseded, confirm);
  });

  it("the confirm door after the webhook already handed the capture to its refund", async () => {
    const superseded = await mintOnPayStep();
    stripe.failCancel = true;
    await editAwayAndBack();
    capture(superseded);
    await deliverSucceededWebhook(superseded);
    expect(await supersededOperations(superseded)).toEqual([
      { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.SUCCEEDED },
      { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: PaymentRecoveryOperationStatus.PENDING },
    ]);

    const confirmed = await confirm(superseded);
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    expect(confirmed.status).toBe(409);
    await expectSupersededCaptureRefunded(superseded);
    await expectFreshPaymentSettles(await payStep(), superseded, confirm);
  });

  it("the webhook after the cancel worker's retry lost to the capture and handed it to its refund", async () => {
    const superseded = await mintOnPayStep();
    stripe.failCancel = true;
    await editAwayAndBack();
    capture(superseded);
    await runCancelWorker(superseded);
    expect(await supersededOperations(superseded)).toEqual([
      { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.SUCCEEDED },
      { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: PaymentRecoveryOperationStatus.PENDING },
    ]);

    await deliverSucceededWebhook(superseded);
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    await expectSupersededCaptureRefunded(superseded);
    await expectFreshPaymentSettles(await payStep(), superseded, async (id) => deliverSucceededWebhook(id));
  });

  it("the pay step's reload, holding the superseded capture", async () => {
    const superseded = await mintOnPayStep();
    stripe.failCancel = true;
    await editAwayAndBack();
    capture(superseded);

    const reload = await payStep();
    // The member is told the earlier payment is going back.
    expect(reload.body.previousPaymentRefunding).toBe(true);
    await deliverSucceededWebhook(superseded);
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    await expectSupersededCaptureRefunded(superseded);
    // The reload minted the fresh intent the member pays with.
    await expectFreshPaymentSettles(reload, superseded, confirm);
  });

  it("the /pay link's reload, holding the superseded capture", async () => {
    const token = await issueLink();
    const minted = await linkStep(token);
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const superseded = minted.body.paymentIntentId as string;
    stripe.failCancel = true;
    await editAwayAndBack();
    capture(superseded);

    const reload = await linkStep(token);
    // The payer is told the earlier payment is going back.
    expect(reload.body.previousPaymentRefunding).toBe(true);
    await deliverSucceededWebhook(superseded);
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    await expectSupersededCaptureRefunded(superseded);
    await expectFreshPaymentSettles(reload, superseded, async (id) => deliverSucceededWebhook(id));
  });

  it("the settle itself, under lock(1): a superseded capture brought straight to markBookingPaymentSucceeded settles nothing", async () => {
    const superseded = await mintOnPayStep();
    stripe.failCancel = true;
    await editAwayAndBack();
    capture(superseded);

    // A saved-card door, or a door whose own check an edit overtook, calls the
    // settle directly with the capture.
    const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
    const settled = await markBookingPaymentSucceeded({
      bookingId: BOOKING_ID,
      paymentIntentId: superseded,
      amountCents: PRICE_CENTS,
      paymentMethodId: "pm_race_4300",
      format: CLUB_FORMAT_TEST,
    });
    expect(settled.outcome).toBe("superseded_capture");
    expect((await money()).status).toBe("PAYMENT_PENDING");
    await drainRecovery();

    await expectNeverPaidWithoutMoney();
    await expectSupersededCaptureRefunded(superseded);
    await expectFreshPaymentSettles(await payStep(), superseded, confirm);
  });

  describe("a saved-card charge beside a superseded capture (the released claim's next attempt)", () => {
    async function nextChargeAttempt() {
      const { beginSavedCardChargeAttempt, SAVED_CARD_CHARGE_REASON } = await import("@/lib/saved-card-charge-attempt");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      // Under the claim's lock(1), as every saved-card door begins its attempt.
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return beginSavedCardChargeAttempt(tx, {
          paymentId: payment.id,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          card: { stripePaymentMethodId: "pm_race_4300_saved" },
          reason: SAVED_CARD_CHARGE_REASON.cron,
        });
      });
    }

    it("once the settle refused it and handed it to its refund, the next attempt charges as usual", async () => {
      const superseded = await mintOnPayStep();
      stripe.failCancel = true;
      await editAwayAndBack();
      capture(superseded);
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      expect(
        (await markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: superseded, amountCents: PRICE_CENTS, paymentMethodId: "pm_race_4300", format: CLUB_FORMAT_TEST })).outcome,
      ).toBe("superseded_capture");
      expect((await supersededOperations(superseded)).map((row) => row.type)).toContain(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);

      await expect(nextChargeAttempt()).resolves.toMatchObject({ kind: "fresh" });
    });

    it("its superseded refund DEAD (Stripe refused every retry), the next attempt refuses for a person to act - never charges beside it", async () => {
      const superseded = await mintOnPayStep();
      stripe.failCancel = true;
      await editAwayAndBack();
      capture(superseded);
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      await markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: superseded, amountCents: PRICE_CENTS, paymentMethodId: "pm_race_4300", format: CLUB_FORMAT_TEST });
      // The refund worker runs it until its retries are spent, Stripe down each time.
      stripeRaceHooks.refund = async () => {
        throw new Error("fake Stripe: refund unavailable");
      };
      const refundRow = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, paymentIntentId: superseded, type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
        select: { id: true },
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await prisma.paymentRecoveryOperation.updateMany({ where: { id: refundRow.id, nextRetryAt: { not: null } }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
        await recovery.runPaymentRecoveryOperationNow(refundRow.id, CLUB_FORMAT_TEST);
      }
      const { isPaymentRecoveryOperationInFlight } = await import("@/lib/payment-recovery-constants");
      expect(isPaymentRecoveryOperationInFlight(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: refundRow.id } }))).toBe(false);

      await expect(nextChargeAttempt()).rejects.toMatchObject({ why: "superseded_refund_stopped", paymentIntentId: superseded });
    });

    for (const cancelRow of ["waiting to retry", "exhausted (FAILED at the ceiling)"] as const) {
      it(`named only by its cancel row (${cancelRow}): the attempt waits, the door's hand-off starts the refund, and the next attempt charges`, async () => {
        const superseded = await mintOnPayStep();
        // Stripe is down for the edit's cancel; for the exhausted variant, for every retry too.
        stripe.failCancel = true;
        await editAwayAndBack();
        if (cancelRow === "exhausted (FAILED at the ceiling)") {
          const cancel = await prisma.paymentRecoveryOperation.findFirstOrThrow({
            where: { bookingId: BOOKING_ID, paymentIntentId: superseded, type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT },
            select: { id: true },
          });
          for (let attempt = 0; attempt < 6; attempt += 1) {
            stripe.failCancel = true;
            await prisma.paymentRecoveryOperation.updateMany({ where: { id: cancel.id, nextRetryAt: { not: null } }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
            await recovery.runPaymentRecoveryOperationNow(cancel.id, CLUB_FORMAT_TEST);
          }
          expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: cancel.id }, select: { status: true, nextRetryAt: true } })).toEqual({
            status: PaymentRecoveryOperationStatus.FAILED,
            nextRetryAt: null,
          });
          stripe.failCancel = false;
        }
        capture(superseded);
        // The capture is on the ledger, as a webhook or a door recording it leaves it.
        const { upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions");
        const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
        await upsertPaymentIntentTransaction({ paymentId: payment.id, kind: "PRIMARY", paymentIntentId: superseded, amountCents: PRICE_CENTS, status: "SUCCEEDED", paymentMethodId: "pm_race_4300" });

        const refusal = await nextChargeAttempt().then(
          () => null,
          (err: unknown) => err as import("@/lib/saved-card-charge-attempt").SavedCardChargeRefusedError,
        );
        expect(refusal).toMatchObject({ why: "superseded_capture_returning", paymentIntentId: superseded, supersededIntentsToHandOff: [superseded] });

        // What every refusing saved-card door does after the rollback.
        const { handOffSupersededCaptureAfterRefusal } = await import("@/lib/superseded-paid-intent");
        await handOffSupersededCaptureAfterRefusal(refusal!);
        expect((await supersededOperations(superseded)).map((row) => row.type)).toContain(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);

        await expect(nextChargeAttempt()).resolves.toMatchObject({ kind: "fresh" });
      });
    }

    it("beside money really taken: refused as captured_primary_exists, yet the superseded capture with no refund started is still handed off, once", async () => {
      const superseded = await mintOnPayStep();
      // Stripe is down for the edit's cancel: only the waiting cancel row names the old intent.
      stripe.failCancel = true;
      await editAwayAndBack();
      // The pay step's reload mints the fresh intent, and the member pays it.
      const reload = await payStep();
      expect(reload.status, JSON.stringify(reload.body)).toBe(200);
      const real = reload.body.paymentIntentId as string;
      expect(real).not.toBe(superseded);
      capture(real);
      // The old tab's capture lands too, after the reload.
      capture(superseded);
      // Both captures are on the ledger, as a webhook or a door recording them leaves them.
      const { upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      for (const intent of [real, superseded]) {
        await upsertPaymentIntentTransaction({ paymentId: payment.id, kind: "PRIMARY", paymentIntentId: intent, amountCents: PRICE_CENTS, status: "SUCCEEDED", paymentMethodId: "pm_race_4300" });
      }
      const refundRows = () =>
        prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, paymentIntentId: superseded, type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT } });
      const refuse = () =>
        nextChargeAttempt().then(
          () => null,
          (err: unknown) => err as import("@/lib/saved-card-charge-attempt").SavedCardChargeRefusedError,
        );
      const { handOffSupersededCaptureAfterRefusal } = await import("@/lib/superseded-paid-intent");

      // Real money wins the refusal, but the waiting superseded capture rides along to be handed off.
      const first = await refuse();
      expect(first).toMatchObject({ why: "captured_primary_exists", paymentIntentId: real, supersededIntentsToHandOff: [superseded] });
      expect(await refundRows()).toBe(0);
      await handOffSupersededCaptureAfterRefusal(first!);
      expect(await refundRows()).toBe(1);

      // A second refusal (the real capture still holds the booking back) and a second hand-off queue no second refund.
      const second = await refuse();
      expect(second).toMatchObject({ why: "captured_primary_exists", paymentIntentId: real, supersededIntentsToHandOff: [] });
      await handOffSupersededCaptureAfterRefusal(second!);
      await handOffSupersededCaptureAfterRefusal(first!);
      expect(await refundRows()).toBe(1);
    });
  });

  for (const door of ["the pay step", "the /pay link"] as const) {
    it(`${door} never hands out a superseded intent's secret again once the price is back at its amount`, async () => {
      const token = door === "the /pay link" ? await issueLink() : null;
      const step = () => (token ? linkStep(token) : payStep());
      const minted = await step();
      expect(minted.status, JSON.stringify(minted.body)).toBe(200);
      const superseded = minted.body.paymentIntentId as string;
      // X -> Y while Stripe is down (the cancel row waits), then Y -> X.
      stripe.failCancel = true;
      await editAwayAndBack();
      expect(stripe.intents.get(superseded)!.status).toBe("requires_payment_method");

      const reload = await step();
      expect(reload.status, JSON.stringify(reload.body)).toBe(200);
      expect(reload.body.paymentIntentId).not.toBe(superseded);
      expect(reload.body.clientSecret).not.toBe(stripe.intents.get(superseded)!.client_secret);

      // The cancel row's retry kills the old intent; the fresh one pays.
      await drainRecovery();
      expect(stripe.intents.get(superseded)!.status).toBe("canceled");
      await expectFreshPaymentSettles(reload, superseded, async (id) => deliverSucceededWebhook(id));
      expect(stripe.refunds).toEqual([]);
    });
  }
});
