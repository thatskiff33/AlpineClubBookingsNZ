import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  refundRequestFindUnique: vi.fn(),
  refundRequestUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  transaction: vi.fn(),
  processRefund: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  sendEmail: vi.fn(),
  refundRequestResolvedTemplate: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: {
      findUnique: mocks.refundRequestFindUnique,
      updateMany: mocks.refundRequestUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/email-templates", () => ({
  refundRequestResolvedTemplate: mocks.refundRequestResolvedTemplate,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  refundPaymentTransactions: mocks.refundPaymentTransactions,
}));

import { PUT } from "@/app/api/admin/refund-requests/[id]/route";

describe("PUT /api/admin/refund-requests/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.auth.mockResolvedValue({
      user: { id: "admin_1", role: "ADMIN" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.processRefund.mockResolvedValue({ id: "re_1" });
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1", paymentIntentId: "pi_1", amountCents: 2500 }],
    });
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_credit_note_1",
      message: "queued",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.refundRequestResolvedTemplate.mockReturnValue("<p>approved</p>");
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentFindUnique.mockResolvedValue({
      amountCents: 10000,
      refundedAmountCents: 0,
    });
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        refundRequest: {
          updateMany: mocks.refundRequestUpdateMany,
        },
        payment: {
          findUnique: mocks.paymentFindUnique,
          update: mocks.paymentUpdate,
        },
      })
    );
  });

  it("queues a refund credit note after approving a refund appeal", async () => {
    const initialRefundRequest = {
      id: "refund_1",
      status: "PENDING",
      booking: {
        id: "booking_1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        payment: {
          id: "payment_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
        member: {
          email: "member@example.com",
        },
      },
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Example",
        email: "member@example.com",
      },
    };
    const updatedRefundRequest = {
      ...initialRefundRequest,
      status: "APPROVED",
      approvedAmountCents: 2500,
    };

    mocks.refundRequestFindUnique
      .mockResolvedValueOnce(initialRefundRequest)
      .mockResolvedValueOnce(updatedRefundRequest);

    const request = new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({
        status: "APPROVED",
        approvedAmountCents: 2500,
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 2500,
      metadata: {
        bookingId: "booking_1",
        reason: "refund_appeal_approved",
        refundRequestId: "refund_1",
      },
      idempotencyKeyPrefix: "refund_request_refund_1",
    });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      2500,
      {
        createdByMemberId: "admin_1",
      }
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  function approvedRefundRequest() {
    return {
      id: "refund_1",
      status: "PENDING",
      booking: {
        id: "booking_1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        payment: {
          id: "payment_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
        member: { email: "member@example.com" },
      },
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Example",
        email: "member@example.com",
      },
    };
  }

  function approveRequest() {
    return new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ status: "APPROVED", approvedAmountCents: 2500 }),
    });
  }

  // Issue #818: the refund must be claimed before any Stripe money movement, so
  // a concurrent approval that loses the claim never issues a refund.
  it("does not issue a Stripe refund when the claim is lost to a concurrent approval", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 0 });

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  // Issue #818: if the Stripe refund fails after the claim, the claim is
  // released back to PENDING so the appeal can be retried.
  it("releases the claim back to PENDING when the Stripe refund fails", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(500);
    // First updateMany claims (PENDING -> APPROVED); second reverts to PENDING.
    expect(mocks.refundRequestUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.refundRequestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "refund_1", status: "APPROVED" },
        data: expect.objectContaining({ status: "PENDING", approvedAmountCents: null }),
      })
    );
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});
