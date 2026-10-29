import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource, PaymentStatus } from "@prisma/client";
import { isAdditionalAmountUncollected } from "@/lib/additional-payment-chase";

const mocks = vi.hoisted(() => ({
  processRefund: vi.fn(),
  listRefunds: vi.fn(),
  prisma: {} as Record<string, unknown>,
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: mocks.loggerWarn,
    info: vi.fn(),
    error: mocks.loggerError,
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  listRefundsForPaymentIntent: mocks.listRefunds,
}));

// #4104: the failed-later debt and its alert, observed here; their own rules are
// `card-refund-failed-later.test.ts`'s.
const failedLater = vi.hoisted(() => ({
  keep: vi.fn<(...args: unknown[]) => Promise<{ debts: unknown[]; readAsRefused: string[] }>>(async () => ({ debts: [], readAsRefused: [] })),
  alert: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
// #4159 review round 2 (F2): the officers' alert for refund money a charge's total cannot hold, observed here.
const capOverflow = vi.hoisted(() => ({ alert: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true) }));
vi.mock("@/lib/card-refund-cap-overflow", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  alertCardRefundCapOverflow: capOverflow.alert,
}));
vi.mock("@/lib/card-refund-failed-later", () => ({
  keepFailedLaterCardRefundsOwed: failedLater.keep,
  alertFailedLaterCardRefunds: failedLater.alert,
}));

