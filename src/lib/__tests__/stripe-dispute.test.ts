import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * #4911 (`INV-PAY-153`): the record and alerts of a cardholder's dispute - a
 * matched capture and an unknown charge, delivery out of order, each outcome,
 * the monotonic merge, redelivery and a lease takeover, and an alert nobody
 * received. The store is one in-memory table keyed as the unique index keys
 * it; the once-ever alert claim is an in-memory key set with the real helper's
 * keep / give-back rule, as `unrecognised-stripe-payment.test.ts` models it.
 */
type Row = Record<string, unknown> & {
  id: string;
  stripeDisputeId: string;
  openedAlertedAt: Date | null;
  closedAlertedAt: Date | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown> & { id: string; stripeDisputeId: string; openedAlertedAt: Date | null; closedAlertedAt: Date | null }>(),
  heldKeys: new Map<string, Date>(),
  transactions: new Map<string, { id: string; paymentId: string; payment: { bookingId: string } }>(),
  payments: new Map<string, { id: string; bookingId: string }>(),
  settlements: new Map<string, { groupBooking: { organiserBookingId: string } }>(),
  bookings: new Map<string, { member: { firstName: string; lastName: string } | null; organisation: { name: string } | null }>(),
  /** How many coming stamp writes fail. */
  stampFailures: 0,
  /** Runs as a claim is attempted: a sibling delivery acting meanwhile. */
  beforeClaim: null as null | (() => void),
}));

