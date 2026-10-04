/**
 * Real-PostgreSQL proof for #3864: an edit's stored credit election must never
 * be spent on top of an old, already-captured full-price card intent (#1641's
 * double pay).
 *
 * Every step is the REAL code: the pay step is the `create-payment-intent`
 * route handler, the edit is `modifyBookingBatch`, and Stripe's success event
 * goes through `processStripeWebhookEvent`. Only Stripe itself is a double: an
 * in-memory intent store in which capture is something the test does, so the
 * old intent can be captured, and its webhook delivered, at each point relative
 * to the edit (E) and the member's reload of the pay step (P).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3864-` fixtures. The mocks below are pass-through
 * unless a case here installs the double, because that harness imports every
 * suite into one process.
 */
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3864-member";
const LODGE_ID = "race-3864-lodge";
const BOOKING_ID = "race-3864-booking";
const GUEST_ID = "race-3864-guest";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const ELECTION_CENTS = 5_000;

type FakeIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  latest_charge: null;
};

/** The Stripe double, off (pass-through) unless a case here turns it on. */
const fake = vi.hoisted(() => ({
  active: false,
  intents: new Map<string, FakeIntent>(),
  byKey: new Map<string, string>(),
  sequence: 0,
  /** Runs once, before the next read of the named intent returns. */
  beforeRead: null as null | { intentId: string; run: () => Promise<void> },
  /** Runs once, after the next cancel lands. */
  afterCancel: null as null | (() => Promise<void>),
  /** The next cancel throws, as a Stripe outage would. */
  failCancel: false,
}));

/**
 * The double sits UNDER `@/lib/stripe`, not in place of it: the real wrappers
 * (the cancel helper, the intent mint, the customer lookup) run against a fake
 * client, and the #3402 suite's own mock of `@/lib/stripe` in the same harness
 * process keeps working. Only the fake key builds the fake client.
 */
const FAKE_STRIPE_KEY = "sk_test_race_3864_fake";
vi.mock("@/lib/stripe-config", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/stripe-config");
  return {
    ...actual,
    getOperationalStripeSecretKey: () =>
      fake.active ? Promise.resolve(FAKE_STRIPE_KEY) : actual.getOperationalStripeSecretKey(),
  };
});
vi.mock("stripe", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (...args: unknown[]) => object };
  const read = async (id: string) => {
    const hook = fake.beforeRead;
    if (hook && hook.intentId === id) {
      fake.beforeRead = null;
      await hook.run();
    }
    const intent = fake.intents.get(id);
    if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
    return { ...intent };
  };
  const client = {
    paymentIntents: {
      retrieve: (id: string) => read(id),
      create: (
        params: { amount: number; currency: string; metadata?: Record<string, string> },
        options?: { idempotencyKey?: string },
      ) => {
        const known = options?.idempotencyKey ? fake.byKey.get(options.idempotencyKey) : undefined;
        if (known) return read(known);
        fake.sequence += 1;
        const id = `pi_race_3864_${fake.sequence}`;
        fake.intents.set(id, {
          id,
          object: "payment_intent",
          amount: params.amount,
          currency: params.currency,
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          payment_method: null,
          metadata: params.metadata ?? {},
          latest_charge: null,
        });
        if (options?.idempotencyKey) fake.byKey.set(options.idempotencyKey, id);
        return read(id);
      },
      cancel: async (id: string) => {
        if (fake.failCancel) {
          fake.failCancel = false;
          throw new Error("fake Stripe: connection reset");
        }
        const intent = fake.intents.get(id);
        if (!intent || intent.status === "succeeded" || intent.status === "canceled") {
          throw new Error(`fake Stripe: cannot cancel a ${intent?.status ?? "missing"} intent`);
        }
        intent.status = "canceled";
        const hook = fake.afterCancel;
        fake.afterCancel = null;
        if (hook) await hook();
        return read(id);
      },
    },
    customers: {
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ id: "cus_race_3864", metadata: {} }),
    },
  };
  class FakeAwareStripe extends actual.default {
    constructor(...args: unknown[]) {
      if (args[0] === FAKE_STRIPE_KEY) {
        // A constructor may return the object it builds; the fake is that object.
        return client as unknown as FakeAwareStripe;
      }
      super(...args);
    }
  }
  return { ...actual, default: FakeAwareStripe };
});