import {
  applyLocalRefundAllocation,
  foldIntoTransactionRefundedAmount,
  markPaymentIntentTransactionFailed,
  PartialRefundError,
  planStripeRefundAllocation,
  reconcilePaymentAggregates,
  recordInternetBankingPaymentTransaction,
  RefundAllocationRacedError,
  refundPaymentTransactions,
  recordStripeRefundsAgainstTransaction,
  syncRefundsFromStripeCharge,
} from "@/lib/payment-transactions";
vi.mock("@/lib/recorded-card-refund-notes", () => ({ queueRecordedCardRefundNotes: vi.fn().mockResolvedValue({ queueOperationId: null }) }));
import { checkCardRefundResend } from "@/lib/card-refund-resend-preflight";
import { refundPlanOrRetryRefusals } from "@/lib/refused-card-refund-retry";
import { predatesRefundLedger } from "@/lib/payment-transaction-status";
import {
  cancelRefundableBaseCents,
  getRemainingRefundableCents,
} from "@/lib/booking-payment-state";
import { calculateRefundAmount } from "@/lib/policies/cancellation";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { refundRequestStripeMetadata } from "@/lib/refund-slice-evidence";
import { createReplayWriter } from "@/test/providers/replay-write";

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
    // #3528: a withdrawn ADDITIONAL row is stamped; the fixture admits it.
    withdrawnAt: null as Date | null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const transactions = [transaction];
  const refunds = new Map<string, Record<string, unknown>>();
  // #3640: when this install's refund ledger writers arrived - the
  // `finished_at` of the migration that shipped them, read from
  // `_prisma_migrations`. A refund Stripe made before it that arrives without a
  // row is pre-ledger history the mirror already counts. `null` models an
  // install whose history has no such row (it never ran pre-ledger code).
  const ledger = {
    startedAt: new Date("2026-01-01T00:00:00.000Z") as Date | null,
    // #3640 D4: a `db push` database has no `_prisma_migrations` table at all.
    historyTablePresent: true,
  };
  // #3640 D2: the account credit this booking issued (MemberCredit
  // dispositions), which the failed-refund floor reads.
  const credit = { dispositionCents: 0 };
  // #4280: the bank cash the payment's "Paid another way" closes recorded,
  // which the failed-refund floor also reads (one reader, grouped by payment).
  const bankClose = { paidAnotherWayCents: 0 };

  const store = {
    // #3640: the one raw read the card-refund writer makes - the ledger
    // writers' migration row. Answered in the physical shape PostgreSQL
    // returns, so the writer's row decoder runs for real.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("to_regclass")) {
        return [{ present: ledger.historyTablePresent }];
      }
      return ledger.startedAt ? [{ finished_at: ledger.startedAt }] : [];
    }),
    // #3640 D1: the Payment row lock every writer takes first.
    $executeRaw: vi.fn(async () => 1),
    memberCredit: {
      aggregate: vi.fn(async () => ({ _sum: { amountCents: credit.dispositionCents } })),
    },
    manualRefundTask: {
      groupBy: vi.fn(async () =>
        bankClose.paidAnotherWayCents > 0 ? [{ paymentId: payment.id, _sum: { amountCents: bankClose.paidAnotherWayCents } }] : [],
      ),
    },
    // #3581: `reconcilePaymentAggregates` now ends by syncing the booking
    // ledger's settlement lines from the same rows, so it reads and writes here.
    bookingLedgerLine: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
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

        // #3581: the booking ledger's settlement sync, which
        // `reconcilePaymentAggregates` now ends in, reads this shape. Answered
        // honestly so the sync RUNS here — a double that returned the bare
        // payment would send it down its error path on every test and prove
        // nothing (review of #3604).
        if (args.select?.refunds && args.select?.transactions) {
          return {
            bookingId: payment.bookingId,
            manuallyMarkedPaidAt: null,
            manuallyMarkedPaidByMemberId: null,
            booking: { lodgeId: "lodge_1" },
            transactions: transactions.map(({ id, source, status, amountCents }) => ({
              id,
              source,
              status,
              amountCents,
            })),
            refunds: [...refunds.values()].map((refund) => ({
              id: refund.id as string,
              status: refund.status as string,
              amountCents: refund.amountCents as number,
            })),
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
          withdrawnAt: data.withdrawnAt ?? null,
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
      // #3640: a FAITHFUL `INSERT ... ON CONFLICT DO NOTHING`. The count is
      // how the writer learns it recorded the refund - the only case the
      // mirror adds - so a double that always said 1 would prove nothing.
      createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const row of data) {
          if (refunds.has(row.stripeRefundId)) {
            if (!skipDuplicates) {
              throw new Error("Unique constraint failed on stripeRefundId");
            }
            continue;
          }
          refunds.set(row.stripeRefundId, {
            id: `payment_refund_${refunds.size + 1}`,
            createdAt: new Date(),
            ...row,
          });
          count += 1;
        }
        return { count };
      }),
      // #3640: the guarded write that decides a counted -> failed/cancelled
      // transition. Faithful to its `where`, so only a row still in a counted
      // status matches.
      updateMany: vi.fn(async ({ where, data }: any) => {
        const existing = refunds.get(where.stripeRefundId);
        if (!existing) return { count: 0 };
        const excluded: string[] = where.status?.notIn ?? [];
        if (excluded.includes(existing.status as string)) return { count: 0 };
        refunds.set(where.stripeRefundId, { ...existing, ...data });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = refunds.get(where.stripeRefundId);
        if (!existing) {
          throw new Error("Record to update not found");
        }
        const nextRefund = { ...existing, ...data };
        refunds.set(where.stripeRefundId, nextRefund);
        return nextRefund;
      }),
      // #4159 round 3 (4): the counted refunds on a charge, which key a cap overflow's alert.
      findMany: vi.fn(async ({ where }: any) =>
        [...refunds.values()].filter(
          (refund) => refund.paymentTransactionId === where.paymentTransactionId && !(where.status?.notIn ?? []).includes(refund.status),
        ),
      ),
      aggregate: vi.fn(async ({ where }: any) => {
        const excludedStatuses = new Set(where.status?.notIn ?? []);
        let amountCents = 0;

        for (const refund of refunds.values()) {
          if (
            where.paymentTransactionId !== undefined &&
            refund.paymentTransactionId !== where.paymentTransactionId
          ) {
            continue;
          }
          if (where.paymentId !== undefined && refund.paymentId !== where.paymentId) {
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

  return { store, payment, transaction, transactions, refunds, ledger, credit, bankClose };
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
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 2500,
      store: store as any,
    });

    expect(result.refunds).toEqual([
      {
        paymentIntentId: "pi_1",
        refundId: "re_direct_1",
        amountCents: 2500,
        // #4070: Stripe's own status, so a caller can tell a refund made from one it refused.
        status: "succeeded",
        // #4083: the slice as sent, so a refused one can be asked for again.
        slice: { paymentTransactionId: "txn_1", amountCents: 2500 },
      },
    ]);
    expect(store.paymentRefund.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
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
        })],
      })
    );
  });

  /*
    #3567 D4: the refund row's currency is Stripe's, always. There is no code
    fallback and no database default any more, so a refund of a charge taken in
    one currency is recorded in that currency whatever the club uses now, and a
    refund with no currency is refused rather than guessed.
  */
  it("records the currency Stripe refunded in, lower-cased, whatever the club's currency", async () => {
    const { store } = createRefundStore();
    // #3640 made the ledger writer private; its one insert is reached through
    // the charge.refunded sync, which every card refund's webhook runs.
    await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: 1200,
      refunds: [{ id: "re_aud_1", amount: 1200, currency: "AUD", status: "succeeded" }],
      store: store as any,
    });
    expect(store.paymentRefund.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ currency: "aud", stripeRefundId: "re_aud_1" })],
      }),
    );
  });

  // #3635: main's assertion that the REFRESH of an already-recorded refund also
  // takes Stripe's currency, restored through the sync (#3640 made the writer
  // private and turned its upsert into insert-or-refresh).
  it("refreshes an already-recorded refund to the currency Stripe refunded in", async () => {
    const { store, transaction, refunds } = createRefundStore();
    transaction.refundedAmountCents = 1200;
    transaction.status = "PARTIALLY_REFUNDED";
    refunds.set("re_aud_1", {
      id: "payment_refund_1",
      paymentId: "payment_1",
      paymentTransactionId: "txn_1",
      stripeRefundId: "re_aud_1",
      stripeChargeId: "ch_1",
      stripePaymentIntentId: "pi_1",
      amountCents: 1200,
      currency: "nzd",
      status: "succeeded",
      reason: null,
      stripeCreatedAt: null,
    });

    await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: 1200,
      refunds: [{ id: "re_aud_1", amount: 1200, currency: "AUD", status: "succeeded" }],
      store: store as any,
    });

    expect(store.paymentRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stripeRefundId: "re_aud_1" }),
        data: expect.objectContaining({ currency: "aud" }),
      }),
    );
    expect(refunds.get("re_aud_1")?.currency).toBe("aud");
  });

  it.each(["", "   "])(
    "refuses to record a refund whose currency is %j, rather than inventing one",
    async (currency) => {
      const { store } = createRefundStore();
      await expect(
        syncRefundsFromStripeCharge({
          paymentIntentId: "pi_1",
          stripeChargeId: "ch_1",
          refundedAmountCents: 1200,
          refunds: [{ id: "re_blank", amount: 1200, currency, status: "succeeded" }],
          store: store as any,
        }),
      ).rejects.toThrow(/carries no currency/);
      expect(store.paymentRefund.createMany).not.toHaveBeenCalled();
    },
  );

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
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 2500,
      idempotencyKeyPrefix: "retry_refund",
      store: store as any,
    });

    // #3640: the replay records nothing new, so it adds nothing - the mirror
    // is written through its compare-and-set and stays at 2500.
    expect(store.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: "txn_1", refundedAmountCents: 2500 },
      data: expect.objectContaining({
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      }),
    });
    expect(transaction.refundedAmountCents).toBe(2500);
    expect(store.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: expect.objectContaining({
        refundedAmountCents: 2500,
        status: "PARTIALLY_REFUNDED",
      }),
    });
  });

  it("upserts charge refund webhook rows by Stripe refund ID", async () => {
    const { store, refunds } = createRefundStore();
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
    // Inserted once; the replay loses the ON CONFLICT race and refreshes the
    // row by its Stripe refund ID instead.
    expect(store.paymentRefund.createMany).toHaveBeenCalledTimes(2);
    expect(refunds.size).toBe(1);
    // Guarded on the row still being counted (#3640 D3): a failed or cancelled
    // row is final and never moved back.
    expect(store.paymentRefund.updateMany).toHaveBeenCalledTimes(1);
    expect(store.paymentRefund.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          stripeRefundId: "re_webhook_1",
          status: { notIn: ["failed", "canceled"] },
        },
        data: expect.objectContaining({
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
        format: CLUB_FORMAT_TEST,
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
      withdrawnAt: null,
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

  it.each([undefined, "slice_evidence"])("carries exact slice-key evidence only on keyed sends (%s)", async (prefix) => {
    const { store } = twoTransactionStore();
    mocks.processRefund.mockImplementation(async (args) => ({
      ...stripeRefund(`re_${args.paymentIntentId}`, args.amountCents, args.paymentIntentId, `ch_${args.paymentIntentId}`), metadata: refundRequestStripeMetadata(args),
    }));
    const metadata = { bookingId: "booking_1", reason: "date_change_price_decrease" };
    await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: 6000, metadata, idempotencyKeyPrefix: prefix, store: store as never });
    expect(mocks.processRefund).toHaveBeenCalledTimes(2);
    for (const [index, transactionId] of ["txn_2", "txn_1"].entries()) {
      const key = prefix ? `${prefix}_${transactionId}_3000` : undefined;
      expect(mocks.processRefund).toHaveBeenNthCalledWith(index + 1, {
        paymentIntentId: index === 0 ? "pi_2" : "pi_1", amountCents: 3000, reason: "requested_by_customer",
        metadata, idempotencyKey: key, stampRefundSliceKey: key !== undefined,
      });
      // The body Stripe receives: the caller's metadata, plus the slice's own key as evidence when keyed.
      expect(refundRequestStripeMetadata(mocks.processRefund.mock.calls[index]![0])).toEqual(key ? { ...metadata, refundSliceKey: key } : metadata);
    }
    expect(metadata).toEqual({ bookingId: "booking_1", reason: "date_change_price_decrease" });
  });

  it("rejects slice evidence beyond Stripe's metadata limit before sending it", async () => {
    const { store } = twoTransactionStore();
    await expect(refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: 1000, idempotencyKeyPrefix: "x".repeat(501), store: store as never })).rejects.toBeInstanceOf(PartialRefundError);
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });

  describe("a key first sent without slice evidence (#4510 review F1, INV-PAY-147)", () => {
    const PREFIX = "booking_cancel_refund_booking_1";
    const KEY = `${PREFIX}_txn_1_3000`;
    const metadata = { bookingId: "booking_1", reason: "cancellation" };
    const allocation = [{ paymentTransactionId: "txn_1", amountCents: 3000 }];

    /** Stripe for 24 hours: a key answers its first body's refund again, and refuses any other body. */
    function stripeRemembersBodies() {
      const made: Array<ReturnType<typeof stripeRefund> & { metadata: Record<string, string> }> = [];
      const write = createReplayWriter(() => Object.assign(
        new Error("Keys for idempotent requests can only be used with the same parameters they were first used with."),
        { type: "StripeIdempotencyError", rawType: "idempotency_error" },
      ));
      const stripe = async (args: Parameters<typeof refundRequestStripeMetadata>[0] & { paymentIntentId: string; amountCents: number; reason?: string }) => {
        const body = refundRequestStripeMetadata(args);
        return write(args.idempotencyKey!, [args.paymentIntentId, args.amountCents, args.reason, body], () => {
          const refund = { ...stripeRefund(`re_made_${made.length + 1}`, args.amountCents, args.paymentIntentId, `ch_${args.paymentIntentId}`), metadata: body };
          made.push(refund);
          return refund;
        });
      };
      mocks.processRefund.mockImplementation(stripe);
      return { made, stripe };
    }

    const send = (store: unknown) => refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: 3000, allocation, metadata, idempotencyKeyPrefix: PREFIX, store: store as never });

    it("a legacy body's key is answered with its original refund once more, and no second refund is made", async () => {
      const { store, refunds } = twoTransactionStore();
      const { made, stripe } = stripeRemembersBodies();
      // Code before the evidence sent this slice's key with the body alone, and recorded nothing.
      await stripe({ paymentIntentId: "pi_1", amountCents: 3000, reason: "requested_by_customer", metadata, idempotencyKey: KEY });
      expect(made).toHaveLength(1);

      const result = await send(store);

      expect(mocks.processRefund).toHaveBeenCalledTimes(2);
      expect(mocks.processRefund.mock.calls.map(([args]) => args.stampRefundSliceKey)).toEqual([true, false]);
      expect(mocks.processRefund.mock.calls.map(([args]) => args.idempotencyKey)).toEqual([KEY, KEY]);
      expect(made).toHaveLength(1);
      expect(result.refunds.map(({ refundId, amountCents }) => ({ refundId, amountCents }))).toEqual([{ refundId: "re_made_1", amountCents: 3000 }]);
      expect([...refunds.values()].map((refund) => refund.stripeRefundId)).toEqual(["re_made_1"]);
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        { paymentId: "payment_1", paymentTransactionId: "txn_1", idempotencyKey: KEY },
        expect.stringContaining("resending the pre-evidence body once"),
      );
    });

    it("a key first sent with a different body still fails, and moves no money", async () => {
      const { store, refunds } = twoTransactionStore();
      const { made, stripe } = stripeRemembersBodies();
      await stripe({ paymentIntentId: "pi_1", amountCents: 3000, reason: "requested_by_customer", metadata: { bookingId: "booking_1", reason: "date_change_price_decrease" }, idempotencyKey: KEY });

      const thrown = await send(store).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(PartialRefundError);
      expect((thrown as PartialRefundError).completedRefundCents).toBe(0);
      expect(((thrown as PartialRefundError).cause as { rawType?: string }).rawType).toBe("idempotency_error");
      expect(mocks.processRefund.mock.calls.map(([args]) => args.stampRefundSliceKey)).toEqual([true, false]);
      expect(made).toHaveLength(1);
      expect(refunds.size).toBe(0);
    });

    it("any other Stripe error is never sent again under the legacy body", async () => {
      const { store, refunds } = twoTransactionStore();
      mocks.processRefund.mockRejectedValueOnce(Object.assign(new Error("Stripe is unavailable"), { type: "StripeAPIError", rawType: "api_error" }));

      await expect(send(store)).rejects.toBeInstanceOf(PartialRefundError);

      expect(mocks.processRefund).toHaveBeenCalledTimes(1);
      expect(refunds.size).toBe(0);
    });
  });

  it("a recording fault followed by replay past key expiry refunds only the unmade slice", async () => {
    const ctx = twoTransactionStore();
    const plan = [{ paymentTransactionId: "txn_1", amountCents: 2000 }, { paymentTransactionId: "txn_2", amountCents: 1000 }];
    const operation = { id: "recovery-test", idempotencyKey: "mod_dates_refund_b1_m1", bookingId: "booking_1", paymentId: "payment_1", paymentIntentId: "pi_1", createdAt: new Date("2026-06-28T00:00:00.000Z"), processingStartedAt: new Date("2026-07-01T00:00:00.000Z"), allocationPlan: plan };
    const row = { ...operation, status: "PROCESSING" };
    const recoveryStore = {
      updateMany: vi.fn(async ({ where, data }) => {
        expect(where).toEqual({ id: row.id, status: row.status, processingStartedAt: row.processingStartedAt, allocationPlan: { equals: row.allocationPlan } });
        Object.assign(row, data);
        return { count: 1 };
      }),
    };
    Object.assign(mocks.prisma, ctx.store, { paymentRecoveryOperation: recoveryStore });
    const made: Array<ReturnType<typeof stripeRefund> & { metadata: Record<string, string> }> = [];
    const remembered = new Map<string, (typeof made)[number]>();
    mocks.processRefund.mockImplementation(async (args) => {
      const previous = remembered.get(args.idempotencyKey);
      if (previous) return previous;
      const refund = { ...stripeRefund(`re_made_${made.length}`, args.amountCents, args.paymentIntentId, `ch_${args.paymentIntentId}`),
        created: new Date("2026-06-29T00:00:00.000Z").getTime() / 1000, metadata: refundRequestStripeMetadata(args) };
      made.push(refund);
      remembered.set(args.idempotencyKey, refund);
      return refund;
    });
    mocks.listRefunds.mockImplementation(async (intent) => made.filter((refund) => refund.payment_intent === intent));
    const send = (allocation: typeof plan) => refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: allocation.reduce((sum, slice) => sum + slice.amountCents, 0), allocation, idempotencyKeyPrefix: operation.idempotencyKey, metadata: { bookingId: "booking_1", reason: "date_change_price_decrease" }, store: ctx.store as never });
    ctx.store.paymentRefund.createMany.mockRejectedValueOnce(new Error("recording failed after Stripe made A"));
    await expect(send(plan)).rejects.toBeInstanceOf(PartialRefundError);
    expect(made).toHaveLength(1);
    expect(ctx.refunds.size).toBe(0);
    // Stripe forgot its keys after 24 hours. Every subsequent send is new money.
    remembered.clear();
    const after = await checkCardRefundResend({ operation, plan, stripeKeyPrefix: operation.idempotencyKey, transactions: ctx.transactions });
    expect(after).toEqual([{ ...plan[0], madeRefundId: "re_made_0" }, plan[1]]);
    await refundPlanOrRetryRefusals({ operation, plan: after, format: CLUB_FORMAT_TEST, refund: send });
    expect(mocks.processRefund).toHaveBeenCalledTimes(2);
    expect(mocks.processRefund.mock.calls[1]![0]).toMatchObject({ paymentIntentId: "pi_2", amountCents: 1000 });
    expect(made.reduce((sum, refund) => sum + refund.amount, 0)).toBe(3000);
    expect([...ctx.refunds.values()].reduce((sum, refund) => sum + Number(refund.amountCents), 0)).toBe(3000);
  });

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
        format: CLUB_FORMAT_TEST,
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
      format: CLUB_FORMAT_TEST,
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
      format: CLUB_FORMAT_TEST,
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

  it("#3924 round 4 (C2): a slice Stripe refunded but that could not be recorded is a partial failure carrying only the slices before it", async () => {
    const { store, refunds } = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce(stripeRefund("re_slice_a", 3000, "pi_2", "ch_2"))
      .mockResolvedValueOnce(stripeRefund("re_slice_b", 3000, "pi_1", "ch_1"));
    const recordingFault = new Error("database connection lost");
    const createMany = store.paymentRefund.createMany as ReturnType<typeof vi.fn>;
    const recordOnce = createMany.getMockImplementation()!;
    createMany.mockImplementationOnce(recordOnce).mockRejectedValueOnce(recordingFault);

    let thrown: unknown;
    try {
      await refundPaymentTransactions({
        format: CLUB_FORMAT_TEST,
        paymentId: "payment_1",
        amountCents: 6000,
        allocation: [
          { paymentTransactionId: "txn_2", amountCents: 3000 },
          { paymentTransactionId: "txn_1", amountCents: 3000 },
        ],
        idempotencyKeyPrefix: "refund_request_rq2",
        store: store as any,
      });
    } catch (error) {
      thrown = error;
    }

    // Not the raw fault: a caller would then re-queue the whole plan.
    expect(thrown).toBeInstanceOf(PartialRefundError);
    const partial = thrown as PartialRefundError;
    expect(partial.cause).toBe(recordingFault);
    // Only the first slice was refunded AND recorded; the second goes to the
    // recovery, which replays its same key and records Stripe's original refund.
    expect(partial.refunds).toEqual([expect.objectContaining({ refundId: "re_slice_a", amountCents: 3000 })]);
    expect(partial.completedRefundCents).toBe(3000);
    expect([...refunds.keys()]).toEqual(["re_slice_a"]);
  });

  // #4083 (`INV-PAY-128`): Stripe can answer a refund `failed` or `canceled`
  // without throwing. Such a slice sent nothing back: it is returned with the
  // slice as sent (so it can be queued and asked for again) and is never
  // counted as completed (so a remainder sized from the partial failure keeps it).
  it("#4083: a refused slice is returned with its slice and never counted as completed", async () => {
    const { store } = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce({ ...stripeRefund("re_refused", 3000, "pi_2", "ch_2"), status: "failed" })
      .mockResolvedValueOnce(stripeRefund("re_made", 3000, "pi_1", "ch_1"));

    const result = await refundPaymentTransactions({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 6000,
      idempotencyKeyPrefix: "mod_dates_refund_b1_m1",
      store: store as any,
    });

    expect(result.refunds).toEqual([
      expect.objectContaining({ refundId: "re_refused", status: "failed", slice: { paymentTransactionId: "txn_2", amountCents: 3000 } }),
      expect.objectContaining({ refundId: "re_made", status: "succeeded", slice: { paymentTransactionId: "txn_1", amountCents: 3000 } }),
    ]);
  });

  it("#4083: a slice refused before a later one throws is owed: completedRefundCents excludes it and refusedSlices names it", async () => {
    const { store } = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce({ ...stripeRefund("re_refused", 3000, "pi_2", "ch_2"), status: "canceled" })
      .mockRejectedValueOnce(new Error("stripe unavailable"));

    const thrown = await refundPaymentTransactions({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 6000,
      idempotencyKeyPrefix: "mod_dates_refund_b1_m1",
      store: store as any,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PartialRefundError);
    expect((thrown as PartialRefundError).completedRefundCents).toBe(0);
    expect((thrown as PartialRefundError).refusedSlices).toEqual([{ paymentTransactionId: "txn_2", amountCents: 3000 }]);
  });

  it("#4083: a slice moved to a fresh key generation is sent under that key; the others keep theirs", async () => {
    const { store } = twoTransactionStore();
    mocks.processRefund
      .mockResolvedValueOnce(stripeRefund("re_retry", 3000, "pi_2", "ch_2"))
      .mockResolvedValueOnce(stripeRefund("re_replayed", 3000, "pi_1", "ch_1"));

    const result = await refundPaymentTransactions({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 6000,
      allocation: [
        { paymentTransactionId: "txn_2", amountCents: 3000, stripeKeySuffix: "refused1" },
        { paymentTransactionId: "txn_1", amountCents: 3000 },
      ],
      idempotencyKeyPrefix: "mod_dates_refund_b1_m1",
      store: store as any,
    });

    expect(mocks.processRefund.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      "mod_dates_refund_b1_m1_txn_2_3000_refused1",
      "mod_dates_refund_b1_m1_txn_1_3000",
    ]);
    expect(result.refunds[0]?.slice).toEqual({ paymentTransactionId: "txn_2", amountCents: 3000, stripeKeySuffix: "refused1" });
  });

  it("rejects an allocation slice that references an unknown transaction", async () => {
    const { store } = twoTransactionStore();

    await expect(
      refundPaymentTransactions({
        format: CLUB_FORMAT_TEST,
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
      withdrawnAt: null,
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
      format: CLUB_FORMAT_TEST,
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
      format: CLUB_FORMAT_TEST,
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

  /**
   * Another writer moves the row between this call's read and its write - in
   * production, a card refund the lockless `charge.refunded` webhook records
   * while a member's cancel settles its credit (#3640). Simulated at the write
   * itself so the two interleave rather than race.
   */
  function interfereOnce(
    ctx: ReturnType<typeof createRefundStore>,
    movedToCents: number,
  ) {
    let interfered = false;
    const guardedUpdateMany = ctx.store.paymentTransaction.updateMany;
    ctx.store.paymentTransaction.updateMany = vi.fn(async (args: any) => {
      if (!interfered) {
        interfered = true;
        ctx.transaction.refundedAmountCents = movedToCents;
      }
      return guardedUpdateMany(args);
    }) as typeof ctx.store.paymentTransaction.updateMany;
  }

  it("absorbs a concurrent move that leaves enough headroom: retries against the fresh total and keeps both", async () => {
    const ctx = createRefundStore();
    interfereOnce(ctx, 3000);

    await applyLocalRefundAllocation({
      paymentId: "payment_1",
      amountCents: 1000,
      store: ctx.store as never,
    });

    // The other writer's $30 survives AND the $10 lands. An unguarded absolute
    // write would have replaced the $30 with $10; the old single-shot guard
    // threw and rolled the member's cancel back with a 500.
    expect(ctx.transaction.refundedAmountCents).toBe(4000);
    expect(ctx.store.paymentTransaction.updateMany).toHaveBeenCalledTimes(2);
  });

  it("refuses loudly only when the concurrent writer used the headroom this allocation needed", async () => {
    const ctx = createRefundStore();
    interfereOnce(ctx, 4500);

    await expect(
      applyLocalRefundAllocation({
        paymentId: "payment_1",
        amountCents: 1000,
        store: ctx.store as never,
      }),
    ).rejects.toBeInstanceOf(RefundAllocationRacedError);
    // Never past what was captured.
    expect(ctx.transaction.refundedAmountCents).toBeLessThanOrEqual(5000);
  });
});

/**
 * #4154 (`INV-PAY-135`, PR #4159 F2/F4): a capacity race's hand-back may land
 * only on the race's own card charge. `onlyTransactionIds` narrows the charges
 * the allocation may use; short there, it refuses as any shortfall does, and
 * never spills onto a charge outside the list, however much that one holds.
 */
describe("#4154 - applyLocalRefundAllocation onlyTransactionIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("MUTATION: a charge outside the list is never used, though it holds the whole amount", async () => {
    const { store, transaction } = createRefundStore();

    await expect(
      applyLocalRefundAllocation({ paymentId: "payment_1", amountCents: 2000, onlyTransactionIds: ["txn_race"], store: store as never }),
    ).rejects.toThrow("Refund amount exceeds captured payments");
    expect(transaction.refundedAmountCents).toBe(0);
  });

  it("a charge on the list takes it", async () => {
    const { store, transaction } = createRefundStore();

    await applyLocalRefundAllocation({ paymentId: "payment_1", amountCents: 2000, onlyTransactionIds: ["txn_1"], store: store as never });
    expect(transaction.refundedAmountCents).toBe(2000);
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

describe("#3528 - reconcilePaymentAggregates reads past a WITHDRAWN ask (INV-ADDPAY-040)", () => {
  /*
    The failure this pins: an officer withdraws an unpaid additional-payment
    request, the withdrawal cancels its intent at Stripe, and the
    payment_intent.canceled webhook then reconciles the payment. A FAILED
    ADDITIONAL row still projects as owed - deliberately, a declined card is
    retried on the same intent - so without the stamp the reconcile would put
    the withdrawn amount straight back on the booking.
  */
  function stampedAdditional(store: ReturnType<typeof createRefundStore>["store"]) {
    const call = store.payment.update.mock.calls.at(-1) as
      | [{ data: Record<string, unknown> }]
      | undefined;
    expect(call).toBeDefined();
    const { additionalAmountCents, additionalPaymentStatus, additionalPaymentIntentId } =
      call![0].data;
    return { additionalAmountCents, additionalPaymentStatus, additionalPaymentIntentId };
  }

  function additionalRow(transaction: ReturnType<typeof createRefundStore>["transaction"]) {
    return {
      ...transaction,
      id: "txn_ask",
      kind: "ADDITIONAL",
      stripePaymentIntentId: "pi_ask",
      amountCents: 2275,
      status: "FAILED",
      reason: "edit_financial_review_charge_mod_1",
      withdrawnAt: null as Date | null,
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    };
  }

  it("CONTROL: a FAILED ask that was NOT withdrawn still projects as owed", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    transactions.push(additionalRow(transaction));

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedAdditional(store)).toEqual({
      additionalAmountCents: 2275,
      additionalPaymentStatus: "FAILED",
      additionalPaymentIntentId: "pi_ask",
    });
  });

  it("a withdrawn ask projects to nothing owed, even when it is the newest row", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    transactions.push({
      ...additionalRow(transaction),
      withdrawnAt: new Date("2026-01-06T00:00:00.000Z"),
    });

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedAdditional(store)).toEqual({
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      additionalPaymentIntentId: null,
    });
  });

  it("an earlier ask that was withdrawn does not shadow a later live one", async () => {
    const { store, payment, transaction, transactions } = createRefundStore();
    transactions.push({
      ...additionalRow(transaction),
      withdrawnAt: new Date("2026-01-06T00:00:00.000Z"),
    });
    transactions.push({
      ...additionalRow(transaction),
      id: "txn_ask_2",
      stripePaymentIntentId: "pi_ask_2",
      amountCents: 1500,
      status: "PENDING",
      createdAt: new Date("2026-01-07T00:00:00.000Z"),
    });

    await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

    expect(stampedAdditional(store)).toEqual({
      additionalAmountCents: 1500,
      additionalPaymentStatus: "PENDING",
      additionalPaymentIntentId: "pi_ask_2",
    });
  });

  /*
    #4320 / #4355: a reversed covering mark-paid. The cash ADDITIONAL row is
    FAILED and NEWER than the card ask the extra goes back to, and the member
    then pays that ask. The reversal stamps its cash row withdrawn (only when a
    live card ask stands), so the rebuild after the capture reads the ask.
  */
  function reversedCashRow(transaction: ReturnType<typeof createRefundStore>["transaction"], withdrawnAt: Date | null) {
    return {
      ...transaction,
      id: "txn_cash",
      kind: "ADDITIONAL",
      source: PaymentSource.INTERNET_BANKING,
      stripePaymentIntentId: null,
      paymentMethodId: null,
      amountCents: 2275,
      status: "FAILED",
      reason: "manual_mark_paid_additional_reversed",
      withdrawnAt,
      createdAt: new Date("2026-01-06T00:00:00.000Z"),
      updatedAt: new Date("2026-01-07T00:00:00.000Z"),
    };
  }

  for (const [label, withdrawnAt, expected] of [
    [
      "CONTROL: unstamped, the reversed cash row hides the paid ask: the extra reads FAILED with no pointer and is chased",
      null,
      { additionalAmountCents: 2275, additionalPaymentStatus: "FAILED", additionalPaymentIntentId: null },
    ],
    [
      "stamped by the reversal, the rebuild reads past it to the paid ask: SUCCEEDED, the pointer on the ask, nothing chased",
      new Date("2026-01-07T00:00:00.000Z"),
      { additionalAmountCents: 2275, additionalPaymentStatus: "SUCCEEDED", additionalPaymentIntentId: "pi_ask" },
    ],
  ] as const) {
    it(label, async () => {
      const { store, payment, transaction, transactions } = createRefundStore();
      transactions.push({ ...additionalRow(transaction), status: "SUCCEEDED" });
      transactions.push(reversedCashRow(transaction, withdrawnAt));

      await reconcilePaymentAggregates({ paymentId: payment.id, store: store as any });

      const projected = stampedAdditional(store);
      expect(projected).toEqual(expected);
      expect(isAdditionalAmountUncollected(projected as { additionalAmountCents: number; additionalPaymentStatus: string | null })).toBe(
        withdrawnAt === null,
      );
    });
  }
});

