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
  reason: "NOT_APP_CREATED" | "APP_INTENT_NO_TRANSACTION" | "APP_INTENT_NOT_PRIMARY";
  bookingId: string | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  heldKeys: new Map<string, Date>(),
  /** Runs inside createMany before the insert: a concurrent delivery's row. */
  beforeInsert: null as null | (() => void),
  /** #4670: how many coming claim releases (the helper's, then the caller's) fail. */
  releaseFailures: 0,
  /** #4670: how many coming `alertedAt` writes fail. */
  stampFailures: 0,
}));

const mocks = vi.hoisted(() => ({
  findCheckoutSession: vi.fn(),
  sendAlert: vi.fn<(...args: unknown[]) => Promise<"sent" | "undelivered">>(async () => "sent"),
  sendUnmatchedAlert: vi.fn<(...args: unknown[]) => Promise<"sent" | "undelivered">>(async () => "sent"),
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
        if (state.stampFailures > 0) {
          state.stampFailures -= 1;
          throw new Error("database blip");
        }
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
      // The real `claimAlertCooldown`, which writes the sent marker (#4670), over the same key set.
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (state.heldKeys.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        state.heldKeys.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        if (state.releaseFailures > 0) {
          state.releaseFailures -= 1;
          throw new Error("database blip");
        }
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
  sendAdminUnmatchedAppStripePaymentAlert: (...args: unknown[]) => mocks.sendUnmatchedAlert(...args),
}));

// The real helper's rule, over a key set: claim, send, keep - or give the claim
// back when the send throws, through the store, so a failing release leaves it
// held (#4670). `unrecognised-stripe-payment-email-retry.test.ts` runs the real helper.
vi.mock("@/lib/admin-alert-once", async () => {
  const { prisma } = await import("@/lib/prisma");
  const heldIn = (keys: readonly string[]) => new Map([...state.heldKeys].filter(([key]) => keys.includes(key)));
  return {
    sendAdminAlertOnceEverClaim: async ({ key, send }: { key: string; send: () => Promise<unknown> }) => {
      if (state.heldKeys.has(key)) return { kept: false, claimedAt: null };
      const claimedAt = new Date();
      state.heldKeys.set(key, claimedAt);
      try {
        await send();
        return { kept: true, claimedAt };
      } catch {
        await prisma.alertCooldown.deleteMany({ where: { key, lastAlertedAt: claimedAt } }).catch(() => undefined);
        return { kept: false, claimedAt };
      }
    },
    readHeldOnceEverAlertTimes: async (keys: readonly string[]) => heldIn(keys),
    findHeldOnceEverAlertKeys: async (keys: readonly string[]) => new Set(heldIn(keys).keys()),
  };
});

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  describeUnrecognisedPayment,
  recordUnmatchedAppStripePayment,
  recordUnrecognisedStripePayment,
  UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS,
  UNRECOGNISED_ALERT_IN_FLIGHT_MS,
  stripeDashboardPaymentUrl,
  unrecognisedPaymentAmountLabel,
  unrecognisedStripePaymentAlertKey,
  unrecognisedStripePaymentAlertSentKey,
  UnrecognisedStripePaymentAlertNotSentError,
  UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH,
} from "@/lib/unrecognised-stripe-payment";
import { STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES } from "@/lib/stripe-webhook-lease";
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
    state.releaseFailures = 0;
    state.stampFailures = 0;
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
          reason: "NOT_APP_CREATED",
          bookingId: null,
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
        reason: "NOT_APP_CREATED",
        bookingId: null,
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
      reason: "NOT_APP_CREATED",
      bookingId: null,
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
      reason: "NOT_APP_CREATED",
      bookingId: null,
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

/**
 * #4647: the window a held claim with no `alertedAt` counts as in flight is the
 * webhook lease less a margin. The dead attempt stamped its lease first and its
 * claim up to the margin later; a takeover comes only once that lease expired.
 * The clock is frozen, so every age below is exact.
 */
