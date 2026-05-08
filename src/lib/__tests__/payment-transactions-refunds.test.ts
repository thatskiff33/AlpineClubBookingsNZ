import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processRefund: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
}));

import {
  refundPaymentTransactions,
  syncRefundsFromStripeCharge,
} from "@/lib/payment-transactions";

function createRefundStore() {
  const payment = {
    id: "payment_1",
    bookingId: "booking_1",
    amountCents: 5000,
    refundedAmountCents: 0,
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_1",
    stripePaymentMethodId: "pm_1",
    additionalPaymentIntentId: null,
    additionalPaymentStatus: null,
    additionalAmountCents: 0,
  };
  const transaction = {
    id: "txn_1",
    paymentId: payment.id,
    kind: "PRIMARY",
    stripePaymentIntentId: "pi_1",
    amountCents: 5000,
    refundedAmountCents: 0,
    status: "SUCCEEDED",
    paymentMethodId: "pm_1",
    reason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const refunds = new Map<string, Record<string, unknown>>();

  const store = {
    payment: {
      findUnique: vi.fn(async (args: any) => {
        if (args.where?.stripePaymentIntentId || args.where?.additionalPaymentIntentId) {
          return null;
        }

        if (args.include?.transactions) {
          return {
            ...payment,
            transactions: [{ ...transaction }],
          };
        }

        if (args.select?.refundedAmountCents) {
          return { refundedAmountCents: payment.refundedAmountCents };
        }

        return { ...payment };
      }),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(payment, data);
        return { ...payment };
      }),
    },
    paymentTransaction: {
      create: vi.fn(),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.stripePaymentIntentId === transaction.stripePaymentIntentId) {
          return { ...transaction };
        }

        return null;
      }),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(transaction, data);
        return { ...transaction };
      }),
    },
    paymentRefund: {
      findUnique: vi.fn(async ({ where }: any) => {
        return refunds.get(where.stripeRefundId) ?? null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = refunds.get(where.stripeRefundId);
        const nextRefund = {
          id: existing?.id ?? `payment_refund_${refunds.size + 1}`,
          ...(existing ? update : create),
        };
        refunds.set(where.stripeRefundId, nextRefund);
        return nextRefund;
      }),
      aggregate: vi.fn(async ({ where }: any) => {
        const excludedStatuses = new Set(where.status?.notIn ?? []);
        let amountCents = 0;

        for (const refund of refunds.values()) {
          if (refund.paymentTransactionId !== where.paymentTransactionId) {
            continue;
          }

          if (excludedStatuses.has(refund.status)) {
            continue;
          }

          amountCents += Number(refund.amountCents);
        }

        return { _sum: { amountCents } };
      }),
    },
  };

  return { store, payment, transaction, refunds };
}

describe("payment refund ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a first-class PaymentRefund row for direct Stripe refunds", async () => {
    const { store } = createRefundStore();
    mocks.processRefund.mockResolvedValue({
      id: "re_direct_1",
      amount: 2500,
      currency: "nzd",
      status: "succeeded",
      reason: "requested_by_customer",
      created: 1770000000,
      charge: "ch_1",
      payment_intent: "pi_1",
    });

    const result = await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 2500,
      store: store as any,
    });

    expect(result.refunds).toEqual([
      {
        paymentIntentId: "pi_1",
        refundId: "re_direct_1",
        amountCents: 2500,
      },
    ]);
    expect(store.paymentRefund.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeRefundId: "re_direct_1" },
        create: expect.objectContaining({
          paymentId: "payment_1",
          paymentTransactionId: "txn_1",
          stripeRefundId: "re_direct_1",
          stripeChargeId: "ch_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 2500,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          stripeCreatedAt: new Date("2026-02-02T02:40:00.000Z"),
        }),
      })
    );
  });

  it("upserts charge refund webhook rows by Stripe refund ID", async () => {
    const { store } = createRefundStore();
    const refund = {
      id: "re_webhook_1",
      amount: 2500,
      currency: "nzd",
      status: "succeeded",
      reason: "requested_by_customer",
      created: 1770000000,
      charge: "ch_1",
      payment_intent: "pi_1",
    };

    const firstSync = await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: 2500,
      refunds: [refund],
      store: store as any,
    });
    const secondSync = await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: 2500,
      refunds: [refund],
      store: store as any,
    });

    expect(firstSync).toEqual(
      expect.objectContaining({
        paymentId: "payment_1",
        transactionId: "txn_1",
        refundDeltaCents: 2500,
        createdRefundsCount: 1,
        createdRefundAmountCents: 2500,
        ledgerRefundedAmountCents: 2500,
      })
    );
    expect(secondSync).toEqual(
      expect.objectContaining({
        paymentId: "payment_1",
        transactionId: "txn_1",
        refundDeltaCents: 0,
        createdRefundsCount: 0,
        createdRefundAmountCents: 0,
        ledgerRefundedAmountCents: 2500,
      })
    );
    expect(store.paymentRefund.upsert).toHaveBeenCalledTimes(2);
    expect(store.paymentRefund.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { stripeRefundId: "re_webhook_1" },
        update: expect.objectContaining({
          stripeChargeId: "ch_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 2500,
          currency: "nzd",
          status: "succeeded",
        }),
      })
    );
  });
});
