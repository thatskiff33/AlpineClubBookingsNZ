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
  applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed,
  PartialRefundError,
  planStripeRefundAllocation,
  reconcilePaymentAggregates,
  recordInternetBankingPaymentTransaction,
  RefundAllocationRacedError,
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
    stripePaymentMethodId: "pm_1" as string | null,
    // #3268: a Payment that carries a SetupIntent owns its saved-card column
    // through the SetupIntent writers, not through the ledger (INV-PAY-054).
    stripeSetupIntentId: null as string | null,
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
    reference: null as string | null,
    amountCents: 5000,
    refundedAmountCents: 0,
    status: "SUCCEEDED",
    paymentMethodId: "pm_1" as string | null,
    // #3267: a saved-card charge ATTEMPT row carries its Stripe key here, so
    // the fixture's column has to admit one.
    reason: null as string | null,
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
      // #3032: a FAITHFUL compare-and-set, not an alias for `update`. The row is
      // written only when every field in the `where` still matches, and the
      // caller is told how many rows matched - which is the whole mechanism
      // `applyLocalRefundAllocation` now relies on, so a double that ignored the
      // guard would make its test pass for the wrong reason.
      updateMany: vi.fn(async ({ where, data }: any) => {
        const target = transactions.find((item) => item.id === where.id);
        if (!target) return { count: 0 };
        if (
          where.refundedAmountCents !== undefined &&
          target.refundedAmountCents !== where.refundedAmountCents
        ) {
          return { count: 0 };
        }
        Object.assign(target, data);
        return { count: 1 };
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

describe("multi-transaction refund allocation (#1097)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function twoTransactionStore() {
    const ctx = createRefundStore();
    ctx.payment.amountCents = 8000;
    ctx.transactions.push({
      id: "txn_2",
      paymentId: "payment_1",
      kind: "ADDITIONAL",
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: "pi_2",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      reference: null,
      amountCents: 3000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      paymentMethodId: "pm_1",
      reason: null,
      // Newer than txn_1 so the internal allocation refunds it first.
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    });
    return ctx;
  }

  function stripeRefund(
    id: string,
    amount: number,
    paymentIntent: string,
    charge: string
  ) {
    return {
      id,
      amount,
      currency: "nzd",
      status: "succeeded",
      reason: "requested_by_customer",
      created: 1770000000,
      charge,
      payment_intent: paymentIntent,
    };
  }

  it("recovers a partial-success-then-fail refund to exactly the approved amount across retries", async () => {
    const { store, refunds } = twoTransactionStore();

    // Original attempt: 6000 approved across txn_2 (3000, newest-first) then
    // txn_1 (3000). The first slice succeeds and is recorded; the second
    // fails at Stripe.
    mocks.processRefund
      .mockResolvedValueOnce(stripeRefund("re_slice_a", 3000, "pi_2", "ch_2"))
      .mockRejectedValueOnce(new Error("stripe unavailable"));

    let thrown: unknown;
    try {
      await refundPaymentTransactions({
        paymentId: "payment_1",
        amountCents: 6000,
        idempotencyKeyPrefix: "refund_request_rq1",
        store: store as any,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PartialRefundError);
    expect((thrown as PartialRefundError).completedRefundCents).toBe(3000);
    expect(mocks.processRefund).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "refund_request_rq1_txn_2_3000",
        amountCents: 3000,
      })
    );
    const originalSecondSliceKey =
      mocks.processRefund.mock.calls[1][0].idempotencyKey;
    expect(originalSecondSliceKey).toBe("refund_request_rq1_txn_1_3000");

    // Recovery, enqueued for exactly the 3000 remainder, executes the frozen
    // plan slice — the identical Stripe key the original attempt used.
    mocks.processRefund.mockResolvedValueOnce(
      stripeRefund("re_slice_b", 3000, "pi_1", "ch_1")
    );
    await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 3000,
      allocation: [{ paymentTransactionId: "txn_1", amountCents: 3000 }],
      idempotencyKeyPrefix: "refund_request_rq1",
      store: store as any,
    });
    expect(mocks.processRefund).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        idempotencyKey: originalSecondSliceKey,
        amountCents: 3000,
      })
    );

    // A rerun of the same plan (crash before the operation completed) replays
    // the same key: Stripe answers with the original refund, the ledger
    // dedupes by refund id, and no new money moves.
    mocks.processRefund.mockResolvedValueOnce(
      stripeRefund("re_slice_b", 3000, "pi_1", "ch_1")
    );
    await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 3000,
      allocation: [{ paymentTransactionId: "txn_1", amountCents: 3000 }],
      idempotencyKeyPrefix: "refund_request_rq1",
      store: store as any,
    });

    const totalRecordedCents = [...refunds.values()].reduce(
      (sum, refund) => sum + Number(refund.amountCents),
      0
    );
    expect(totalRecordedCents).toBe(6000);
  });

  it("rejects an allocation slice that references an unknown transaction", async () => {
    const { store } = twoTransactionStore();

    await expect(
      refundPaymentTransactions({
        paymentId: "payment_1",
        amountCents: 100,
        allocation: [{ paymentTransactionId: "txn_missing", amountCents: 100 }],
        store: store as any,
      })
    ).rejects.toThrow(/not a captured Stripe transaction/);
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });
});

