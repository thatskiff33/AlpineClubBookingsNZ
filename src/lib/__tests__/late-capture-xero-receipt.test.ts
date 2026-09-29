import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  operationCount: vi.fn(),
  operationFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.taskFindMany(...a),
    },
    xeroObjectLink: {
      findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
    },
    xeroSyncOperation: {
      count: (...a: unknown[]) => mocks.operationCount(...a),
      findMany: (...a: unknown[]) => mocks.operationFindMany(...a),
    },
  },
}));

import {
  findKeptLateCaptureInvoiceIdForPayment,
  findLateCapturePaymentIntents,
  hasXeroReceiptForLateCapture,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import { cancelledBookingPrimaryPaymentRefundReason } from "@/lib/deleted-booking-modification-payment";

/**
 * #3635 (review F2, round-3 R1/R5, orchestrator decision 29 Sep 2026): whether
 * a refund of a late capture gets the app's refund note is asked of the
 * capture's OWN invoice rows, never of the booking's pre-cancel invoice, and
 * a receipt an officer recorded by hand gets none.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindUnique.mockResolvedValue({ id: "task_kept" });
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.operationCount.mockResolvedValue(0);
  mocks.operationFindMany.mockResolvedValue([]);
  mocks.taskFindMany.mockResolvedValue([{ id: "task_kept" }]);
});

describe("readLateCaptureXeroReceipt", () => {
  it("is recorded, naming the kept invoice, once it is in Xero (the task's active link), not while it is only queued", async () => {
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "none" });
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: "inv_kept",
    });
    expect(mocks.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "ManualRefundTask",
          localId: "task_kept",
          role: "KEPT_LATE_CAPTURE_INVOICE",
          active: true,
        }),
      }),
    );
  });

  it("is resolved by hand once an officer recorded the kept invoice and resolved it in Xero, so no automatic note is owed", async () => {
    mocks.operationCount.mockResolvedValue(1);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(false);
    expect(mocks.operationCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: { not: "CANCELLED" },
        manuallyResolvedAt: { not: null },
      }),
    });
  });

  it("is recorded for the change's supplementary invoice released for this intent, naming it once sent, never a waiting or withdrawn one", async () => {
    mocks.operationFindMany.mockResolvedValue([
      { status: "PENDING", xeroObjectId: null, manuallyResolvedAt: null },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: null,
    });
    mocks.operationFindMany.mockResolvedValue([
      { status: "SUCCEEDED", xeroObjectId: "inv_change", manuallyResolvedAt: null },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: "inv_change",
    });
    expect(mocks.operationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          queueType: "SUPPLEMENTARY_INVOICE",
          status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
          requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
    // A released one an officer resolved by hand is the officer's record.
    mocks.operationFindMany.mockResolvedValue([
      { status: "FAILED", xeroObjectId: null, manuallyResolvedAt: new Date("2026-06-20T00:00:00Z") },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
  });
});

describe("findLateCapturePaymentIntents (round-3 R1)", () => {
  it("finds an intent an approval task owns and one the webhook refunded automatically, and nothing else", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: "pi_owned", reason: null },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingPrimaryPaymentRefundReason("pi_auto") },
    ]);
    const found = await findLateCapturePaymentIntents(["pi_owned", "pi_auto", "pi_ordinary"]);
    expect([...found].sort()).toEqual(["pi_auto", "pi_owned"]);
  });

  it("asks nothing for no intents", async () => {
    await expect(findLateCapturePaymentIntents([])).resolves.toEqual(new Set());
    expect(mocks.taskFindMany).not.toHaveBeenCalled();
  });
});

describe("findKeptLateCaptureInvoiceIdForPayment", () => {
  it("names the payment's kept invoice, for the refund note to answer", async () => {
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBe("inv_kept");
    mocks.taskFindMany.mockResolvedValue([]);
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBeNull();
  });
});
