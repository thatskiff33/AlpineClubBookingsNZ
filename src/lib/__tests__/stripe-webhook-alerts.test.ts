import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockConstructWebhookEvent,
  mockProcessedWebhookCreate,
  mockProcessedWebhookDeleteMany,
  mockProcessedWebhookFindFirst,
  mockProcessedWebhookUpdateMany,
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
  mockMarkGroupSettlementIntentRefunded,
  mockGroupBookingFindUnique,
  mockRecordAutomaticCancelledBookingRefundTask,
  mockFindCompletedHandBackForLateCapture,
  mockSendAdminLateCaptureAutoRefundAlert,
  mockSendAdminLateCaptureHandBackConflictAlert,
} = vi.hoisted(() => ({
  mockConstructWebhookEvent: vi.fn(),
  mockProcessedWebhookCreate: vi.fn(),
  mockProcessedWebhookDeleteMany: vi.fn(),
  mockProcessedWebhookFindFirst: vi.fn(),
  mockProcessedWebhookUpdateMany: vi.fn(),
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
  mockMarkGroupSettlementIntentRefunded: vi.fn().mockResolvedValue(undefined),
  mockGroupBookingFindUnique: vi.fn().mockResolvedValue(null),
  // #2700 close, #2760 close-or-write, #2773 both handlers.
  // `existingStatus: null` is the healthy default: nothing was already there, so
  // this call IS the record. #2774 reads this field to detect the hand-COMPLETED
  // row that means the member was paid twice.
  mockRecordAutomaticCancelledBookingRefundTask: vi.fn().mockResolvedValue({
    closed: 0,
    created: true,
    alreadyRecorded: false,
    existingStatus: null,
  }),
  // #2774: the fence. `null` is "no operator has handed this capture back", which
  // is every ordering except the one the fence exists for.
  mockFindCompletedHandBackForLateCapture: vi.fn().mockResolvedValue(null),
  // #2761: this path's own unmuteable alert, in place of the generic
  // payment-failure mail.
  mockSendAdminLateCaptureAutoRefundAlert: vi.fn().mockResolvedValue(undefined),
  // #2774: the reconciliation alert that replaces it when an operator's hand-back
  // and the automatic refund claim the same capture.
  mockSendAdminLateCaptureHandBackConflictAlert: vi
    .fn()
    .mockResolvedValue(undefined),
}));