describe("planStripeRefundAllocation (#1349)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function twoTransactionStore() {
    const ctx = createRefundStore();
    ctx.payment.amountCents = 8000;
    ctx.transactions.push({
      id: "txn_2",
      paymentId: "payment_1",
      kind: "ADDITIONAL",
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: "pi_2",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      reference: null,
      amountCents: 3000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      paymentMethodId: "pm_1",
      reason: null,
      // Newer than txn_1 so the newest-first allocation slices it first.
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    });
    return ctx;
  }

  function stripeRefund(
    id: string,
    amount: number,
    paymentIntent: string,
    charge: string
  ) {
    return {
      id,
      amount,
      currency: "nzd",
      status: "succeeded",
      reason: "requested_by_customer",
      created: 1770000000,
      charge,
      payment_intent: paymentIntent,
    };
  }

  it("freezes exactly the slices — and therefore the Stripe keys — an inline derive would mint", async () => {
    // Freeze the plan the way the cancellation claim transaction does (#1349).
    const planCtx = twoTransactionStore();
    const { slices, plannedAmountCents, totalRefundableCents } =
      await planStripeRefundAllocation({
        paymentId: "payment_1",
        amountCents: 5000,
        store: planCtx.store as any,
      });

    expect(slices).toEqual([
      { paymentTransactionId: "txn_2", amountCents: 3000 },
      { paymentTransactionId: "txn_1", amountCents: 2000 },
    ]);
    expect(plannedAmountCents).toBe(5000);
    expect(totalRefundableCents).toBe(8000);

    // Inline derive-mode refund on an IDENTICAL payment state...
    const deriveCtx = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce(stripeRefund("re_d1", 3000, "pi_2", "ch_2"))
      .mockResolvedValueOnce(stripeRefund("re_d2", 2000, "pi_1", "ch_1"));
    await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 5000,
      idempotencyKeyPrefix: "booking_cancel_refund_booking_1",
      store: deriveCtx.store as any,
    });
    const deriveKeys = mocks.processRefund.mock.calls.map(
      (call) => call[0].idempotencyKey
    );

    // ...and plan-execution mode (inline cancel or cron replay) on another
    // identical state mint byte-identical Stripe idempotency keys, so either
    // side replays — never repeats — the other's refunds.
    mocks.processRefund.mockClear();
    const executeCtx = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce(stripeRefund("re_p1", 3000, "pi_2", "ch_2"))
      .mockResolvedValueOnce(stripeRefund("re_p2", 2000, "pi_1", "ch_1"));
    await refundPaymentTransactions({
      paymentId: "payment_1",
      amountCents: 5000,
      allocation: slices,
      idempotencyKeyPrefix: "booking_cancel_refund_booking_1",
      store: executeCtx.store as any,
    });
    const planKeys = mocks.processRefund.mock.calls.map(
      (call) => call[0].idempotencyKey
    );

    expect(planKeys).toEqual(deriveKeys);
    expect(planKeys).toEqual([
      "booking_cancel_refund_booking_1_txn_2_3000",
      "booking_cancel_refund_booking_1_txn_1_2000",
    ]);
  });

  it("caps the plan at the ledger-refundable total instead of throwing (mirror drift)", async () => {
    const ctx = twoTransactionStore();

    const { slices, plannedAmountCents, totalRefundableCents } =
      await planStripeRefundAllocation({
        paymentId: "payment_1",
        amountCents: 10000,
        store: ctx.store as any,
      });

    expect(plannedAmountCents).toBe(8000);
    expect(totalRefundableCents).toBe(8000);
    expect(slices).toEqual([
      { paymentTransactionId: "txn_2", amountCents: 3000 },
      { paymentTransactionId: "txn_1", amountCents: 5000 },
    ]);
  });

  it("skips non-captured transactions and already-refunded value", async () => {
    const ctx = twoTransactionStore();
    ctx.transactions[1].status = "FAILED";
    ctx.transactions[0].refundedAmountCents = 1000;

    const { slices, plannedAmountCents } = await planStripeRefundAllocation({
      paymentId: "payment_1",
      amountCents: 5000,
      store: ctx.store as any,
    });

    expect(slices).toEqual([
      { paymentTransactionId: "txn_1", amountCents: 4000 },
    ]);
    expect(plannedAmountCents).toBe(4000);
  });
});