/*
  #3640 - A CARD REFUND ADDS TO THE REFUNDED TOTAL.

  The mirror counts account-credit settlements (no PaymentRefund row) AND card
  refunds. It used to be set to max(stored, card refunds on record), so a card
  refund made after a credit vanished: $100 credit then $50 card read $100, and
  the member cancelling at 100% was paid $450 against $400 taken. Every card
  writer now goes through `recordStripeRefundsAgainstTransaction`, which adds
  exactly the refund it newly recorded, through a compare-and-set.
*/
describe("#3640 / INV-PAY-103 - a card refund adds to the refunded total", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PAID_CENTS = 40000;
  const CREDIT_CENTS = 10000;
  const CARD_REFUND_CENTS = 5000;

  function paidStore() {
    const ctx = createRefundStore();
    ctx.payment.amountCents = PAID_CENTS;
    ctx.transaction.amountCents = PAID_CENTS;
    return ctx;
  }

  function cardRefund(id: string, amount: number, status = "succeeded") {
    return {
      id,
      amount,
      currency: "nzd",
      status,
      reason: "requested_by_customer",
      created: 1770000000,
      charge: "ch_1",
      payment_intent: "pi_1",
    };
  }

  type Ctx = ReturnType<typeof paidStore>;
  type Refund = ReturnType<typeof cardRefund>;

  // The two writers a card refund reaches the mirror through: an officer's
  // refund made inline, and a refund made in the Stripe dashboard arriving on
  // `charge.refunded` (Stripe's cumulative `amount_refunded` alongside). Each
  // returns the webhook's `refundDeltaCents`, or null where there is none.
  async function inlineRefund(
    ctx: Ctx,
    refund: Refund = cardRefund("re_1", CARD_REFUND_CENTS),
  ): Promise<number | null> {
    mocks.processRefund.mockResolvedValueOnce(refund);
    await refundPaymentTransactions({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: refund.amount,
      idempotencyKeyPrefix: "refund_request_rq1",
      store: ctx.store as never,
    });
    return null;
  }

  async function webhookSync(
    ctx: Ctx,
    refund: Refund = cardRefund("re_1", CARD_REFUND_CENTS),
  ): Promise<number | null> {
    // Stripe lists every refund on the charge, not just the new one.
    const earlier = [...ctx.refunds.values()]
      .filter((row) => row.stripeRefundId !== refund.id)
      .map((row) =>
        cardRefund(
          row.stripeRefundId as string,
          row.amountCents as number,
          row.status as string,
        ),
      );
    const listed = [...earlier, refund];
    const result = await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: listed
        .filter((row) => row.status === "succeeded")
        .reduce((sum, row) => sum + row.amount, 0),
      refunds: listed,
      store: ctx.store as never,
    });
    return result?.refundDeltaCents ?? null;
  }

  async function settleCredit(ctx: Ctx, amountCents = CREDIT_CENTS) {
    await applyLocalRefundAllocation({
      paymentId: "payment_1",
      amountCents,
      store: ctx.store as never,
    });
    // The MemberCredit row the real credit writers mint alongside.
    ctx.credit.dispositionCents += amountCents;
  }

  describe.each([
    ["the inline refund", inlineRefund],
    ["the charge.refunded webhook sync", webhookSync],
  ] as const)("through %s", (_name, writeCardRefund) => {
    it("credit then card refund adds up: $100 + $50 = $150", async () => {
      const ctx = paidStore();

      await settleCredit(ctx);
      const delta = await writeCardRefund(ctx);

      expect(ctx.transaction.refundedAmountCents).toBe(15000);
      expect(ctx.payment.refundedAmountCents).toBe(15000);
      expect(ctx.transaction.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      // The webhook's delta is the real one, so the Xero credit note is
      // queued at once instead of waiting for the daily reconciliation.
      if (delta !== null) expect(delta).toBe(CARD_REFUND_CENTS);
    });

    it("card refund then credit stays correct: $50 + $100 = $150", async () => {
      const ctx = paidStore();

      await writeCardRefund(ctx);
      await settleCredit(ctx);

      expect(ctx.transaction.refundedAmountCents).toBe(15000);
      expect(ctx.payment.refundedAmountCents).toBe(15000);
    });

    it("a replayed refund event changes nothing", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await writeCardRefund(ctx);

      const replayDelta = await writeCardRefund(ctx);

      expect(ctx.refunds.size).toBe(1);
      expect(ctx.transaction.refundedAmountCents).toBe(15000);
      expect(ctx.payment.refundedAmountCents).toBe(15000);
      if (replayDelta !== null) expect(replayDelta).toBe(0);
    });

    it("a refund Stripe reports as failed adds nothing", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);

      await writeCardRefund(
        ctx,
        cardRefund("re_failed", CARD_REFUND_CENTS, "failed"),
      );

      expect(ctx.refunds.size).toBe(1);
      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);
    });

    // The worked scenario from the issue: $400 paid -> a $100 guest removal
    // taken as account credit (price now $300) -> a $50 card refund -> the
    // member cancels in a 100% tier. The cancel's base is
    // min(amount - refunded, price) (`booking-cancel.ts`, the paid path) and
    // the refund-request cap is `getRemainingRefundableCents`.
    it("the $400 -> $100 credit -> $50 refund -> 100%-tier cancel pays out $400 in all, never $450", async () => {
      const ctx = paidStore();
      const finalPriceCents = PAID_CENTS - CREDIT_CENTS;
      await settleCredit(ctx);
      await writeCardRefund(ctx);

      const remainingCents = getRemainingRefundableCents(ctx.payment);
      // The cancel's own base derivation, not a copy of it (review of #3640):
      // the executed cancel and its preview both call this.
      const cancelBase = (changeFeeCents: number) =>
        cancelRefundableBaseCents({
          amountCents: ctx.payment.amountCents,
          refundedAmountCents: ctx.payment.refundedAmountCents,
          openNonCancellationHandBackCents: 0,
          finalPriceCents,
          changeFeeCents,
        });
      const tier100 = [{ daysBeforeStay: 0, refundPercentage: 100 }];
      const { refundAmountCents: cancelRefundCents } = calculateRefundAmount(
        cancelBase(0),
        30,
        tier100,
      );

      expect(remainingCents).toBe(25000);
      expect(cancelRefundCents).toBe(25000);
      expect(CREDIT_CENTS + CARD_REFUND_CENTS + cancelRefundCents).toBe(
        PAID_CENTS,
      );
      // With a $20 change fee from an earlier edit, the fee stays with the club
      // and the member still never gets back more than they paid.
      const withFee = calculateRefundAmount(cancelBase(2000), 30, tier100);
      expect(withFee.refundAmountCents).toBe(23000);
      expect(CREDIT_CENTS + CARD_REFUND_CENTS + withFee.refundAmountCents).toBe(
        PAID_CENTS - 2000,
      );

      // And the ledger itself refuses the old over-payment: the $300 the
      // cancel used to pay is more than the card still holds for the member.
      const plan = await planStripeRefundAllocation({
        paymentId: "payment_1",
        amountCents: 30000,
        store: ctx.store as never,
      });
      expect(plan.plannedAmountCents).toBe(25000);
      await expect(
        refundPaymentTransactions({
          format: CLUB_FORMAT_TEST,
          paymentId: "payment_1",
          amountCents: 30000,
          store: ctx.store as never,
        }),
      ).rejects.toThrow(/exceeds captured Stripe payments/);
    });
  });

  it("the inline refund and then its own webhook add the refund once", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);
    const refund = cardRefund("re_1", CARD_REFUND_CENTS);

    await inlineRefund(ctx, refund);
    const webhookDelta = await webhookSync(ctx, refund);

    expect(ctx.transaction.refundedAmountCents).toBe(15000);
    // Recorded inline, which queues its own note: the webhook queues nothing.
    expect(webhookDelta).toBe(0);
  });

  it("two writers recording the same refund at the same moment add it once", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);
    const refund = cardRefund("re_1", CARD_REFUND_CENTS);

    await Promise.all([inlineRefund(ctx, refund), webhookSync(ctx, refund)]);

    expect(ctx.refunds.size).toBe(1);
    expect(ctx.transaction.refundedAmountCents).toBe(15000);
  });

  it("an increment cannot be lost to a writer that moves the row between its read and its write", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);

    // A concurrent $20 credit allocation commits between the card writer's
    // read and its compare-and-set. Forced at the write itself, as #3032's
    // test does, so the interleaving is guaranteed rather than raced for.
    let interfered = false;
    const guardedUpdateMany = ctx.store.paymentTransaction.updateMany;
    ctx.store.paymentTransaction.updateMany = vi.fn(async (args: any) => {
      if (!interfered) {
        interfered = true;
        ctx.transaction.refundedAmountCents += 2000;
      }
      return guardedUpdateMany(args);
    }) as typeof ctx.store.paymentTransaction.updateMany;

    await webhookSync(ctx);

    // $100 credit + $20 credit + $50 card. A stale absolute write would have
    // said $150 and handed the $20 back as phantom headroom.
    expect(ctx.transaction.refundedAmountCents).toBe(17000);
    expect(ctx.store.paymentTransaction.updateMany).toHaveBeenCalledTimes(2);
  });

  it("records the refund rows and the mirror in one transaction when given the root client", async () => {
    const ctx = paidStore();
    // The transaction client: the same models, without the root client's
    // `$connect` - so the reconcile inside joins this transaction (#4217).
    const txClient = { ...ctx.store };
    const transactionSpy = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
    );
    const rootClient = Object.assign(ctx.store, {
      $connect: vi.fn(),
      $transaction: transactionSpy,
    });

    await syncRefundsFromStripeCharge({
      paymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      refundedAmountCents: CARD_REFUND_CENTS,
      refunds: [cardRefund("re_1", CARD_REFUND_CENTS)],
      store: rootClient as never,
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const [txOrder] = transactionSpy.mock.invocationCallOrder;
    const [insertOrder] =
      ctx.store.paymentRefund.createMany.mock.invocationCallOrder;
    const [casOrder] =
      ctx.store.paymentTransaction.updateMany.mock.invocationCallOrder;
    expect(txOrder).toBeLessThan(insertOrder);
    expect(txOrder).toBeLessThan(casOrder);
    expect(ctx.transaction.refundedAmountCents).toBe(CARD_REFUND_CENTS);
  });

  // A refund made before this install's refund ledger existed has no row, and
  // the old max-based total already counted it (from Stripe's amount_refunded).
  // The first sync that lists it inserts its row for the first time: that must
  // not add it again.
  // #4154 review (M1): the charge caps the total, so cents above it are refund money the total cannot hold - logged, never silent.
  describe("a refund the charge's total cannot hold is logged as an error", () => {
    it("MUTATION: credit for the whole charge, then a card refund on top: capped at the charge, the discarded cents named", async () => {
      const ctx = paidStore();
      await settleCredit(ctx, PAID_CENTS);
      await webhookSync(ctx);
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ paymentTransactionId: ctx.transaction.id, discardedCents: CARD_REFUND_CENTS }),
        expect.stringContaining("#4154"),
      );
    });

    it("CONTROL: a refund within the charge logs no error", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await webhookSync(ctx);
      expect(mocks.loggerError).not.toHaveBeenCalled();
      expect(capOverflow.alert).not.toHaveBeenCalled();
    });

    // #4159 review round 2 (F2): logged is not enough - the officers are told, after the commit, never inside it.
    const record = (store: unknown) =>
      recordStripeRefundsAgainstTransaction({ paymentId: "payment_1", paymentTransactionId: "txn_1", refunds: [cardRefund("re_over", CARD_REFUND_CENTS)], store: store as never });

    it("MUTATION: on its own commit, the discarded cents reach the officers' alert - after the transaction - and are returned", async () => {
      const ctx = paidStore();
      await settleCredit(ctx, PAID_CENTS);
      let committed = false;
      const root = { ...ctx.store, $connect: () => undefined, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { const out = await fn(ctx.store); committed = true; return out; } };
      capOverflow.alert.mockImplementationOnce(async () => { expect(committed).toBe(true); return true; });
      const result = await record(root);
      const overflow = { paymentId: "payment_1", paymentTransactionId: "txn_1", discardedCents: CARD_REFUND_CENTS, recordedRefundCents: CARD_REFUND_CENTS, countedRefundIds: ["re_over"] };
      expect(result.capOverflow).toEqual(overflow);
      expect(capOverflow.alert).toHaveBeenCalledWith(overflow);
    });

    it("MUTATION (round 3, 6): the charge.refunded sync passes the discarded cents on to its caller", async () => {
      const ctx = paidStore();
      await settleCredit(ctx, PAID_CENTS);
      const synced = await syncRefundsFromStripeCharge({
        paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: CARD_REFUND_CENTS, refunds: [cardRefund("re_over", CARD_REFUND_CENTS)], store: ctx.store as never,
      });
      expect(synced?.capOverflow).toMatchObject({ paymentTransactionId: "txn_1", discardedCents: CARD_REFUND_CENTS, countedRefundIds: ["re_over"] });
    });

    it("CONTROL (round 3, 6): an inline card refund within the charge passes on no overflow", async () => {
      const ctx = paidStore();
      mocks.processRefund.mockResolvedValueOnce(cardRefund("re_1", CARD_REFUND_CENTS));
      const result = await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: CARD_REFUND_CENTS, idempotencyKeyPrefix: "refund_request_rq1", store: ctx.store as never });
      expect(result.capOverflows).toEqual([]);
    });

    it("joined to a caller's transaction, it alerts nothing itself and returns the discarded cents for the caller", async () => {
      const ctx = paidStore();
      await settleCredit(ctx, PAID_CENTS);
      const result = await record(ctx.store);
      expect(result.capOverflow).toMatchObject({ discardedCents: CARD_REFUND_CENTS });
      expect(capOverflow.alert).not.toHaveBeenCalled();
    });
  });

  describe("a refund older than the refund ledger", () => {
    const PRE_LEDGER_CENTS = 3000;
    const preLedgerRefund = {
      ...cardRefund("re_pre_ledger", PRE_LEDGER_CENTS),
      created: Date.parse("2026-03-01T00:00:00.000Z") / 1000,
    };

    // Made after the ledger started, so the mirror has not counted it.
    const freshRefund = (id: string) => ({
      ...cardRefund(id, CARD_REFUND_CENTS),
      created: Date.parse("2026-09-20T00:00:00.000Z") / 1000,
    });

    function legacyStore() {
      const ctx = paidStore();
      ctx.ledger.startedAt = new Date("2026-05-10T00:00:00.000Z");
      // What the old code left: the refund in the mirror, no row.
      ctx.transaction.refundedAmountCents = PRE_LEDGER_CENTS;
      ctx.transaction.status = "PARTIALLY_REFUNDED";
      ctx.payment.refundedAmountCents = PRE_LEDGER_CENTS;
      return ctx;
    }

    async function syncListing(ctx: Ctx, listed: Refund[]) {
      const result = await syncRefundsFromStripeCharge({
        paymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        refundedAmountCents: listed.reduce((sum, row) => sum + row.amount, 0),
        refunds: listed,
        store: ctx.store as never,
      });
      return result?.refundDeltaCents ?? null;
    }

    it("a new refund raises the total by the new refund only", async () => {
      const ctx = legacyStore();

      const delta = await syncListing(ctx, [
        preLedgerRefund,
        freshRefund("re_new"),
      ]);

      expect(ctx.refunds.size).toBe(2);
      expect(ctx.transaction.refundedAmountCents).toBe(
        PRE_LEDGER_CENTS + CARD_REFUND_CENTS,
      );
      expect(delta).toBe(CARD_REFUND_CENTS);
    });

    it("... and so does the inline refund followed by its webhook, which backfills the old row", async () => {
      const ctx = legacyStore();
      const fresh = freshRefund("re_new");

      await inlineRefund(ctx, fresh);
      const delta = await syncListing(ctx, [preLedgerRefund, fresh]);

      expect(ctx.transaction.refundedAmountCents).toBe(
        PRE_LEDGER_CENTS + CARD_REFUND_CENTS,
      );
      expect(delta).toBe(0);
    });

    it("... with a credit on top, which is the case a floor alone cannot tell apart", async () => {
      const ctx = legacyStore();
      await settleCredit(ctx);

      await syncListing(ctx, [preLedgerRefund, freshRefund("re_new")]);

      expect(ctx.transaction.refundedAmountCents).toBe(
        PRE_LEDGER_CENTS + CREDIT_CENTS + CARD_REFUND_CENTS,
      );
    });

    it("upgrade straight from pre-ledger code: a refund made the day before the migration is not counted again", async () => {
      const ctx = legacyStore();
      await settleCredit(ctx);

      await syncListing(ctx, [
        { ...preLedgerRefund, created: Date.parse("2026-05-09T23:59:59.000Z") / 1000 },
        freshRefund("re_new"),
      ]);

      expect(ctx.transaction.refundedAmountCents).toBe(
        PRE_LEDGER_CENTS + CREDIT_CENTS + CARD_REFUND_CENTS,
      );
    });

    it("compares in whole seconds: a refund in the same second the migration finished is counted", async () => {
      const ctx = legacyStore();
      ctx.ledger.startedAt = new Date("2026-05-10T00:00:00.700Z");
      await settleCredit(ctx);

      await syncListing(ctx, [
        preLedgerRefund,
        { ...freshRefund("re_new"), created: Date.parse("2026-05-10T00:00:00.000Z") / 1000 },
      ]);

      expect(ctx.transaction.refundedAmountCents).toBe(
        PRE_LEDGER_CENTS + CREDIT_CENTS + CARD_REFUND_CENTS,
      );
    });

    it("with no ledger-writers migration in the history, nothing is pre-ledger", async () => {
      const ctx = paidStore();
      ctx.ledger.startedAt = null;
      await settleCredit(ctx);

      await syncListing(ctx, [preLedgerRefund]);

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + PRE_LEDGER_CENTS);
    });
  });

  // A fresh install: the ledger writers' migration finished at install time,
  // so no refund the install ever saw is pre-ledger - whatever the ledger's
  // own rows say. Each case is one the old data-guessed start got wrong
  // (review of #3640, correctness F1), with a credit on the transaction so the
  // floor cannot hide a skipped refund.
  describe("a fresh install counts every refund it sees", () => {
    const INSTALLED = new Date("2026-06-01T10:00:00.000Z");
    const at = (iso: string) => Date.parse(iso) / 1000;

    function freshInstall() {
      const ctx = paidStore();
      ctx.ledger.startedAt = INSTALLED;
      return ctx;
    }

    it("the first-ever refund's second slice, made in the same second as the first row, counts", async () => {
      const ctx = freshInstall();
      await settleCredit(ctx);
      // Two slices of one refund reach Stripe a fraction of a second apart and
      // both carry the same whole-second `created`; the first writes the
      // install's first ledger row. The old start - that row's createdAt, in
      // milliseconds - made the second slice look older than the ledger.
      const sameSecond = at("2026-06-02T09:00:00.000Z");

      await inlineRefund(ctx, { ...cardRefund("re_slice_1", 3000), created: sameSecond });
      await inlineRefund(ctx, { ...cardRefund("re_slice_2", 2000), created: sameSecond });

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + 3000 + 2000);
    });

    it("a dashboard refund made before the first app refund, delivered after it, counts", async () => {
      const ctx = freshInstall();
      await settleCredit(ctx);
      // The app's first refund row, written first.
      await inlineRefund(ctx, { ...cardRefund("re_app", 2000), created: at("2026-06-03T12:00:00.000Z") });

      await webhookSync(ctx, { ...cardRefund("re_dashboard", 3000), created: at("2026-06-03T11:59:00.000Z") });

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + 2000 + 3000);
    });

    it("an empty ledger and a webhook delivered weeks late still counts the refund", async () => {
      const ctx = freshInstall();
      await settleCredit(ctx);

      await webhookSync(ctx, { ...cardRefund("re_late", CARD_REFUND_CENTS), created: at("2026-06-02T00:00:00.000Z") });

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + CARD_REFUND_CENTS);
    });
  });

  describe("#1491's fold is an increment, not a stale absolute write", () => {
    it("attributes folded history up to the row's headroom and says how much it placed", async () => {
      const ctx = paidStore();
      ctx.transaction.refundedAmountCents = 38000;

      const placed = await foldIntoTransactionRefundedAmount({
        paymentTransactionId: "txn_1",
        amountCents: 5000,
        store: ctx.store as never,
      });

      expect(placed).toBe(2000);
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);
      // The fold never touched status, and still does not.
      expect(ctx.transaction.status).toBe("SUCCEEDED");
    });

    it("keeps a card refund the lockless webhook commits between the fold's read and its write", async () => {
      const ctx = paidStore();
      let interfered = false;
      const guardedUpdateMany = ctx.store.paymentTransaction.updateMany;
      ctx.store.paymentTransaction.updateMany = vi.fn(async (args: any) => {
        if (!interfered) {
          interfered = true;
          ctx.transaction.refundedAmountCents += CARD_REFUND_CENTS;
        }
        return guardedUpdateMany(args);
      }) as typeof ctx.store.paymentTransaction.updateMany;

      const placed = await foldIntoTransactionRefundedAmount({
        paymentTransactionId: "txn_1",
        amountCents: 3000,
        store: ctx.store as never,
      });

      // The old `row.refundedAmountCents + bump` write said 3000 and erased the
      // webhook's 5000.
      expect(placed).toBe(3000);
      expect(ctx.transaction.refundedAmountCents).toBe(CARD_REFUND_CENTS + 3000);
      expect(ctx.store.paymentTransaction.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * A root client whose `$transaction` really rolls back: the store's rows are
   * snapshotted when the callback starts and restored if it throws, so a test
   * can crash a writer part-way and see what a retry finds.
   */
  function asRootClientWithRollback(ctx: Ctx) {
    const transactionSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const rows = ctx.transactions.map((row) => ({ ...row }));
      const refundRows = new Map(
        [...ctx.refunds].map(([key, row]) => [key, { ...row }] as const),
      );
      const paymentRow = { ...ctx.payment };
      try {
        return await fn(ctx.store);
      } catch (error) {
        rows.forEach((row, index) => Object.assign(ctx.transactions[index], row));
        ctx.refunds.clear();
        refundRows.forEach((row, key) => ctx.refunds.set(key, row));
        Object.assign(ctx.payment, paymentRow);
        throw error;
      }
    });
    return {
      transactionSpy,
      client: Object.assign(ctx.store, { $connect: vi.fn(), $transaction: transactionSpy }),
    };
  }

  describe("a refund that later fails or is cancelled is taken back out", () => {
    it("subtracts it once, through the same writer, when a sync sees it fail", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await webhookSync(ctx);
      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + CARD_REFUND_CENTS);

      const failed = await webhookSync(ctx, cardRefund("re_1", CARD_REFUND_CENTS, "failed"));
      // Replayed: the transition is already recorded, so nothing more comes off.
      await webhookSync(ctx, cardRefund("re_1", CARD_REFUND_CENTS, "failed"));

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);
      // Not a refund: no Xero note is queued for a negative move.
      expect(failed).toBe(0);
    });

    it("a failed refund replaced by a new one counts once, not twice", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await webhookSync(ctx);

      // R1 failed; the officer refunded the same amount again (R2). Stripe
      // lists both on the next event.
      await syncRefundsFromStripeCharge({
        paymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        refundedAmountCents: CARD_REFUND_CENTS,
        refunds: [
          cardRefund("re_1", CARD_REFUND_CENTS, "failed"),
          cardRefund("re_2", CARD_REFUND_CENTS),
        ],
        store: ctx.store as never,
      });

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + CARD_REFUND_CENTS);
    });
  });

  describe("a failed refund's subtraction has a floor (#3640 delta review, D2)", () => {
    it("a refund the OLD arithmetic never added, failing now, leaves the credit in the total", async () => {
      // $400 paid, $100 credit (mirror $100), then a $50 card refund recorded by
      // the old max rule: row written, mirror left at max(100, 50) = 100.
      const ctx = paidStore();
      await settleCredit(ctx);
      ctx.refunds.set("re_old", {
        id: "payment_refund_old",
        paymentId: "payment_1",
        paymentTransactionId: "txn_1",
        stripeRefundId: "re_old",
        amountCents: CARD_REFUND_CENTS,
        status: "succeeded",
      });
      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);

      const delta = await webhookSync(ctx, cardRefund("re_old", CARD_REFUND_CENTS, "failed"));

      // Unfloored it would read $50 and offer $50 of headroom that is not there.
      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);
      expect(delta).toBe(0);
    });

    // #4280 (owner, 22 and 26 Oct 2026): a "Paid another way" close's bank cash
    // is part of the floor; a late card refund the cap kept out, failing, takes
    // none of it. The real-PostgreSQL proof drives the real writers:
    // `card-refund-reversal-bank-cash-floor.realdb.test.ts`.
    async function closePaidAnotherWay(ctx: Ctx, amountCents: number) {
      await applyLocalRefundAllocation({ paymentId: "payment_1", amountCents, store: ctx.store as never });
      // The completed close record the real close writes alongside.
      ctx.bankClose.paidAnotherWayCents += amountCents;
    }

    it("#4280: a late card refund the cap kept out, failing, leaves the close's bank cash in the total", async () => {
      const ctx = paidStore();
      await closePaidAnotherWay(ctx, PAID_CENTS);
      // The lost refund, recorded late: the cap keeps it out of the total.
      await webhookSync(ctx, cardRefund("re_late", PAID_CENTS, "pending"));
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);

      const delta = await webhookSync(ctx, cardRefund("re_late", PAID_CENTS, "failed"));

      // Unfloored it read $0, and offered the bank refund's $400 again.
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);
      expect(ctx.payment.refundedAmountCents).toBe(PAID_CENTS);
      expect(delta).toBe(0);
      expect(ctx.store.manualRefundTask.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ paymentId: "payment_1", occurrenceKey: { startsWith: "card-refund-paid-another-way:" }, status: "COMPLETED" }) }),
      );
    });

    it("#4280: a part close keeps only what it paid, and credit beside it adds", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await closePaidAnotherWay(ctx, 12000);
      await webhookSync(ctx, cardRefund("re_late", PAID_CENTS, "pending"));
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);

      await webhookSync(ctx, cardRefund("re_late", PAID_CENTS, "failed"));

      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + 12000);
    });

    it("#4280: the cap binds - credit, a counted card refund and the close's cash above the capture hold the total at the capture", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await closePaidAnotherWay(ctx, PAID_CENTS - CREDIT_CENTS);
      // A dashboard refund that succeeded on the full charge (the member paid twice), and the lost one recorded late.
      await webhookSync(ctx, cardRefund("re_extra", CARD_REFUND_CENTS));
      await webhookSync(ctx, cardRefund("re_late", PAID_CENTS - CREDIT_CENTS, "pending"));
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);

      await webhookSync(ctx, cardRefund("re_late", PAID_CENTS - CREDIT_CENTS, "failed"));

      // $50 + $100 + $300 = $450, capped at the $400 captured. The writer never reads above its own
      // charge either way (the floor only bounds a subtraction), so the cap shows in the audit's
      // expected figure (`refunded-total-shortfall-audit.test.ts`), which this floor shares.
      expect(ctx.transaction.refundedAmountCents).toBe(PAID_CENTS);
      expect(ctx.payment.refundedAmountCents).toBe(PAID_CENTS);
    });

    it("the floor never RAISES a total - it only bounds the subtraction", async () => {
      const ctx = paidStore();
      await settleCredit(ctx);
      await webhookSync(ctx);
      // Something outside the writer left the mirror below the floor.
      ctx.transaction.refundedAmountCents = 12000;

      await webhookSync(ctx, cardRefund("re_1", CARD_REFUND_CENTS, "failed"));

      // 12000 - 5000 = 7000, floored at min(12000, credit 10000) = 10000.
      expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);
    });
  });

  it("a replayed stale 'succeeded' never resurrects a failed row, so its failure is subtracted once (#3640 delta review, D3)", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);
    const refund = cardRefund("re_1", CARD_REFUND_CENTS);
    await inlineRefund(ctx, refund);
    await webhookSync(ctx, cardRefund("re_1", CARD_REFUND_CENTS, "failed"));
    expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);

    // The officer retries: Stripe answers the idempotency key with its
    // ORIGINAL response, a stale 'succeeded'.
    await inlineRefund(ctx, refund);
    expect(ctx.refunds.get("re_1")?.status).toBe("failed");
    // The next sync lists it failed again.
    await webhookSync(ctx, cardRefund("re_1", CARD_REFUND_CENTS, "failed"));

    expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);
  });

  it("a database with no migration history (db push) treats nothing as pre-ledger, warns, and does not fail the write (#3640 delta review, D4)", async () => {
    const ctx = paidStore();
    ctx.ledger.historyTablePresent = false;
    await settleCredit(ctx);

    await webhookSync(ctx, {
      ...cardRefund("re_1", CARD_REFUND_CENTS),
      created: Date.parse("2020-01-01T00:00:00.000Z") / 1000,
    });

    expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS + CARD_REFUND_CENTS);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("No _prisma_migrations table"),
    );
  });

  it("takes the Payment row FIRST, before any refund row or transaction row (#3640 delta review, D1)", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);
    ctx.store.$executeRaw.mockClear();
    ctx.store.paymentRefund.createMany.mockClear();
    ctx.store.paymentTransaction.updateMany.mockClear();

    await webhookSync(ctx);

    const [lockOrder] = ctx.store.$executeRaw.mock.invocationCallOrder;
    const [insertOrder] = ctx.store.paymentRefund.createMany.mock.invocationCallOrder;
    const casOrders = ctx.store.paymentTransaction.updateMany.mock.invocationCallOrder;
    expect(lockOrder).toBeLessThan(insertOrder);
    expect(lockOrder).toBeLessThan(Math.min(...casOrders));
    const [strings, paymentId] = ctx.store.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join("?")).toContain('FROM "Payment"');
    expect(strings.join("?")).toContain("FOR NO KEY UPDATE");
    expect(paymentId).toBe("payment_1");
  });

  it("the account-credit allocation takes the Payment row first too", async () => {
    const ctx = paidStore();

    await settleCredit(ctx);

    const [lockOrder] = ctx.store.$executeRaw.mock.invocationCallOrder;
    const [casOrder] = ctx.store.paymentTransaction.updateMany.mock.invocationCallOrder;
    expect(lockOrder).toBeLessThan(casOrder);
  });

  it("a crash after the mirror and before the aggregate rolls back whole, so the webhook's retry still reports the delta", async () => {
    const ctx = paidStore();
    await settleCredit(ctx);
    const { client } = asRootClientWithRollback(ctx);
    const realUpdate = ctx.store.payment.update;
    ctx.store.payment.update = vi.fn(async () => {
      throw new Error("database went away");
    }) as typeof ctx.store.payment.update;
    const refund = cardRefund("re_1", CARD_REFUND_CENTS);
    const sync = () =>
      syncRefundsFromStripeCharge({
        paymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        refundedAmountCents: CARD_REFUND_CENTS,
        refunds: [refund],
        store: client as never,
      });

    await expect(sync()).rejects.toThrow("database went away");
    expect(ctx.refunds.size).toBe(0);
    expect(ctx.transaction.refundedAmountCents).toBe(CREDIT_CENTS);

    ctx.store.payment.update = realUpdate;
    const retried = await sync();

    // Committed apart, the retry would record nothing new, report 0 and queue
    // no Xero note.
    expect(retried?.refundDeltaCents).toBe(CARD_REFUND_CENTS);
    expect(ctx.payment.refundedAmountCents).toBe(CREDIT_CENTS + CARD_REFUND_CENTS);
  });

  it("a mirror that keeps moving fails LOUD after five attempts and commits nothing", async () => {
    const ctx = paidStore();
    const { client, transactionSpy } = asRootClientWithRollback(ctx);
    ctx.store.paymentTransaction.updateMany = vi.fn(async () => ({
      count: 0,
    })) as typeof ctx.store.paymentTransaction.updateMany;

    await expect(
      syncRefundsFromStripeCharge({
        paymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        refundedAmountCents: CARD_REFUND_CENTS,
        refunds: [cardRefund("re_1", CARD_REFUND_CENTS)],
        store: client as never,
      }),
    ).rejects.toThrow(/kept moving under 5 compare-and-set attempts/);

    expect(ctx.store.paymentTransaction.updateMany).toHaveBeenCalledTimes(5);
    await expect(transactionSpy.mock.results[0]?.value).rejects.toThrow();
    expect(ctx.refunds.size).toBe(0);
  });

  it("lifts a mirror left below the card refunds on record (a pre-#3640 crash between the two writes)", async () => {
    const ctx = paidStore();
    ctx.refunds.set("re_1", {
      id: "payment_refund_1",
      paymentId: "payment_1",
      paymentTransactionId: "txn_1",
      stripeRefundId: "re_1",
      amountCents: CARD_REFUND_CENTS,
      status: "succeeded",
    });

    const delta = await webhookSync(ctx);

    expect(ctx.transaction.refundedAmountCents).toBe(CARD_REFUND_CENTS);
    expect(delta).toBe(CARD_REFUND_CENTS);
  });
});

