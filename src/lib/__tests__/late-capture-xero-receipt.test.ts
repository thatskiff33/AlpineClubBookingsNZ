import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  linkCount: vi.fn(),
  linkFindFirst: vi.fn(),
  operationCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.taskFindMany(...a),
    },
    xeroObjectLink: {
      count: (...a: unknown[]) => mocks.linkCount(...a),
      findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
    },
    xeroSyncOperation: { count: (...a: unknown[]) => mocks.operationCount(...a) },
  },
}));

import {
  findKeptLateCaptureInvoiceIdForPayment,
  hasXeroReceiptForLateCapture,
  stripeRefundNeedsXeroNoteNow,
} from "@/lib/late-capture-xero-receipt";

/**
 * #3635 (review F2, orchestrator decision 29 Sep 2026): whether a refund of a
 * late capture needs a Xero refund note is asked of the capture's OWN invoice
 * rows, never of the booking's pre-cancel invoice.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindUnique.mockResolvedValue({ id: "task_kept" });
  mocks.linkCount.mockResolvedValue(0);
  mocks.operationCount.mockResolvedValue(0);
  mocks.taskFindMany.mockResolvedValue([{ id: "task_kept" }]);
  mocks.linkFindFirst.mockResolvedValue(null);
});

describe("hasXeroReceiptForLateCapture", () => {
  it("is yes once the kept-capture invoice is in Xero (the task's active link), not while it is only queued", async () => {
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(false);
    mocks.linkCount.mockResolvedValue(1);
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(true);
    expect(mocks.linkCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        role: "KEPT_LATE_CAPTURE_INVOICE",
        active: true,
      }),
    });
  });

  it("is yes once an officer recorded the kept invoice by hand and resolved it in Xero (#3635, INV-INT-025)", async () => {
    mocks.operationCount.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.queueType === "KEPT_LATE_CAPTURE_INVOICE" &&
      (args.where.manuallyResolvedAt as { not: null } | undefined)?.not === null
        ? 1
        : 0,
    );
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(true);
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

  it("is yes for the change's supplementary invoice released for this intent, never for a waiting or withdrawn one", async () => {
    mocks.operationCount.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.queueType === "SUPPLEMENTARY_INVOICE" ? 1 : 0,
    );
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(true);
    expect(mocks.operationCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        queueType: "SUPPLEMENTARY_INVOICE",
        status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
        requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
      }),
    });
  });
});

describe("stripeRefundNeedsXeroNoteNow (charge.refunded)", () => {
  it("is always yes for a capture no #3639 task owns, as before", async () => {
    mocks.taskFindUnique.mockResolvedValue(null);
    await expect(stripeRefundNeedsXeroNoteNow("pi_other")).resolves.toBe(true);
  });

  it("waits for the receipt for a capture a task owns", async () => {
    await expect(stripeRefundNeedsXeroNoteNow("pi_late")).resolves.toBe(false);
    mocks.linkCount.mockResolvedValue(1);
    await expect(stripeRefundNeedsXeroNoteNow("pi_late")).resolves.toBe(true);
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