/*
  Only the two LEAF functions are mocked, not the shared epilogue in
  `cancelled-booking-late-capture.ts` (#2773). That module is deliberately left
  REAL here: it is the thing that decides which alert goes out, whether the record
  failure is audited, and whether #2774's fence returns before the refund — and a
  test that mocked it would assert the handler calls something rather than that the
  right thing happens. Its collaborators (`@/lib/audit`, `@/lib/email`,
  `@/lib/prisma`, `@/lib/logger`) are all already mocked below, so it runs against
  the same doubles the handler does.
*/
vi.mock("@/lib/deleted-booking-modification-payment", () => ({
  recordAutomaticCancelledBookingRefundTask: (...args: unknown[]) =>
    mockRecordAutomaticCancelledBookingRefundTask(...args),
  findCompletedHandBackForLateCapture: (...args: unknown[]) =>
    mockFindCompletedHandBackForLateCapture(...args),
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...args: unknown[]) => mockConstructWebhookEvent(...args),
  listRefundsForCharge: (...args: unknown[]) => mockListRefundsForCharge(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
}));
// DB-only (#2082): the webhook route resolves its signing secret via
// stripe-config and records a test-mode verified marker; mock both so the route
// reaches signature verification without a DB.
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeWebhookSecret: vi.fn().mockResolvedValue("whsec_test"),
  recordStripeWebhookVerified: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceeded: (...args: unknown[]) =>
    mockApplyGroupSettlementSucceeded(...args),
  markGroupSettlementIntentFailed: (...args: unknown[]) =>
    mockMarkGroupSettlementIntentFailed(...args),
  markGroupSettlementIntentRefunded: (...args: unknown[]) =>
    mockMarkGroupSettlementIntentRefunded(...args),
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
      findFirst: (...args: unknown[]) => mockProcessedWebhookFindFirst(...args),
      updateMany: (...args: unknown[]) => mockProcessedWebhookUpdateMany(...args),
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
  // #2761: the late-capture path's own unmuteable alert.
  sendAdminLateCaptureAutoRefundAlert: (...args: unknown[]) =>
    mockSendAdminLateCaptureAutoRefundAlert(...args),
  // #2774: the hand-back conflict alert, which REPLACES the one above whenever an
  // operator's hand-back and the automatic refund claim the same capture.
  sendAdminLateCaptureHandBackConflictAlert: (...args: unknown[]) =>
    mockSendAdminLateCaptureHandBackConflictAlert(...args),
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
    // F16 (#1887): the claim is a lease. Default findFirst to a COMPLETED row so
    // a P2002 duplicate short-circuits as before; updateMany (the COMPLETED
    // stamp on success, and the lease takeover) defaults to one affected row.
    mockProcessedWebhookFindFirst.mockResolvedValue({
      status: "COMPLETED",
      processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
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
      category: "payment",
      entityType: "Booking",
      entityId: "booking-4",
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
    // F16 (#1887): the existing claim is COMPLETED, so the redelivery is a true
    // duplicate and short-circuits with 200.
    mockProcessedWebhookFindFirst.mockResolvedValue({
      status: "COMPLETED",
      processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    // Issue #815: the claim is scoped to the stripe source so the composite
    // (source, eventId) idempotency key is always fully populated and a Stripe
    // event ID can never collide with a Xero/SES event that shares the same id.
    // F16 (#1887): the claim now also carries the lease fields.
    expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
      data: {
        eventId: "evt_dup",
        source: "stripe",
        eventType: "payment_intent.succeeded",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
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
    // F16 fence (#1887): the release is keyed on status + the claimed lease token.
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "evt_fail",
        source: "stripe",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
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

  it("auto-refunds a late capture rejected by the durable group-cancel fence (#1881)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_cancelled", "pi_group_cancelled"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "cancelled",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_group_cancelled",
        amountCents: 50000,
        idempotencyKey:
          "group_settlement_superseded_refund_pi_group_cancelled",
      }),
    );
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledWith(
      "pi_group_cancelled"
    );
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

  // #1883 (F6) — the auto-refund must also mark the settlement row, or the
  // refunded intent (which stays "succeeded" in Stripe forever) can be
  // re-admitted later and settle the children with money already handed back.
  it("marks the settlement refunded after the auto-refund closes it out (#1883)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mark", "pi_group_mismatch"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledTimes(1);
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledWith(
      "pi_group_mismatch",
    );
    // The mark happens only once the money is actually back with the organiser.
    expect(
      mockMarkGroupSettlementIntentRefunded.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockProcessRefund.mock.invocationCallOrder[0]);
  });

  it("does not mark the settlement refunded when the refund itself fails (#1883)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mark_fail", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockProcessRefund.mockRejectedValue(new Error("stripe unavailable"));

    const response = await POST(makeRequest());

    // No refund happened, so the settlement must stay untouched; the released
    // claim lets Stripe redeliver and retry the refund + mark together.
    expect(response.status).toBe(500);
    expect(mockMarkGroupSettlementIntentRefunded).not.toHaveBeenCalled();
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
    // F16 fence (#1887): release keyed on status + the claimed lease token.
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "evt_group_refund_fail",
        source: "stripe",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
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

    /**
     * #2760: `deletedAt` is now part of what this handler reads, because the
     * record and the alert both name which population the capture belonged to.
     * Defaults to the DELETED population — a soft-deleted booking is always
     * CANCELLED (`INV-ADDPAY-030`), which is the case #2700 and #2750 were about —
     * and the merely-cancelled population passes `deletedAt: null` explicitly.
     */
    function armCancelledBooking(
      xeroInvoiceId: string | null = null,
      deletedAt: Date | null = new Date("2026-06-20"),
    ) {
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-9",
        status: "CANCELLED",
        deletedAt,
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
      // #2761: its own alert, not the generic "Payment Failed" mail. Exactly one
      // notification for the event — the old sender is not called on this path at
      // all.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 2500,
          paymentIntentId: "pi_additional_late",
          bookingId: "booking-9",
          bookingDeleted: true,
        }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
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

    /**
     * #2700 — this pre-existing #1350 path is the reason the deleted-booking
     * ManualRefundTask needs closing rather than leaving OPEN.
     *
     * A soft-deleted booking is ALWAYS CANCELLED (`INV-ADDPAY-030`), so every
     * deleted booking reaches the branch above. If the browser confirm won the
     * race first, it recorded the capture and raised an OPEN task asking a human
     * to decide whether to refund. The refund this handler has just issued
     * answers that question, and an operator who then COMPLETES the task would
     * write a SECOND refund allocation through `resolveManualRefundTask` and
     * double-count one refund in the ledger.
     *
     * MUTATION PROOF: delete the close call from
     * `handleCancelledBookingAdditionalPaymentSucceeded` and this fails by name.
     */
    it("records the automatic refund after refunding, with the amount and the population (#2700 / #2760)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_task_close"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith({
        bookingId: "booking-9",
        paymentId: "payment-9",
        paymentIntentId: "pi_additional_late",
        // #2760: the captured cents, so the row the webhook may have to CREATE
        // states the amount that went back. Integer cents, straight from the
        // intent — nothing recomputes a refund.
        amountCents: 2500,
        bookingDeleted: true,
        // #2773: which sentence the row stores. This handler is the
        // booking-CHANGE one, and the sibling passes "primary" — asserted here
        // exactly rather than loosely, because the reason is operator-facing text
        // on the finance card and a wrong kind prints a false sentence.
        captureKind: "modification",
      });
      // Recorded AFTER the money actually went back, never before.
      expect(
        mockRefundPaymentTransactions.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRecordAutomaticCancelledBookingRefundTask.mock
          .invocationCallOrder[0],
      );
    });

    it("records and alerts the cancelled-but-not-deleted population too (#2760)", async () => {
      /*
        The population the owner widened this to, deliberately over the narrower
        recommendation. #1350's refund fires on `status === "CANCELLED"`, not on
        `deletedAt`, so this capture was already being auto-refunded — it simply
        left no operator record anywhere, because the confirm route's raise is
        gated on `deletedAt`.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_live_booking"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking(null, null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false, amountCents: 2500 }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false }),
      );
      // The refund itself is unchanged by the population.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-9",
          amountCents: 2500,
          idempotencyKeyPrefix:
            "late_cancel_refund_booking-9_pi_additional_late",
        }),
      );
    });

    it("still returns 200 when recording that task fails (#2700 / #2760)", async () => {
      // The money is already back with the member. A 500 here would clear the
      // processed-event marker and replay the whole refund path for the sake of
      // a bookkeeping row.
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_task_close_fails"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("database is down"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
    });

    it("writes a CRITICAL audit row when the record write fails, because Stripe will never redeliver a 200", async () => {
      /*
        THE BLOCKER THIS PINS (review of #2760). Answering 200 is right — the money
        is back with the member and a 500 replays the refund path — but it means
        Stripe never redelivers and NOTHING else in the tree ever writes that row.
        Meanwhile the finance card and `INV-ADDPAY-037` both now assert the record
        is complete. A container log is not a record, so the loss has to surface on
        the audit log the card itself names as permanent: `critical` severity,
        `outcome: "failure"`, carrying the booking and the payment intent so a
        finance operator can reconcile it by hand against the
        `refunded_after_cancellation` entry beside it.

        Mutation proof: delete the `logAudit` call in the catch and this fails while
        every other test in the file still passes.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_record_fails_audited"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("could not serialize access due to concurrent update"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.auto_refund_record_failed",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityType: "Booking",
          entityId: "booking-9",
        }),
      );
      const failureRow = mockLogAudit.mock.calls
        .map(([params]) => params as { action: string; details?: string })
        .find(
          (params) =>
            params.action === "booking.payment.auto_refund_record_failed",
        );
      expect(failureRow?.details).toBeDefined();
      expect(JSON.parse(failureRow?.details ?? "{}")).toMatchObject({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
      });
      // The refund entry is still written beside it: the money DID go back, and
      // reconciling the gap by hand needs both rows.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
        }),
      );
      // And the club is still told at the time — a lost bookkeeping row must not
      // also cost the notification.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
    });

    it("re-reads deletedAt after the Stripe round trip, so a deletion mid-refund is not recorded as 'still on file'", async () => {
      /*
        The booking is loaded BEFORE `refundPaymentTransactions` makes a live
        Stripe round trip, and both the stored `reason` sentence and the alert's
        follow-up paragraph name which population the capture belonged to. An admin
        deleting the booking inside that window would otherwise store "cancelled,
        still on file" and mail "normally nothing to do" for precisely the case that
        needs a person — remake the booking and charge the member again. The confirm
        route re-reads the same flag after its own round trip for the same reason.

        Deletion is one-way (`INV-ADDPAY-030`), so the two reads can only disagree
        in one direction: the stale read can only ever UNDER-report a deletion.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_deleted_mid_refund"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      // Opening read: cancelled, not deleted. Re-read: deleted.
      mockBookingFindUnique
        .mockResolvedValueOnce({
          id: "booking-9",
          status: "CANCELLED",
          deletedAt: null,
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          member: { firstName: "Alice", lastName: "Example" },
          payment: { id: "payment-9", xeroInvoiceId: null },
        })
        .mockResolvedValueOnce({ deletedAt: new Date("2026-07-30") });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The ROW stores the deleted population...
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-9", bookingDeleted: true }),
      );
      // ...and the MAIL says the same thing, so the stored reason, the alert and
      // the card's grouping (which reads current state) cannot disagree.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true }),
      );
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

    /*
      #2774 D2 — THE MONEY BUG, AND THE HIGHEST-VALUE ASSERTION IN THIS FILE.

      An operator can resolve the confirm route's OPEN hand-back task themselves:
      it sits OPEN for as long as the webhook is delayed or disabled. Resolving it
      as COMPLETED writes a local refund allocation through
      `applyLocalRefundAllocation` — the ledger saying the club paid the member back
      out of its own funds. Before this change nothing stopped the webhook refunding
      the same capture at Stripe on top of it, so the member was paid TWICE and only
      a reconciliation would ever have noticed.

      MUTATION PROOF: delete the fence's early return and this fails by name, while
      the refund tests either side of it still pass.
    */
    it("does not refund a capture an operator has already handed back by hand (#2774)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_hand_completed"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockResolvedValueOnce({
        id: "task-hand-completed",
        amountCents: 2500,
        completedAt: new Date("2026-07-28"),
        completedByMemberId: "member-operator",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The money does NOT move. This is the whole point.
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      // No second ManualRefundTask row: the operator's COMPLETED row IS the record
      // of this capture, and one row per capture is the property every lookup on
      // this path protects.
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      // The audit log must NOT claim a refund that did not happen — that action is
      // named as the club's permanent record of automatic refunds.
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
        }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_refund_withheld",
          category: "payment",
          severity: "critical",
          // A guard refused an action; nothing failed.
          outcome: "blocked",
          entityType: "Booking",
          entityId: "booking-9",
        }),
      );
      // The row says, in words, that the money did not go — nobody reconciling it
      // should have to infer that from an action name.
      const withheld = mockLogAudit.mock.calls
        .map((call) => call[0] as { action: string; details?: string })
        .find(
          (row) =>
            row.action === "booking.payment.late_capture_refund_withheld",
        );
      expect(JSON.parse(String(withheld?.details))).toMatchObject({
        refundSent: false,
        manualRefundTaskId: "task-hand-completed",
        handBackAmountCents: 2500,
        captureKind: "modification",
      });
      // Exactly ONE notification for the event, and it is the one that says the
      // refund was withheld — never the "refunded automatically" mail.
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ refundSent: false, bookingId: "booking-9" }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // Nothing downstream of the refund runs, because there was no refund to
      // mirror in Xero.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("answers 500 rather than guessing when the hand-back fence cannot be read (#2774)", async () => {
      /*
        Refunding twice and never refunding at all are both bad, so a fence that
        cannot answer gives NEITHER answer. The rejection reaches the outer catch,
        the processed-event marker is cleared and Stripe redelivers against the same
        idempotent refund keys — so a redelivery that reaches a working database
        refunds exactly once. Swallowing this and refunding would reopen the double
        payment; swallowing it and returning 200 would leave the capture unrefunded
        for good, because Stripe never redelivers a 200.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_fence_unreadable"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockRejectedValueOnce(
        new Error("database is down"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalled();
    });

    it("reports a possible DOUBLE payment when the hand-completion lands during the refund (#2774)", async () => {
      /*
        The window the fence cannot close, detected rather than left silent. The
        fence read the task as unresolved; the operator committed COMPLETED while
        Stripe was refunding; the record writer then finds it under
        `pg_advisory_xact_lock(1)` and reports the status. Closing this window would
        mean holding that lock across a provider round trip, which
        `docs/CONCURRENCY_AND_LOCKING.md` forbids — so the exposure is shrunk from
        days to one Stripe call and the residue is reported.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_double_paid"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
        closed: 0,
        created: false,
        alreadyRecorded: "hand-resolved",
        existingStatus: "COMPLETED",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The refund DID go out — this ordering is not preventable, only reportable.
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_double_refund_suspected",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityId: "booking-9",
        }),
      );
      // ONE notification, and it is the one that says the money may have gone
      // twice. Sending the cheerful "refunded automatically" mail here would be a
      // lie by omission about money leaving the club twice.
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(expect.objectContaining({ refundSent: true }));
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
    });

    it("does NOT escalate the ordinary hand-DISMISSED carve-out (#2774 D1)", async () => {
      /*
        #2774 D1 keeps this carve-out - the orchestrator's call on that issue's
        Recommended option, not the owner's. A DISMISSED row means an operator
        settled the matter another way and wrote NO refund allocation, so nothing
        was paid twice; the only consequence is that the automatic refund reaches no
        finance card, which `INV-ADDPAY-037` and the card copy both name. Escalating
        it would cry double-payment over a capture nobody was paid twice for, and
        the pinned expectation is inverted here on purpose so a future author cannot
        widen the escalation to "any hand resolution" without this failing.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_hand_dismissed"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
        closed: 0,
        created: false,
        alreadyRecorded: "hand-resolved",
        existingStatus: "DISMISSED",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_double_refund_suspected",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // #2773: a late Stripe capture of the booking's OWN (PRIMARY) payment on a
  // CANCELLED booking. #1350 has always refunded it; until #2773 it left NO
  // operator record and sent the generic muteable "Payment Failed" mail, while its
  // booking-change sibling had both since #2760/#2761.
  // ---------------------------------------------------------------------------
  describe("late primary capture on a cancelled booking (#1350 / #2773)", () => {
    function primarySucceededEvent(id = "evt_primary_cancelled") {
      return {
        id,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_primary_late",
            amount: 12000,
            payment_method: "pm_primary_late",
            // No `type: "modification_additional"` — this is the booking's own
            // payment, which is what routes it to the sibling handler.
            metadata: { bookingId: "booking-7" },
          },
        },
      } as any;
    }

    function armCancelledBooking(
      xeroInvoiceId: string | null = null,
      deletedAt: Date | null = new Date("2026-06-20"),
    ) {
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-7",
        paymentId: "payment-7",
        kind: "PRIMARY",
        amountCents: 12000,
        status: "PENDING",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-7",
        status: "CANCELLED",
        deletedAt,
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-04"),
        member: { firstName: "Bruce", lastName: "Example" },
        payment: { id: "payment-7", xeroInvoiceId },
      });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          {
            paymentIntentId: "pi_primary_late",
            refundId: "re_primary_7",
            amountCents: 12000,
          },
        ],
        totalRefundedAmountCents: 12000,
      });
    }

    it("records the refund and sends the unmuteable alert instead of 'Payment Failed' (#2773)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent());
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The refund is unchanged: same amount, same idempotent per-intent key.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-7",
          amountCents: 12000,
          idempotencyKeyPrefix: "late_cancel_refund_booking-7_pi_primary_late",
        }),
      );
      // The record this path never had, with its OWN reason sentence — "primary",
      // not the booking-change one, which would print a false sentence on the card.
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith({
        bookingId: "booking-7",
        paymentId: "payment-7",
        paymentIntentId: "pi_primary_late",
        amountCents: 12000,
        bookingDeleted: true,
        captureKind: "primary",
      });
      // Recorded AFTER the money went back, never before.
      expect(
        mockRefundPaymentTransactions.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRecordAutomaticCancelledBookingRefundTask.mock
          .invocationCallOrder[0],
      );
      // The alert: the unmuteable one, naming which payment it was. The generic
      // muteable "Payment Failed" mail this path used to send is gone.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-7",
          amountCents: 12000,
          bookingDeleted: true,
          captureKind: "primary",
        }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // The audit entry is unchanged except that it now names its kind, so the two
      // handlers' rows are told apart by the row rather than by knowing the code.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
          targetId: "booking-7",
          details: expect.stringContaining('"kind":"primary"'),
        }),
      );
    });

    it("records the cancelled-but-not-deleted population too (#2773)", async () => {
      // #1350's refund fires on `status === "CANCELLED"`, not on `deletedAt`, so
      // this capture was already being auto-refunded — with no record anywhere.
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_cancelled_live"),
      );
      armCancelledBooking(null, null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingDeleted: false,
          captureKind: "primary",
          amountCents: 12000,
        }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false }),
      );
    });

    it("re-reads deletedAt after the Stripe round trip on this path too (#2773)", async () => {
      /*
        An admin deleting the booking while the refund is in flight would otherwise
        store "cancelled, still on file" and mail "normally nothing to do" for the
        one population that needs a person. The shared recorder owns the re-read, so
        this path gets it by construction rather than by remembering to copy it.
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_deleted_mid_refund"),
      );
      armCancelledBooking(null, null);
      mockBookingFindUnique
        .mockResolvedValueOnce({
          id: "booking-7",
          status: "CANCELLED",
          deletedAt: null,
          checkIn: new Date("2026-09-01"),
          checkOut: new Date("2026-09-04"),
          member: { firstName: "Bruce", lastName: "Example" },
          payment: { id: "payment-7", xeroInvoiceId: null },
        })
        .mockResolvedValueOnce({ deletedAt: new Date("2026-08-30") });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true, captureKind: "primary" }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true }),
      );
    });

    it("still returns 200 and audits the loss when the record write fails (#2773)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_record_fails"),
      );
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("could not serialize access due to concurrent update"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.auto_refund_record_failed",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityId: "booking-7",
        }),
      );
      // Still reported to a person, and still exactly one notification.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
    });

    it("withholds the refund on this path too when a hand-back already exists (#2774)", async () => {
      /*
        Nothing currently raises an OPEN task for a PRIMARY intent, so this state is
        not reachable in the shipped tree — the fence is here because it is keyed on
        the payment intent rather than on the handler, so a reader of one handler
        cannot conclude the other is unfenced and a future raiser is covered by
        construction. Pinned so that "unreachable today" cannot quietly become
        "unfenced".
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_hand_completed"),
      );
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockResolvedValueOnce({
        id: "task-primary-hand-completed",
        amountCents: 12000,
        completedAt: new Date("2026-08-29"),
        completedByMemberId: "member-operator",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_refund_withheld",
          severity: "critical",
          outcome: "blocked",
          entityId: "booking-7",
        }),
      );
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          refundSent: false,
          captureKind: "primary",
          handBackAmountCents: 12000,
        }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("keeps the Xero credit note for a payment that carries an invoice (#2773 changes nothing here)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_with_invoice"),
      );
      armCancelledBooking("xero-inv-7");

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment-7",
        12000,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F16 (#1887): the ProcessedWebhookEvent claim is a processing lease, closing
  // two lost-event windows: (a) a crash between claim-insert and completion no
  // longer ACKs every redelivery as a duplicate; (b) a concurrent redelivery is
  // no longer ACKed while an in-flight attempt later fails.
  // ---------------------------------------------------------------------------
  describe("webhook dedup processing lease (#1887)", () => {
    function succeededEvent(eventId: string) {
      return {
        id: eventId,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_lease",
            amount: 5000,
            metadata: { bookingId: "booking-1" },
            payment_method: "pm_123",
          },
        },
      } as any;
    }

    function armPaidBooking() {
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
    }

    it("claims a fresh event under a PROCESSING lease and marks it COMPLETED on success", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_fresh"));
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The claim is inserted PROCESSING with a lease stamp.
      expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
        data: {
          eventId: "evt_fresh",
          source: "stripe",
          eventType: "payment_intent.succeeded",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
      });
      // On success it flips to COMPLETED so a later redelivery is a true dup.
      // Fenced (F16 fence, #1887) on status + the claimed processingStartedAt.
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_fresh",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
    });

    it("fences the COMPLETED stamp to the exact lease it claimed (interleaving, #1887)", async () => {
      // A slow original that outlived its lease must not flip a takeover
      // successor's fresh claim to COMPLETED. The fence keys the COMPLETED stamp
      // on the SAME processingStartedAt written at claim time, so it can only
      // ever complete the lease this attempt owns.
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_fence"));
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      const claimToken =
        mockProcessedWebhookCreate.mock.calls[0]![0].data.processingStartedAt;
      expect(claimToken).toBeInstanceOf(Date);
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_fence",
          status: "PROCESSING",
          processingStartedAt: claimToken,
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
    });

    it("ACKs a redelivery of a COMPLETED event without re-running handlers", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_done"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "COMPLETED",
        processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true });
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      // A completed dup neither re-marks nor releases the claim.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    });

    it("forces a provider retry (500) for a redelivery still inside the lease window (crash-window fix)", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_inflight"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt claimed it one minute ago and is still in flight.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 60 * 1000),
      });

      const response = await POST(makeRequest());

      // Not ACKed: the in-flight (possibly-doomed) attempt owns it; Stripe
      // must redeliver rather than drop the event.
      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      // We never take over a live lease, so no takeover update and no release.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    });

    it("takes over an expired lease (a crashed prior attempt) and reprocesses", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_expired"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // Claimed 30 minutes ago and never completed: past the 15-minute lease.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      // The conditional takeover update wins.
      mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // First updateMany is the lease takeover on the expired claim.
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_expired",
          status: "PROCESSING",
          processingStartedAt: { lt: expect.any(Date) },
        },
        data: { processingStartedAt: expect.any(Date), eventType: "payment_intent.succeeded" },
      });
      // The handler runs on takeover, then the claim is marked COMPLETED —
      // fenced on the takeover's own processingStartedAt (F16 fence, #1887).
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_expired",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
    });

    it("forces a retry (500) when it loses the expired-lease takeover race", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_race"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      // Another racer took the lease first: our conditional update matches 0 rows.
      mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 0 });

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("forces a retry (500) when the claim was raced away between insert and read", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_gone"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt failed and deleted its claim between our insert and read.
      mockProcessedWebhookFindFirst.mockResolvedValue(null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
    });

    it("releases the claim (delete) and does NOT mark COMPLETED when a handler throws", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_throw"));
      mockProcessedWebhookCreate.mockResolvedValue({});
      mockFindPaymentTransactionByIntentId.mockRejectedValue(
        new Error("database unavailable"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // Fenced (F16 fence, #1887): the release keys on status + the claimed
      // processingStartedAt, so it only removes the lease this attempt owns.
      const claimToken =
        mockProcessedWebhookCreate.mock.calls[0]![0].data.processingStartedAt;
      expect(claimToken).toBeInstanceOf(Date);
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
        where: {
          eventId: "evt_throw",
          source: "stripe",
          status: "PROCESSING",
          processingStartedAt: claimToken,
        },
      });
      // A failed attempt must never leave a COMPLETED marker behind.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
    });

    it("records the in-progress lease contention 500 for telemetry (F16 LOW, #1887)", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_busy"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt holds a live lease.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 60 * 1000),
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // The otherwise-invisible concurrent-redelivery 500 is logged.
      expect(mockRecordWebhookLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "stripe",
          eventId: "evt_busy",
          status: "failure",
          error: expect.stringContaining("in progress"),
        }),
      );
    });
  });
});