/**
 * #3032: the local allocation is a compare-and-set, because it can now race.
 *
 * `applyLocalRefundAllocation` computes an ABSOLUTE `refundedAmountCents` from a
 * value it read a moment earlier. Every caller before this epic either held the
 * global settlement key `lock(1)` or ran only on a CANCELLED booking, so no two
 * could ever interleave; completing an `EDIT_FINANCIAL_REVIEW` task is neither -
 * it allocates against a LIVE booking and deliberately holds no lock. A lost
 * update there does not just mislay a number: it UNDER-records what has been
 * refunded, which OVERSTATES the refundable headroom and lets a later refund
 * exceed what was ever captured.
 */
describe("#3032 - applyLocalRefundAllocation cannot lose an update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CONTROL: records the allocation and the resulting status when nothing races it", async () => {
    const { store, transaction, payment } = createRefundStore();

    await applyLocalRefundAllocation({
      paymentId: "payment_1",
      amountCents: 2000,
      store: store as never,
    });

    expect(transaction.refundedAmountCents).toBe(2000);
    expect(transaction.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(payment.refundedAmountCents).toBe(2000);
  });

  it("MUTATION: refuses - and keeps the other writer's value - when the row moved under it", async () => {
    const { store, transaction } = createRefundStore();

    // Another writer records a $30 refund on the same transaction between this
    // call's read and its write. Simulated at the write itself so the two are
    // guaranteed to interleave rather than raced for.
    let interfered = false;
    const guardedUpdateMany = store.paymentTransaction.updateMany;
    store.paymentTransaction.updateMany = vi.fn(async (args: any) => {
      if (!interfered) {
        interfered = true;
        transaction.refundedAmountCents = 3000;
      }
      return guardedUpdateMany(args);
    }) as typeof store.paymentTransaction.updateMany;

    await expect(
      applyLocalRefundAllocation({
        paymentId: "payment_1",
        amountCents: 1000,
        store: store as never,
      }),
    ).rejects.toBeInstanceOf(RefundAllocationRacedError);

    // The other writer's $30 survives. An unguarded absolute write would have
    // replaced it with $10 - the whole $30 refund gone from the ledger, and $30
    // of phantom headroom created.
    expect(transaction.refundedAmountCents).toBe(3000);
  });
});

describe("#3268 - reconcilePaymentAggregates and the saved-card column (INV-PAY-054)", () => {
  /*
    The failure this pins: the cron retires an unusable card (nulling the pm on
    every Payment row and ledger row carrying it), the member re-saves a new
    card (the setup_intent.succeeded webhook writes `Payment.stripePaymentMethodId`
    directly), and THEN a late `payment_intent.canceled` for the OLD intent
    reconciles. The latest PRIMARY is still the old, nulled row. A derivation
    that mirrored it would wipe the card the member just saved.

    The rule: a Payment with a `stripeSetupIntentId` never has its card moved by
    the ledger; without one the ledger is followed, but a Stripe row that
    recorded no pm never NULLS a card that is set. Internet Banking still nulls
    it (#1967 depends on the IB switch dropping the card).
  */
  function stampedPaymentMethod(store: ReturnType<typeof createRefundStore>["store"]) {
    const call = store.payment.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }] | undefined;
    expect(call).toBeDefined();
    expect(call![0].data).toHaveProperty("stripePaymentMethodId");
    return call![0].data.stripePaymentMethodId;
  }

  it("(a) Stripe latest PRIMARY with no pm + Payment pm set + SetupIntent set -> unchanged", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.stripePaymentMethodId = "pm_resaved";
    payment.stripeSetupIntentId = "seti_1";
    transaction.paymentMethodId = null;
    transaction.status = "CANCELED";

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedPaymentMethod(store)).toBe("pm_resaved");
  });

  it("(b) Stripe latest PRIMARY with no pm + Payment pm set + NO SetupIntent -> unchanged (a row without a card never nulls one)", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.stripePaymentMethodId = "pm_kept";
    payment.stripeSetupIntentId = null;
    transaction.paymentMethodId = null;

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedPaymentMethod(store)).toBe("pm_kept");
  });

  it("(b') ... and that holds when the Stripe row carries no intent id either (a pre-charge attempt row)", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.stripePaymentMethodId = "pm_kept";
    payment.stripeSetupIntentId = null;
    // No intent anywhere yet: otherwise `ensurePaymentTransactionsBackfilled`
    // would mint a newer legacy Stripe row carrying the Payment's own pm and
    // this would pass for the wrong reason.
    payment.stripePaymentIntentId = null;
    transaction.paymentMethodId = null;
    transaction.stripePaymentIntentId = null;
    transaction.status = "PENDING";

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedPaymentMethod(store)).toBe("pm_kept");
  });

  it("(c) Stripe latest PRIMARY with pm X + Payment pm Y + SetupIntent set -> stays Y (the SetupIntent writers own the column)", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.stripePaymentMethodId = "pm_Y_saved";
    payment.stripeSetupIntentId = "seti_1";
    transaction.paymentMethodId = "pm_X_one_off";

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedPaymentMethod(store)).toBe("pm_Y_saved");
  });

  it("(d) Stripe latest PRIMARY with pm X + Payment pm Y + NO SetupIntent -> X (the ledger is the only witness)", async () => {
    const { store, payment, transaction } = createRefundStore();
    payment.stripePaymentMethodId = "pm_Y";
    payment.stripeSetupIntentId = null;
    transaction.paymentMethodId = "pm_X";

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedPaymentMethod(store)).toBe("pm_X");
  });

  it.each([["with a SetupIntent", "seti_1"], ["without one", null]])(
    "(e) Internet Banking latest PRIMARY -> null %s (#1967: the IB switch drops the card)",
    async (_label, setupIntentId) => {
      const { store, payment, transaction } = createRefundStore();
      // An IB-settled payment: the switch-at-pay flip left no intent pointer,
      // so the backfill has nothing to mint and the IB row IS the latest PRIMARY.
      payment.source = PaymentSource.INTERNET_BANKING;
      payment.stripePaymentIntentId = null;
      payment.stripePaymentMethodId = "pm_old";
      payment.stripeSetupIntentId = setupIntentId;
      transaction.source = PaymentSource.INTERNET_BANKING;
      transaction.stripePaymentIntentId = null;
      transaction.paymentMethodId = null;

      await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

      expect(stampedPaymentMethod(store)).toBeNull();
    },
  );
});

