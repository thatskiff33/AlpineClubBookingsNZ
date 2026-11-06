/**
 * Real-PostgreSQL proof for #4320 (`INV-PAY-045`): reversing a manual mark-paid
 * re-applies the supersede rule to the restored booking and withdraws the
 * cancellation of every intent that booking can still be paid with - one still
 * waiting to retry after a Stripe outage included - while an intent at a price
 * the booking no longer owes, or one an edit had superseded before the settle,
 * stays cancelled.
 *
 * The mark-paid queues a CANCEL_PAYMENT_INTENT row for each live card intent on
 * the booking. Before #4320 the reversal deleted only the PENDING and
 * PROCESSING ones, so a row Stripe's outage had left FAILED and retrying
 * survived: once the booking was payable again, the member's capture of that
 * intent was handed to its superseded refund and the booking never settled.
 * The cases below also pin the cases a remembered list cannot see: an edit on
 * the PAID booking sharing the settle's cancel row, a settle recorded before
 * #4320, and a capture whose hand-off lands while the reversal is running.
 * A cancellation the runner will not finish (given up, or on its last attempt
 * while the reversal runs), on an intent the reversal condemns or the settle
 * adopted, is re-armed and cancels once Stripe is back. Once the mark-paid's
 * cancel has landed, the pay step after the reversal refuses card before
 * reaching Stripe, so the first intent's `_initial` key is never replayed
 * (#4348). An ADDITIONAL intent's
 * cases (the live ask a covering settle's mirror rebuild hid, and the cash row
 * the reversal stamps so the mirror reads that ask once paid, #4355) are pinned
 * in the unit suites only: an edit on a cash-paid booking asks no card top-up,
 * and no real writer presents the extra's coverage question on a settle that
 * can complete (`INV-PAY-058`), so none reaches one on a booking a reversal
 * accepts.
 *
 * EVERY STEP IS THE REAL CODE: the pay step is the `create-payment-intent`
 * route, the confirm is the `confirm-payment` route, mark-paid and its reversal
 * are `applyManualBookingPayment`, the edits are `modifyBookingBatch`, Stripe's
 * success event goes through `processStripeWebhookEvent`, and the recovery
 * worker is `runPaymentRecoveryOperationNow`. Only Stripe is a double (the
 * harness's one `@/lib/stripe` double, an in-memory intent store in which a
 * capture is something the test does), and the session is the harness's one
 * `@/lib/auth` double. The only state moved by hand is a row's `nextRetryAt`,
 * brought back to now as the passing of its backoff would, and, for the
 * pre-#4320 settle, the adopted list taken off its audit row as that code
 * never wrote it. One Stripe cancel is held mid-call, to land the reversal
 * inside a worker's last attempt.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4320-` fixtures.
 */
import { PaymentRecoveryOperationStatus, PaymentRecoveryOperationType, Role, type PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
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

const OWNER_ID = "race-4320-owner";
const OFFICER_ID = "race-4320-officer";
const LODGE_ID = "race-4320-lodge";
const SEASON_ID = "race-4320-season";
const BOOKING_ID = "race-4320-booking";
const GUEST_ID = "race-4320-guest";
const GUEST_2_ID = "race-4320-guest-2";
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
  /** Every create call, a key replay included. */
  createCalls: 0,
  /** While true, every cancel throws, as a Stripe outage would. */
  down: false,
};

let prisma: PrismaClient;
let payRoute: typeof import("@/app/api/payments/create-payment-intent/route");
let confirmRoute: typeof import("@/app/api/bookings/[id]/confirm-payment/route");
let webhook: typeof import("@/lib/stripe-webhook-service");
let editService: typeof import("@/lib/booking-batch-modification-service");
let recovery: typeof import("@/lib/payment-recovery");
let manualPayment: typeof import("@/lib/manual-booking-payment");
let clubTimeServer: typeof import("@/lib/club-time/server");
let chargeCurrency: typeof import("@/lib/stripe-charge-currency");
let webhookEventSequence = 0;
/** Two more connections, for the interleaving proof: one holds a row the reversal needs, one watches. */
let holderClient: PrismaClient;
let observerClient: PrismaClient;

