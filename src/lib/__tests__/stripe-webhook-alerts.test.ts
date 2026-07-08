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
  mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
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
  mockProcessRefund,
  mockApplyGroupSettlementSucceeded,
  mockMarkGroupSettlementIntentFailed,
  mockGroupBookingFindUnique,
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
  mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent: vi
    .fn()
    .mockResolvedValue(false),
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
  mockProcessRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  mockApplyGroupSettlementSucceeded: vi.fn().mockResolvedValue({
    outcome: "settled",
    settledBookingIds: [],
  }),
  mockMarkGroupSettlementIntentFailed: vi.fn().mockResolvedValue(undefined),
  mockGroupBookingFindUnique: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...args: unknown[]) => mockConstructWebhookEvent(...args),
  listRefundsForCharge: (...args: unknown[]) => mockListRefundsForCharge(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
}));
vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceeded: (...args: unknown[]) =>
    mockApplyGroupSettlementSucceeded(...args),
  markGroupSettlementIntentFailed: (...args: unknown[]) =>
    mockMarkGroupSettlementIntentFailed(...args),
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
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
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
    // #1641 — the capture guard derives applied credit from the ledger only when
    // the captured amount is not the full price; these fixtures apply none.
    memberCredit: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
    },
    groupBooking: {
      findUnique: (...args: unknown[]) => mockGroupBookingFindUnique(...args),
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
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent: (
    ...args: unknown[]
  ) => mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(...args),
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
    mockProcessRefund.mockResolvedValue({ id: "re_1" });
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "settled",
      settledBookingIds: [],
    });
    mockMarkGroupSettlementIntentFailed.mockResolvedValue(undefined);
    mockGroupBookingFindUnique.mockResolvedValue(null);
    mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(
      false,
    );
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

  it("returns 400 when the Stripe signature header is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing stripe-signature header",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized Stripe webhook payloads before signature verification", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "test-sig",
          "content-length": String(1024 * 1024 + 1),
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload too large",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed Stripe webhook content-length before signature verification", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "test-sig",
          "content-length": "42x",
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid content-length header",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a present-but-invalid Stripe signature without processing the event", async () => {
    // Wrong-signature row of the webhook Critical matrix (issue #1133): the
    // header is present but verification fails, so nothing may be processed
    // and no idempotency claim may be written.
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload"
      );
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook signature verification failed",
    });
    expect(mockProcessedWebhookCreate).not.toHaveBeenCalled();
  });

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

  it("alerts and refuses a capture whose amount no longer matches the booking total (#1161)", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_stale_capture",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_stale",
          amount: 10000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    // Transaction mirrors the intent (both 10000), so the tx-vs-intent check
    // passes; only the booking's CURRENT price reveals the staleness.
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 10000,
      status: "PENDING",
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "PAYMENT_PENDING",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      promoRedemption: null,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_stale",
        amountCents: 10000,
        errorMessage: expect.stringContaining("stale intent"),
      }),
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

  it("logs payment_intent.requires_action as an observability event without mutating state", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_requires_action",
      type: "payment_intent.requires_action",
      data: {
        object: {
          id: "pi_requires_action",
          amount: 6000,
          metadata: { bookingId: "booking-3ds" },
          next_action: { type: "use_stripe_sdk" },
        },
      },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_3ds",
      kind: "ADDITIONAL",
      paymentId: "pay_3ds",
      status: "PENDING",
      createdAt: new Date(),
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFindPaymentTransactionByIntentId).toHaveBeenCalledWith({
      paymentIntentId: "pi_requires_action",
    });
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  it("logs payment_intent.processing as an observability event without mutating state", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_processing",
      type: "payment_intent.processing",
      data: {
        object: {
          id: "pi_processing",
          amount: 6000,
          metadata: { bookingId: "booking-bank-debit" },
        },
      },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFindPaymentTransactionByIntentId).toHaveBeenCalledWith({
      paymentIntentId: "pi_processing",
    });
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  // Issue #815 / #814(#6): duplicate Stripe delivery must be a no-op. The
  // ProcessedWebhookEvent claim is the idempotency boundary; when the claim
  // already exists (P2002) the handler chain must not run again.
  it("short-circuits a duplicate Stripe event without re-running handlers", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_dup",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_dup",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    // The event was already processed: claiming it hits the unique constraint.
    mockProcessedWebhookCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    // Issue #815: the claim is scoped to the stripe source so the composite
    // (source, eventId) idempotency key is always fully populated and a Stripe
    // event ID can never collide with a Xero/SES event that shares the same id.
    expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
      data: { eventId: "evt_dup", source: "stripe", eventType: "payment_intent.succeeded" },
    });

    // No downstream payment, booking, Xero, recovery, or email side effects.
    expect(mockQueueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();

    // The existing claim is left intact (it belongs to the first delivery) and
    // the early return happens before the success webhook log is recorded.
    expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    expect(mockRecordWebhookLog).not.toHaveBeenCalled();
  });

  // Issue #815: when a handler fails after the event was claimed, the claim
  // must be released so Stripe's automatic retry can reprocess the event.
  it("releases the processed-event claim when a handler throws so retries work", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_fail",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_fail",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    mockProcessedWebhookCreate.mockResolvedValue({}); // claim succeeds
    // Force the handler to throw after the claim is taken.
    mockFindPaymentTransactionByIntentId.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: { eventId: "evt_fail", source: "stripe" },
    });
  });

  // Issue #1016: a captured group-settlement intent that matches no PENDING
  // settlement is a superseded intent confirmed off a retained client_secret.
  function groupSettlementSucceededEvent(eventId: string, intentId: string) {
    return {
      id: eventId,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: intentId,
          amount: 50000,
          payment_method: "pm_group",
          metadata: { type: "group_settlement", groupBookingId: "group-1" },
        },
      },
    } as any;
  }

  it("refunds and alerts exactly once when a succeeded group settlement intent matches no settlement", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_orphan", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockGroupBookingFindUnique.mockResolvedValue({
      organiserMember: { firstName: "Olive", lastName: "Organiser" },
      organiserBooking: {
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockApplyGroupSettlementSucceeded).toHaveBeenCalledWith({
      id: "pi_group_stale",
      amount: 50000,
    });
    // Full refund with a deterministic per-intent idempotency key.
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockProcessRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_group_stale",
      amountCents: 50000,
      reason: "requested_by_customer",
      metadata: {
        groupBookingId: "group-1",
        reason: "group_settlement_superseded",
      },
      idempotencyKey: "group_settlement_superseded_refund_pi_group_stale",
    });
    // One admin alert naming the organiser.
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Olive Organiser",
        amountCents: 50000,
        paymentIntentId: "pi_group_stale",
      }),
    );
    // The group path never falls through to the per-booking handlers.
    expect(mockQueueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("refunds and alerts exactly once when a succeeded group settlement intent mismatches the recorded amount", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mismatch", "pi_group_mismatch"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockProcessRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_group_mismatch",
        amountCents: 50000,
        idempotencyKey: "group_settlement_superseded_refund_pi_group_mismatch",
      }),
    );
    // The alert still sends when the group cannot be loaded for details.
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("does not refund or alert when the group settlement applies cleanly", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_ok", "pi_group_ok"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "settled",
      settledBookingIds: ["child-1"],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("short-circuits a redelivered group settlement event without refunding or alerting again", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_dup", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    // The first delivery already claimed and processed this event.
    mockProcessedWebhookCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockApplyGroupSettlementSucceeded).not.toHaveBeenCalled();
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("alerts, releases the claim, and returns 500 when the group settlement refund fails", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_refund_fail", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockProcessRefund.mockRejectedValue(new Error("stripe unavailable"));

    const response = await POST(makeRequest());

    // The failure alert still reaches admins, and the released claim lets
    // Stripe's redelivery retry the refund (idempotency key stops doubles).
    expect(response.status).toBe(500);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("automatic refund failed"),
      }),
    );
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: { eventId: "evt_group_refund_fail", source: "stripe" },
    });
  });

  // ---------------------------------------------------------------------------
  // F1 (#1350): a late Stripe capture of an ADDITIONAL modification payment on
  // a CANCELLED booking must be refunded + alerted, never recorded as paid,
  // and the supplementary Xero invoice must never be released.
  // ---------------------------------------------------------------------------
  describe("late additional capture on a cancelled booking (#1350)", () => {
    function additionalSucceededEvent(id = "evt_add_cancelled") {
      return {
        id,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_additional_late",
            amount: 2500,
            payment_method: "pm_late",
            metadata: {
              bookingId: "booking-9",
              type: "modification_additional",
            },
          },
        },
      } as any;
    }

    function armCancelledBooking(xeroInvoiceId: string | null = null) {
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-9",
        status: "CANCELLED",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        member: { firstName: "Alice", lastName: "Example" },
        payment: { id: "payment-9", xeroInvoiceId },
      });
    }

    it("refunds and alerts instead of recording the capture and releasing the supplementary invoice", async () => {
      mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent());
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        // The cancel claim marked it FAILED — exactly the state the old code
        // flipped straight to SUCCEEDED and released the invoice for.
        status: "FAILED",
      });
      armCancelledBooking();
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          { paymentIntentId: "pi_additional_late", refundId: "re_late_9", amountCents: 2500 },
        ],
        totalRefundedAmountCents: 2500,
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The capture is recorded truthfully, then refunded in full under the
      // idempotent late-cancel key pinned to this transaction.
      expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
        paymentMethodId: "pm_late",
      });
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith({
        paymentId: "payment-9",
        amountCents: 2500,
        allocation: [{ paymentTransactionId: "txn-9", amountCents: 2500 }],
        metadata: {
          bookingId: "booking-9",
          reason: "cancelled_booking_late_capture",
        },
        idempotencyKeyPrefix: "late_cancel_refund_booking-9_pi_additional_late",
      });
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 2500,
          paymentIntentId: "pi_additional_late",
        }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
          targetId: "booking-9",
        }),
      );
      // The supplementary Xero invoice is NEVER released on this path.
      expect(
        mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
      ).not.toHaveBeenCalled();
      // No Xero presence -> no corrective credit note.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("does not flip an already-refunded transaction back on webhook replay, and still never releases the invoice", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_replay"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "REFUNDED",
      });
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
      // The refund replays the identical keys; Stripe answers with the
      // original refund and the ledger dedupes.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKeyPrefix:
            "late_cancel_refund_booking-9_pi_additional_late",
        }),
      );
      expect(
        mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    it("enqueues the corrective refund credit note when the supplementary invoice was already released in a race", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_raced"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(
        true,
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment-9",
        2500,
      );
    });

    it("fails the webhook (retryable) when the refund cannot be issued, instead of swallowing the debt", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_refund_down"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRefundPaymentTransactions.mockRejectedValue(new Error("stripe down"));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // The processed-event marker is cleared so Stripe's retry re-runs the
      // handler with the same idempotent refund keys.
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalled();
      expect(
        mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    it("keeps the live-booking additional payment path unchanged (mark + release, no refund)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_live"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "PENDING",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-9",
        status: "PAID",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        member: { firstName: "Alice", lastName: "Example" },
        payment: { id: "payment-9", xeroInvoiceId: null },
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
        paymentMethodId: "pm_late",
      });
      expect(
        mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
      ).toHaveBeenCalledWith("pi_additional_late");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });
  });
});
