/**
 * Real-PostgreSQL proof of #4532 (`INV-INT-032`): a succeeded Stripe payment
 * the app did not create - a Payment Link donation, a dashboard charge - is
 * recorded once and alerted once, under redelivery and under two deliveries
 * racing, and the event still completes.
 *
 * Every step runs through the real writers: each delivery goes through
 * `processStripeWebhookEvent`, the row is claimed by the table's real unique
 * index, and the alert by the real once-ever `AlertCooldown` claim through the
 * real unmuteable sender. Two doubles: Stripe's Checkout read, through the
 * harness's one shared `@/lib/stripe` double (no Stripe call is made), and a
 * pass-through on `sendEmail` that counts each copy and can refuse it as a mail
 * provider would.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL every realdb suite uses (`CONCURRENCY_RACE_DATABASE_URL`,
 * `RUN_CONCURRENCY_RACE_TESTS=1`), and owns and cleans its own `race-4532`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

/** Each copy the real unmuteable sender hands the mailer, by template; `refuse` makes the mailer throw, as a provider outage does. */
const mail = vi.hoisted(() => ({ sent: [] as string[], refuse: false }));
vi.mock("@/lib/email/core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/email/core");
  return {
    ...actual,
    sendEmail: async (...args: Parameters<typeof actual.sendEmail>) => {
      mail.sent.push(String(args[0].templateName));
      if (mail.refuse) throw new Error("Mail provider unavailable");
      return actual.sendEmail(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const EVENT_PREFIX = "evt_race_4532_";
const INTENT_PREFIX = "pi_race_4532_";
const BOOKING_ID = "race-4532-no-such-booking";
const TEMPLATE = "admin-unrecognised-stripe-payment";
const PAUSED_TEMPLATE = "admin-unrecognised-stripe-payments-paused";
/** Every claim this feature makes starts so: the single-payment keys and the paused key. */
const FEATURE_KEY_PREFIX = "unrecognised-stripe-payment";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let processStripeWebhookEvent: (typeof import("@/lib/stripe-webhook-service"))["processStripeWebhookEvent"];
let alertKey: (typeof import("@/lib/unrecognised-stripe-payment"))["unrecognisedStripePaymentAlertKey"];
let feature: typeof import("@/lib/unrecognised-stripe-payment");
let harnessRole: { before: string | undefined; restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "a Stripe payment the app did not create - real PostgreSQL (#4532)",
  { timeout: 120_000 },
  () => {
    let eventSequence = 0;
    let checkoutReads: string[] = [];

    async function deleteFixtures() {
      await prisma.unrecognisedStripePayment.deleteMany({ where: { stripePaymentIntentId: { startsWith: INTENT_PREFIX } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: FEATURE_KEY_PREFIX } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: EVENT_PREFIX } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: EVENT_PREFIX } } });
      await prisma.emailLog.deleteMany({ where: { templateName: { in: [TEMPLATE, PAUSED_TEMPLATE] } } });
    }

    function succeededEvent(paymentIntentId: string, metadata: Record<string, string> = {}, eventId?: string): Stripe.Event {
      eventSequence += 1;
      return {
        id: eventId ?? `${EVENT_PREFIX}${eventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        livemode: false,
        created: Date.parse("2026-06-30T21:00:00.000Z") / 1000,
        request: null,
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: 2500,
            amount_received: 2500,
            currency: "nzd",
            created: Date.parse("2026-06-30T20:00:00.000Z") / 1000,
            status: "succeeded",
            description: null,
            latest_charge: `ch_${paymentIntentId}`,
            application: null,
            metadata,
          },
        },
      } as unknown as Stripe.Event;
    }

    async function deliver(event: Stripe.Event) {
      const result = await processStripeWebhookEvent(event);
      return result.init?.status ?? 200;
    }

    const rows = (paymentIntentId: string) =>
      prisma.unrecognisedStripePayment.findMany({ where: { stripePaymentIntentId: paymentIntentId } });
    const alertClaims = (paymentIntentId: string) => prisma.alertCooldown.count({ where: { key: alertKey(paymentIntentId) } });
    const completed = (eventId: string) =>
      prisma.processedWebhookEvent.count({ where: { source: "stripe", eventId, status: "COMPLETED" } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "unrecognised Stripe payment proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      ({ processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service"));
      feature = await import("@/lib/unrecognised-stripe-payment");
      alertKey = feature.unrecognisedStripePaymentAlertKey;
      await deleteFixtures();
    }, 60_000);

    beforeEach(async () => {
      // Each case starts with no claims, so the hourly cap counts only its own.
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: FEATURE_KEY_PREFIX } } });
      mail.sent = [];
      mail.refuse = false;
      resetStripeRaceHooks();
      checkoutReads = [];
      stripeRaceHooks.checkoutSession = async (paymentIntentId) => {
        checkoutReads.push(paymentIntentId);
        return {
          id: `cs_${paymentIntentId}`,
          payment_link: "plink_race_4532_donations",
          line_items: { data: [{ description: "Winter donation", quantity: 1 }] },
        };
      };
    });

    afterAll(async () => {
      try {
        resetStripeRaceHooks();
        if (typeof prisma !== "undefined") {
          try {
            await deleteFixtures();
          } finally {
            await prisma.$disconnect().catch(() => {});
          }
        }
      } finally {
        harnessRole?.restore();
      }
    });

    it("records a Payment Link donation once, alerts once, and completes the event - then a redelivery and a replay add nothing", async () => {
      const intent = `${INTENT_PREFIX}link`;
      const first = succeededEvent(intent);

      expect(await deliver(first)).toBe(200);

      const [row] = await rows(intent);
      expect(row).toMatchObject({
        stripeChargeId: `ch_${intent}`,
        stripeCheckoutSessionId: `cs_${intent}`,
        stripePaymentLinkId: "plink_race_4532_donations",
        amountCents: 2500,
        currency: "nzd",
        // When it succeeded (the event), not when checkout began (the intent).
        stripeSucceededAt: new Date("2026-06-30T21:00:00.000Z"),
        description: "Winter donation",
        stripeEventId: first.id,
      });
      expect(await alertClaims(intent)).toBe(1);
      expect(row!.alertSentAt).toBeInstanceOf(Date);
      expect(mail.sent).toEqual([TEMPLATE]);
      expect(await completed(first.id)).toBe(1);

      // Stripe redelivers the same event: the completed claim answers it.
      expect(await deliver(first)).toBe(200);
      // A second event for the same payment (a lease takeover's replay is the same shape).
      const replay = succeededEvent(intent);
      expect(await deliver(replay)).toBe(200);

      expect(await rows(intent)).toHaveLength(1);
      expect(await alertClaims(intent)).toBe(1);
      expect(await completed(replay.id)).toBe(1);
      // The stored row answered the replay: Stripe was asked once.
      expect(checkoutReads).toEqual([intent]);
    });

    it("records a dashboard charge with no Checkout session", async () => {
      const intent = `${INTENT_PREFIX}dashboard`;
      stripeRaceHooks.checkoutSession = async () => null;

      expect(await deliver(succeededEvent(intent))).toBe(200);

      expect(await rows(intent)).toEqual([
        expect.objectContaining({ stripeCheckoutSessionId: null, stripePaymentLinkId: null, description: null }),
      ]);
      expect(await alertClaims(intent)).toBe(1);
    });

    it("writes one row and one alert claim when two deliveries of one payment race", async () => {
      const intent = `${INTENT_PREFIX}race`;
      // Both reach the Checkout read before either inserts.
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      stripeRaceHooks.checkoutSession = async (paymentIntentId) => {
        checkoutReads.push(paymentIntentId);
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return null;
      };
      const a = succeededEvent(intent);
      const b = succeededEvent(intent);

      const statuses = await Promise.all([deliver(a), deliver(b)]);

      expect(statuses).toEqual([200, 200]);
      expect(checkoutReads).toEqual([intent, intent]);
      expect(await rows(intent)).toHaveLength(1);
      expect(await alertClaims(intent)).toBe(1);
      expect(mail.sent).toEqual([TEMPLATE]);
      expect(await completed(a.id)).toBe(1);
      expect(await completed(b.id)).toBe(1);
    });

    it("keeps the claim and completes the event when the mail provider refuses every copy: the email retry job re-sends it", async () => {
      const intent = `${INTENT_PREFIX}refused`;
      mail.refuse = true;
      const delivery = succeededEvent(intent);

      expect(await deliver(delivery)).toBe(200);

      expect(mail.sent).toEqual([TEMPLATE]);
      expect(await alertClaims(intent)).toBe(1);
      expect((await rows(intent))[0]!.alertSentAt).toBeInstanceOf(Date);
      expect(await completed(delivery.id)).toBe(1);
    });

    /** A row and an alert claim as a delivery that died between claim and send leaves them. */
    async function seedClaimedNotSent(intent: string, claimAgeMs: number) {
      await prisma.unrecognisedStripePayment.create({
        data: {
          stripePaymentIntentId: intent,
          amountCents: 2500,
          currency: "nzd",
          stripeSucceededAt: new Date("2026-06-30T21:00:00.000Z"),
          stripeEventId: `${EVENT_PREFIX}dead`,
        },
      });
      await prisma.alertCooldown.create({ data: { key: alertKey(intent), lastAlertedAt: new Date(new Date().getTime() - claimAgeMs) } });
    }

    it("re-sends, once, an alert claimed longer ago than the webhook lease and never sent", async () => {
      const intent = `${INTENT_PREFIX}stale`;
      await seedClaimedNotSent(intent, feature.UNRECOGNISED_PAYMENT_STALE_CLAIM_MS + 60_000);

      expect(await deliver(succeededEvent(intent))).toBe(200);
      expect(await deliver(succeededEvent(intent))).toBe(200);

      expect(mail.sent).toEqual([TEMPLATE]);
      expect(await alertClaims(intent)).toBe(1);
      expect((await rows(intent))[0]!.alertSentAt).toBeInstanceOf(Date);
      expect(checkoutReads).toEqual([]);
    });

    it("leaves a claim younger than the webhook lease to the sender holding it", async () => {
      const intent = `${INTENT_PREFIX}fresh`;
      await seedClaimedNotSent(intent, 60_000);

      expect(await deliver(succeededEvent(intent))).toBe(200);

      expect(mail.sent).toEqual([]);
      expect((await rows(intent))[0]!.alertSentAt).toBeNull();
    });

    it("caps single alerts per hour and sends one \"more payments\" alert instead, recording every payment", async () => {
      stripeRaceHooks.checkoutSession = async () => null;
      const intents = Array.from({ length: 8 }, (_, index) => `${INTENT_PREFIX}burst_${index}`);

      for (const intent of intents) expect(await deliver(succeededEvent(intent))).toBe(200);

      const capped = intents.length - 5;
      expect(mail.sent.filter((name) => name === TEMPLATE)).toHaveLength(intents.length - capped);
      expect(mail.sent.filter((name) => name === PAUSED_TEMPLATE)).toHaveLength(1);
      expect(
        await prisma.unrecognisedStripePayment.count({ where: { stripePaymentIntentId: { in: intents }, alertSentAt: { not: null } } }),
      ).toBe(intents.length);
    });

    it("leaves an app intent alone, even one whose booking cannot be found", async () => {
      const intent = `${INTENT_PREFIX}app`;

      expect(await deliver(succeededEvent(intent, { bookingId: BOOKING_ID }))).toBe(200);

      expect(await rows(intent)).toHaveLength(0);
      expect(await alertClaims(intent)).toBe(0);
      expect(checkoutReads).toEqual([]);
    });
  },
);

// Runs after the describe above, its `afterAll` included, so a declaration that
// outlived it fails here rather than arming whichever suite runs next.
(RUN ? describe : describe.skip)("#4532: the suite puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
    expect(harnessRole, "the suite declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(harnessRole!.before);
  });
});