const mocks = vi.hoisted(() => ({
  sendAlert: vi.fn<(...args: unknown[]) => Promise<"sent" | "queued-for-retry" | "undelivered">>(async () => "sent"),
  getChargePaymentIntentId: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
  createMany: vi.fn(),
  /** Every merge write (stamps excluded). */
  mergeWrites: vi.fn(),
  lockedIds: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const byId = (id: string) => [...state.rows.values()].find((row) => row.id === id) ?? null;
  const prisma: Record<string, unknown> = {
    stripeDispute: {
      findUnique: async ({ where }: { where: { stripeDisputeId?: string; id?: string } }) => {
        const row = where.stripeDisputeId ? state.rows.get(where.stripeDisputeId) ?? null : byId(where.id!);
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = byId(where.id);
        if (!row) throw new Error("missing dispute row");
        return { ...row };
      },
      createMany: async (args: { data: (Record<string, unknown> & { stripeDisputeId: string })[]; skipDuplicates: boolean }) => {
        mocks.createMany(args);
        let count = 0;
        for (const data of args.data) {
          if (state.rows.has(data.stripeDisputeId)) {
            if (!args.skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
            continue;
          }
          state.rows.set(data.stripeDisputeId, {
            ...data,
            id: `sd_${state.rows.size + 1}`,
            openedAlertedAt: null,
            closedAlertedAt: null,
          });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const stamp = "openedAlertedAt" in data || "closedAlertedAt" in data;
        if (stamp && state.stampFailures > 0) {
          state.stampFailures -= 1;
          throw new Error("database blip");
        }
        if (!stamp) mocks.mergeWrites(data);
        const row = byId(where.id);
        if (!row) throw new Error("missing dispute row");
        Object.assign(row, data);
        return { ...row };
      },
    },
    paymentTransaction: {
      findUnique: async ({ where }: { where: { stripePaymentIntentId: string } }) =>
        state.transactions.get(where.stripePaymentIntentId) ?? null,
    },
    payment: {
      findFirst: async ({ where }: { where: { stripePaymentIntentId: string } }) =>
        state.payments.get(where.stripePaymentIntentId) ?? null,
    },
    groupBookingSettlement: {
      findUnique: async ({ where }: { where: { stripePaymentIntentId: string } }) =>
        state.settlements.get(where.stripePaymentIntentId) ?? null,
    },
    booking: {
      findUnique: async ({ where }: { where: { id: string } }) => state.bookings.get(where.id) ?? null,
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.lockedIds(...values);
      return 1;
    },
    alertCooldown: {
      // The real `claimAlertCooldown`, which writes the sent marker, over the same key set.
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (state.heldKeys.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        state.heldKeys.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const held = state.heldKeys.get(where.key);
        if (held && held.getTime() === where.lastAlertedAt.getTime()) {
          state.heldKeys.delete(where.key);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  prisma.$transaction = async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma);
  return { prisma };
});

vi.mock("@/lib/stripe", () => ({
  findCheckoutSessionForPaymentIntent: async () => null,
}));

vi.mock("@/lib/stripe-charge", () => ({
  getChargePaymentIntentId: (...args: unknown[]) => mocks.getChargePaymentIntentId(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminStripeDisputeAlert: (...args: unknown[]) => mocks.sendAlert(...args),
}));

// The real helper's rule over a key set: claim, send, keep - or give the claim
// back when the send throws. The give-back of a takeover's own claim is the real one.
vi.mock("@/lib/admin-alert-once", async (importOriginal) => {
  const { prisma } = await import("@/lib/prisma");
  const { giveBackOwnOnceEverClaim } = (await importOriginal()) as typeof import("@/lib/admin-alert-once");
  const heldIn = (keys: readonly string[]) => new Map([...state.heldKeys].filter(([key]) => keys.includes(key)));
  return {
    sendAdminAlertOnceEverClaim: async ({ key, send }: { key: string; send: () => Promise<unknown> }) => {
      const claimedAt = new Date();
      state.beforeClaim?.();
      if (state.heldKeys.has(key)) return { kept: false, claimedAt: null, claimUncertain: false };
      state.heldKeys.set(key, claimedAt);
      try {
        await send();
        return { kept: true, claimedAt, claimUncertain: false };
      } catch {
        await (prisma as unknown as { alertCooldown: { deleteMany: (args: unknown) => Promise<unknown> } }).alertCooldown
          .deleteMany({ where: { key, lastAlertedAt: claimedAt } })
          .catch(() => undefined);
        return { kept: false, claimedAt, claimUncertain: false };
      }
    },
    giveBackOwnOnceEverClaim,
    readHeldOnceEverAlertTimes: async (keys: readonly string[]) => heldIn(keys),
    findHeldOnceEverAlertKeys: async (keys: readonly string[]) => new Set(heldIn(keys).keys()),
  };
});

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import logger from "@/lib/logger";
import type { StripeDisputeAlertFields } from "@/lib/email-templates/admin-stripe-dispute";
import {
  disputeBalanceMovements,
  disputeIsClosed,
  disputeStatusFromStripe,
  mergeDisputeSnapshot,
  recordStripeDispute,
  STRIPE_DISPUTE_CHARGE_READ_TIMEOUT_MS,
  stripeDisputeAlertKey,
  stripeDisputeAlertSentKey,
  StripeDisputeAlertNotSentError,
  type DisputeSnapshot,
} from "@/lib/stripe-dispute";
import { STRIPE_DISPUTE_NEXT_STEP } from "@/lib/stripe-dispute-note";
import { UNRECOGNISED_ALERT_IN_FLIGHT_MS } from "@/lib/unrecognised-stripe-payment";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** Stripe's seconds: the dispute opened, then each later event a minute on. */
const OPENED = Date.parse("2026-06-30T21:00:00.000Z") / 1000;
const MINUTE = 60;

function dispute(overrides: Record<string, unknown> = {}): Stripe.Dispute {
  return {
    id: "dp_1",
    object: "dispute",
    amount: 12000,
    currency: "nzd",
    reason: "product_not_received",
    status: "needs_response",
    created: OPENED,
    charge: "ch_1",
    payment_intent: "pi_1",
    balance_transactions: [],
    ...overrides,
  } as unknown as Stripe.Dispute;
}

function event(type: string, createdSecondsAfterOpen = 0, id = `evt_${type}_${createdSecondsAfterOpen}`): Stripe.Event {
  return { id, type, livemode: true, created: OPENED + createdSecondsAfterOpen } as Stripe.Event;
}

/** Each stage's alert, in the order sent. */
function sentAlerts(): StripeDisputeAlertFields[] {
  return mocks.sendAlert.mock.calls.map(([fields]) => fields as StripeDisputeAlertFields);
}

function stored(): Row {
  const row = state.rows.get("dp_1");
  if (!row) throw new Error("no dispute row");
  return row;
}

function matchedCapture() {
  state.transactions.set("pi_1", { id: "txn_1", paymentId: "payment_1", payment: { bookingId: "booking_1" } });
  state.bookings.set("booking_1", { member: { firstName: "Sam", lastName: "Member" }, organisation: null });
}

function reset() {
  vi.clearAllMocks();
  state.rows.clear();
  state.heldKeys.clear();
  state.transactions.clear();
  state.payments.clear();
  state.settlements.clear();
  state.bookings.clear();
  state.stampFailures = 0;
  state.beforeClaim = null;
  mocks.sendAlert.mockResolvedValue("sent");
  mocks.getChargePaymentIntentId.mockResolvedValue(null);
}

describe("recordStripeDispute (#4911)", () => {
  beforeEach(reset);

  it("records a dispute on a booking's capture with the transaction, payment, booking, amount, reason and status, and alerts once", async () => {
    matchedCapture();

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(1);
    expect(stored()).toEqual(
      expect.objectContaining({
        stripeDisputeId: "dp_1",
        stripeChargeId: "ch_1",
        stripePaymentIntentId: "pi_1",
        paymentTransactionId: "txn_1",
        paymentId: "payment_1",
        bookingId: "booking_1",
        amountCents: 12000,
        currency: "nzd",
        reason: "product_not_received",
        status: "OPEN",
        stripeStatus: "needs_response",
        withdrawnCents: 0,
        reinstatedCents: 0,
        stripeCreatedAt: new Date(OPENED * 1000),
        lastEventCreatedAt: new Date(OPENED * 1000),
        stripeEventId: "evt_charge.dispute.created_0",
        openedAlertedAt: expect.any(Date),
        closedAlertedAt: null,
      }),
    );
    // The intent is the dispute's own: Stripe is asked nothing.
    expect(mocks.getChargePaymentIntentId).not.toHaveBeenCalled();
    expect(sentAlerts()).toEqual([
      expect.objectContaining({
        stage: "opened",
        outcome: "open",
        amount: "$120.00",
        reason: "product not received",
        bookingId: "booking_1",
        bookingOwner: "Sam Member",
        disputeId: "dp_1",
        paymentIntentId: "pi_1",
        chargeId: "ch_1",
        disputeNextStep: STRIPE_DISPUTE_NEXT_STEP.OPEN,
        stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_1",
      }),
    ]);
    expect(state.heldKeys.has(stripeDisputeAlertKey("dp_1", "opened"))).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ disputeId: "dp_1", bookingId: "booking_1" }),
      expect.stringContaining("on a booking payment"),
    );
  });

  it("reads the intent from the charge when the dispute names none, under its bounded timeout", async () => {
    matchedCapture();
    mocks.getChargePaymentIntentId.mockResolvedValue("pi_1");

    await recordStripeDispute(dispute({ payment_intent: null, charge: { id: "ch_1" } }), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.getChargePaymentIntentId).toHaveBeenCalledWith("ch_1", STRIPE_DISPUTE_CHARGE_READ_TIMEOUT_MS);
    expect(stored()).toEqual(expect.objectContaining({ stripeChargeId: "ch_1", stripePaymentIntentId: "pi_1", bookingId: "booking_1" }));
  });

  it("matches a pre-ledger payment when no transaction names the intent, and names an organisation's booking by the organisation", async () => {
    state.payments.set("pi_1", { id: "payment_old", bookingId: "booking_org" });
    state.bookings.set("booking_org", { member: null, organisation: { name: "Ski School" } });

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(stored()).toEqual(expect.objectContaining({ paymentTransactionId: null, paymentId: "payment_old", bookingId: "booking_org" }));
    expect(sentAlerts()[0]).toEqual(expect.objectContaining({ bookingId: "booking_org", bookingOwner: "Ski School" }));
  });

  it("matches a group organiser's settlement by its intent and names the organiser's booking", async () => {
    state.settlements.set("pi_1", { groupBooking: { organiserBookingId: "booking_organiser" } });
    state.bookings.set("booking_organiser", { member: { firstName: "Olive", lastName: "Organiser" }, organisation: null });

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(stored()).toEqual(expect.objectContaining({ paymentTransactionId: null, paymentId: null, bookingId: "booking_organiser" }));
    expect(sentAlerts()[0]).toEqual(expect.objectContaining({ bookingId: "booking_organiser", bookingOwner: "Olive Organiser" }));
  });

  it("records a dispute on a charge the app does not know with no booking, still alerts, and does not throw", async () => {
    await expect(recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST)).resolves.toBeUndefined();

    expect(stored()).toEqual(expect.objectContaining({ paymentTransactionId: null, paymentId: null, bookingId: null, openedAlertedAt: expect.any(Date) }));
    expect(sentAlerts()).toEqual([
      expect.objectContaining({
        stage: "opened",
        bookingId: "None - the app has no payment for this charge",
        bookingOwner: "None",
        paymentIntentId: "pi_1",
      }),
    ]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ disputeId: "dp_1", bookingId: null }),
      expect.stringContaining("a charge the app does not know"),
    );
  });

  it("records a dispute whose charge resolves to no intent, linking the charge in Stripe", async () => {
    await recordStripeDispute(dispute({ payment_intent: null }), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(stored()).toEqual(expect.objectContaining({ stripePaymentIntentId: null, bookingId: null }));
    expect(sentAlerts()[0]).toEqual(
      expect.objectContaining({ paymentIntentId: "None", stripeDashboardUrl: "https://dashboard.stripe.com/payments/ch_1" }),
    );
  });

  it.each([
    { stripeStatus: "won", status: "WON", outcome: "won" },
    { stripeStatus: "lost", status: "LOST", outcome: "lost" },
    { stripeStatus: "warning_closed", status: "CLOSED_OTHER", outcome: "closed with no funds taken" },
  ] as const)("closes as $status: one opened alert, then one closed alert saying $outcome", async ({ stripeStatus, status, outcome }) => {
    matchedCapture();
    const withdrawn = [{ net: -13500 }];
    const back = stripeStatus === "won" ? [{ net: -13500 }, { net: 12000 }] : withdrawn;

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await recordStripeDispute(dispute({ balance_transactions: withdrawn }), event("charge.dispute.funds_withdrawn", MINUTE), CLUB_FORMAT_TEST);
    await recordStripeDispute(
      dispute({ status: stripeStatus, balance_transactions: back }),
      event("charge.dispute.closed", 2 * MINUTE),
      CLUB_FORMAT_TEST,
    );

    expect(stored()).toEqual(
      expect.objectContaining({
        status,
        stripeStatus,
        withdrawnCents: 13500,
        reinstatedCents: stripeStatus === "won" ? 12000 : 0,
        lastEventCreatedAt: new Date((OPENED + 2 * MINUTE) * 1000),
        openedAlertedAt: expect.any(Date),
        closedAlertedAt: expect.any(Date),
      }),
    );
    expect(sentAlerts().map((fields) => [fields.stage, fields.outcome])).toEqual([
      ["opened", "open"],
      ["closed", outcome],
    ]);
    expect(sentAlerts()[1].disputeNextStep).toBe(STRIPE_DISPUTE_NEXT_STEP[status]);
  });

  it("records a dispute whose closed event arrives first as closed, and sends the opened and closed alerts once each", async () => {
    matchedCapture();

    await recordStripeDispute(dispute({ status: "lost", balance_transactions: [{ net: -13500 }] }), event("charge.dispute.closed", 2 * MINUTE), CLUB_FORMAT_TEST);

    expect(stored()).toEqual(
      expect.objectContaining({ status: "LOST", stripeStatus: "lost", withdrawnCents: 13500, stripeCreatedAt: new Date(OPENED * 1000) }),
    );
    // The opened alert reports the dispute as it opened, whatever event raised it.
    expect(sentAlerts().map((fields) => [fields.stage, fields.outcome, fields.disputeNextStep])).toEqual([
      ["opened", "open", STRIPE_DISPUTE_NEXT_STEP.OPEN],
      ["closed", "lost", STRIPE_DISPUTE_NEXT_STEP.LOST],
    ]);

    // The earlier events arrive late: the dispute stays closed and nothing more is sent.
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await recordStripeDispute(dispute({ balance_transactions: [{ net: -13500 }] }), event("charge.dispute.funds_withdrawn", MINUTE), CLUB_FORMAT_TEST);

    expect(stored()).toEqual(expect.objectContaining({ status: "LOST", stripeStatus: "lost", lastEventCreatedAt: new Date((OPENED + 2 * MINUTE) * 1000) }));
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.mergeWrites).not.toHaveBeenCalled();
  });

  it("merges each event under the row's lock", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await recordStripeDispute(dispute({ status: "won" }), event("charge.dispute.closed", MINUTE), CLUB_FORMAT_TEST);

    expect(mocks.lockedIds).toHaveBeenCalledTimes(2);
    expect(mocks.lockedIds).toHaveBeenCalledWith(stored().id);
    expect(mocks.mergeWrites).toHaveBeenCalledTimes(1);
  });

  it("writes and alerts nothing more when the same event is delivered again", async () => {
    matchedCapture();
    const created = event("charge.dispute.created");

    await recordStripeDispute(dispute(), created, CLUB_FORMAT_TEST);
    const first = { ...stored() };
    await recordStripeDispute(dispute(), created, CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(1);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.mergeWrites).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual(first);
  });

  it("finishes the alert on redelivery when the delivery that wrote the row died before sending it", async () => {
    matchedCapture();
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    stored().openedAlertedAt = null;
    state.heldKeys.clear();
    mocks.sendAlert.mockClear();

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(stored().openedAlertedAt).toBeInstanceOf(Date);
  });

  it("after a lease takeover, releases a dead delivery's claim older than the in-flight window and sends once", async () => {
    matchedCapture();
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    // The dead delivery claimed the key and died before stamping the row.
    stored().openedAlertedAt = null;
    const key = stripeDisputeAlertKey("dp_1", "opened");
    state.heldKeys.set(key, new Date(Date.now() - UNRECOGNISED_ALERT_IN_FLIGHT_MS));
    mocks.sendAlert.mockClear();

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(stored().openedAlertedAt).toBeInstanceOf(Date);
    expect(state.heldKeys.has(key)).toBe(true);
    expect(state.rows.size).toBe(1);
  });

  it("sends nothing again for a stage the row says went out, even with its claim gone", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    state.heldKeys.clear();

    await recordStripeDispute(dispute(), event("charge.dispute.created", MINUTE), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(state.heldKeys.size).toBe(0);
  });

  it("reads a sibling's stamp, written after this delivery read the row, as sent rather than taking its old claim over", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    stored().openedAlertedAt = null;
    const key = stripeDisputeAlertKey("dp_1", "opened");
    state.heldKeys.set(key, new Date(Date.now() - UNRECOGNISED_ALERT_IN_FLIGHT_MS));
    state.beforeClaim = () => {
      state.beforeClaim = null;
      stored().openedAlertedAt = new Date();
    };
    mocks.sendAlert.mockClear();

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(state.heldKeys.has(key)).toBe(true);
  });

  it("leaves a claim younger than the in-flight window to its holder, and completes without sending", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    stored().openedAlertedAt = null;
    const key = stripeDisputeAlertKey("dp_1", "opened");
    state.heldKeys.set(key, new Date(Date.now() - UNRECOGNISED_ALERT_IN_FLIGHT_MS + 1));
    mocks.sendAlert.mockClear();

    await expect(recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST)).resolves.toBeUndefined();

    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(state.heldKeys.has(key)).toBe(true);
  });

  it("reads the sent marker as sent when the stamp failed, so a later delivery never sends a second alert", async () => {
    state.stampFailures = 1;
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(stored().openedAlertedAt).toBeNull();
    expect(state.heldKeys.has(stripeDisputeAlertSentKey("dp_1", "opened"))).toBe(true);
    // Past the in-flight window, the held claim would be taken over were it not for the marker.
    state.heldKeys.set(stripeDisputeAlertKey("dp_1", "opened"), new Date(Date.now() - UNRECOGNISED_ALERT_IN_FLIGHT_MS));

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("throws when the opened alert reached nobody, giving its claim back, and the redelivery sends it", async () => {
    mocks.sendAlert.mockResolvedValueOnce("undelivered");

    const failure = recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await expect(failure).rejects.toBeInstanceOf(StripeDisputeAlertNotSentError);
    await expect(failure).rejects.toEqual(expect.objectContaining({ disputeId: "dp_1", stage: "opened" }));
    expect(state.rows.size).toBe(1);
    expect(stored().openedAlertedAt).toBeNull();
    expect(state.heldKeys.size).toBe(0);

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    expect(stored().openedAlertedAt).toBeInstanceOf(Date);
  });

  it("throws when the alert could not be sent at all, and the redelivery retries it", async () => {
    mocks.sendAlert.mockRejectedValueOnce(new Error("mail down"));

    await expect(recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST)).rejects.toBeInstanceOf(
      StripeDisputeAlertNotSentError,
    );
    expect(state.heldKeys.size).toBe(0);

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
  });

  it("treats a send the email retry job holds as sent, stamping the row", async () => {
    mocks.sendAlert.mockResolvedValueOnce("queued-for-retry");

    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(stored().openedAlertedAt).toBeInstanceOf(Date);
    expect(state.heldKeys.has(stripeDisputeAlertKey("dp_1", "opened"))).toBe(true);
  });

  it("throws for the closed alert alone when it reached nobody, and the redelivery sends only that one", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    mocks.sendAlert.mockResolvedValueOnce("undelivered");
    const closed = event("charge.dispute.closed", MINUTE);

    await expect(recordStripeDispute(dispute({ status: "lost" }), closed, CLUB_FORMAT_TEST)).rejects.toEqual(
      expect.objectContaining({ name: "StripeDisputeAlertNotSentError", stage: "closed" }),
    );
    // The record kept the close; only the alert waits for the redelivery.
    expect(stored()).toEqual(expect.objectContaining({ status: "LOST", closedAlertedAt: null }));

    await recordStripeDispute(dispute({ status: "lost" }), closed, CLUB_FORMAT_TEST);

    expect(sentAlerts().map((fields) => fields.stage)).toEqual(["opened", "closed", "closed"]);
    expect(stored().closedAlertedAt).toBeInstanceOf(Date);
  });

  it("claims each dispute's alerts under their own keys, so a second dispute on another charge is never silenced", async () => {
    await recordStripeDispute(dispute(), event("charge.dispute.created"), CLUB_FORMAT_TEST);
    await recordStripeDispute(dispute({ id: "dp_2", charge: "ch_2", payment_intent: "pi_2" }), event("charge.dispute.created"), CLUB_FORMAT_TEST);

    expect(state.rows.size).toBe(2);
    expect(sentAlerts().map((fields) => fields.disputeId)).toEqual(["dp_1", "dp_2"]);
  });
});

