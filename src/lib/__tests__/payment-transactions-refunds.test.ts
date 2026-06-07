import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource, PaymentStatus } from "@prisma/client";

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
  markPaymentIntentTransactionFailed,
  recordInternetBankingPaymentTransaction,
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
    source: PaymentSource.STRIPE as PaymentSource,
    reference: null,
    stripePaymentIntentId: "pi_1" as string | null,
    stripePaymentMethodId: "pm_1",
    xeroInvoiceId: null as string | null,
    xeroInvoiceNumber: null as string | null,
    additionalPaymentIntentId: null,
    additionalPaymentStatus: null,
    additionalAmountCents: 0,
  };
  const transaction = {
    id: "txn_1",
    paymentId: payment.id,
    kind: "PRIMARY",
    source: PaymentSource.STRIPE as PaymentSource,
    stripePaymentIntentId: "pi_1" as string | null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    reference: null,
    amountCents: 5000,
    refundedAmountCents: 0,
    status: "SUCCEEDED",
    paymentMethodId: "pm_1",
    reason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const transactions = [transaction];
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
            transactions: transactions.map((item) => ({ ...item })),
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
      create: vi.fn(async ({ data }: any) => {
        const nextTransaction = {
          id: data.id ?? `txn_${transactions.length + 1}`,
          paymentId: data.paymentId,
          kind: data.kind,
          source: data.source ?? PaymentSource.STRIPE,
          stripePaymentIntentId: data.stripePaymentIntentId ?? null,
          xeroInvoiceId: data.xeroInvoiceId ?? null,
          xeroInvoiceNumber: data.xeroInvoiceNumber ?? null,
          reference: data.reference ?? null,
          amountCents: data.amountCents,
          refundedAmountCents: data.refundedAmountCents ?? 0,
          status: data.status ?? "PENDING",
          paymentMethodId: data.paymentMethodId ?? null,
          reason: data.reason ?? null,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        };
        transactions.push(nextTransaction);
        return { ...nextTransaction };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const found = transactions.find(
          (item) =>
            (where.id && item.id === where.id) ||
            (where.stripePaymentIntentId &&
              item.stripePaymentIntentId === where.stripePaymentIntentId)
        );

        if (found) {
          return { ...found };
        }

        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const target =
          transactions.find((item) => item.id === where.id) ?? transaction;
        Object.assign(target, data);
        return { ...target };
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

  return { store, payment, transaction, transactions, refunds };
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

  it("does not double-count a direct refund when an idempotent retry replays the same Stripe refund", async () => {
    const { store, transaction, refunds } = createRefundStore();
    transaction.refundedAmountCents = 2500;
    transaction.status = "PARTIALLY_REFUNDED";
    refunds.set("re_direct_1", {
      id: "payment_refund_1",
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
    });
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

    await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 2500,
      idempotencyKeyPrefix: "retry_refund",
      store: store as any,
    });

    expect(store.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: "txn_1" },
      data: expect.objectContaining({
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      }),
    });
    expect(store.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: expect.objectContaining({
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      }),
    });
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

  it("preserves zero-dollar succeeded payments when superseded intents fail later", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.amountCents = 0;
    payment.status = "SUCCEEDED";
    payment.stripePaymentIntentId = null;
    payment.stripePaymentMethodId = null;
    transaction.amountCents = 6000;
    transaction.status = "PROCESSING";
    transaction.reason = "zero_dollar_batch_modification_superseded";

    await markPaymentIntentTransactionFailed({
      paymentIntentId: "pi_1",
      store: store as any,
    });

    expect(store.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: expect.objectContaining({
        amountCents: 0,
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
      }),
    });
  });

  it("records an Internet Banking transaction without Stripe identifiers", async () => {
    const { store, payment, transactions } = createRefundStore();
    transactions.length = 0;
    payment.source = PaymentSource.INTERNET_BANKING;
    payment.stripePaymentIntentId = null;
    payment.stripePaymentMethodId = null;
    payment.amountCents = 0;
    payment.status = "PENDING";
    payment.refundedAmountCents = 0;

    await recordInternetBankingPaymentTransaction({
      paymentId: payment.id,
      amountCents: 12500,
      status: PaymentStatus.PENDING,
      xeroInvoiceId: "inv_123",
      xeroInvoiceNumber: "INV-123",
      reference: "ACB-booking_1",
      reason: "internet_banking_invoice",
      store: store as any,
    });

    expect(store.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: payment.id,
        kind: "PRIMARY",
        source: PaymentSource.INTERNET_BANKING,
        stripePaymentIntentId: null,
        xeroInvoiceId: "inv_123",
        xeroInvoiceNumber: "INV-123",
        reference: "ACB-booking_1",
        amountCents: 12500,
      }),
    });
    expect(store.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: expect.objectContaining({
        source: PaymentSource.INTERNET_BANKING,
        reference: "ACB-booking_1",
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        xeroInvoiceId: "inv_123",
        xeroInvoiceNumber: "INV-123",
      }),
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });

  it("does not send Internet Banking transactions to Stripe refund APIs", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.source = PaymentSource.INTERNET_BANKING;
    payment.stripePaymentIntentId = null;
    payment.stripePaymentMethodId = null;
    transaction.source = PaymentSource.INTERNET_BANKING;
    transaction.stripePaymentIntentId = null;

    await expect(
      refundPaymentTransactions({
        paymentId: payment.id,
        amountCents: 2500,
        store: store as any,
      })
    ).rejects.toThrow("Refund amount exceeds captured Stripe payments");

    expect(mocks.processRefund).not.toHaveBeenCalled();
  });
});
