import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * #4532 (`INV-INT-032`): the record and alert of a succeeded Stripe payment the
 * app did not create - with and without a Checkout session / Payment Link, on
 * redelivery, on a concurrent delivery, when the alert cannot be sent, when a
 * sender died between claim and send, and under the hourly cap.
 *
 * Two in-memory tables stand in for PostgreSQL, keyed as their unique indexes
 * key them: the payment rows and `AlertCooldown`. The once-ever and cooldown
 * claim helpers (`admin-alert-once.ts`, `alert-cooldown.ts`) run for real over
 * the second. `unrecognised-stripe-payment.realdb.test.ts` runs the same flow
 * against a real database.
 */
type Row = {
  id: string;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentLinkId: string | null;
  stripeApplicationId: string | null;
  amountCents: number;
  currency: string;
  stripeSucceededAt: Date;
  description: string | null;
  stripeEventId: string;
  alertSentAt: Date | null;
  createdAt: Date;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  cooldowns: new Map<string, Date>(),
  /** Runs inside createMany before the insert: a concurrent delivery's row. */
  beforeInsert: null as null | (() => void),
}));

const mocks = vi.hoisted(() => ({
  findCheckoutSession: vi.fn(),
  sendAlert: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  sendPausedAlert: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  createMany: vi.fn(),
}));

function uniqueError() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

/** `startsWith` as `exactPrefix` escapes it: the LIKE metacharacters stand for themselves. */
function unescapeLike(pattern: string): string {
  return pattern.replace(/\\([\\%_])/g, "$1");
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    unrecognisedStripePayment: {
      findUnique: async ({ where }: { where: { stripePaymentIntentId: string } }) => {
        const row = state.rows.get(where.stripePaymentIntentId);
        return row ? { ...row } : null;
      },
      createMany: async (args: { data: Omit<Row, "id" | "createdAt" | "alertSentAt">[]; skipDuplicates: boolean }) => {
        mocks.createMany(args);
        state.beforeInsert?.();
        let count = 0;
        for (const data of args.data) {
          if (state.rows.has(data.stripePaymentIntentId)) {
            if (!args.skipDuplicates) throw uniqueError();
            continue;
          }
          state.rows.set(data.stripePaymentIntentId, {
            ...data,
            id: `row_${data.stripePaymentIntentId}`,
            alertSentAt: null,
            createdAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where, data }: { where: { id: string; alertSentAt: null }; data: { alertSentAt: Date } }) => {
        const row = [...state.rows.values()].find((candidate) => candidate.id === where.id);
        if (!row || row.alertSentAt !== null) return { count: 0 };
        row.alertSentAt = data.alertSentAt;
        return { count: 1 };
      },
      count: async ({ where }: { where: { createdAt: { gte: Date } } }) =>
        [...state.rows.values()].filter((row) => row.createdAt >= where.createdAt.gte).length,
    },
    alertCooldown: {
      updateMany: async ({ where, data }: { where: { key: string; lastAlertedAt: { lt: Date } }; data: { lastAlertedAt: Date } }) => {
        const at = state.cooldowns.get(where.key);
        if (!at || !(at < where.lastAlertedAt.lt)) return { count: 0 };
        state.cooldowns.set(where.key, data.lastAlertedAt);
        return { count: 1 };
      },
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (state.cooldowns.has(data.key)) throw uniqueError();
        state.cooldowns.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const at = state.cooldowns.get(where.key);
        if (!at || at.getTime() !== where.lastAlertedAt.getTime()) return { count: 0 };
        state.cooldowns.delete(where.key);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { key: { in: string[] }; lastAlertedAt: { gte: Date } } }) =>
        where.key.in
          .filter((key) => {
            const at = state.cooldowns.get(key);
            return at !== undefined && at >= where.lastAlertedAt.gte;
          })
          .map((key) => ({ key, lastAlertedAt: state.cooldowns.get(key)! })),
      count: async ({ where }: { where: { key: { startsWith: string }; lastAlertedAt: { gte: Date } } }) => {
        const prefix = unescapeLike(where.key.startsWith);
        return [...state.cooldowns.entries()].filter(([key, at]) => key.startsWith(prefix) && at >= where.lastAlertedAt.gte)
          .length;
      },
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  findCheckoutSessionForPaymentIntent: (...args: unknown[]) => mocks.findCheckoutSession(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminUnrecognisedStripePaymentAlert: (...args: unknown[]) => mocks.sendAlert(...args),
  sendAdminUnrecognisedStripePaymentsPausedAlert: (...args: unknown[]) => mocks.sendPausedAlert(...args),
}));

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  describeUnrecognisedPayment,
  recordUnrecognisedStripePayment,
  unrecognisedPaymentAmountLabel,
  unrecognisedStripePaymentAlertKey,
  UnrecognisedStripePaymentAlertNotSentError,
  UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS,
  UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH,
  UNRECOGNISED_PAYMENT_STALE_CLAIM_MS,
  UNRECOGNISED_PAYMENTS_PAUSED_ALERT_KEY,
} from "@/lib/unrecognised-stripe-payment";
import { UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR, unrecognisedPaymentApplicationNote } from "@/lib/unrecognised-stripe-payment-note";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** The frozen test clock's "now". */
const NOW = new Date();
const CREATED = Date.parse("2026-06-28T21:00:00.000Z") / 1000;
const SUCCEEDED = Date.parse("2026-06-30T21:00:00.000Z") / 1000;

function paymentIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: "pi_donation",
    object: "payment_intent",
    amount: 5000,
    amount_received: 5000,
    currency: "nzd",
    created: CREATED,
    description: null,
    latest_charge: "ch_donation",
    application: null,
    metadata: {},
    ...overrides,
  } as Stripe.PaymentIntent;
}

function event(id = "evt_donation", livemode = true): Stripe.Event {
  return { id, livemode, created: SUCCEEDED, type: "payment_intent.succeeded" } as Stripe.Event;
}

function checkoutSession(): Stripe.Checkout.Session {
  return {
    id: "cs_donation",
    payment_link: "plink_donations",
    line_items: {
      data: [
        { description: "Winter donation", quantity: 1 },
        { description: "Raffle ticket", quantity: 3 },
      ],
    },
  } as unknown as Stripe.Checkout.Session;
}

function storedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "row_pi_donation",
    stripePaymentIntentId: "pi_donation",
    stripeChargeId: "ch_donation",
    stripeCheckoutSessionId: null,
    stripePaymentLinkId: null,
    stripeApplicationId: null,
    amountCents: 5000,
    currency: "nzd",
    stripeSucceededAt: new Date(SUCCEEDED * 1000),
    description: null,
    stripeEventId: "evt_donation",
    alertSentAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const record = (intent = paymentIntent(), evt = event()) => recordUnrecognisedStripePayment(intent, evt, CLUB_FORMAT_TEST);

