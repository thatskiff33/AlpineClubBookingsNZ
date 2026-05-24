import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentStatus,
} from "@prisma/client";

const {
  mockPaymentRecoveryFindMany,
  mockPaymentRecoveryFindUnique,
  mockPaymentRecoveryFindFirst,
  mockPaymentRecoveryUpdateMany,
  mockPaymentRecoveryUpdate,
  mockPaymentRecoveryUpsert,
  mockPaymentTransactionUpdateMany,
  mockPaymentTransactionUpdate,
  mockPaymentTransactionFindUnique,
  mockBookingFindUnique,
  mockCancelPaymentIntentIfCancellableWithResult,
  mockProcessRefund,
  mockReconcilePaymentAggregates,
  mockRecordStripeRefundLedgerEntry,
  mockSendAdminPaymentFailureAlert,
} = vi.hoisted(() => ({
  mockPaymentRecoveryFindMany: vi.fn(),
  mockPaymentRecoveryFindUnique: vi.fn(),
  mockPaymentRecoveryFindFirst: vi.fn(),
  mockPaymentRecoveryUpdateMany: vi.fn(),
  mockPaymentRecoveryUpdate: vi.fn(),
  mockPaymentRecoveryUpsert: vi.fn(),
  mockPaymentTransactionUpdateMany: vi.fn(),
  mockPaymentTransactionUpdate: vi.fn(),
  mockPaymentTransactionFindUnique: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockCancelPaymentIntentIfCancellableWithResult: vi.fn(),
  mockProcessRefund: vi.fn(),
  mockReconcilePaymentAggregates: vi.fn().mockResolvedValue(undefined),
  mockRecordStripeRefundLedgerEntry: vi.fn().mockResolvedValue({
    created: true,
    amountCents: 6000,
  }),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: {
      findMany: (...args: unknown[]) => mockPaymentRecoveryFindMany(...args),
      findUnique: (...args: unknown[]) => mockPaymentRecoveryFindUnique(...args),
      findFirst: (...args: unknown[]) => mockPaymentRecoveryFindFirst(...args),
      updateMany: (...args: unknown[]) => mockPaymentRecoveryUpdateMany(...args),
      update: (...args: unknown[]) => mockPaymentRecoveryUpdate(...args),
      upsert: (...args: unknown[]) => mockPaymentRecoveryUpsert(...args),
    },
    paymentTransaction: {
      updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
      update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
      findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellableWithResult(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
}));

vi.mock("@/lib/payment-transactions", () => ({
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
  recordStripeRefundLedgerEntry: (...args: unknown[]) =>
    mockRecordStripeRefundLedgerEntry(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mockSendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "recovery-1",
    type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
    status: PaymentRecoveryOperationStatus.PROCESSING,
    bookingId: "booking-1",
    paymentId: "payment-1",
    paymentTransactionId: "txn-1",
    paymentIntentId: "pi_superseded",
    amountCents: 6000,
    idempotencyKey: "payment_recovery_cancel_txn-1_pi_superseded",
    attempts: 1,
    nextRetryAt: new Date("2026-05-23T00:00:00.000Z"),
    lastError: null,
    processingStartedAt: new Date("2026-05-23T00:00:00.000Z"),
    succeededAt: null,
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    ...overrides,
  };
}

describe("payment recovery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        // resetStaleProcessingOperations queries for exhausted PROCESSING rows.
        if (args?.where?.attempts && "gte" in args.where.attempts) {
          return Promise.resolve([]);
        }
        return Promise.resolve([makeOperation({ status: "PENDING" })]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation());
    mockPaymentRecoveryUpdateMany.mockImplementation(({ where }: { where?: { id?: string } }) =>
      Promise.resolve({ count: where?.id ? 1 : 0 })
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentTransactionUpdate.mockResolvedValue({});
    mockPaymentTransactionFindUnique.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      stripePaymentIntentId: "pi_superseded",
      amountCents: 6000,
      refundedAmountCents: 0,
      status: PaymentStatus.SUCCEEDED,
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      member: {
        firstName: "Alice",
        lastName: "Example",
      },
    });
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });
    mockProcessRefund.mockResolvedValue({
      id: "re_refund",
      amount: 6000,
      currency: "nzd",
      status: "succeeded",
      payment_intent: "pi_superseded",
    });
  });

  it("cancels a cancellable superseded PaymentIntent and marks the transaction failed", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "txn-1",
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "zero_dollar_batch_modification_superseded",
      },
    });
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith({
      where: { id: "recovery-1" },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
      }),
    });
  });

  it("treats an already-canceled PaymentIntent as a successful cancellation recovery", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith({
      where: { id: "recovery-1" },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
      }),
    });
  });

  it("retries transient Stripe cancellation failures with a later retry time", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe unavailable")
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      processed: 1,
      succeeded: 0,
      retried: 1,
      failed: 0,
    });
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith({
      where: { id: "recovery-1" },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Stripe unavailable",
        processingStartedAt: null,
        nextRetryAt: expect.any(Date),
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("alerts admins when a recovery operation exhausts its retries", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation({ attempts: 5 }));
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe still unavailable")
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      processed: 1,
      failed: 1,
      retried: 0,
    });
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith({
      where: { id: "recovery-1" },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Stripe still unavailable",
        nextRetryAt: null,
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        amountCents: 6000,
        paymentIntentId: "pi_superseded",
        errorMessage: expect.stringContaining("failed after 5 attempts"),
      })
    );
  });

  it("marks stale PROCESSING rows at max attempts terminally failed and alerts admins", async () => {
    const staleExhausted = makeOperation({
      id: "recovery-stale-5",
      attempts: 5,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    mockPaymentRecoveryFindMany
      // resetStaleProcessingOperations looks for exhausted stale rows
      .mockResolvedValueOnce([staleExhausted])
      // the regular queue findMany returns nothing this tick
      .mockResolvedValueOnce([]);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-stale-5",
        status: PaymentRecoveryOperationStatus.PROCESSING,
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        nextRetryAt: null,
        processingStartedAt: null,
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        amountCents: 6000,
        paymentIntentId: "pi_superseded",
        errorMessage: expect.stringContaining("timed out on the final attempt"),
      }),
    );
  });

  it("queues refund recovery when the superseded PaymentIntent already succeeded", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: {
        id: "pi_superseded",
        status: "succeeded",
        amount: 6000,
        payment_method: "pm_123",
      },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: "txn-1" },
      data: expect.objectContaining({
        amountCents: 6000,
        status: PaymentStatus.SUCCEEDED,
        paymentMethodId: "pm_123",
        reason: "zero_dollar_batch_modification_late_capture",
      }),
    });
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "payment_recovery_refund_txn-1_pi_superseded" },
      create: expect.objectContaining({
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentIntentId: "pi_superseded",
        amountCents: 6000,
      }),
      update: expect.objectContaining({
        paymentIntentId: "pi_superseded",
        amountCents: 6000,
      }),
    });
  });
});