/*
  #4104 (`INV-PAY-128`) - A REFUND SEEN FAILING AFTER IT COUNTED IS OWED AGAIN.

  The one writer of a transaction's refund rows says when it sees a refund
  fail after it counted, and keeps it owed in the same transaction: its own
  guarded counted -> refused write, or a caller told the refund counts (a
  replayed key reads Stripe's original 'pending') while the row says refused -
  the refund-failed webhook having got there first.
*/
describe("#4104 - a card refund seen failing after it counted is kept owed, once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const APP_METADATA = { bookingId: "booking_1", reason: "cancellation" };
  const refund = (status: string) => ({
    id: "re_1",
    amount: 2000,
    currency: "nzd",
    status,
    created: 1770000000,
    charge: "ch_1",
    payment_intent: "pi_1",
    metadata: APP_METADATA,
  });
  /** The refunds each write handed over as failed later, write by write. */
  const seen = () =>
    failedLater.keep.mock.calls.map((call) =>
      (call[1] as { seen: Array<{ refund: { id: string }; kind: string }> }).seen.map(({ refund, kind }) => `${refund.id}:${kind}`),
    );
  const record = (store: unknown, status: string) =>
    syncRefundsFromStripeCharge({ paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: 0, refunds: [refund(status)], store: store as never });

  it("the counted -> failed write keeps it owed, with the refund and its charge, and a replay does not again", async () => {
    const { store, transaction } = createRefundStore();
    await record(store, "pending");
    expect(transaction.refundedAmountCents).toBe(2000);
    expect(seen()).toEqual([[]]);

    await record(store, "failed");
    expect(transaction.refundedAmountCents).toBe(0);
    expect(failedLater.keep.mock.calls[1]?.[1]).toEqual({
      paymentId: "payment_1",
      paymentTransactionId: "txn_1",
      seen: [{ refund: expect.objectContaining({ id: "re_1", amount: 2000, metadata: APP_METADATA }), kind: "transition" }],
      fallbackPaymentIntentId: "pi_1",
    });

    // The same event again: the row is already refused, nothing is seen twice.
    await record(store, "failed");
    expect(seen()).toEqual([[], ["re_1:transition"], []]);
  });

  it("a refund told to count while its row already says refused is kept owed (the event arrived first)", async () => {
    const { store, transaction } = createRefundStore();
    await record(store, "failed");
    expect(transaction.refundedAmountCents).toBe(0);

    // The door's own write, carrying Stripe's original answer.
    await record(store, "pending");
    expect(seen()).toEqual([[], ["re_1:replayed"]]);
    expect(transaction.refundedAmountCents).toBe(0);
  });

  it("a refund Stripe refused at once is the door's to keep owed (#4083), not this", async () => {
    const { store } = createRefundStore();
    await record(store, "failed");
    await record(store, "canceled");
    expect(seen()).toEqual([[], []]);
  });

  it("alerts after the commit it owns, with the debts it kept; joined to a caller's transaction it leaves that to the caller", async () => {
    const debt = { outcome: "raised", operationId: "op_1" };
    const joined = createRefundStore();
    await record(joined.store, "pending");
    failedLater.keep.mockResolvedValueOnce({ debts: [debt], readAsRefused: [] });
    const joinedSync = await record(joined.store, "failed");
    // Returned for the caller to alert after its own commit (concurrency E).
    expect(joinedSync?.failedLaterDebts).toEqual([debt]);
    expect(failedLater.alert).not.toHaveBeenCalled();

    const owned = createRefundStore();
    const root = { ...owned.store, $connect: vi.fn(), $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(owned.store)) };
    await record(root, "pending");
    expect(failedLater.alert).toHaveBeenLastCalledWith([]);
    failedLater.keep.mockResolvedValueOnce({ debts: [debt], readAsRefused: [] });
    await record(root, "failed");
    expect(root.$transaction).toHaveBeenCalledTimes(2);
    expect(failedLater.alert).toHaveBeenLastCalledWith([debt]);
  });
});

