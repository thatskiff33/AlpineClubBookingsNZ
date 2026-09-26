import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  paymentTransaction: { count: vi.fn() },
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
    h.paymentTransaction.count.mockResolvedValue(4);
    h.payment.count.mockResolvedValue(2);
    h.paymentRecoveryOperation.count.mockResolvedValue(1);
  });

  it("counts the three populations a currency change catches mid-flight", async () => {
    expect(await countInFlightCardPayments()).toEqual({
      unpaidCardPayments: 4,
      pendingSavedCardCharges: 2,
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
