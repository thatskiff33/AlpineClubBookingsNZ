import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * #4532 (`INV-INT-032`): the record and alert of a succeeded Stripe payment the
 * app did not create - with and without a Checkout session / Payment Link, on
 * redelivery, on a concurrent delivery that won the insert, and when the alert
 * cannot be sent. The store is one in-memory table keyed as the unique index
 * keys it; the once-ever alert claim is an in-memory key set with the real
 * helper's keep / give-back rule. `unrecognised-stripe-payment.realdb.test.ts`
 * runs the same flow against PostgreSQL and the real claim.
 */
type Row = {
  id: string;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentLinkId: string | null;
  amountCents: number;
  currency: string;
  stripeCreatedAt: Date;
  description: string | null;
  stripeEventId: string;
  alertedAt: Date | null;
  createdAt: Date;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  heldKeys: new Map<string, Date>(),
  /** Runs inside createMany before the insert: a concurrent delivery's row. */
  beforeInsert: null as null | (() => void),
}));

const mocks = vi.hoisted(() => ({
  findCheckoutSession: vi.fn(),
  sendAlert: vi.fn<(...args: unknown[]) => Promise<"sent" | "undelivered">>(async () => "sent"),
  createMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    unrecognisedStripePayment: {
      findUnique: async ({ where }: { where: { stripePaymentIntentId?: string; id?: string } }) => {
        if (where.stripePaymentIntentId) return state.rows.get(where.stripePaymentIntentId) ?? null;
        return [...state.rows.values()].find((row) => row.id === where.id) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { alertedAt: Date } }) => {
        const row = [...state.rows.values()].find((item) => item.id === where.id);
        if (!row) throw new Error("missing row");
        Object.assign(row, data);
        return row;
      },
      createMany: async (args: { data: Omit<Row, "id" | "createdAt" | "alertedAt">[]; skipDuplicates: boolean }) => {
        mocks.createMany(args);
        state.beforeInsert?.();
        let count = 0;
        for (const data of args.data) {
          if (state.rows.has(data.stripePaymentIntentId)) {
            if (!args.skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
            continue;
          }
          state.rows.set(data.stripePaymentIntentId, {
            ...data,
            id: `row_${state.rows.size + 1}`,
            alertedAt: null,
            createdAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
    },
    alertCooldown: {
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const held = state.heldKeys.get(where.key);
        if (held && held.getTime() === where.lastAlertedAt.getTime()) {
          state.heldKeys.delete(where.key);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  findCheckoutSessionForPaymentIntent: (...args: unknown[]) => mocks.findCheckoutSession(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminUnrecognisedStripePaymentAlert: (...args: unknown[]) => mocks.sendAlert(...args),
}));

// The real helper's rule, over a key set: claim, send, keep - or give the claim
// back when the send throws. `admin-alert-once.test.ts` pins the helper itself.
vi.mock("@/lib/admin-alert-once", () => ({
  sendAdminAlertOnceEver: async ({ key, send }: { key: string; send: () => Promise<unknown> }) => {
    if (state.heldKeys.has(key)) return false;
    state.heldKeys.set(key, new Date());
    try {
      await send();
      return true;
    } catch {
      state.heldKeys.delete(key);
      return false;
    }
  },
  readHeldOnceEverAlertTimes: async (keys: readonly string[]) =>
    new Map([...state.heldKeys].filter(([key]) => keys.includes(key))),
}));

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  describeUnrecognisedPayment,
  recordUnrecognisedStripePayment,
  UNRECOGNISED_ALERT_IN_FLIGHT_MS,
  stripeDashboardPaymentUrl,
  unrecognisedPaymentAmountLabel,
  unrecognisedStripePaymentAlertKey,
  UnrecognisedStripePaymentAlertNotSentError,
  UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH,
} from "@/lib/unrecognised-stripe-payment";
import { STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES } from "@/lib/stripe-webhook-service";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CREATED = Date.parse("2026-06-30T21:00:00.000Z") / 1000;

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
    metadata: {},
    ...overrides,
  } as Stripe.PaymentIntent;
}

function event(id = "evt_donation", livemode = true): Stripe.Event {
  return { id, livemode, type: "payment_intent.succeeded", created: CREATED } as Stripe.Event;
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

describe("recordUnrecognisedStripePayment (#4532)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.heldKeys.clear();
    state.beforeInsert = null;
    mocks.findCheckoutSession.mockResolvedValue(null);
  });

  it("records a Payment Link payment with its Checkout session, link and line items, and alerts once", async () => {
    mocks.findCheckoutSession.mockResolvedValue(checkoutSession());

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.findCheckoutSession).toHaveBeenCalledWith("pi_donation");
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          stripePaymentIntentId: "pi_donation",
          stripeChargeId: "ch_donation",
          stripeCheckoutSessionId: "cs_donation",
          stripePaymentLinkId: "plink_donations",
          amountCents: 5000,
          currency: "nzd",
          stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
          description: "Winter donation; 3 x Raffle ticket",
          stripeEventId: "evt_donation",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledWith({
      amount: "$50.00",
      receivedAt: expect.any(String),
      description: "Winter donation; 3 x Raffle ticket",
      paymentIntentId: "pi_donation",
      chargeId: "ch_donation",
      checkoutSessionId: "cs_donation",
      paymentLinkId: "plink_donations",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_donation",
    });
    expect(state.heldKeys.has(unrecognisedStripePaymentAlertKey("pi_donation"))).toBe(true);
  });

  it("records a dashboard charge with no Checkout session, from the intent's own description", async () => {
    await recordUnrecognisedStripePayment(
      paymentIntent({ description: "Hut hire - cash sale", latest_charge: { id: "ch_obj" } as Stripe.Charge }),
      event("evt_dash", false),
      CLUB_FORMAT_TEST,
    );

    const row = state.rows.get("pi_donation")!;
    expect(row).toMatchObject({
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

  it("alerts each payment under its own claim, so a second payment is never silenced by the first", async () => {
    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);
    await recordUnrecognisedStripePayment(paymentIntent({ id: "pi_second" }), event("evt_second"), CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(2);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect([...state.heldKeys.keys()].sort()).toEqual([
      "unrecognised-stripe-payment:pi_donation",
      "unrecognised-stripe-payment:pi_second",
    ]);
  });

  it("does not record the payment when the Checkout read fails, so Stripe redelivers", async () => {
    mocks.findCheckoutSession.mockRejectedValue(new Error("Stripe unavailable"));

    await expect(recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST)).rejects.toThrow(
      "Stripe unavailable",
    );

    expect(state.rows.size).toBe(0);
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("writes and alerts nothing more on redelivery, and asks Stripe nothing", async () => {
    mocks.findCheckoutSession.mockResolvedValue(checkoutSession());
    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);
    vi.clearAllMocks();

    await recordUnrecognisedStripePayment(paymentIntent(), event("evt_redelivered"), CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_donation")!.stripeEventId).toBe("evt_donation");
    expect(mocks.findCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("alerts from the stored row when a concurrent delivery won the insert, and only once between them", async () => {
    state.beforeInsert = () => {
      state.rows.set("pi_donation", {
        id: "row_other",
        stripePaymentIntentId: "pi_donation",
        stripeChargeId: "ch_donation",
        stripeCheckoutSessionId: "cs_other",
        stripePaymentLinkId: "plink_other",
        amountCents: 5000,
        currency: "nzd",
        stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
        description: "Theirs",
        stripeEventId: "evt_other",
        alertedAt: null,
        createdAt: new Date(),
      });
      // The winner already holds a fresh alert claim and has not stamped the row.
      state.heldKeys.set(unrecognisedStripePaymentAlertKey("pi_donation"), new Date());
    };

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_donation")!.stripeEventId).toBe("evt_other");
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("finishes the alert on redelivery when the delivery that wrote the row died before sending it", async () => {
    state.rows.set("pi_donation", {
      id: "row_1",
      stripePaymentIntentId: "pi_donation",
      stripeChargeId: "ch_donation",
      stripeCheckoutSessionId: null,
      stripePaymentLinkId: null,
      amountCents: 5000,
      currency: "nzd",
      stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
      description: null,
      stripeEventId: "evt_donation",
      alertedAt: null,
      createdAt: new Date(),
    });

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("releases a claim older than the webhook lease that never stamped the row, and sends", async () => {
    const key = unrecognisedStripePaymentAlertKey("pi_donation");
    state.rows.set("pi_donation", {
      id: "row_1",
      stripePaymentIntentId: "pi_donation",
      stripeChargeId: "ch_donation",
      stripeCheckoutSessionId: null,
      stripePaymentLinkId: null,
      amountCents: 5000,
      currency: "nzd",
      stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
      description: null,
      stripeEventId: "evt_donation",
      alertedAt: null,
      createdAt: new Date(),
    });
    state.heldKeys.set(key, new Date(Date.now() - 16 * 60 * 1000));

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeInstanceOf(Date);
    expect(state.heldKeys.has(key)).toBe(true);
  });

  it("throws when the sender reports the mail undelivered, so Stripe redelivers", async () => {
    mocks.sendAlert.mockResolvedValueOnce("undelivered");

    await expect(recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      UnrecognisedStripePaymentAlertNotSentError,
    );
    expect(state.rows.size).toBe(1);
    expect(state.heldKeys.size).toBe(0);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeNull();
  });

  it("throws when the alert could not be sent, keeping the row, so Stripe redelivers and the alert is retried", async () => {
    mocks.sendAlert.mockRejectedValueOnce(new Error("mail down"));

    await expect(recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      UnrecognisedStripePaymentAlertNotSentError,
    );
    expect(state.rows.size).toBe(1);
    expect(state.heldKeys.size).toBe(0);

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect(state.heldKeys.has(unrecognisedStripePaymentAlertKey("pi_donation"))).toBe(true);
    expect(state.rows.size).toBe(1);
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
    expect(
      describeUnrecognisedPayment(
        { description: "intent" },
        { line_items: { data: [{ description: "Donation", quantity: 1 }], has_more: true } } as unknown as Stripe.Checkout.Session,
      ),
    ).toBe("Donation; further line items were not listed");
  });

  it("dates the payment from the succeeded event, not from when the PaymentIntent was opened", async () => {
    await recordUnrecognisedStripePayment(paymentIntent({ created: CREATED - 3600 }), event(), CLUB_FORMAT_TEST);
    expect(state.rows.get("pi_donation")?.stripeCreatedAt).toEqual(new Date(CREATED * 1000));
  });

  it("treats a claim older than the webhook lease as abandoned", () => {
    expect(UNRECOGNISED_ALERT_IN_FLIGHT_MS).toBe(STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES * 60 * 1000);
  });

  it("links the Stripe dashboard in the event's mode", () => {
    expect(stripeDashboardPaymentUrl("pi_1", true)).toBe("https://dashboard.stripe.com/payments/pi_1");
    expect(stripeDashboardPaymentUrl("pi_1", false)).toBe("https://dashboard.stripe.com/test/payments/pi_1");
  });
});