describe("#4104 review - what the refund sender and the snapshot floor do with a failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stripeRefund = (id: string, status: string, amount = 2000) => ({
    id,
    amount,
    currency: "nzd",
    status,
    created: 1770000000,
    charge: "ch_1",
    payment_intent: "pi_1",
    metadata: { bookingId: "booking_1", reason: "cancellation" },
  });

  it("MUTATION (money 4): a charge.refunded snapshot taken before a refund failed does not lift the total back up", async () => {
    const { store, transaction } = createRefundStore();
    await syncRefundsFromStripeCharge({ paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: 2000, refunds: [stripeRefund("re_1", "pending")], store: store as never });
    await syncRefundsFromStripeCharge({ paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: 2000, refunds: [stripeRefund("re_1", "failed")], store: store as never });
    expect(transaction.refundedAmountCents).toBe(0);
    // A late snapshot still carrying the failed refund in Stripe's cumulative figure.
    await syncRefundsFromStripeCharge({ paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: 2000, refunds: [stripeRefund("re_1", "failed")], store: store as never });
    expect(transaction.refundedAmountCents).toBe(0);
    // Backed by counted rows, the figure still floors the total.
    await syncRefundsFromStripeCharge({ paymentIntentId: "pi_1", stripeChargeId: "ch_1", refundedAmountCents: 500, refunds: [stripeRefund("re_1", "failed"), stripeRefund("re_2", "succeeded", 500)], store: store as never });
    expect(transaction.refundedAmountCents).toBe(500);
  });

  it("a refund a row it is moving owns is handed back as refused: never counted as completed, and owed by that row", async () => {
    const { store } = createRefundStore();
    failedLater.keep.mockResolvedValueOnce({ debts: [], readAsRefused: ["re_held"] });
    mocks.processRefund.mockResolvedValueOnce(stripeRefund("re_held", "pending"));
    const result = await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: 2000, idempotencyKeyPrefix: "booking_cancel_refund_b1", store: store as never });
    expect(result.refunds).toEqual([expect.objectContaining({ refundId: "re_held", status: "failed" })]);
  });

  it("returns what it decided, for a caller whose transaction it joined to alert after its commit (concurrency E)", async () => {
    const { store } = createRefundStore();
    const debt = { outcome: "raised", operationId: "op_1" };
    failedLater.keep.mockResolvedValueOnce({ debts: [debt], readAsRefused: [] });
    mocks.processRefund.mockResolvedValueOnce(stripeRefund("re_x", "succeeded"));
    const result = await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: "payment_1", amountCents: 2000, store: store as never });
    expect(result.failedLaterDebts).toEqual([debt]);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ failedLaterDebts: [debt] }), expect.stringContaining("#4104"));
  });
});

// #4154 review (M9): ONE rule for "made before the refund ledger", whose undated reading is each caller's to name.
describe("predatesRefundLedger", () => {
  it("a dated refund predates the ledger only when made before its start; no start predates nothing", () => {
    expect(predatesRefundLedger(999, 1_000, "since-ledger")).toBe(true);
    expect(predatesRefundLedger(1_000, 1_000, "pre-ledger")).toBe(false);
    expect(predatesRefundLedger(999, null, "pre-ledger")).toBe(false);
  });

  it("MUTATION: an undated refund is read as its caller names, whatever the start", () => {
    for (const start of [1_000, null]) {
      expect(predatesRefundLedger(null, start, "pre-ledger")).toBe(true);
      expect(predatesRefundLedger(undefined, start, "since-ledger")).toBe(false);
    }
  });
});