/** The member's session, only while a case here installs one. */
const session = vi.hoisted(() => ({ current: null as null | { user: Record<string, unknown> } }));
// No other realdb suite reads a session, so signed-out is the pass-through.
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve(session.current) }));

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeElectionDoublePayRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Election double-pay proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run election double-pay proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Election double-pay proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Election double-pay proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let memberCredit: typeof import("@/lib/member-credit");
let payRoute: typeof import("@/app/api/payments/create-payment-intent/route");
let webhook: typeof import("@/lib/stripe-webhook-service");
let editService: typeof import("@/lib/booking-batch-modification-service");
let creditElection: typeof import("@/lib/booking-credit-election");
let clubTimeServer: typeof import("@/lib/club-time/server");
let webhookEventSequence = 0;

async function clean(): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ targetId: BOOKING_ID }, { memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { subjectMemberId: MEMBER_ID }] },
  });
  await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_3864_" } } });
  await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_3864_" } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, ...(payment ? [payment.id] : [])] } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  if (payment) {
    await prisma.paymentRefund.deleteMany({ where: { paymentId: payment.id } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: payment.id } });
    await prisma.payment.deleteMany({ where: { id: payment.id } });
  }
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A PAYMENT_PENDING booking (an admin-released review), and $50 of credit to spend. */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      memberId: MEMBER_ID,
      firstName: "Election",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: PRICE_CENTS,
      nights: { create: [{ stayDate: CHECK_IN, priceCents: PRICE_CENTS, priceSource: "SOLD" }] },
    },
  });
  await prisma.memberCredit.create({
    data: { memberId: MEMBER_ID, amountCents: ELECTION_CENTS, type: "ADMIN_ADJUSTMENT", description: "race 3864 opening balance" },
  });
}

/** P: the member opens (or reloads) the pay step — the real route handler. */
async function payStep(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { NextRequest } = await import("next/server");
  const response = await payRoute.POST(
    new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: BOOKING_ID }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** E: the member edits the booking to apply their credit — the real edit service. */
async function editToApplyCredit() {
  return editService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: MEMBER_ID, role: "MEMBER" },
    input: { applyCreditCents: ELECTION_CENTS },
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

/** C: Stripe captures the intent (the member confirmed it in a tab still holding its secret). */
function capture(intentId: string): void {
  const intent = fake.intents.get(intentId);
  if (!intent) throw new Error(`no intent ${intentId}`);
  if (intent.status === "canceled" || intent.status === "succeeded") {
    throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
  }
  intent.status = "succeeded";
  intent.payment_method = "pm_race_3864";
}

/** W: Stripe's `payment_intent.succeeded` for the intent — the real webhook processor. */
async function deliverSucceededWebhook(intentId: string) {
  webhookEventSequence += 1;
  const event = {
    id: `evt_race_3864_${webhookEventSequence}`,
    object: "event",
    type: "payment_intent.succeeded",
    request: null,
    data: { object: { ...fake.intents.get(intentId)! } },
  } as unknown as Stripe.Event;
  return webhook.processStripeWebhookEvent(event);
}

async function money() {
  const [booking, payment, appliedRows, balance] = await Promise.all([
    prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true, creditElectionCents: true } }),
    prisma.payment.findUnique({ where: { bookingId: BOOKING_ID }, select: { amountCents: true, creditAppliedCents: true, status: true } }),
    prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED" } }),
    memberCredit.getMemberCreditBalance(MEMBER_ID),
  ]);
  const ledgerApplied = await memberCredit.deriveBookingAppliedCreditCents(BOOKING_ID);
  const capturedCardCents = [...fake.intents.values()]
    .filter((intent) => intent.status === "succeeded")
    .reduce((sum, intent) => sum + intent.amount, 0);
  return { booking, payment, appliedRows, balance, ledgerApplied, capturedCardCents };
}

/** The money law the issue is about: card cash plus credit spent is the price, never more. */
function expectPaidOnce(state: Awaited<ReturnType<typeof money>>, { cardCents, creditCents }: { cardCents: number; creditCents: number }) {
  expect(state.booking.status).toBe("PAID");
  expect(state.capturedCardCents).toBe(cardCents);
  expect(state.ledgerApplied).toBe(creditCents);
  expect(state.balance).toBe(ELECTION_CENTS - creditCents);
  expect(state.capturedCardCents + state.ledgerApplied).toBe(PRICE_CENTS);
  // The Payment mirror says the same thing (`amountCents + creditAppliedCents = finalPriceCents`).
  expect(state.payment).toMatchObject({ amountCents: cardCents, creditAppliedCents: creditCents, status: "SUCCEEDED" });
  expect(state.booking.creditElectionCents).toBeNull();
}

