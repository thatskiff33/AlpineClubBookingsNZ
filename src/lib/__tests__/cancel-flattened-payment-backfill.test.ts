import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  backfillFlattenedCancelPayments,
  deriveFlattenedPaymentRestoration,
  formatFlattenedCancelPaymentReport,
  paymentHasCaptureEvidence,
  type FlattenedCandidatePayment,
} from "@/lib/cancel-flattened-payment-backfill";

function payment(
  overrides: Partial<FlattenedCandidatePayment> = {}
): FlattenedCandidatePayment {
  return {
    id: overrides.id ?? "pay_1",
    bookingId: overrides.bookingId ?? "bk_1",
    source: overrides.source ?? PaymentSource.STRIPE,
    status: overrides.status ?? PaymentStatus.FAILED,
    amountCents: overrides.amountCents ?? 10_000,
    refundedAmountCents: overrides.refundedAmountCents ?? 0,
    transactions: overrides.transactions ?? [],
    booking: overrides.booking ?? { organiserSettled: false, parentBookingId: null },
  };
}

describe("paymentHasCaptureEvidence (mirror of booking-cancel #1489 discriminator)", () => {
  it("treats any captured ledger row as capture evidence, incl. IB", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({
          source: PaymentSource.INTERNET_BANKING,
          transactions: [{ status: PaymentStatus.SUCCEEDED }],
        })
      )
    ).toBe(true);
  });

  it("trusts the STRIPE-only refund mirror for pre-ledger rows", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({ source: PaymentSource.STRIPE, refundedAmountCents: 2_500 })
      )
    ).toBe(true);
  });

  it("does NOT trust the mirror for a folded never-captured IB payment", () => {
    // The inbound reconcile folds credit notes into refundedAmountCents on
    // never-captured IB payments (zero cash) — these must stay FAILED.
    expect(
      paymentHasCaptureEvidence(
        payment({
          source: PaymentSource.INTERNET_BANKING,
          refundedAmountCents: 3_000,
          transactions: [],
        })
      )
    ).toBe(false);
  });

  it("finds no evidence for a genuinely never-captured STRIPE row (mirror clean)", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({ source: PaymentSource.STRIPE, refundedAmountCents: 0 })
      )
    ).toBe(false);
  });
});

describe("deriveFlattenedPaymentRestoration", () => {
  it("restores a partially-refunded STRIPE payment flattened to FAILED (mirror-only)", () => {
    const restoration = deriveFlattenedPaymentRestoration(
      payment({ amountCents: 10_000, refundedAmountCents: 4_000 })
    );
    expect(restoration).not.toBeNull();
    expect(restoration).toMatchObject({
      field: "status",
      storedStatus: PaymentStatus.FAILED,
      restoredStatus: PaymentStatus.PARTIALLY_REFUNDED,
    });
  });

  it("restores a fully-refunded STRIPE payment flattened to FAILED", () => {
    const restoration = deriveFlattenedPaymentRestoration(
      payment({ amountCents: 10_000, refundedAmountCents: 10_000 })
    );
    expect(restoration?.restoredStatus).toBe(PaymentStatus.REFUNDED);
  });

  it("restores a captured-ledger row with no refund to SUCCEEDED", () => {
    const restoration = deriveFlattenedPaymentRestoration(
      payment({
        amountCents: 10_000,
        refundedAmountCents: 0,
        transactions: [{ status: PaymentStatus.SUCCEEDED }],
      })
    );
    expect(restoration?.restoredStatus).toBe(PaymentStatus.SUCCEEDED);
  });

  it("skips the narrow unrecoverable residual (STRIPE, no ledger, refunded == 0)", () => {
    expect(
      deriveFlattenedPaymentRestoration(
        payment({ refundedAmountCents: 0, transactions: [] })
      )
    ).toBeNull();
  });

  it("skips a folded never-captured IB payment (correctly FAILED at cancel)", () => {
    expect(
      deriveFlattenedPaymentRestoration(
        payment({
          source: PaymentSource.INTERNET_BANKING,
          refundedAmountCents: 3_000,
          transactions: [],
        })
      )
    ).toBeNull();
  });

  it("skips a payment that is not FAILED (already-correct / idempotent)", () => {
    expect(
      deriveFlattenedPaymentRestoration(
        payment({
          status: PaymentStatus.PARTIALLY_REFUNDED,
          refundedAmountCents: 4_000,
        })
      )
    ).toBeNull();
  });
});

