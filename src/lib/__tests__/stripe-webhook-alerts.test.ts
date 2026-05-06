import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockConstructWebhookEvent,
  mockProcessedWebhookCreate,
  mockProcessedWebhookDeleteMany,
  mockPaymentFindUnique,
  mockPaymentUpdate,
  mockBookingFindUnique,
  mockBookingUpdateMany,
  mockTransaction,
  mockRecordWebhookLog,
  mockIsXeroConnected,
  mockEnqueueXeroBookingInvoiceOperation,
  mockEnqueueXeroRefundCreditNoteOperation,
  mockKickQueuedXeroOutboxOperationsIfConnected,
  mockNotifyXeroSyncError,
  mockSendBookingConfirmedEmail,
  mockSendAdminPaymentFailureAlert,
  mockSendSetupIntentFailedEmail,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockConstructWebhookEvent: vi.fn(),
  mockProcessedWebhookCreate: vi.fn(),
  mockProcessedWebhookDeleteMany: vi.fn(),
  mockPaymentFindUnique: vi.fn(),
  mockPaymentUpdate: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockBookingUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockEnqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_1",
    message: "queued",
  }),
  mockEnqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_credit_note_1",
    message: "queued",
  }),
  mockKickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({
    found: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  }),
  mockNotifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
  mockSendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockSendSetupIntentFailedEmail: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...args: unknown[]) => mockConstructWebhookEvent(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedWebhookEvent: {
      create: (...args: unknown[]) => mockProcessedWebhookCreate(...args),
      deleteMany: (...args: unknown[]) => mockProcessedWebhookDeleteMany(...args),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock("@/lib/webhook-log", () => ({
  recordWebhookLog: (...args: unknown[]) => mockRecordWebhookLog(...args),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) =>
    mockEnqueueXeroRefundCreditNoteOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: (...args: unknown[]) => mockNotifyXeroSyncError(...args),
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendBookingConfirmedEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendSetupIntentFailedEmail: (...args: unknown[]) => mockSendSetupIntentFailedEmail(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST } from "@/app/api/webhooks/stripe/route";

describe("Stripe webhook Xero alerting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        payment: {
          update: (...args: unknown[]) => mockPaymentUpdate(...args),
        },
        booking: {
          updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
          findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
        },
      })
    );
  });

  function makeRequest() {
    return new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "test-sig" },
      body: JSON.stringify({}),
    });
  }

  it("uses the deduplicated notifier when invoice creation fails after payment success", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_primary",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_primary",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      bookingId: "booking-1",
      amountCents: 5000,
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 5000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      promoRedemption: null,
    });
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero invoice failed"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "INVOICE_CREATION",
      operation: "Queue invoice for booking booking-1",
      errorMessage: "Xero invoice failed",
    });
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "stripe",
        eventType: "payment_intent.succeeded",
        status: "success",
      })
    );
  });

  it("uses the deduplicated notifier when credit note creation fails after a refund webhook", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund",
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: "pi_refund",
          amount_refunded: 5000,
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-2",
      amountCents: 5000,
      refundedAmountCents: 0,
    });
    mockIsXeroConnected.mockResolvedValue(true);
    mockEnqueueXeroRefundCreditNoteOperation.mockRejectedValue(
      new Error("Xero credit note failed")
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-2" },
      data: {
        refundedAmountCents: 5000,
        status: "REFUNDED",
      },
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment-2",
      5000
    );
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "CREDIT_NOTE_CREATION",
      operation: "Queue refund credit note for payment payment-2",
      errorMessage: "Xero credit note failed",
    });
  });

  it("queues only the newly observed refund delta from Stripe's cumulative amount", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_delta",
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: "pi_refund_delta",
          amount_refunded: 5000,
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-3",
      amountCents: 5000,
      refundedAmountCents: 1200,
    });
    mockIsXeroConnected.mockResolvedValue(false);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-3" },
      data: {
        refundedAmountCents: 5000,
        status: "REFUNDED",
      },
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment-3",
      3800
    );
  });

  it("marks canceled additional payment intents as failed when Stripe sends payment_intent.canceled", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_additional",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_additional_canceled",
          amount: 2500,
          cancellation_reason: "requested_by_customer",
          metadata: {
            bookingId: "booking-4",
            type: "modification_additional",
          },
        },
      },
    } as any);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { bookingId: "booking-4" },
      data: { additionalPaymentStatus: "FAILED" },
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: "booking.modification.payment.canceled",
      targetId: "booking-4",
      details: JSON.stringify({
        paymentIntentId: "pi_additional_canceled",
        amountCents: 2500,
        cancellationReason: "requested_by_customer",
      }),
    });
  });

  it("does not queue a new Xero refund credit note when Stripe repeats the same cumulative refund total", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_repeat",
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: "pi_refund_repeat",
          amount_refunded: 5000,
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-4",
      amountCents: 5000,
      refundedAmountCents: 5000,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-4" },
      data: {
        refundedAmountCents: 5000,
        status: "REFUNDED",
      },
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});
