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
  mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
  mockNotifyXeroSyncError,
  mockSendBookingConfirmedEmail,
  mockSendAdminPaymentFailureAlert,
  mockSendSetupIntentFailedEmail,
  mockLogAudit,
  mockFindPaymentTransactionByIntentId,
  mockMarkPaymentIntentTransactionFailed,
  mockMarkPaymentIntentTransactionSucceeded,
  mockRefundPaymentTransactions,
  mockSyncRefundsFromStripeCharge,
  mockUpsertPaymentIntentTransaction,
  mockCompleteCanceledSupersededPaymentIntentRecovery,
  mockQueueSupersededPaymentIntentRefundRecovery,
  mockMarkBookingPaymentSucceeded,
  mockMarkBookingSetupIntentSucceeded,
  mockListRefundsForCharge,
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
  mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent: vi.fn().mockResolvedValue({
    released: 0,
    queueOperationIds: [],
  }),
  mockNotifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
  mockSendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockSendSetupIntentFailedEmail: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
  mockFindPaymentTransactionByIntentId: vi.fn(),
  mockMarkPaymentIntentTransactionFailed: vi.fn().mockResolvedValue(undefined),
  mockMarkPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue(undefined),
  mockRefundPaymentTransactions: vi.fn().mockResolvedValue({
    refunds: [],
    totalRefundedAmountCents: 0,
  }),
  mockSyncRefundsFromStripeCharge: vi.fn().mockResolvedValue(null),
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
  mockCompleteCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(false),
  mockQueueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(false),
  mockMarkBookingPaymentSucceeded: vi.fn().mockResolvedValue({
    outcome: "paid",
    bookingId: "booking-1",
    bumpedBookingIds: [],
  }),
  mockMarkBookingSetupIntentSucceeded: vi.fn().mockResolvedValue(undefined),
  mockListRefundsForCharge: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...args: unknown[]) => mockConstructWebhookEvent(...args),
  listRefundsForCharge: (...args: unknown[]) => mockListRefundsForCharge(...args),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
  markBookingSetupIntentSucceeded: (...args: unknown[]) =>
    mockMarkBookingSetupIntentSucceeded(...args),
}));
vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mockFindPaymentTransactionByIntentId(...args),
  markPaymentIntentTransactionFailed: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionFailed(...args),
  markPaymentIntentTransactionSucceeded: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionSucceeded(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  syncRefundsFromStripeCharge: (...args: unknown[]) =>
    mockSyncRefundsFromStripeCharge(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));
