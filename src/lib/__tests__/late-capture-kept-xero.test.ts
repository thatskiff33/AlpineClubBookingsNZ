import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  transactionFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  linkCount: vi.fn(),
}));

vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroKeptLateCaptureInvoiceOperation(...a),
  keptLateCaptureDocumentDate: () => "2026-06-10",
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) =>
    mocks.kickQueuedXeroOutboxOperationsIfConnected(...a),
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...a: unknown[]) =>
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...a),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  creditBackLateCaptureRefunds: (...a: unknown[]) => mocks.creditBackLateCaptureRefunds(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
} from "@/lib/late-capture-kept-xero";
import {
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
  keptLateCaptureRecordRoute,
} from "@/lib/late-capture-kept-xero-rules";
import type { ClubTimeZone } from "@/lib/club-time";

/**
 * #3635 (owner decision 29 Sep 2026): a late capture a treasurer KEPT on a
 * cancelled booking is recorded in Xero by the app. The one decision, and the
 * dismissal's two halves; the document itself is
 * `xero-kept-late-capture-invoice.test.ts`'s and the resulting books
 * `xero-kept-late-capture-ledger.test.ts`'s.
 */
const store = {
  paymentTransaction: { findUnique: (...a: unknown[]) => mocks.transactionFindUnique(...a) },
  manualRefundTask: { findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a) },
  payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
  xeroObjectLink: { count: (...a: unknown[]) => mocks.linkCount(...a) },
};

function plan() {
  return planKeptLateCaptureXeroRecord({
    manualRefundTaskId: "task_kept",
    bookingId: "booking-1",
    paymentIntentId: "pi_late",
    actingMemberId: "treasurer-1",
    clubZone: "Pacific/Auckland" as ClubTimeZone,
    store: store as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({
    kind: "PRIMARY",
    status: "SUCCEEDED",
    amountCents: 24000,
    paymentId: "payment-1",
  });
  mocks.taskFindUnique.mockResolvedValue({ createdAt: new Date("2026-06-10T01:00:00Z") });
  mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: null });
  mocks.linkCount.mockResolvedValue(0);
  mocks.enqueueXeroKeptLateCaptureInvoiceOperation.mockResolvedValue({
    queueOperationId: "op_kept",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.creditBackLateCaptureRefunds.mockResolvedValue(undefined);
  mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({
    released: 1,
    queueOperationIds: ["op_supp"],
    outcome: "released",
  });
});

describe("decideLateCapture (the one decision)", () => {
  const capture = { status: "SUCCEEDED" as const, amountCents: 24000 };
  it("lets a task decide; with none, the webhook's routing", () => {
    expect(decideLateCapture({ taskStatus: "OPEN", bookingStatus: "CANCELLED", superseded: false, capture })).toEqual({
      state: "awaiting-decision",
      recordCents: 0,
    });
    expect(
      decideLateCapture({ taskStatus: "COMPLETED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "refunded", recordCents: 0 });
    expect(
      decideLateCapture({ taskStatus: "DISMISSED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "kept", recordCents: 24000 });
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CANCELLED", superseded: false, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: true, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: false, capture }).state).toBe(
      "kept",
    );
  });

  it("records the GROSS capture, even one refunded since - the refund is its own note", () => {
    for (const status of ["PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        decideLateCapture({
          taskStatus: "DISMISSED",
          bookingStatus: "CANCELLED",
          superseded: false,
          capture: { status, amountCents: 24000 },
        }).recordCents,
      ).toBe(24000);
    }
    expect(
      decideLateCapture({
        taskStatus: "DISMISSED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture: { status: "FAILED", amountCents: 24000 },
      }).recordCents,
    ).toBe(0);
  });

  it("routes a change payment on an invoiced booking to its own invoice, everything else to the kept invoice", () => {
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: true })).toBe(
      "change-invoice",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: false })).toBe(
      "kept-invoice",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "PRIMARY", bookingHasPrimaryInvoice: true })).toBe(
      "kept-invoice",
    );
  });

  it("counts a kept invoice row in any state but CANCELLED as already asked for", () => {
    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status }])).toBe(true);
    }
    expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status: "CANCELLED" }])).toBe(
      false,
    );
  });
});

describe("planKeptLateCaptureXeroRecord", () => {
  it("queues the kept invoice for the gross cents dated the capture day, INSIDE the caller's transaction", async () => {
    await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith({
      manualRefundTaskId: "task_kept",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      capturedCents: 24000,
      capturedOn: "2026-06-10",
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it("still queues the gross receipt for a capture refunded in the dashboard since", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "PRIMARY",
      status: "REFUNDED",
      amountCents: 24000,
      paymentId: "payment-1",
    });
    await plan();
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 24000 }),
    );
  });

  it("hands a kept change payment on an invoiced booking to the late-capture release", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: "inv_primary" });
    await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });

  it("gives a kept change payment on a booking Xero never invoiced the kept invoice (review F3)", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    await expect(plan()).resolves.toMatchObject({ kind: "kept-invoice-queued" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 2500 }),
    );
  });

  it("does nothing for an intent with no recorded capture", async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);
    await expect(plan()).resolves.toEqual({ kind: "none" });
  });
});

describe("finishKeptLateCaptureXeroRecord", () => {
  it("releases a kept change payment's invoice, credits back any refund already taken, and kicks the outbox", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).toHaveBeenCalledWith("pi_late");
    expect(mocks.creditBackLateCaptureRefunds).toHaveBeenCalledWith("pi_late");
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("kicks the outbox for a queued kept invoice", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("never throws: the decision has already committed", async () => {
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockRejectedValue(new Error("db down"));
    await expect(
      finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" }),
    ).resolves.toBeUndefined();
  });
});
