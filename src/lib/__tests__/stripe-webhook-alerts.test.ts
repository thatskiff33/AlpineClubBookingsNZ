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
  mockCreateXeroInvoiceForBooking,
  mockCreateXeroCreditNote,
  mockNotifyXeroSyncError,
  mockSendBookingConfirmedEmail,
  mockSendAdminPaymentFailureAlert,
  mockSendSetupIntentFailedEmail,
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
  mockCreateXeroInvoiceForBooking: vi.fn().mockResolvedValue("inv_1"),
  mockCreateXeroCreditNote: vi.fn().mockResolvedValue("cn_1"),
  mockNotifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
  mockSendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockSendSetupIntentFailedEmail: vi.fn().mockResolvedValue(undefined),
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
  createXeroInvoiceForBooking: (...args: unknown[]) => mockCreateXeroInvoiceForBooking(...args),
  createXeroCreditNote: (...args: unknown[]) => mockCreateXeroCreditNote(...args),
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: (...args: unknown[]) => mockNotifyXeroSyncError(...args),
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendBookingConfirmedEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendSetupIntentFailedEmail: (...args: unknown[]) => mockSendSetupIntentFailedEmail(...args),
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
    mockIsXeroConnected.mockResolvedValue(true);
    mockCreateXeroInvoiceForBooking.mockRejectedValue(new Error("Xero invoice failed"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "INVOICE_CREATION",
      operation: "Create invoice for booking booking-1",
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
    });
    mockIsXeroConnected.mockResolvedValue(true);
    mockCreateXeroCreditNote.mockRejectedValue(new Error("Xero credit note failed"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-2" },
      data: {
        refundedAmountCents: 5000,
        status: "REFUNDED",
      },
    });
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "CREDIT_NOTE_CREATION",
      operation: "Create refund credit note for payment payment-2",
      errorMessage: "Xero credit note failed",
    });
  });
});
