import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  paymentTransaction: { count: vi.fn() },
  groupBookingSettlement: { count: vi.fn() },
  payment: { count: vi.fn() },
  paymentRecoveryOperation: { count: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: h }));

import { countInFlightCardPayments } from "@/lib/club-format-in-flight";

/**
 * The counts the currency-change confirmation shows (#3567, owner decision
 * D2). Each population is pinned by its query, because a count over the wrong
 * rows reads exactly like a right one on screen.
 */
describe("countInFlightCardPayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.paymentTransaction.count.mockImplementation(async (args: { where: { stripePaymentIntentId: unknown } }) =>
      args.where.stripePaymentIntentId === null ? 3 : 4,
    );
    h.groupBookingSettlement.count.mockResolvedValue(1);
    h.payment.count.mockResolvedValue(2);
    h.paymentRecoveryOperation.count.mockResolvedValue(1);
  });

  it("counts the three populations a currency change catches mid-flight", async () => {
    expect(await countInFlightCardPayments()).toEqual({
      // 4 pending card intents on bookings + 1 pending group-settlement intent.
      unpaidCardPayments: 5,
      pendingSavedCardCharges: 2,
      unansweredSavedCardAttempts: 3,
      openRecoveryRetries: 1,
    });
  });

  it("counts started card intents: Stripe, pending or processing, with an intent and an amount", async () => {
    await countInFlightCardPayments();
    expect(h.paymentTransaction.count).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        status: { in: ["PENDING", "PROCESSING"] },
        stripePaymentIntentId: { not: null },
        amountCents: { gt: 0 },
      },
    });
  });

  it("counts a group settlement's pending card intent as a payment already started", async () => {
    await countInFlightCardPayments();
    expect(h.groupBookingSettlement.count).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: { not: null },
        amountCents: { gt: 0 },
      },
    });
  });

  it("counts saved-card attempts Stripe never answered: pending, no intent, an attempt key", async () => {
    await countInFlightCardPayments();
    expect(h.paymentTransaction.count).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        status: "PENDING",
        stripePaymentIntentId: null,
        reference: { startsWith: "pending_charge_" },
      },
    });
  });

  it("counts saved cards still to be charged on a pending booking", async () => {
    await countInFlightCardPayments();
    expect(h.payment.count).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        status: "PENDING",
        stripePaymentMethodId: { not: null },
        booking: { status: "PENDING" },
      },
    });
  });

  it("counts only claimable recovery retries that create a card charge", async () => {
    await countInFlightCardPayments();
    expect(h.paymentRecoveryOperation.count).toHaveBeenCalledWith({
      where: {
        type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
        status: { not: "SUCCEEDED" },
        attempts: { lt: 5 },
      },
    });
  });

  it("answers null, never zero, when the database cannot be read", async () => {
    h.payment.count.mockRejectedValue(new Error("unreachable"));
    expect(await countInFlightCardPayments()).toBeNull();
  });
});