vi.mock("@/lib/payment-recovery", () => ({
  completeCanceledSupersededPaymentIntentRecovery: (...args: unknown[]) =>
    mockCompleteCanceledSupersededPaymentIntentRecovery(...args),
  queueSupersededPaymentIntentRefundRecovery: (...args: unknown[]) =>
    mockQueueSupersededPaymentIntentRefundRecovery(...args),
  getStripePaymentMethodId: (paymentIntent: {
    payment_method?: string | { id?: string | null } | null;
  }) =>
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null,
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
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: (...args: unknown[]) =>
    mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent(...args),
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
    mockFindPaymentTransactionByIntentId.mockResolvedValue(null);
    mockMarkPaymentIntentTransactionFailed.mockResolvedValue(undefined);
    mockMarkPaymentIntentTransactionSucceeded.mockResolvedValue(undefined);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockSyncRefundsFromStripeCharge.mockResolvedValue(null);
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(false);
    mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValue(false);
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    mockMarkBookingSetupIntentSucceeded.mockResolvedValue(undefined);
    mockListRefundsForCharge.mockResolvedValue([]);
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

    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 5000,
      status: "PENDING",
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "CONFIRMED",
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
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_primary",
      amountCents: 5000,
      paymentMethodId: "pm_123",
    });
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
          id: "ch_refund",
          payment_intent: "pi_refund",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund",
        amount: 5000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund",
        payment_intent: "pi_refund",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-2",
      refundDeltaCents: 5000,
      payment: {
        id: "payment-2",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });
    mockIsXeroConnected.mockResolvedValue(true);
    mockEnqueueXeroRefundCreditNoteOperation.mockRejectedValue(
      new Error("Xero credit note failed")
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockListRefundsForCharge).toHaveBeenCalledWith("ch_refund");
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund",
      stripeChargeId: "ch_refund",
      refundedAmountCents: 5000,
      refunds,
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
          id: "ch_refund_delta",
          payment_intent: "pi_refund_delta",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund_delta",
        amount: 3800,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund_delta",
        payment_intent: "pi_refund_delta",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-3",
      refundDeltaCents: 3800,
      payment: {
        id: "payment-3",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });
    mockIsXeroConnected.mockResolvedValue(false);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund_delta",
      stripeChargeId: "ch_refund_delta",
      refundedAmountCents: 5000,
      refunds,
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

    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-4",
      paymentId: "payment-4",
      kind: "ADDITIONAL",
      amountCents: 2500,
      status: "PENDING",
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_additional_canceled",
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

  it("completes superseded cancellation recovery when Stripe sends payment_intent.canceled", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_superseded",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_superseded_canceled",
          amount: 6000,
          cancellation_reason: "requested_by_customer",
          metadata: {
            bookingId: "booking-5",
          },
        },
      },
    } as any);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockCompleteCanceledSupersededPaymentIntentRecovery).toHaveBeenCalledWith({
      paymentIntentId: "pi_superseded_canceled",
    });
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
  });

  it("queues refund recovery instead of confirming a superseded succeeded PaymentIntent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_succeeded_superseded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_superseded_succeeded",
          amount: 6000,
          payment_method: "pm_superseded",
          metadata: {
            bookingId: "booking-5",
          },
        },
      },
    } as any);
    mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValue(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockQueueSupersededPaymentIntentRefundRecovery).toHaveBeenCalledWith({
      paymentIntentId: "pi_superseded_succeeded",
      amountCents: 6000,
      paymentMethodId: "pm_superseded",
    });
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("ignores stale failed intents when no current payment transaction matches the webhook intent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_failed_stale",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_stale_failed",
          amount: 2500,
          metadata: {
            bookingId: "booking-5",
          },
          last_payment_error: {
            message: "Card declined",
          },
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("ignores stale canceled intents when no current payment transaction matches the webhook intent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_stale",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_stale_canceled",
          amount: 2500,
          cancellation_reason: "abandoned",
          metadata: {
            bookingId: "booking-6",
          },
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("does not queue a new Xero refund credit note when Stripe repeats the same cumulative refund total", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_repeat",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_repeat",
          payment_intent: "pi_refund_repeat",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund_repeat",
        amount: 5000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund_repeat",
        payment_intent: "pi_refund_repeat",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-4",
      refundDeltaCents: 0,
      payment: {
        id: "payment-4",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund_repeat",
      stripeChargeId: "ch_refund_repeat",
      refundedAmountCents: 5000,
      refunds,
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("does not enqueue a Xero credit note when a recovery-driven refund's webhook arrives after the ledger is already up to date", async () => {
    // Scenario: the payment recovery worker called refundPaymentTransactions,
    // which recorded the Stripe refund ledger entry and updated the
    // PaymentTransaction.refundedAmountCents. The charge.refunded webhook
    // arrives afterwards; syncRefundsFromStripeCharge sees the cumulative
    // total matches the ledger and returns refundDeltaCents=0. The handler
    // must not enqueue a duplicate Xero credit note.
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_recovery_refund_webhook",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_recovery_refund",
          payment_intent: "pi_recovery_refund",
          amount_refunded: 4000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_recovery",
        amount: 4000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000001,
        charge: "ch_recovery_refund",
        payment_intent: "pi_recovery_refund",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-recovery",
      refundDeltaCents: 0,
      payment: {
        id: "payment-recovery",
        amountCents: 4000,
        refundedAmountCents: 4000,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});