async function clean(): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
        ...(payment ? [{ entityId: payment.id }] : []),
      ],
    },
  });
  await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4320_" } } });
  await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4320_" } } });
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
  stripeRaceHooks.customer = async () => ({ id: "cus_race_4320", object: "customer", metadata: {} });
  stripeRaceHooks.create = async (args) => {
    stripe.createCalls += 1;
    const known = args.idempotencyKey ? stripe.byKey.get(args.idempotencyKey) : undefined;
    if (known) return { ...stripe.intents.get(known)! };
    stripe.sequence += 1;
    const id = `pi_race_4320_${stripe.sequence}`;
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
    if (stripe.down) throw new Error("fake Stripe: connection reset");
    const intent = stripe.intents.get(id);
    if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
    if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
    intent.status = "canceled";
    return { paymentIntent: { ...intent }, canceled: true };
  };
  stripeRaceHooks.refund = async (args) => {
    const id = `re_race_4320_${stripe.refunds.length + 1}`;
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

/** The member confirms the intent in a tab still holding its secret. */
function capture(intentId: string): void {
  const intent = stripe.intents.get(intentId);
  if (!intent) throw new Error(`no intent ${intentId}`);
  if (intent.status === "canceled" || intent.status === "succeeded") {
    throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
  }
  intent.status = "succeeded";
  intent.payment_method = "pm_race_4320";
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

/** Stripe's `payment_intent.succeeded`: the real webhook processor. */
async function deliverSucceededWebhook(intentId: string) {
  webhookEventSequence += 1;
  const event = {
    id: `evt_race_4320_${webhookEventSequence}`,
    object: "event",
    type: "payment_intent.succeeded",
    request: null,
    data: { object: { ...stripe.intents.get(intentId)! } },
  } as unknown as Stripe.Event;
  return webhook.processStripeWebhookEvent(event);
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

/** The officer records cash for the booking: the real mark-paid. */
async function markPaid(expectedAmountCents: number = PRICE_CENTS) {
  return manualPayment.applyManualBookingPayment({
    bookingId: BOOKING_ID,
    direction: "paid",
    actingMemberId: OFFICER_ID,
    notifyMember: false,
    expectedAmountCents,
    note: "cash at the lodge",
  });
}

/** The officer reverses it: the real reversal. */
async function reverse() {
  return manualPayment.applyManualBookingPayment({ bookingId: BOOKING_ID, direction: "unpaid", actingMemberId: OFFICER_ID, note: "recorded in error" });
}

/** The cancel row on one intent. */
async function cancelRow(intentId: string) {
  return prisma.paymentRecoveryOperation.findFirst({
    where: { bookingId: BOOKING_ID, paymentIntentId: intentId, type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT },
  });
}

/** One run of the cancel worker on an intent's row, after its retry backoff has passed. */
async function runCancelWorker(intentId: string) {
  const row = await cancelRow(intentId);
  if (!row) throw new Error(`no cancel row on ${intentId}`);
  await prisma.paymentRecoveryOperation.updateMany({ where: { id: row.id, nextRetryAt: { not: null } }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
  return recovery.runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
}

/** The recovery worker, after its retry backoff: every open row on the booking, until none is left to run. */
async function drainRecovery(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    const open = await prisma.paymentRecoveryOperation.findMany({
      where: { bookingId: BOOKING_ID, status: { in: [PaymentRecoveryOperationStatus.PENDING, PaymentRecoveryOperationStatus.FAILED] }, nextRetryAt: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (open.length === 0) return;
    await prisma.paymentRecoveryOperation.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: { nextRetryAt: new Date(Date.now() - 1_000) },
    });
    for (const row of open) await recovery.runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
  }
  throw new Error("recovery did not settle in six passes");
}

/** A promise the test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** What the booking says, against what Stripe holds. */
async function money() {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
  const capturedCents = [...stripe.intents.values()].filter((intent) => intent.status === "succeeded").reduce((sum, intent) => sum + intent.amount, 0);
  const refundedCents = stripe.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  return { status: booking.status, capturedCents, refundedCents, heldCents: capturedCents - refundedCents };
}

(RUN ? describe : describe.skip)("reversing a manual mark-paid re-derives which intents stay cancelled and withdraws the rest, retrying ones included, on PostgreSQL (#4320, INV-PAY-045)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Manual reversal retrying cancel");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    payRoute = await import("@/app/api/payments/create-payment-intent/route");
    confirmRoute = await import("@/app/api/bookings/[id]/confirm-payment/route");
    webhook = await import("@/lib/stripe-webhook-service");
    editService = await import("@/lib/booking-batch-modification-service");
    recovery = await import("@/lib/payment-recovery");
    manualPayment = await import("@/lib/manual-booking-payment");
    clubTimeServer = await import("@/lib/club-time/server");
    chargeCurrency = await import("@/lib/stripe-charge-currency");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const separateClient = (applicationName: string) => {
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", applicationName);
      return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
    };
    holderClient = separateClient("race-4320-holder");
    observerClient = separateClient("race-4320-observer");
    await Promise.all([holderClient.$connect(), observerClient.$connect()]);

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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4320 Lodge", slug: "race-4320" } });
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
        name: "Race 4320 spring",
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
    stripe.createCalls = 0;
    stripe.down = false;
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
    await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
  });

  /** The pay step mints the member's intent at the booking's price. */
  async function mintOnPayStep(): Promise<string> {
    const minted = await payStep();
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    expect(minted.body.chargedAmountCents).toBe(PRICE_CENTS);
    return minted.body.paymentIntentId as string;
  }

  /**
   * The member holds the pay step open; the officer records cash while Stripe
   * is down, so the mark-paid's own cancel of that intent fails and its row
   * waits FAILED to retry; then the officer reverses the mark-paid.
   */
  async function markPaidCancelRetryingThenReverse(): Promise<{ intent: string; reversal: Awaited<ReturnType<typeof reverse>> }> {
    const intent = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    expect((await money()).status).toBe("PAID");
    // The mark-paid's own cancel row, run by the worker during the outage.
    expect(await cancelRow(intent)).toMatchObject({ status: PaymentRecoveryOperationStatus.PENDING });
    expect(await runCancelWorker(intent)).toBe("failed");
    expect(await cancelRow(intent)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, nextRetryAt: expect.any(Date) });
    stripe.down = false;

    const reversal = await reverse();
    expect(reversal.bookingStatus).toBe("PAYMENT_PENDING");
    return { intent, reversal };
  }

  it("the mark-paid's own cancel, FAILED and retrying, is withdrawn: the member's capture of that intent settles the booking", async () => {
    const { intent } = await markPaidCancelRetryingThenReverse();
    expect(await cancelRow(intent)).toBeNull();

    // The member pays in the tab they still hold: the booking is payable again at that price.
    capture(intent);
    const confirmed = await confirm(intent);
    await deliverSucceededWebhook(intent);
    await drainRecovery();

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(stripe.refunds).toEqual([]);
    expect(await money()).toMatchObject({ status: "PAID", heldCents: PRICE_CENTS });
  });

  it("the mark-paid's own cancel, FAILED and retrying, is withdrawn: a later worker run cancels nothing", async () => {
    const { intent, reversal } = await markPaidCancelRetryingThenReverse();
    await drainRecovery();
    expect(stripe.intents.get(intent)!.status).toBe("requires_payment_method");
    expect(reversal.bookingStatus).toBe("PAYMENT_PENDING");

    // The reversal's audit row names the row it withdrew, with the status it read.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "booking-payment.manual-payment.mark-unpaid", targetId: BOOKING_ID },
      select: { metadata: true },
    });
    expect((audit.metadata as { closedRecoveryOperations: unknown[] }).closedRecoveryOperations).toEqual([
      expect.objectContaining({ paymentIntentId: intent, type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.FAILED }),
    ]);
  });

  it("the mark-paid's own cancel, exhausted at the ceiling, is withdrawn too: the reversal makes it moot", async () => {
    const intent = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    for (let attempt = 0; attempt < 6; attempt += 1) await runCancelWorker(intent);
    expect(await cancelRow(intent)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, nextRetryAt: null });
    stripe.down = false;

    await reverse();
    expect(await cancelRow(intent)).toBeNull();

    capture(intent);
    await deliverSucceededWebhook(intent);
    await drainRecovery();
    expect(stripe.refunds).toEqual([]);
    expect(await money()).toMatchObject({ status: "PAID", heldCents: PRICE_CENTS });
  });

  it("#4348: the mark-paid's cancel landed before the reversal: the pay step refuses card before minting, so no key is reused and the cancelled intent's secret never returns", async () => {
    const cancelled = await mintOnPayStep();
    await markPaid();
    expect(await runCancelWorker(cancelled)).toBe("succeeded");
    expect(stripe.intents.get(cancelled)!.status).toBe("canceled");
    expect((await reverse()).bookingStatus).toBe("PAYMENT_PENDING");

    // The reversal leaves the payment on internet banking, so the pay step stops
    // before Stripe: the pointer is null, and a mint here would reuse the first
    // intent's `_initial` key, which Stripe answers with the cancelled intent for 24 hours.
    const createCallsBefore = stripe.createCalls;
    const again = await payStep();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SWITCHED_TO_INTERNET_BANKING");
    expect(again.body).not.toHaveProperty("clientSecret");
    expect(stripe.createCalls).toBe(createCallsBefore);
    expect((await prisma.payment.findUniqueOrThrow({ where: { bookingId: BOOKING_ID } })).stripePaymentIntentId).toBeNull();
  });

  it("an edit's cancel the mark-paid found waiting (FAILED, retrying) outlives the reversal: the superseded intent is still cancelled", async () => {
    const superseded = await mintOnPayStep();
    // Stripe is down through the edit, the mark-paid and its reversal.
    stripe.down = true;
    await editAwayAndBack();
    expect(await cancelRow(superseded)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, nextRetryAt: expect.any(Date) });
    await markPaid();
    await reverse();
    stripe.down = false;

    // The edit's row is still there and does its job.
    expect(await cancelRow(superseded)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED });
    await drainRecovery();
    expect(stripe.intents.get(superseded)!.status).toBe("canceled");
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
    expect(stripe.refunds).toEqual([]);
  });

  it("an edit's cancel the mark-paid found waiting outlives the reversal: the old tab's capture is refunded, never settles (INV-PAY-138)", async () => {
    const superseded = await mintOnPayStep();
    stripe.down = true;
    await editAwayAndBack();
    await markPaid();
    await reverse();
    stripe.down = false;

    capture(superseded);
    const confirmed = await confirm(superseded);
    await deliverSucceededWebhook(superseded);
    await drainRecovery();

    expect(confirmed.status).toBe(409);
    expect(stripe.refunds).toEqual([expect.objectContaining({ paymentIntentId: superseded, amountCents: PRICE_CENTS })]);
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
  });

  /** The officer adds a guest: the real batch edit door. */
  async function addGuest(firstName: string): Promise<void> {
    await edit({ addGuests: [{ ...ADDED_GUEST, firstName }] });
  }

  /** The live cancel rows on the booking, by intent. */
  async function liveCancelIntents(): Promise<string[]> {
    const rows = await prisma.paymentRecoveryOperation.findMany({
      where: { bookingId: BOOKING_ID, type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: { not: PaymentRecoveryOperationStatus.SUCCEEDED } },
      select: { paymentIntentId: true },
    });
    return rows.map((row) => row.paymentIntentId).sort();
  }

  it("MUTATION: an edit on the PAID booking that shares the settle's cancel row: the reversal keeps the intent at the old price cancelled, and its old tab's capture is refunded", async () => {
    const oldPrice = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    // The officer adds a guest to the cash-paid booking: the price moves, and
    // the edit's supersede upserts the very cancel row the settle minted.
    await addGuest("Later");
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).finalPriceCents).toBe(PRICE_CENTS + GUEST_CENTS);
    await reverse();
    stripe.down = false;

    // The old intent is not what the restored booking owes: its cancellation stands.
    expect(await liveCancelIntents()).toContain(oldPrice);
    expect(stripe.intents.get(oldPrice)!.status).toBe("requires_payment_method");

    capture(oldPrice);
    await deliverSucceededWebhook(oldPrice);
    await drainRecovery();
    expect(stripe.refunds).toEqual([expect.objectContaining({ paymentIntentId: oldPrice, amountCents: PRICE_CENTS })]);
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
  });

  it("MUTATION: a condemned intent's cancellation the runner gave up on during the outage is re-armed by the reversal and cancels once Stripe is back", async () => {
    const oldPrice = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    await addGuest("Later");
    // The outage outlasts every retry: the shared cancel row is dead.
    for (let attempt = 0; attempt < 6; attempt += 1) await runCancelWorker(oldPrice);
    const dead = await cancelRow(oldPrice);
    expect(dead).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, nextRetryAt: null, attempts: 5 });

    await reverse();
    expect(await cancelRow(oldPrice)).toMatchObject({ id: dead!.id, status: PaymentRecoveryOperationStatus.PENDING, attempts: 0, nextRetryAt: expect.any(Date) });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "booking-payment.manual-payment.mark-unpaid", targetId: BOOKING_ID },
      select: { metadata: true },
    });
    expect(audit.metadata).toMatchObject({ stillCancelledPaymentIntentIds: [oldPrice], rearmedRecoveryOperationIds: [dead!.id] });

    stripe.down = false;
    await drainRecovery();
    expect(stripe.intents.get(oldPrice)!.status).toBe("canceled");
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
    expect(stripe.refunds).toEqual([]);
  });

  it("MUTATION: a condemned intent's cancellation on its last attempt while the reversal runs is re-armed; the worker's failure cannot kill it, and it cancels once Stripe is back", async () => {
    const oldPrice = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    await addGuest("Later");
    // The doors' own immediate attempts count too: run the worker up to one short of the ceiling.
    while ((await cancelRow(oldPrice))!.attempts < 4) await runCancelWorker(oldPrice);
    expect(await cancelRow(oldPrice)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, attempts: 4, nextRetryAt: expect.any(Date) });

    // The fifth and last attempt reaches Stripe's cancel and hangs there.
    const atStripe = deferred();
    const answer = deferred();
    stripeRaceHooks.cancel = async () => {
      atStripe.resolve();
      await answer.promise;
      throw new Error("fake Stripe: connection reset");
    };
    const lastAttempt = runCancelWorker(oldPrice);
    let outcome: unknown;
    try {
      await atStripe.promise;
      const held = await cancelRow(oldPrice);
      expect(held).toMatchObject({ status: PaymentRecoveryOperationStatus.PROCESSING, attempts: 5 });

      await reverse();
      expect(await cancelRow(oldPrice)).toMatchObject({ id: held!.id, status: PaymentRecoveryOperationStatus.PENDING, attempts: 0 });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "booking-payment.manual-payment.mark-unpaid", targetId: BOOKING_ID },
        select: { metadata: true },
      });
      expect(audit.metadata).toMatchObject({ stillCancelledPaymentIntentIds: [oldPrice], rearmedRecoveryOperationIds: [held!.id] });
    } finally {
      answer.resolve();
      outcome = await lastAttempt;
    }
    // The worker's failure write is fenced on the attempt it claimed: it misses the re-armed row.
    expect(outcome).toBe("failed");
    expect(await cancelRow(oldPrice)).toMatchObject({ status: PaymentRecoveryOperationStatus.PENDING, attempts: 0, nextRetryAt: expect.any(Date) });

    installStripe();
    stripe.down = false;
    await drainRecovery();
    expect(stripe.intents.get(oldPrice)!.status).toBe("canceled");
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
    expect(stripe.refunds).toEqual([]);
  });

  it("MUTATION: an intent the settle adopted, whose cancellation gave up during the outage, is re-armed by the reversal and cancels once Stripe is back", async () => {
    const superseded = await mintOnPayStep();
    stripe.down = true;
    // The edit's supersede queues the cancel; the outage outlasts every retry.
    await editAwayAndBack();
    for (let attempt = 0; attempt < 6; attempt += 1) await runCancelWorker(superseded);
    const dead = await cancelRow(superseded);
    expect(dead).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED, nextRetryAt: null, attempts: 5 });
    // The settle finds that cancellation already queued: adopted, not minted.
    await markPaid();
    const settleAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "booking-payment.manual-payment.mark-paid", targetId: BOOKING_ID },
      select: { metadata: true },
    });
    expect(settleAudit.metadata).toMatchObject({ adoptedCancelPaymentIntentIds: [superseded] });

    // At the price the restored booking owes, so only the adoption keeps it cancelled.
    await reverse();
    expect(await cancelRow(superseded)).toMatchObject({ id: dead!.id, status: PaymentRecoveryOperationStatus.PENDING, attempts: 0 });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "booking-payment.manual-payment.mark-unpaid", targetId: BOOKING_ID },
      select: { metadata: true },
    });
    expect(audit.metadata).toMatchObject({ stillCancelledPaymentIntentIds: [superseded], rearmedRecoveryOperationIds: [dead!.id] });

    stripe.down = false;
    await drainRecovery();
    expect(stripe.intents.get(superseded)!.status).toBe("canceled");
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
    expect(stripe.refunds).toEqual([]);
  });

  it("MUTATION: a settle recorded before #4320 (no adopted list): the reversal still keeps an edit's stale intent cancelled", async () => {
    const stale = await mintOnPayStep();
    stripe.down = true;
    // The edit supersedes the intent first; then the officer records cash at the new price.
    await addGuest("Before");
    expect(await cancelRow(stale)).toMatchObject({ status: PaymentRecoveryOperationStatus.FAILED });
    await markPaid(PRICE_CENTS + GUEST_CENTS);
    // The audit row as the code before #4320 wrote it: no adopted list.
    const settleAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "booking-payment.manual-payment.mark-paid", targetId: BOOKING_ID },
      select: { id: true, metadata: true },
    });
    const { adoptedCancelPaymentIntentIds, ...legacy } = settleAudit.metadata as Record<string, unknown>;
    expect(adoptedCancelPaymentIntentIds).toEqual([stale]);
    await prisma.auditLog.update({ where: { id: settleAudit.id }, data: { metadata: legacy as never } });

    await reverse();
    stripe.down = false;

    expect(await liveCancelIntents()).toEqual([stale]);
    await drainRecovery();
    expect(stripe.intents.get(stale)!.status).toBe("canceled");
    expect(await money()).toMatchObject({ status: "PAYMENT_PENDING", heldCents: 0 });
  });

  it("MUTATION: the hand-off waits for the reversal on the Payment row: a capture landing mid-reversal settles the booking, never charged and refunded", async () => {
    const intent = await mintOnPayStep();
    stripe.down = true;
    await markPaid();
    stripe.down = false;
    // The member pays in the tab they still hold, while the officer reverses.
    capture(intent);

    // A second connection holds the booking row, so the reversal stops at its
    // booking write: past its "no settled card money" check, holding the Payment row.
    const release = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
    })();
    const held = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
    })();
    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${BOOKING_ID} FOR UPDATE`;
        held.resolve();
        await release.promise;
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
    await held.promise;

    const blocked = async () => {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      return rows[0]?.count ?? 0;
    };
    const waitFor = async (count: number) => {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 3_000) {
        if ((await blocked()) >= count) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    let reversalError: unknown;
    let webhookError: unknown;
    let reversalQueued = false;
    let handOffQueued = false;
    let reversal: Promise<unknown> = Promise.resolve();
    let webhookRun: Promise<unknown> = Promise.resolve();
    try {
      reversal = reverse().catch((error: unknown) => (reversalError = error));
      reversalQueued = await waitFor(1);
      // Stripe's success event arrives now: its hand-off finds the cancel row live.
      webhookRun = deliverSucceededWebhook(intent).catch((error: unknown) => (webhookError = error));
      handOffQueued = await waitFor(2);
    } finally {
      release.resolve();
      await holder;
      await reversal;
      await webhookRun;
    }
    expect(reversalQueued, "the reversal never stopped at the held booking row").toBe(true);
    expect(handOffQueued, "the hand-off never queued behind the reversal").toBe(true);
    expect(reversalError).toBeUndefined();
    expect(webhookError).toBeUndefined();

    // The reversal committed first and withdrew the row: the hand-off claimed
    // nothing, and the capture settled the booking it was meant for.
    await drainRecovery();
    expect(stripe.refunds).toEqual([]);
    expect(await money()).toMatchObject({ status: "PAID", heldCents: PRICE_CENTS });
    expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT } })).toBe(0);
  });
});
