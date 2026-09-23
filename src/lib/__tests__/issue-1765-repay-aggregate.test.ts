import { describe, expect, it, vi } from "vitest";
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { reconcilePaymentAggregates } from "@/lib/payment-transactions";

// #1765 — proves the MONEY MATH of the repay-after-refund model, which the
// route/guard tests (which mock upsertPaymentIntentTransaction) never exercise.
// The owner flagged the net-based invariant alignment as "the first thing worth
// checking in review": after a booking is paid, fully refunded, repriced, then
// repaid on the SAME Payment row, the aggregate mirror must reproduce the
// owner-verified production shape — amountCents 28500 / refundedAmountCents
// 19500 / PARTIALLY_REFUNDED — because reconcilePaymentAggregates DERIVES the
// mirror from the transaction ledger (gross = sum of captured-status
// transactions, which INCLUDES REFUNDED; refunded is monotonic per #1353). The
// mirror is a derived idempotent sum, never an increment, so no retry can
// double-count.

type StoreTransaction = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  paymentMethodId: string | null;
  reference: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  createdAt: Date;
};

type StorePayment = {
  id: string;
  amountCents: number;
  creditAppliedCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  source: PaymentSource;
  reference: string | null;
  stripePaymentIntentId: string | null;
  stripePaymentMethodId: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  additionalPaymentIntentId: string | null;
  additionalAmountCents: number;
  additionalPaymentStatus: string;
  transactions: StoreTransaction[];
};

// Minimal in-memory PaymentStore standing in for a Prisma transaction client,
// exposing only the surface reconcilePaymentAggregates touches.
function makeStore(payment: StorePayment) {
  const paymentTransactionCreate = vi.fn();
  const store = {
    // #3581: `reconcilePaymentAggregates` now ends by syncing the booking
    // ledger's settlement lines from the same rows, so it reads and writes here.
    bookingLedgerLine: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    payment: {
      findUnique: vi.fn(async () => payment),
      update: vi.fn(async ({ data }: { data: Partial<StorePayment> }) => {
        Object.assign(payment, data);
        return payment;
      }),
    },
    paymentTransaction: {
      create: paymentTransactionCreate,
    },
  };
  return { store, payment, paymentTransactionCreate };
}

const REPRICED_FINAL_CENTS = 9000; // $90 after the promo reprice
const ORIGINAL_CENTS = 19500; // $195 original capture, fully refunded
const REPAY_CENTS = 9000; // fresh card-entry capture at the effective price

function twoGenerationPayment(): StorePayment {
  return {
    id: "pay-repay",
    // A stale/transient value the route wrote before reconcile; must be
    // overwritten by the derived gross, never persisted.
    amountCents: REPAY_CENTS,
    creditAppliedCents: 0,
    refundedAmountCents: ORIGINAL_CENTS,
    status: PaymentStatus.REFUNDED,
    source: PaymentSource.STRIPE,
    reference: null,
    // Pointer already moved to the repay intent (latest PRIMARY).
    stripePaymentIntentId: "pi_repay",
    stripePaymentMethodId: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    additionalPaymentIntentId: null,
    additionalAmountCents: 0,
    additionalPaymentStatus: "NONE",
    transactions: [
      {
        id: "txn-original",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.STRIPE,
        stripePaymentIntentId: "pi_orig",
        amountCents: ORIGINAL_CENTS,
        refundedAmountCents: ORIGINAL_CENTS, // fully refunded, immutable history
        status: PaymentStatus.REFUNDED,
        paymentMethodId: "pm_orig",
        reference: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        createdAt: new Date("2026-07-04T00:00:00Z"),
      },
      {
        id: "txn-repay",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.STRIPE,
        stripePaymentIntentId: "pi_repay",
        amountCents: REPAY_CENTS,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED, // fresh capture settled
        paymentMethodId: "pm_repay",
        reference: null,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        createdAt: new Date("2026-07-11T00:00:00Z"),
      },
    ],
  };
}

describe("#1765 repay-after-refund aggregate (net-based mirror invariant)", () => {
  it("derives the owner-verified 28500/19500/PARTIALLY_REFUNDED shape from the ledger", async () => {
    const { store, payment, paymentTransactionCreate } = makeStore(
      twoGenerationPayment()
    );

    await reconcilePaymentAggregates({
      paymentId: "pay-repay",
      store: store as never,
    });

    // Gross accumulates across generations (original refunded capture counts,
    // because REFUNDED is a captured status); refunded stays at its #1353 floor.
    expect(payment.amountCents).toBe(ORIGINAL_CENTS + REPAY_CENTS); // 28500
    expect(payment.refundedAmountCents).toBe(ORIGINAL_CENTS); // 19500
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    // Pointer settles on the repay intent (latest PRIMARY).
    expect(payment.stripePaymentIntentId).toBe("pi_repay");

    // Net-based mirror invariant at repay settlement:
    // (amountCents - refundedAmountCents) + creditAppliedCents = finalPriceCents.
    expect(
      payment.amountCents -
        payment.refundedAmountCents +
        payment.creditAppliedCents
    ).toBe(REPRICED_FINAL_CENTS);

    // Derived from existing rows: no ledger row is invented (no legacy backfill).
    expect(paymentTransactionCreate).not.toHaveBeenCalled();
  });

  it("before the repay settles, the pending generation is not yet gross (net owed = full effective price)", async () => {
    const payment = twoGenerationPayment();
    // Repay intent minted but not yet captured.
    const repay = payment.transactions.find((t) => t.id === "txn-repay")!;
    repay.status = PaymentStatus.PROCESSING;
    const { store, payment: live } = makeStore(payment);

    await reconcilePaymentAggregates({
      paymentId: "pay-repay",
      store: store as never,
    });

    // Only the original refunded capture is gross; the PROCESSING repay is not.
    expect(live.amountCents).toBe(ORIGINAL_CENTS); // 19500
    expect(live.refundedAmountCents).toBe(ORIGINAL_CENTS); // 19500
    expect(live.status).toBe(PaymentStatus.REFUNDED); // refunded >= gross
    // Net cash is 0 -> the member still owes the full repriced price.
    expect(live.amountCents - live.refundedAmountCents).toBe(0);
  });
});