describe("the alert claim's in-flight window against the webhook lease (#4647)", () => {
  const LEASE_MS = STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES * 60_000;
  const key = unrecognisedStripePaymentAlertKey("pi_donation");

  /** A stored row a dead delivery wrote, and its claim taken `ageMs` ago. */
  function deadDeliveryClaim(ageMs: number) {
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
      reason: "NOT_APP_CREATED",
      bookingId: null,
    });
    state.heldKeys.set(key, new Date(Date.now() - ageMs));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.heldKeys.clear();
    state.beforeInsert = null;
    state.releaseFailures = 0;
    state.stampFailures = 0;
    mocks.findCheckoutSession.mockResolvedValue(null);
  });

  it("is the webhook lease less a positive margin, so it is derived and never equal to the lease", () => {
    expect(UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS).toBeGreaterThan(0);
    expect(UNRECOGNISED_ALERT_IN_FLIGHT_MS).toBe(LEASE_MS - UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS);
    expect(UNRECOGNISED_ALERT_IN_FLIGHT_MS).toBeGreaterThan(0);
  });

  it("sends on a takeover 1 ms after the lease expired, though the dead attempt claimed late in its lease", async () => {
    // The dead attempt's lease was stamped 1 ms more than a lease ago (so a
    // takeover is allowed now), and its claim just inside the margin after that.
    const leaseStampedAgoMs = LEASE_MS + 1;
    deadDeliveryClaim(leaseStampedAgoMs - (UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS - 1));

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeInstanceOf(Date);
    expect(state.heldKeys.get(key)).toEqual(new Date());
  });

  it("leaves a claim 1 ms younger than the window to its holder, and completes without sending", async () => {
    const heldAt = new Date(Date.now() - (UNRECOGNISED_ALERT_IN_FLIGHT_MS - 1));
    deadDeliveryClaim(UNRECOGNISED_ALERT_IN_FLIGHT_MS - 1);

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(state.heldKeys.get(key)).toEqual(heldAt);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeNull();
  });

  it("releases a claim exactly as old as the window, and sends", async () => {
    deadDeliveryClaim(UNRECOGNISED_ALERT_IN_FLIGHT_MS);

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeInstanceOf(Date);
  });
});

/**
 * #4670: the alert goes out exactly once across a failed claim release and a
 * failed `alertedAt` write - the two writes around the send that can fail
 * after the claim was taken.
 */