/** The member's booking history says their credit was not spent (#2265's report). */
async function unspentCreditReports(): Promise<number[]> {
  const rows = await prisma.auditLog.findMany({
    where: { action: creditElection.UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION, targetId: BOOKING_ID },
    select: { details: true },
  });
  return rows.map((row) => (JSON.parse(row.details ?? "{}") as { creditElectionCents: number }).creditElectionCents);
}

/** Step 1 of the issue: the full-price intent the pay step mints before any election exists. */
async function mintFullPriceIntent(): Promise<string> {
  const minted = await payStep();
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  expect(minted.body.chargedAmountCents).toBe(PRICE_CENTS);
  return minted.body.paymentIntentId as string;
}

(RUN ? describe : describe.skip)("an edit's credit election against an old full-price card intent, on PostgreSQL (#3864)", () => {
  beforeAll(async () => {
    assertSafeElectionDoublePayRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    memberCredit = await import("@/lib/member-credit");
    payRoute = await import("@/app/api/payments/create-payment-intent/route");
    webhook = await import("@/lib/stripe-webhook-service");
    editService = await import("@/lib/booking-batch-modification-service");
    creditElection = await import("@/lib/booking-credit-election");
    clubTimeServer = await import("@/lib/club-time/server");

    await clean();
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Election", lastName: "Proof", ageTier: "ADULT", canLogin: true },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3864 Lodge", slug: "race-3864" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
  }, 120_000); // cold imports of the route, edit and webhook module graphs

  beforeEach(async () => {
    await clean();
    fake.active = true;
    fake.intents.clear();
    fake.byKey.clear();
    fake.beforeRead = null;
    fake.afterCancel = null;
    fake.failCancel = false;
    session.current = { user: { id: MEMBER_ID, role: "MEMBER", accessRoles: [], canLogin: true } };
    await seed();
  });

  afterAll(async () => {
    fake.active = false;
    session.current = null;
    if (!prisma) return;
    await clean();
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("C, W, then E: the capture settles first, so the edit refuses to store the election", async () => {
    const oldIntent = await mintFullPriceIntent();
    capture(oldIntent);
    expect((await deliverSucceededWebhook(oldIntent)).status ?? 200).toBe(200);

    await expect(editToApplyCredit()).rejects.toThrow(/has not been paid yet/);

    expectPaidOnce(await money(), { cardCents: PRICE_CENTS, creditCents: 0 });
  }, 60_000);

  it("E, C, W, then P: the webhook settles at full price and clears the election, so the reload spends nothing", async () => {
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).creditElectionCents).toBe(ELECTION_CENTS);
    capture(oldIntent);
    await deliverSucceededWebhook(oldIntent);

    const reload = await payStep();
    expect(reload.status).toBe(400);

    const state = await money();
    expectPaidOnce(state, { cardCents: PRICE_CENTS, creditCents: 0 });
    expect(state.appliedRows).toBe(0);
  }, 60_000);

  it("E, C, P, then W (the issue's order): the reload must not spend the credit on top of the captured full price", async () => {
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();
    capture(oldIntent);

    const reload = await payStep();
    expect(reload.status).toBe(200);
    expect(reload.body.alreadyPaid).toBe(true);
    // The late webhook for the same capture is a replay.
    await deliverSucceededWebhook(oldIntent);

    const state = await money();
    expectPaidOnce(state, { cardCents: PRICE_CENTS, creditCents: 0 });
    // Not spent and given back: never spent at all, and the member is told.
    expect(state.appliedRows).toBe(0);
    expect(await unspentCreditReports()).toEqual([ELECTION_CENTS]);
  }, 60_000);

  it("E, C, then W lands INSIDE P, at the pay step's first Stripe read: still no double pay", async () => {
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();
    capture(oldIntent);
    fake.beforeRead = { intentId: oldIntent, run: async () => void (await deliverSucceededWebhook(oldIntent)) };

    const reload = await payStep();
    expect(fake.beforeRead).toBeNull();
    expect([200, 400]).toContain(reload.status);

    const state = await money();
    expectPaidOnce(state, { cardCents: PRICE_CENTS, creditCents: 0 });
    expect(state.appliedRows).toBe(0);
  }, 60_000);

  it("E, P, then the old tab tries to capture: the old intent is already dead, and the credit pays its share once", async () => {
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();

    const reload = await payStep();
    expect(reload.status).toBe(200);
    expect(reload.body.chargedAmountCents).toBe(PRICE_CENTS - ELECTION_CENTS);
    const newIntent = reload.body.paymentIntentId as string;
    expect(newIntent).not.toBe(oldIntent);

    // The old client secret can no longer take money.
    expect(() => capture(oldIntent)).toThrow(/canceled/);

    capture(newIntent);
    await deliverSucceededWebhook(newIntent);
    expectPaidOnce(await money(), { cardCents: PRICE_CENTS - ELECTION_CENTS, creditCents: ELECTION_CENTS });
  }, 60_000);

  it("E, P while Stripe cannot confirm the cancel: the pay step refuses and spends nothing", async () => {
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();
    fake.failCancel = true;

    const reload = await payStep();
    expect(reload.status).toBe(409);
    // Told why, not sent to reload a booking that is still payable.
    expect(reload.body.error).toMatch(/credit has not been applied yet/);
    expect(fake.intents.get(oldIntent)!.status).toBe("requires_payment_method");
    const state = await money();
    expect(state.appliedRows).toBe(0);
    expect(state.booking).toMatchObject({ status: "PAYMENT_PENDING", creditElectionCents: ELECTION_CENTS });
  }, 60_000);

  it("A STALE TAB mints a full-price intent between this pay step's cancel and its spend: the spend is refused under the locks", async () => {
    const oldIntent = await mintFullPriceIntent();
    const aCancelled = Promise.withResolvers<void>();
    const staleTabDone = Promise.withResolvers<void>();
    let reloadA: Promise<Awaited<ReturnType<typeof payStep>>> | null = null;

    // Tab B read the booking BEFORE the edit; it pauses at its Stripe read while
    // the edit lands and tab A cancels the old intent, then mints at full price.
    // The test clock is frozen, so it steps a minute on for B's intent to be the
    // Payment's newest, as it would be on a real clock.
    const frozenNow = new Date();
    fake.beforeRead = {
      intentId: oldIntent,
      run: async () => {
        await editToApplyCredit();
        fake.afterCancel = async () => {
          aCancelled.resolve();
          await staleTabDone.promise;
        };
        reloadA = payStep();
        await aCancelled.promise;
        vi.setSystemTime(new Date(frozenNow.getTime() + 60_000));
      },
    };
    const reloadB = await payStep().finally(() => vi.setSystemTime(frozenNow));
    staleTabDone.resolve();
    expect(reloadB.status).toBe(200);
    expect(reloadB.body.chargedAmountCents).toBe(PRICE_CENTS);
    const resultA = await reloadA!;
    expect(resultA.status).toBe(409);
    expect((await money()).appliedRows).toBe(0);

    // Tab B's full-price intent captures: the election was never spent under it.
    const staleIntent = reloadB.body.paymentIntentId as string;
    capture(staleIntent);
    await deliverSucceededWebhook(staleIntent);
    const state = await money();
    expectPaidOnce(state, { cardCents: PRICE_CENTS, creditCents: 0 });
    expect(state.appliedRows).toBe(0);
  }, 60_000);

  it("THE SETTLE DOOR: a full-price capture landing on a booking whose election was already spent gives the credit back", async () => {
    // The state the pre-fix pay step left behind, built by the real writers: the
    // full-price intent minted, then the election consumed without retiring it.
    const oldIntent = await mintFullPriceIntent();
    await editToApplyCredit();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await creditElection.consumeStoredCreditElection(tx, { bookingId: BOOKING_ID, format: CLUB_FORMAT_TEST });
    });
    expect(await memberCredit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(ELECTION_CENTS);

    capture(oldIntent);
    await deliverSucceededWebhook(oldIntent);

    // The card paid the whole price, so the credit was not spent: it is back,
    // through one give-back row, and the member is told.
    expectPaidOnce(await money(), { cardCents: PRICE_CENTS, creditCents: 0 });
    expect(await unspentCreditReports()).toEqual([ELECTION_CENTS]);
    // A replay of the same event gives nothing back twice.
    await deliverSucceededWebhook(oldIntent);
    expectPaidOnce(await money(), { cardCents: PRICE_CENTS, creditCents: 0 });
    expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, amountCents: { gt: 0 } } })).toBe(1);
  }, 60_000);
});
