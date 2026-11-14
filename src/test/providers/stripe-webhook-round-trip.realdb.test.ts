/**
 * Real-PostgreSQL round trip through the Stripe test transport (#4908): the
 * app's own Stripe client is served by `StripeFake` (`setStripeClientForTests`),
 * and the events the fake emits are handed, unaltered, to the real
 * `processStripeWebhookEvent`. Nothing in `@/lib/stripe` or the webhook service
 * is mocked: the refund list the charge handler reads comes from the fake
 * through the production `listRefundsForCharge`.
 *
 * A card booking's capture, a refund made by hand in the Stripe dashboard, its
 * redelivery, and then Stripe failing that refund later: the stored refund and
 * the payment's refunded total are asserted at each step.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL the race harness uses, and owns its `race-4908-stripe-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { releaseBookingJournalForTeardown } from "@/lib/__tests__/support/booking-financial-history-teardown";
import { StripeFake } from "./stripe-fake";
import { stripeTransport } from "./stripe-transport";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4908-stripe";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const PAID_CENTS = 20_000;
const REFUND_CENTS = 6_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let stripeLib: typeof import("@/lib/stripe");
let stripeOverride: typeof import("@/lib/stripe-test-client-override");
let webhook: typeof import("@/lib/stripe-webhook-service");

(RUN ? describe : describe.skip)("Stripe webhooks served by StripeFake - real PostgreSQL (#4908)", { timeout: 60_000 }, () => {
  let fake: StripeFake;
  let transport: ReturnType<typeof stripeTransport>;
  let intentId: string;
  /** Events already delivered, so each step hands over only what is new. */
  let delivered = 0;

  async function clean() {
    const eventIds = transport?.events().map((e) => e.id) ?? [];
    await prisma.processedWebhookEvent.deleteMany({ where: { source: "stripe", eventId: { startsWith: P } } });
    if (eventIds.length) await prisma.webhookLog.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
    await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  }

  /** Hands every event emitted since the last delivery to the real webhook service. */
  async function deliverNew() {
    const events = transport.events().slice(delivered);
    delivered += events.length;
    const results = [];
    for (const event of events) results.push(await webhook.processStripeWebhookEvent(event));
    return results;
  }

  const paymentState = () =>
    prisma.payment.findUniqueOrThrow({
      where: { id: PAYMENT_ID },
      select: { refundedAmountCents: true, refunds: { select: { stripeRefundId: true, amountCents: true, status: true } } },
    });

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Stripe transport round trip");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    stripeLib = await import("@/lib/stripe");
    stripeOverride = await import("@/lib/stripe-test-client-override");
    webhook = await import("@/lib/stripe-webhook-service");
    await clean();
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Round", lastName: "Trip", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4908 Stripe Lodge", slug: P } });
  }, 60_000);

  beforeEach(async () => {
    await clean();
    fake = new StripeFake(`${P}-`);
    transport = stripeTransport(fake);
    delivered = 0;
    stripeOverride.setStripeClientForTests(transport.client);

    // The card is authorised and captured through the app's own Stripe client.
    const stripe = await stripeLib.getStripe();
    const intent = await stripe.paymentIntents.create(
      { amount: PAID_CENTS, currency: "nzd", capture_method: "manual", metadata: { bookingId: BOOKING_ID, memberId: MEMBER_ID } },
      { idempotencyKey: `${P}-authorise` },
    );
    await stripe.paymentIntents.capture(intent.id, { amount_to_capture: PAID_CENTS }, { idempotencyKey: `${P}-capture` });
    intentId = intent.id;
    // The capture's own webhook is not under test here; the booking is recorded paid.
    delivered = transport.events().length;

    await prisma.booking.create({
      data: {
        id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID,
        checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"),
        status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
      },
    });
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: intentId,
        transactions: {
          create: { id: `${P}-txn`, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: intentId, amountCents: PAID_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
        },
      },
    });
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    } finally {
      stripeOverride?.resetStripeClientForTests();
    }
  });

  it("records a dashboard refund once, and takes it back out when Stripe fails it later", async () => {
    const refund = fake.dashboardRefund(intentId, REFUND_CENTS);
    const results = await deliverNew();
    expect(transport.events().slice(-2).map((e) => e.type)).toEqual(["refund.created", "charge.refunded"]);
    expect(results.map((r) => r.body)).toEqual([{ received: true }, { received: true }]);
    expect(await paymentState()).toMatchObject({
      refundedAmountCents: REFUND_CENTS,
      refunds: [{ stripeRefundId: refund.id, amountCents: REFUND_CENTS, status: "succeeded" }],
    });

    // Stripe redelivers the same events: acknowledged, nothing written twice.
    for (const event of transport.events().slice(-2)) expect((await webhook.processStripeWebhookEvent(event)).body).toEqual({ received: true });
    expect(await paymentState()).toMatchObject({ refundedAmountCents: REFUND_CENTS, refunds: [{ stripeRefundId: refund.id }] });

    fake.failRefund(refund.id);
    expect((await deliverNew()).map((r) => r.body)).toEqual([{ received: true }, { received: true }]);
    expect(transport.events().slice(-1)[0]?.type).toBe("refund.failed");
    expect(await paymentState()).toMatchObject({
      refundedAmountCents: 0,
      refunds: [{ stripeRefundId: refund.id, amountCents: REFUND_CENTS, status: "failed" }],
    });
  });

  it("an app refund through the production client is recorded by the charge webhook at the amount Stripe holds", async () => {
    const made = await stripeLib.processRefund({ paymentIntentId: intentId, amountCents: REFUND_CENTS, idempotencyKey: `${P}-app-refund` });
    expect((await deliverNew()).map((r) => r.body)).toEqual([{ received: true }, { received: true }]);
    expect(await paymentState()).toMatchObject({
      refundedAmountCents: REFUND_CENTS,
      refunds: [{ stripeRefundId: made.id, amountCents: REFUND_CENTS, status: "succeeded" }],
    });
    // Stripe refuses a refund past what is left; the app sees Stripe's own error class.
    await expect(stripeLib.processRefund({ paymentIntentId: intentId, amountCents: PAID_CENTS })).rejects.toMatchObject({ type: "StripeInvalidRequestError", code: "amount_too_large" });
    expect(fake.snapshot().refunds).toHaveLength(1);
  });
});
