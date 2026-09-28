import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn(),
  transactionFindUnique: vi.fn(),
}));

vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroKeptLateCaptureInvoiceOperation(...a),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) =>
    mocks.kickQueuedXeroOutboxOperationsIfConnected(...a),
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...a: unknown[]) =>
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
} from "@/lib/late-capture-kept-xero";
import {
  keptLateCaptureCents,
  keptLateCaptureInvoiceAsked,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * #3635 (owner decision 29 Sep 2026): a late capture a treasurer KEPT on a
 * cancelled booking is recorded in Xero by the app. The dismissal's two halves;
 * the document itself is `xero-kept-late-capture-invoice.test.ts`'s.
 */
const store = {
  paymentTransaction: { findUnique: (...a: unknown[]) => mocks.transactionFindUnique(...a) },
};

function plan() {
  return planKeptLateCaptureXeroRecord({
    manualRefundTaskId: "task_kept",
    bookingId: "booking-1",
    paymentIntentId: "pi_late",
    actingMemberId: "treasurer-1",
    store: store as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({
    kind: "PRIMARY",
    status: "SUCCEEDED",
    amountCents: 24000,
    refundedAmountCents: 0,
  });
  mocks.enqueueXeroKeptLateCaptureInvoiceOperation.mockResolvedValue({
    queueOperationId: "op_kept",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({
    released: 1,
    queueOperationIds: ["op_supp"],
    outcome: "released",
  });
});

describe("the rules", () => {
  it("keeps the capture net of anything refunded since, never below zero", () => {
    expect(keptLateCaptureCents({ amountCents: 24000, refundedAmountCents: 0 })).toBe(24000);
    expect(keptLateCaptureCents({ amountCents: 24000, refundedAmountCents: 4000 })).toBe(20000);
    expect(keptLateCaptureCents({ amountCents: 24000, refundedAmountCents: 24000 })).toBe(0);
  });

  it("counts a kept invoice row in any state but CANCELLED as already asked for", () => {
    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      expect(
        keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status }]),
      ).toBe(true);
    }
    expect(
      keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status: "CANCELLED" }]),
    ).toBe(false);
    expect(keptLateCaptureInvoiceAsked([{ queueType: "BOOKING_INVOICE", status: "SUCCEEDED" }])).toBe(
      false,
    );
  });
});

describe("planKeptLateCaptureXeroRecord", () => {
  it("queues the kept booking payment's own invoice for the kept cents, INSIDE the caller's transaction", async () => {
    await expect(plan()).resolves.toEqual({
      kind: "kept-invoice-queued",
      queueOperationId: "op_kept",
    });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith({
      manualRefundTaskId: "task_kept",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      keptCents: 24000,
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it("queues only what is still kept after a partial dashboard refund", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "PRIMARY",
      status: "PARTIALLY_REFUNDED",
      amountCents: 24000,
      refundedAmountCents: 4000,
    });
    await plan();
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ keptCents: 20000 }),
    );
  });

  it("hands a kept CHANGE payment to the late-capture release, queuing no invoice of its own", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      refundedAmountCents: 0,
    });

    await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });

  it("does nothing for an intent with no recorded capture", async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);
    await expect(plan()).resolves.toEqual({ kind: "none" });
  });

  it("does nothing for a capture already refunded in full in the Stripe dashboard", async () => {
    for (const kind of ["PRIMARY", "ADDITIONAL"]) {
      mocks.transactionFindUnique.mockResolvedValue({
        kind,
        status: "REFUNDED",
        amountCents: 24000,
        refundedAmountCents: 24000,
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
    }
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });
});

describe("finishKeptLateCaptureXeroRecord", () => {
  it("releases a kept change payment's invoice and kicks the outbox", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });

    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).toHaveBeenCalledWith(
      "pi_late",
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("kicks the outbox for a queued kept invoice", async () => {
    await finishKeptLateCaptureXeroRecord({
      kind: "kept-invoice-queued",
      queueOperationId: "op_kept",
    });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("never throws: the decision has already committed", async () => {
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockRejectedValue(
      new Error("db down"),
    );
    await expect(
      finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" }),
    ).resolves.toBeUndefined();
  });
});
