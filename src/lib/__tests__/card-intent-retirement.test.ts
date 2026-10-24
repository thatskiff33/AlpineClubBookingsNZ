import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentStatus } from "@prisma/client";

// #3638 — the one home for "is this card intent dead, or harmless to leave?".
// Five doors read it: the Internet Banking switch, both card mint doors (#1765
// refund history), booking cancellation, soft delete and the superseded-intent
// recovery.

const mocks = vi.hoisted(() => ({
  findPaymentTransactionByIntentId: vi.fn(),
  queueSupersededPaymentIntentRefundRecovery: vi.fn(),
}));

vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: mocks.findPaymentTransactionByIntentId,
}));

// #4300: the doors' superseded check (which hands off), real in its own suite.
vi.mock("@/lib/payment-recovery", () => ({
  queueSupersededPaymentIntentRefundRecovery: mocks.queueSupersededPaymentIntentRefundRecovery,
}));

import {
  isCardIntentRetired,
  isPaymentIntentCancelConfirmed,
  isRefundedPaymentIntentHistory,
} from "@/lib/card-intent-retirement";

const intent = (status: string) => ({ id: "pi_1", status }) as never;

beforeEach(() => {
  mocks.findPaymentTransactionByIntentId.mockReset();
  mocks.queueSupersededPaymentIntentRefundRecovery.mockReset().mockResolvedValue(false);
});

describe("isPaymentIntentCancelConfirmed", () => {
  it("is true when this call cancelled the intent or it was already cancelled", () => {
    expect(
      isPaymentIntentCancelConfirmed({ paymentIntent: intent("canceled"), canceled: true }),
    ).toBe(true);
    expect(
      isPaymentIntentCancelConfirmed({ paymentIntent: intent("canceled"), canceled: false }),
    ).toBe(true);
  });

  it("is false for an intent Stripe would not cancel", () => {
    expect(
      isPaymentIntentCancelConfirmed({ paymentIntent: intent("succeeded"), canceled: false }),
    ).toBe(false);
  });
});

describe("isRefundedPaymentIntentHistory (#1765)", () => {
  it("reads the intent's own transaction first", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });
    await expect(
      isRefundedPaymentIntentHistory({
        paymentIntentId: "pi_1",
        // The aggregate is ignored when the row exists.
        paymentStatus: PaymentStatus.SUCCEEDED,
      }),
    ).resolves.toBe(true);
    expect(mocks.findPaymentTransactionByIntentId).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
    });
  });

  it("treats a SUCCEEDED transaction as a live capture, whatever the aggregate says", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      status: PaymentStatus.SUCCEEDED,
    });
    await expect(
      isRefundedPaymentIntentHistory({
        paymentIntentId: "pi_1",
        paymentStatus: PaymentStatus.REFUNDED,
      }),
    ).resolves.toBe(false);
  });

  it("falls back to the payment's aggregate status when no row can be derived", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
    await expect(
      isRefundedPaymentIntentHistory({
        paymentIntentId: "pi_1",
        paymentStatus: PaymentStatus.REFUNDED,
      }),
    ).resolves.toBe(true);
    await expect(
      isRefundedPaymentIntentHistory({
        paymentIntentId: "pi_1",
        paymentStatus: PaymentStatus.PENDING,
      }),
    ).resolves.toBe(false);
  });
});

describe("isCardIntentRetired", () => {
  it("is retired on a confirmed cancel without touching the ledger", async () => {
    await expect(
      isCardIntentRetired({
        result: { paymentIntent: intent("canceled"), canceled: true },
        paymentStatus: PaymentStatus.PENDING,
      }),
    ).resolves.toBe(true);
    expect(mocks.findPaymentTransactionByIntentId).not.toHaveBeenCalled();
  });

  it("is retired for a succeeded intent the ledger shows refunded", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      status: PaymentStatus.REFUNDED,
    });
    await expect(
      isCardIntentRetired({
        result: { paymentIntent: intent("succeeded"), canceled: false },
        paymentStatus: PaymentStatus.REFUNDED,
      }),
    ).resolves.toBe(true);
  });

  it("is live for a succeeded intent with no refund history", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      status: PaymentStatus.SUCCEEDED,
    });
    await expect(
      isCardIntentRetired({
        result: { paymentIntent: intent("succeeded"), canceled: false },
        paymentStatus: PaymentStatus.PENDING,
      }),
    ).resolves.toBe(false);
  });

  it("#4300: is retired for a succeeded capture the superseded machinery owns, through the doors' own check (which hands it off)", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({ status: PaymentStatus.SUCCEEDED, paymentId: "pay-1" });
    mocks.queueSupersededPaymentIntentRefundRecovery.mockResolvedValue(true);
    const paymentIntent = { id: "pi_1", status: "succeeded", amount: 6000, payment_method: "pm_1" } as never;
    await expect(
      isCardIntentRetired({ result: { paymentIntent, canceled: false }, paymentStatus: PaymentStatus.PENDING }),
    ).resolves.toBe(true);
    expect(mocks.queueSupersededPaymentIntentRefundRecovery).toHaveBeenCalledWith(paymentIntent);
  });

  it("never asks the ledger about a status that is neither cancelled nor succeeded", async () => {
    await expect(
      isCardIntentRetired({
        result: { paymentIntent: intent("processing"), canceled: false },
        paymentStatus: PaymentStatus.REFUNDED,
      }),
    ).resolves.toBe(false);
    expect(mocks.findPaymentTransactionByIntentId).not.toHaveBeenCalled();
  });
});