interface FakeStore {
  store: unknown;
  updates: Array<{ where: unknown; data: unknown }>;
  findMany: ReturnType<typeof vi.fn>;
}

function makeStore(rows: FlattenedCandidatePayment[]): FakeStore {
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const findMany = vi.fn(async () => rows);
  const store = {
    payment: {
      findMany,
      update: vi.fn((args: { where: { id: string }; data: unknown }) => {
        updates.push(args);
        return Promise.resolve({ id: args.where.id });
      }),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { store, updates, findMany };
}

describe("backfillFlattenedCancelPayments", () => {
  const mixedRows = () => [
    // flattened captured (mirror-only) -> restore
    payment({ id: "flat", bookingId: "bk_flat", refundedAmountCents: 4_000 }),
    // folded never-captured IB -> skip
    payment({
      id: "ib",
      bookingId: "bk_ib",
      source: PaymentSource.INTERNET_BANKING,
      refundedAmountCents: 3_000,
    }),
    // genuinely never-captured STRIPE -> skip
    payment({ id: "clean", bookingId: "bk_clean", refundedAmountCents: 0 }),
  ];

  it("dry run reports candidates without writing", async () => {
    const { store, updates, findMany } = makeStore(mixedRows());
    const result = await backfillFlattenedCancelPayments({
      store: store as never,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("dry-run");
    expect(result.scanned).toBe(3);
    expect(result.restorations).toHaveLength(1);
    expect(result.restorations[0]).toMatchObject({
      paymentId: "flat",
      restoredStatus: PaymentStatus.PARTIALLY_REFUNDED,
    });
    expect(result.appliedCount).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("apply writes each restoration inside a transaction with a FAILED guard", async () => {
    const { store, updates } = makeStore(mixedRows());
    const result = await backfillFlattenedCancelPayments({
      store: store as never,
      apply: true,
    });

    expect(result.mode).toBe("apply");
    expect(result.appliedCount).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      where: { id: "flat", status: PaymentStatus.FAILED },
      data: { status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    expect(
      (store as { $transaction: ReturnType<typeof vi.fn> }).$transaction
    ).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a store with nothing flattened writes nothing", async () => {
    const { store, updates } = makeStore([]);
    const result = await backfillFlattenedCancelPayments({
      store: store as never,
      apply: true,
    });

    expect(result.scanned).toBe(0);
    expect(result.restorations).toHaveLength(0);
    expect(result.appliedCount).toBe(0);
    expect(updates).toHaveLength(0);
    // No writes at all when there is nothing to restore.
    expect(
      (store as { $transaction: ReturnType<typeof vi.fn> }).$transaction
    ).not.toHaveBeenCalled();
  });
});

describe("formatFlattenedCancelPaymentReport", () => {
  it("summarises a dry run with per-row detail", () => {
    const report = formatFlattenedCancelPaymentReport({
      mode: "dry-run",
      scanned: 5,
      appliedCount: 0,
      restorations: [
        {
          paymentId: "pay_1",
          bookingId: "bk_1",
          source: PaymentSource.STRIPE,
          field: "status",
          storedStatus: PaymentStatus.FAILED,
          restoredStatus: PaymentStatus.PARTIALLY_REFUNDED,
          amountCents: 10_000,
          refundedAmountCents: 4_000,
        },
      ],
    });
    expect(report).toContain("dry-run");
    expect(report).toContain("FAILED -> PARTIALLY_REFUNDED");
    expect(report).toContain("Re-run with --apply");
  });

  it("reports a clean scan", () => {
    const report = formatFlattenedCancelPaymentReport({
      mode: "apply",
      scanned: 0,
      appliedCount: 0,
      restorations: [],
    });
    expect(report).toContain("nothing to restore");
  });
});