describe("the alert across a failed write around the send (#4670)", () => {
  const key = unrecognisedStripePaymentAlertKey("pi_donation");
  const sentKey = unrecognisedStripePaymentAlertSentKey("pi_donation");

  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.heldKeys.clear();
    state.beforeInsert = null;
    state.releaseFailures = 0;
    state.stampFailures = 0;
    mocks.findCheckoutSession.mockResolvedValue(null);
  });

  it("fails the webhook when the send failed and giving the claim back failed, and the redelivery sends", async () => {
    mocks.sendAlert.mockRejectedValueOnce(new Error("mail down"));
    state.releaseFailures = 1;

    // Its own leftover claim is not a sibling's in flight: never complete the event on it.
    await expect(recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      UnrecognisedStripePaymentAlertNotSentError,
    );
    expect(state.heldKeys.has(key)).toBe(false);

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeInstanceOf(Date);
  });

  it("still fails the webhook when the second release fails too", async () => {
    mocks.sendAlert.mockRejectedValueOnce(new Error("mail down"));
    state.releaseFailures = 2;

    await expect(recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      UnrecognisedStripePaymentAlertNotSentError,
    );
    expect(state.heldKeys.has(key)).toBe(true);
  });

  it("keeps the claim and completes when the alert went out but its alertedAt write failed", async () => {
    state.stampFailures = 1;

    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.rows.get("pi_donation")?.alertedAt).toBeNull();
    expect(state.heldKeys.has(key)).toBe(true);
    expect(state.heldKeys.has(sentKey)).toBe(true);
  });

  it("reads the sent marker as sent, so a delivery past the in-flight window never sends a second alert", async () => {
    state.stampFailures = 1;
    await recordUnrecognisedStripePayment(paymentIntent(), event(), CLUB_FORMAT_TEST);
    // The kept claim, unstamped, is older than the window a delivery would take it over after.
    state.heldKeys.set(key, new Date(Date.now() - UNRECOGNISED_ALERT_IN_FLIGHT_MS - 60_000));

    await recordUnrecognisedStripePayment(paymentIntent(), event("evt_other"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
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

  it("links the Stripe dashboard in the event's mode", () => {
    expect(stripeDashboardPaymentUrl("pi_1", true)).toBe("https://dashboard.stripe.com/payments/pi_1");
    expect(stripeDashboardPaymentUrl("pi_1", false)).toBe("https://dashboard.stripe.com/test/payments/pi_1");
  });
});

/**
 * #4624 (`INV-INT-033`): a succeeded PaymentIntent the app created for a booking
 * that no PRIMARY payment transaction names - the same record, the same claim
 * and the same once-ever key, with its own alert and reason.
 */
describe("recordUnmatchedAppStripePayment (#4624)", () => {
  function appIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
    return paymentIntent({
      id: "pi_app",
      amount: 12000,
      amount_received: 12000,
      latest_charge: "ch_app",
      metadata: { bookingId: "booking-1" },
      ...overrides,
    });
  }
  const NO_ROW = { bookingId: "booking-1", matchedKind: null };

  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.heldKeys.clear();
    state.beforeInsert = null;
    state.releaseFailures = 0;
    state.stampFailures = 0;
  });

  it("records an app intent no payment transaction names once, with its booking, and alerts once with its own alert", async () => {
    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, NO_ROW);

    // The app makes no Checkout session, so Stripe is not asked for one.
    expect(mocks.findCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          stripePaymentIntentId: "pi_app",
          stripeChargeId: "ch_app",
          stripeCheckoutSessionId: null,
          stripePaymentLinkId: null,
          amountCents: 12000,
          currency: "nzd",
          stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
          description: null,
          stripeEventId: "evt_app",
          reason: "APP_INTENT_NO_TRANSACTION",
          bookingId: "booking-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(mocks.sendUnmatchedAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendUnmatchedAlert).toHaveBeenCalledWith({
      amount: "$120.00",
      receivedAt: expect.any(String),
      bookingId: "booking-1",
      ledgerMatch: "No payment record names this Stripe payment",
      paymentIntentId: "pi_app",
      chargeId: "ch_app",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_app",
    });
    expect(state.rows.get("pi_app")?.alertedAt).toBeInstanceOf(Date);
    expect(state.heldKeys.has(unrecognisedStripePaymentAlertKey("pi_app"))).toBe(true);
  });

  it("records an app intent whose only row is not PRIMARY as APP_INTENT_NOT_PRIMARY, and says so", async () => {
    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, {
      bookingId: "booking-1",
      matchedKind: "ADDITIONAL",
    });

    expect(state.rows.get("pi_app")?.reason).toBe("APP_INTENT_NOT_PRIMARY");
    expect(mocks.sendUnmatchedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerMatch: expect.stringContaining("An additional-payment request names this Stripe payment") }),
    );
  });

  it("records nothing new and alerts nothing on redelivery", async () => {
    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, NO_ROW);
    vi.clearAllMocks();

    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app_redelivered"), CLUB_FORMAT_TEST, NO_ROW);

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_app")!.stripeEventId).toBe("evt_app");
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendUnmatchedAlert).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("alerts nothing when a concurrent delivery won the insert and holds a fresh claim", async () => {
    state.beforeInsert = () => {
      state.rows.set("pi_app", {
        id: "row_other",
        stripePaymentIntentId: "pi_app",
        stripeChargeId: "ch_app",
        stripeCheckoutSessionId: null,
        stripePaymentLinkId: null,
        amountCents: 12000,
        currency: "nzd",
        stripeCreatedAt: new Date("2026-06-30T21:00:00.000Z"),
        description: null,
        stripeEventId: "evt_other",
        alertedAt: null,
        createdAt: new Date(),
        reason: "APP_INTENT_NO_TRANSACTION",
        bookingId: "booking-1",
      });
      state.heldKeys.set(unrecognisedStripePaymentAlertKey("pi_app"), new Date());
    };

    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, NO_ROW);

    expect(state.rows.size).toBe(1);
    expect(state.rows.get("pi_app")!.stripeEventId).toBe("evt_other");
    expect(mocks.sendUnmatchedAlert).not.toHaveBeenCalled();
  });

  it("throws when the alert is not delivered, keeping the row, and the redelivery sends it", async () => {
    mocks.sendUnmatchedAlert.mockResolvedValueOnce("undelivered");

    await expect(
      recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, NO_ROW),
    ).rejects.toBeInstanceOf(UnrecognisedStripePaymentAlertNotSentError);
    expect(state.rows.size).toBe(1);
    expect(state.heldKeys.size).toBe(0);

    await recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, NO_ROW);

    expect(mocks.sendUnmatchedAlert).toHaveBeenCalledTimes(2);
    expect(state.rows.get("pi_app")?.alertedAt).toBeInstanceOf(Date);
  });

  it("alerts by the STORED row's reason: one PaymentIntent is one record and one alert, whichever case recorded it", async () => {
    await recordUnrecognisedStripePayment(paymentIntent({ id: "pi_app" }), event("evt_first"), CLUB_FORMAT_TEST);
    vi.clearAllMocks();

    await recordUnmatchedAppStripePayment(appIntent(), event("evt_second"), CLUB_FORMAT_TEST, NO_ROW);

    expect(state.rows.get("pi_app")?.reason).toBe("NOT_APP_CREATED");
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.sendUnmatchedAlert).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("refuses a PRIMARY match, which the webhook settles and never records", async () => {
    await expect(
      recordUnmatchedAppStripePayment(appIntent(), event("evt_app"), CLUB_FORMAT_TEST, {
        bookingId: "booking-1",
        matchedKind: "PRIMARY",
      }),
    ).rejects.toThrow("A PRIMARY payment transaction matches this PaymentIntent");
    expect(state.rows.size).toBe(0);
    expect(mocks.sendUnmatchedAlert).not.toHaveBeenCalled();
  });
});