describe("what a dispute event says (#4911)", () => {
  const AT = new Date(OPENED * 1000);
  const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);
  const storedRow = (overrides: Partial<ReturnType<typeof mergeDisputeSnapshot>> = {}) => ({
    amountCents: 12000,
    currency: "nzd",
    reason: "fraudulent",
    status: "OPEN" as const,
    stripeStatus: "needs_response",
    withdrawnCents: 0,
    reinstatedCents: 0,
    lastEventCreatedAt: later(1),
    ...overrides,
  });
  const incoming = (overrides: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
    amountCents: 12000,
    currency: "nzd",
    reason: "fraudulent",
    status: "OPEN",
    stripeStatus: "needs_response",
    withdrawnCents: 0,
    reinstatedCents: 0,
    eventCreatedAt: later(2),
    ...overrides,
  });

  it("maps Stripe's statuses, holding anything not closed as open", () => {
    expect(disputeStatusFromStripe("won")).toBe("WON");
    expect(disputeStatusFromStripe("lost")).toBe("LOST");
    expect(disputeStatusFromStripe("warning_closed")).toBe("CLOSED_OTHER");
    expect(disputeStatusFromStripe("prevented")).toBe("CLOSED_OTHER");
    for (const open of ["needs_response", "under_review", "warning_needs_response", "warning_under_review", "something_new"]) {
      expect(disputeStatusFromStripe(open)).toBe("OPEN");
    }
    expect(disputeIsClosed("OPEN")).toBe(false);
    expect(["WON", "LOST", "CLOSED_OTHER"].every((status) => disputeIsClosed(status as "WON"))).toBe(true);
  });

  it("sums the balance movements: what left the club's balance and what came back, fees included", () => {
    expect(disputeBalanceMovements([{ net: -13500 }, { net: 12000 }, { net: -500 }])).toEqual({ withdrawnCents: 14000, reinstatedCents: 12000 });
    expect(disputeBalanceMovements([])).toEqual({ withdrawnCents: 0, reinstatedCents: 0 });
    expect(disputeBalanceMovements(null)).toEqual({ withdrawnCents: 0, reinstatedCents: 0 });
    expect(disputeBalanceMovements(undefined)).toEqual({ withdrawnCents: 0, reinstatedCents: 0 });
  });

  it("never reopens a closed dispute, even on a newer open event", () => {
    const merged = mergeDisputeSnapshot(storedRow({ status: "LOST", stripeStatus: "lost" }), incoming({ eventCreatedAt: later(5), amountCents: 11000 }));
    expect(merged.status).toBe("LOST");
    expect(merged.stripeStatus).toBe("lost");
    // The other fields still follow the newer event.
    expect(merged.amountCents).toBe(11000);
    expect(merged.lastEventCreatedAt).toEqual(later(5));
  });

  it("closes an open dispute on a closing event, however old", () => {
    const merged = mergeDisputeSnapshot(storedRow(), incoming({ status: "WON", stripeStatus: "won", eventCreatedAt: AT, amountCents: 9999 }));
    expect(merged.status).toBe("WON");
    expect(merged.stripeStatus).toBe("won");
    // An older event changes nothing else.
    expect(merged.amountCents).toBe(12000);
    expect(merged.lastEventCreatedAt).toEqual(later(1));
  });

  it("between two closed outcomes the newer event wins, and an older one changes nothing", () => {
    const wonStored = storedRow({ status: "WON", stripeStatus: "won" });
    expect(mergeDisputeSnapshot(wonStored, incoming({ status: "LOST", stripeStatus: "lost", eventCreatedAt: later(3) })).status).toBe("LOST");
    expect(mergeDisputeSnapshot(wonStored, incoming({ status: "LOST", stripeStatus: "lost", eventCreatedAt: AT })).status).toBe("WON");
  });

  it("keeps the stored row on a tie and on a replay", () => {
    const row = storedRow();
    const tie = incoming({ eventCreatedAt: later(1), reason: "duplicate", stripeStatus: "under_review" });
    expect(mergeDisputeSnapshot(row, tie)).toEqual(row);
    const replay = incoming({ eventCreatedAt: later(1) });
    expect(mergeDisputeSnapshot(row, replay)).toEqual(row);
  });

  it("takes a newer event's amount, currency, reason and open status", () => {
    const merged = mergeDisputeSnapshot(
      storedRow(),
      incoming({ amountCents: 11000, currency: "aud", reason: "duplicate", stripeStatus: "under_review", eventCreatedAt: later(4) }),
    );
    expect(merged).toEqual(
      expect.objectContaining({ amountCents: 11000, currency: "aud", reason: "duplicate", status: "OPEN", stripeStatus: "under_review", lastEventCreatedAt: later(4) }),
    );
  });

  it("only grows the balance movements, whichever event is newer", () => {
    const row = storedRow({ withdrawnCents: 13500, reinstatedCents: 12000 });
    expect(mergeDisputeSnapshot(row, incoming({ withdrawnCents: 13500, reinstatedCents: 0, eventCreatedAt: later(9) }))).toEqual(
      expect.objectContaining({ withdrawnCents: 13500, reinstatedCents: 12000 }),
    );
    expect(mergeDisputeSnapshot(storedRow(), incoming({ withdrawnCents: 13500, eventCreatedAt: AT }))).toEqual(
      expect.objectContaining({ withdrawnCents: 13500, reinstatedCents: 0 }),
    );
  });

  it("names each dispute's alert claims and sent markers by stage", () => {
    expect(stripeDisputeAlertKey("dp_1", "opened")).toBe("stripe-dispute-opened:dp_1");
    expect(stripeDisputeAlertKey("dp_1", "closed")).toBe("stripe-dispute-closed:dp_1");
    expect(stripeDisputeAlertSentKey("dp_1", "closed")).toBe("stripe-dispute-closed:dp_1:sent");
  });
});