describe("recordUnrecognisedStripePayment (#4532)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.cooldowns.clear();
    state.beforeInsert = null;
    mocks.findCheckoutSession.mockResolvedValue(null);
  });

  it("records a Payment Link payment with its Checkout session, link and line items, and alerts once", async () => {
    mocks.findCheckoutSession.mockResolvedValue(checkoutSession());

    await record();

    expect(mocks.findCheckoutSession).toHaveBeenCalledWith("pi_donation");
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          stripePaymentIntentId: "pi_donation",
          stripeChargeId: "ch_donation",
          stripeCheckoutSessionId: "cs_donation",
          stripePaymentLinkId: "plink_donations",
          stripeApplicationId: null,
          amountCents: 5000,
          currency: "nzd",
          // When it succeeded (the event), not when checkout began (the intent).
          stripeSucceededAt: new Date("2026-06-30T21:00:00.000Z"),
          description: "Winter donation; 3 x Raffle ticket",
          stripeEventId: "evt_donation",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledWith({
      amount: "$50.00",
      paidAt: expect.any(String),
      description: "Winter donation; 3 x Raffle ticket",
      paymentIntentId: "pi_donation",
      chargeId: "ch_donation",
      checkoutSessionId: "cs_donation",
      paymentLinkId: "plink_donations",
      applicationNote: "",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_donation",
    });
    expect(state.cooldowns.has(unrecognisedStripePaymentAlertKey("pi_donation"))).toBe(true);
    expect(state.rows.get("pi_donation")!.alertSentAt).toBeInstanceOf(Date);
  });

  it("records a dashboard charge with no Checkout session, from the intent's own description", async () => {
    await record(
      paymentIntent({ description: "Hut hire - cash sale", latest_charge: { id: "ch_obj" } as Stripe.Charge }),
      event("evt_dash", false),
    );

    expect(state.rows.get("pi_donation")).toMatchObject({
      stripeChargeId: "ch_obj",
      stripeCheckoutSessionId: null,
      stripePaymentLinkId: null,
      description: "Hut hire - cash sale",
      stripeEventId: "evt_dash",
    });
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "None",
        paymentLinkId: "None",
        description: "Hut hire - cash sale",
        stripeDashboardUrl: "https://dashboard.stripe.com/test/payments/pi_donation",
      }),
    );
  });

  it("stores the platform that created a payment, and says so in the alert", async () => {
    await record(paymentIntent({ application: "ca_xero" }));

    expect(state.rows.get("pi_donation")!.stripeApplicationId).toBe("ca_xero");
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ applicationNote: unrecognisedPaymentApplicationNote("ca_xero") }),
    );
    expect(unrecognisedPaymentApplicationNote("ca_xero")).toContain("ca_xero");
  });

  it("still records the payment when the Checkout read fails", async () => {
    mocks.findCheckoutSession.mockRejectedValue(new Error("Stripe unavailable"));

    await record();

    expect(state.rows.get("pi_donation")).toMatchObject({ stripeCheckoutSessionId: null, description: null });
    expect(mocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ description: "None" }));
  });

  it("alerts each payment under its own claim, so a second payment is never silenced by the first", async () => {
    await record();
    await record(paymentIntent({ id: "pi_second" }), event("evt_second"));

    expect(state.rows.size).toBe(2);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect([...state.cooldowns.keys()].sort()).toEqual([
      "unrecognised-stripe-payment:pi_donation",
      "unrecognised-stripe-payment:pi_second",
    ]);
  });

  it("writes and alerts nothing more on redelivery, and asks Stripe nothing", async () => {
    mocks.findCheckoutSession.mockResolvedValue(checkoutSession());
    await record();
    vi.clearAllMocks();

    await record(paymentIntent(), event("evt_redelivered"));

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_donation")!.stripeEventId).toBe("evt_donation");
    expect(mocks.findCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("leaves a fresh claim to the concurrent delivery holding it, and does not fail", async () => {
    state.beforeInsert = () => {
      state.rows.set("pi_donation", storedRow({ stripeEventId: "evt_other", description: "Theirs" }));
      // The racing delivery has just claimed the alert and is sending it.
      state.cooldowns.set(unrecognisedStripePaymentAlertKey("pi_donation"), new Date());
    };

    await record();

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_donation")!.stripeEventId).toBe("evt_other");
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("sends the alert on redelivery when the delivery that wrote the row died before claiming it", async () => {
    state.rows.set("pi_donation", storedRow());

    await record();

    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.rows.get("pi_donation")!.alertSentAt).toBeInstanceOf(Date);
  });

  it("re-sends, once, an alert whose claim is older than the webhook lease with nothing sent", async () => {
    const staleAt = new Date(NOW.getTime() - UNRECOGNISED_PAYMENT_STALE_CLAIM_MS - 1);
    state.rows.set("pi_donation", storedRow());
    state.cooldowns.set(unrecognisedStripePaymentAlertKey("pi_donation"), staleAt);

    await record();
    await record(paymentIntent(), event("evt_again"));

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.cooldowns.get(unrecognisedStripePaymentAlertKey("pi_donation"))!.getTime()).toBeGreaterThan(staleAt.getTime());
    expect(state.rows.get("pi_donation")!.alertSentAt).toBeInstanceOf(Date);
  });

  it("does not re-send while the claim is younger than the webhook lease", async () => {
    state.rows.set("pi_donation", storedRow());
    state.cooldowns.set(
      unrecognisedStripePaymentAlertKey("pi_donation"),
      new Date(NOW.getTime() - UNRECOGNISED_PAYMENT_STALE_CLAIM_MS + 60_000),
    );

    await record();

    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(state.rows.get("pi_donation")!.alertSentAt).toBeNull();
  });

  it("throws when the alert could not be sent, keeping the row, so Stripe redelivers and the alert is retried", async () => {
    mocks.sendAlert.mockRejectedValueOnce(new Error("recipients unreadable"));

    await expect(record()).rejects.toBeInstanceOf(UnrecognisedStripePaymentAlertNotSentError);
    expect(state.rows.size).toBe(1);
    expect(state.cooldowns.size).toBe(0);
    expect(state.rows.get("pi_donation")!.alertSentAt).toBeNull();

    await record();

    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect(state.cooldowns.has(unrecognisedStripePaymentAlertKey("pi_donation"))).toBe(true);
    expect(state.rows.size).toBe(1);
  });
});

describe("the hourly alert cap (#4532)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.cooldowns.clear();
    state.beforeInsert = null;
    mocks.findCheckoutSession.mockResolvedValue(null);
  });

  const burst = async (count: number, from = 0) => {
    for (let index = from; index < from + count; index += 1) {
      await record(paymentIntent({ id: `pi_burst_${index}` }), event(`evt_burst_${index}`));
    }
  };

  it(`sends ${UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR} single alerts an hour, then one "more payments" alert, and still records every payment`, async () => {
    await burst(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR + 4);

    expect(state.rows.size).toBe(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR + 4);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR);
    expect(mocks.sendPausedAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendPausedAlert).toHaveBeenCalledWith({
      paymentCount: String(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR + 1),
      pausedUntil: expect.any(String),
      stripeDashboardUrl: "https://dashboard.stripe.com/payments",
    });
    // Every capped payment is covered, so a redelivery of one sends nothing.
    expect([...state.rows.values()].every((row) => row.alertSentAt !== null)).toBe(true);
  });

  it("resumes single alerts once the hour has passed", async () => {
    await burst(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR + 1);
    // Age every claim past the window, as an hour passing would.
    for (const [key, at] of state.cooldowns) {
      state.cooldowns.set(key, new Date(at.getTime() - UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS - 1));
    }
    vi.clearAllMocks();

    await burst(1, 100);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendPausedAlert).not.toHaveBeenCalled();
  });

  it("gives the hour's claim back and fails the event when the paused alert cannot be sent", async () => {
    await burst(UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR);
    mocks.sendPausedAlert.mockRejectedValueOnce(new Error("recipients unreadable"));

    await expect(burst(1, 50)).rejects.toThrow("recipients unreadable");
    expect(state.cooldowns.has(UNRECOGNISED_PAYMENTS_PAUSED_ALERT_KEY)).toBe(false);
    expect(state.rows.get("pi_burst_50")!.alertSentAt).toBeNull();

    await burst(1, 50);

    expect(mocks.sendPausedAlert).toHaveBeenCalledTimes(2);
    expect(state.rows.get("pi_burst_50")!.alertSentAt).toBeInstanceOf(Date);
  });
});

