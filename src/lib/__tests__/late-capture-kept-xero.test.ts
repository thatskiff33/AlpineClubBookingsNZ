import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn(),
  transactionFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  operationFindMany: vi.fn(),
  linkCount: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroBookingInvoiceOperation(...a),
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) =>
    mocks.kickQueuedXeroOutboxOperationsIfConnected(...a),
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...a: unknown[]) =>
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...a),
}));
vi.mock("@/lib/email", () => ({
  sendAdminXeroSyncErrorAlert: (...a: unknown[]) => mocks.sendAdminXeroSyncErrorAlert(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
} from "@/lib/late-capture-kept-xero";
import {
  keptPrimaryCaptureInvoiceQueued,
  keptPrimaryCaptureInvoiceRefusal,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * #3635 (owner decision 29 Sep 2026): a late capture a treasurer KEPT on a
 * cancelled booking is recorded in Xero the way a normal card payment is - an
 * invoice for the kept amount, paid from the Stripe account.
 */
const store = {
  paymentTransaction: { findUnique: (...a: unknown[]) => mocks.transactionFindUnique(...a) },
  booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  manualRefundTask: { findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a) },
  xeroSyncOperation: { findMany: (...a: unknown[]) => mocks.operationFindMany(...a) },
  xeroObjectLink: { count: (...a: unknown[]) => mocks.linkCount(...a) },
};
const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");

const cleanPayment = {
  id: "payment-1",
  source: "STRIPE" as const,
  xeroInvoiceId: null,
  manuallyMarkedPaidAt: null,
  creditAppliedCents: 0,
  amountCents: 24000,
  refundedAmountCents: 0,
};

function plan() {
  return planKeptLateCaptureXeroRecord({
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
  mocks.bookingFindUnique.mockResolvedValue({ finalPriceCents: 24000, payment: cleanPayment });
  mocks.taskFindUnique.mockResolvedValue({ createdAt: RAISED_AT });
  mocks.operationFindMany.mockResolvedValue([]);
  mocks.linkCount.mockResolvedValue(0);
  mocks.enqueueXeroBookingInvoiceOperation.mockResolvedValue({ queueOperationId: "op_inv" });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({
    released: 1,
    queueOperationIds: ["op_supp"],
    outcome: "released",
  });
  mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(undefined);
});

describe("keptPrimaryCaptureInvoiceRefusal", () => {
  const input = (overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) => ({
    keptCents: 24000,
    finalPriceCents: 24000,
    hasPrimaryInvoiceLink: false,
    ...overrides,
    payment: { ...cleanPayment, ...payment },
  });

  it("allows the ordinary booking invoice only when it bills exactly the kept money", () => {
    expect(keptPrimaryCaptureInvoiceRefusal(input())).toBeNull();
    expect(keptPrimaryCaptureInvoiceRefusal(input({ finalPriceCents: 25000 }))).toBe("amount-differs");
    expect(keptPrimaryCaptureInvoiceRefusal(input({}, { refundedAmountCents: 500 }))).toBe(
      "amount-differs",
    );
    expect(keptPrimaryCaptureInvoiceRefusal(input({}, { creditAppliedCents: 1000 }))).toBe(
      "credit-applied",
    );
    expect(keptPrimaryCaptureInvoiceRefusal(input({}, { xeroInvoiceId: "inv-old" }))).toBe(
      "invoice-exists",
    );
    expect(keptPrimaryCaptureInvoiceRefusal(input({ hasPrimaryInvoiceLink: true }))).toBe(
      "invoice-exists",
    );
    expect(
      keptPrimaryCaptureInvoiceRefusal(input({}, { manuallyMarkedPaidAt: new Date() })),
    ).toBe("manually-settled");
    expect(keptPrimaryCaptureInvoiceRefusal(input({}, { source: "INTERNET_BANKING" }))).toBe(
      "not-card",
    );
    expect(keptPrimaryCaptureInvoiceRefusal(input({ keptCents: 0 }))).toBe("not-captured");
  });
});

describe("keptPrimaryCaptureInvoiceQueued", () => {
  const op = (status: string, createdAt: Date, queueType = "BOOKING_INVOICE") => ({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    queueType,
    status,
    createdAt,
  });
  const after = new Date(RAISED_AT.getTime() + 1000);

  it("counts a booking invoice queued since the task was raised, in any state but CANCELLED", () => {
    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      expect(
        keptPrimaryCaptureInvoiceQueued({ raisedAt: RAISED_AT, paymentOperations: [op(status, after)] }),
      ).toBe(true);
    }
    expect(
      keptPrimaryCaptureInvoiceQueued({ raisedAt: RAISED_AT, paymentOperations: [op("CANCELLED", after)] }),
    ).toBe(false);
    // One from before the late capture is some earlier invoice, not this one.
    expect(
      keptPrimaryCaptureInvoiceQueued({
        raisedAt: RAISED_AT,
        paymentOperations: [op("SUCCEEDED", new Date(RAISED_AT.getTime() - 1000))],
      }),
    ).toBe(false);
    expect(
      keptPrimaryCaptureInvoiceQueued({
        raisedAt: RAISED_AT,
        paymentOperations: [op("SUCCEEDED", after, "SUPPLEMENTARY_INVOICE")],
      }),
    ).toBe(false);
  });
});

describe("planKeptLateCaptureXeroRecord", () => {
  it("queues the booking's own invoice INSIDE the caller's transaction for a kept primary capture", async () => {
    await expect(plan()).resolves.toEqual({
      kind: "booking-invoice-queued",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      queueOperationId: "op_inv",
    });
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("booking-1", {
      createdByMemberId: "treasurer-1",
      invoiceEmailDelivery: null,
      store,
    });
  });

  it("hands a kept CHANGE payment to the late-capture release, queuing no booking invoice", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      refundedAmountCents: 0,
    });

    await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("queues nothing, and says why, when the booking invoice would not bill the kept money", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      finalPriceCents: 24000,
      payment: { ...cleanPayment, creditAppliedCents: 3000 },
    });

    await expect(plan()).resolves.toMatchObject({
      kind: "booking-invoice-refused",
      refusal: "credit-applied",
      keptCents: 24000,
    });
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("queues nothing when an invoice is already linked (for example one a cancellation cleared)", async () => {
    mocks.linkCount.mockResolvedValue(1);

    await expect(plan()).resolves.toMatchObject({ refusal: "invoice-exists" });
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("queues nothing more when a booking invoice was already asked for since the task was raised", async () => {
    mocks.operationFindMany.mockResolvedValue([
      {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: "BOOKING_INVOICE",
        status: "SUCCEEDED",
        createdAt: new Date(RAISED_AT.getTime() + 60_000),
      },
    ]);

    await expect(plan()).resolves.toEqual({ kind: "none" });
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("does nothing for an intent with no recorded capture", async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);
    await expect(plan()).resolves.toEqual({ kind: "none" });
  });

  it("does nothing, and tells nobody, for a capture already refunded in full in the Stripe dashboard", async () => {
    for (const kind of ["PRIMARY", "ADDITIONAL"]) {
      mocks.transactionFindUnique.mockResolvedValue({
        kind,
        status: "REFUNDED",
        amountCents: 24000,
        refundedAmountCents: 24000,
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
    }
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
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

  it("kicks the outbox for a queued booking invoice and tells nobody", async () => {
    await finishKeptLateCaptureXeroRecord({
      kind: "booking-invoice-queued",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      queueOperationId: "op_inv",
    });

    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });

  it("tells an officer to record a refused one by hand, naming the reason", async () => {
    await finishKeptLateCaptureXeroRecord({
      kind: "booking-invoice-refused",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      keptCents: 24000,
      refusal: "amount-differs",
    });

    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "KEPT_LATE_CAPTURE_NOT_INVOICED",
        errorMessage: expect.stringContaining("no longer equals what the card paid"),
      }),
    );
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
