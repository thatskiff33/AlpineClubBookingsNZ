import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  paymentFindUnique: vi.fn(),
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  logAudit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: mocks.paymentFindUnique,
    },
  },
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST } from "@/app/api/admin/payments/[id]/generate-invoice/route";

describe("POST /api/admin/payments/[id]/generate-invoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.auth.mockResolvedValue({
      user: { id: "admin_1", role: "ADMIN" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.enqueueXeroBookingInvoiceOperation.mockResolvedValue({
      queueOperationId: "op_1",
      message: "Xero booking invoice queued for background processing.",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("returns the created invoice when the queued worker completes immediately", async () => {
    mocks.paymentFindUnique
      .mockResolvedValueOnce({
        id: "payment_1",
        bookingId: "booking_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        status: "SUCCEEDED",
      })
      .mockResolvedValueOnce({
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/admin/payments/payment_1/generate-invoice", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "payment_1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "generated",
      xeroInvoiceId: "inv_1",
      xeroInvoiceNumber: "INV-001",
      queueOperationId: "op_1",
    });

    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
    });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "XERO_INVOICE_GENERATED",
        memberId: "admin_1",
        targetId: "booking_1",
      })
    );
  });

  it("returns 202 when the invoice remains queued because Xero is disconnected", async () => {
    mocks.paymentFindUnique
      .mockResolvedValueOnce({
        id: "payment_1",
        bookingId: "booking_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        status: "SUCCEEDED",
      })
      .mockResolvedValueOnce({
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
      });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValueOnce(null);

    const response = await POST(
      new NextRequest("http://localhost/api/admin/payments/payment_1/generate-invoice", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "payment_1" }) }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      queueOperationId: "op_1",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      message:
        "Xero booking invoice queued, but Xero is currently disconnected. The operation will run automatically once the connection is restored.",
    });

    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "XERO_INVOICE_GENERATION_QUEUED",
        memberId: "admin_1",
        targetId: "booking_1",
      })
    );
  });

  it("keeps the request successful when the immediate worker kick fails", async () => {
    mocks.paymentFindUnique
      .mockResolvedValueOnce({
        id: "payment_1",
        bookingId: "booking_1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        status: "SUCCEEDED",
      })
      .mockResolvedValueOnce({
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
      });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockRejectedValueOnce(
      new Error("worker unavailable")
    );

    const response = await POST(
      new NextRequest("http://localhost/api/admin/payments/payment_1/generate-invoice", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "payment_1" }) }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      queueOperationId: "op_1",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      message:
        "Xero booking invoice queued. The immediate worker kick failed, but the operation will retry automatically.",
    });

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        paymentId: "payment_1",
        queueOperationId: "op_1",
      }),
      "Failed to kick queued Xero booking invoice from admin repair route"
    );
  });
});