describe("what the record and alert say (#4532)", () => {
  it("formats the amount in the payment's own currency", () => {
    expect(unrecognisedPaymentAmountLabel(5000, "nzd", CLUB_FORMAT_TEST)).toBe("$50.00");
    expect(unrecognisedPaymentAmountLabel(5000, "aud", CLUB_FORMAT_TEST)).toBe("A$50.00");
    // A currency that does not count in hundredths is never given a guessed decimal.
    expect(unrecognisedPaymentAmountLabel(5000, "jpy", CLUB_FORMAT_TEST)).toBe("5000 JPY (Stripe's smallest unit)");
  });

  it("caps the description and prefers line items to the intent's description", () => {
    const long = "x".repeat(UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH + 50);
    expect(describeUnrecognisedPayment({ description: long }, null)).toHaveLength(UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH);
    expect(
      describeUnrecognisedPayment(
        { description: "intent" },
        { line_items: { data: [{ description: "Donation", quantity: 1 }] } } as unknown as Stripe.Checkout.Session,
      ),
    ).toBe("Donation");
    expect(describeUnrecognisedPayment({ description: "  " }, null)).toBeNull();
  });

  it("says nothing about another platform for a direct payment", () => {
    expect(unrecognisedPaymentApplicationNote(null)).toBe("");
  });
});