describe("#3267 - reconcilePaymentAggregates and the Payment's intent pointer (INV-PAY-055)", () => {
  /*
    The failure this pins: a saved-card charge ATTEMPT row is a Stripe PRIMARY
    row born without an intent id (and it stays so after a definite failure).
    While it is the latest PRIMARY, any reconcile — the #1992 sweep's
    `payment_intent.canceled` webhook for an older intent, a failed webhook —
    used to derive `Payment.stripePaymentIntentId = null` from it. `/pay` and
    `create-payment-intent` read that pointer to decide whether to mint, and a
    nulled pointer sends them back to the `_initial` key, which Stripe answers
    with the CANCELLED first intent: a dead client secret.

    The rule mirrors #3268's for the card column: a Stripe latest PRIMARY
    without an intent keeps the pointer the Payment already holds; an Internet
    Banking latest PRIMARY still nulls it.
  */
  function stampedIntent(store: ReturnType<typeof createRefundStore>["store"]) {
    const call = store.payment.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }] | undefined;
    expect(call).toBeDefined();
    expect(call![0].data).toHaveProperty("stripePaymentIntentId");
    return call![0].data.stripePaymentIntentId;
  }

  it("a Stripe latest PRIMARY with NO intent id (a pre-charge attempt row) keeps the pointer the Payment holds", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    payment.stripePaymentIntentId = "pi_1";
    // The captured row for pi_1 is older; the attempt row is the latest PRIMARY.
    transactions.push({
      ...transaction,
      id: "txn_attempt",
      stripePaymentIntentId: null,
      reference: "pending_charge_booking_1_txn_attempt",
      status: "PENDING",
      paymentMethodId: "pm_1",
      reason: "pending_hold_auto_charge",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedIntent(store)).toBe("pi_1");
  });

  it("a Stripe latest PRIMARY WITH an intent id still moves the pointer to it", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    payment.stripePaymentIntentId = "pi_1";
    transactions.push({
      ...transaction,
      id: "txn_attempt",
      stripePaymentIntentId: "pi_2",
      status: "PROCESSING",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedIntent(store)).toBe("pi_2");
  });

  it("an Internet Banking latest PRIMARY still nulls it (unchanged)", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    payment.source = PaymentSource.INTERNET_BANKING;
    payment.stripePaymentIntentId = "pi_stale";
    // The abandoned Stripe attempt keeps its own row, so the legacy backfill
    // has nothing to invent — a Payment naming an intent no ledger row knows
    // is what that backfill is FOR, and it would mint a Stripe PRIMARY newer
    // than the IB row and make this test assert the opposite of its name.
    transaction.stripePaymentIntentId = "pi_stale";
    transaction.status = "FAILED";
    transaction.amountCents = 0;
    transactions.push({
      ...transaction,
      id: "txn_ib",
      source: PaymentSource.INTERNET_BANKING,
      stripePaymentIntentId: null,
      paymentMethodId: null,
      status: "SUCCEEDED",
      amountCents: 5000,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedIntent(store)).toBeNull();
  });
});
