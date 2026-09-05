import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaymentSource,
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
  mockAlertCooldownUpdateMany,
  mockAlertCooldownCreate,
  mockPaymentTransactionUpdateMany,
  mockPaymentTransactionUpdate,
  mockPaymentTransactionFindUnique,
  mockPaymentFindUnique,
  mockBookingFindUnique,
  mockCancelPaymentIntentIfCancellableWithResult,
  mockProcessRefund,
  mockReconcilePaymentAggregates,
  mockRecordStripeRefundLedgerEntry,
  mockRefundPaymentTransactions,
  mockSumRecordedRefundsForTransaction,
  mockSendAdminPaymentFailureAlert,
  mockCreatePaymentIntent,
  mockFindOrCreateCustomer,
  mockUpsertPaymentIntentTransaction,
  mockQueueSupersededAdditionalIntentCancellations,
  mockAttachIntentToWaitingOps,
  mockExecuteGroupSettlementRefundPlan,
  mockRecordDuplicateCaptureRefundEvent,
  mockSyncEditFinancialReviewChargeRequest,
  mockBookingModificationFindUnique,
  mockCompleteDeferredSupplementaryInvoice,
  mockRecordShortEditReviewChargeInvoice,
  mockRecordUncollectedEditReviewChargeShare,
  mockFindEditReviewChargeRequest,
  mockCreateAuditLog,
  settlementModuleLoadFailure,
} = vi.hoisted(() => ({
  mockPaymentRecoveryFindMany: vi.fn(),
  mockPaymentRecoveryFindUnique: vi.fn(),
  mockPaymentRecoveryFindFirst: vi.fn(),
  mockPaymentRecoveryUpdateMany: vi.fn(),
  mockPaymentRecoveryUpdate: vi.fn(),
  mockPaymentRecoveryUpsert: vi.fn(),
  mockAlertCooldownUpdateMany: vi.fn(),
  mockAlertCooldownCreate: vi.fn(),
  mockPaymentTransactionUpdateMany: vi.fn(),
  mockPaymentTransactionUpdate: vi.fn(),
  mockPaymentTransactionFindUnique: vi.fn(),
  mockPaymentFindUnique: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockCancelPaymentIntentIfCancellableWithResult: vi.fn(),
  mockFindEditReviewChargeRequest: vi.fn(),
  mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
  mockProcessRefund: vi.fn(),
  mockReconcilePaymentAggregates: vi.fn().mockResolvedValue(undefined),
  mockRecordStripeRefundLedgerEntry: vi.fn().mockResolvedValue({
    created: true,
    amountCents: 6000,
  }),
  mockRefundPaymentTransactions: vi.fn(),
  mockSumRecordedRefundsForTransaction: vi.fn().mockResolvedValue(0),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockCreatePaymentIntent: vi.fn(),
  mockFindOrCreateCustomer: vi.fn(),
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  mockQueueSupersededAdditionalIntentCancellations: vi
    .fn()
    .mockResolvedValue([]),
  mockAttachIntentToWaitingOps: vi.fn().mockResolvedValue({ attached: 0 }),
  mockExecuteGroupSettlementRefundPlan: vi
    .fn()
    .mockResolvedValue({ outcome: "refunded", mirroredChildren: 1 }),
  mockRecordDuplicateCaptureRefundEvent: vi.fn().mockResolvedValue(undefined),
  mockSyncEditFinancialReviewChargeRequest: vi.fn(),
  // #3181: the edit whose additional payment is being recovered, read back for
  // the SIGNED components its deferred supplementary invoice bills.
  mockBookingModificationFindUnique: vi
    .fn()
    .mockResolvedValue({ priceDiffCents: 3000, changeFeeCents: 0 }),
  mockCompleteDeferredSupplementaryInvoice: vi
    .fn()
    .mockResolvedValue("covers-total"),
  mockRecordShortEditReviewChargeInvoice: vi.fn().mockResolvedValue(false),
  mockRecordUncollectedEditReviewChargeShare: vi.fn().mockResolvedValue(undefined),
  /**
   * #3181 fix round: arms a failure to LOAD the settlement module, as distinct
   * from a failure of the call inside it. The worker reaches that module through
   * `await import`, and an import can throw - a module whose own top level
   * throws, a build that cannot resolve the chunk. Read through a getter on the
   * mocked namespace so the throw lands on the same destructuring line the worker
   * really executes, which is the line that used to sit outside the `try`.
   */
  settlementModuleLoadFailure: { current: null as Error | null },
}));

/**
 * #3170: reached through a DYNAMIC import inside the worker (the charge module
 * imports this one), which `vi.mock` still intercepts.
 */
vi.mock("@/lib/edit-financial-review-charge", () => ({
  syncEditFinancialReviewChargeRequest: (...args: unknown[]) =>
    mockSyncEditFinancialReviewChargeRequest(...args),
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
    alertCooldown: {
      updateMany: (...args: unknown[]) => mockAlertCooldownUpdateMany(...args),
      create: (...args: unknown[]) => mockAlertCooldownCreate(...args),
    },
    paymentTransaction: {
      updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
      update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
      findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
    },
    bookingModification: {
      findUnique: (...args: unknown[]) =>
        mockBookingModificationFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellableWithResult(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
  createPaymentIntent: (...args: unknown[]) => mockCreatePaymentIntent(...args),
  findOrCreateCustomer: (...args: unknown[]) =>
    mockFindOrCreateCustomer(...args),
}));

vi.mock("@/lib/group-cancel", () => ({
  executeGroupSettlementRefundPlan: (...args: unknown[]) =>
    mockExecuteGroupSettlementRefundPlan(...args),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: (...args: unknown[]) =>
    mockQueueSupersededAdditionalIntentCancellations(...args),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  attachPaymentIntentToWaitingSupplementaryInvoiceOperations: (
    ...args: unknown[]
  ) => mockAttachIntentToWaitingOps(...args),
}));

/**
 * #3181: both reached through DYNAMIC imports inside the worker, which `vi.mock`
 * still intercepts. Doubled here rather than left real because each pulls the
 * Xero outbox's provider-client import graph in behind it, and this file mocks
 * that module down to a single export.
 *
 * That the enqueue really raises exactly ONE invoice per anchor is proven
 * against the real outbox in `xero-operation-outbox.test.ts`; these doubles prove
 * the worker asks for it, with the right figure, on the paths that should and
 * not on the paths that should not.
 */
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  get completeDeferredXeroSupplementaryInvoice() {
    if (settlementModuleLoadFailure.current) {
      throw settlementModuleLoadFailure.current;
    }
    return (...args: unknown[]) =>
      mockCompleteDeferredSupplementaryInvoice(...args);
  },
}));

vi.mock("@/lib/edit-financial-review-charge-request", () => ({
  recordShortEditReviewChargeInvoice: (...args: unknown[]) =>
    mockRecordShortEditReviewChargeInvoice(...args),
  recordUncollectedEditReviewChargeShare: (...args: unknown[]) =>
    mockRecordUncollectedEditReviewChargeShare(...args),
  // #3220: the dead-recovery cancel reads this module for the edit's ask. The
  // factory replaces the whole module, so an export it omits throws at IMPORT
  // and kills the file before a test runs.
  findEditReviewChargeRequest: (...args: unknown[]) =>
    mockFindEditReviewChargeRequest(...args),
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));

vi.mock("@/lib/payment-transactions", () => ({
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
  recordStripeRefundLedgerEntry: (...args: unknown[]) =>
    mockRecordStripeRefundLedgerEntry(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  sumRecordedRefundsForTransaction: (...args: unknown[]) =>
    mockSumRecordedRefundsForTransaction(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mockSendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordDuplicateCaptureRefundEvent: (...args: unknown[]) =>
    mockRecordDuplicateCaptureRefundEvent(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
  enqueueBookingCancellationRefundRecovery,
  enqueueBookingModificationRefundRecovery,
  enqueueCapacityClaimFailedRefundRecovery,
  enqueueGroupSettlementRefundRecovery,
  enqueuePaymentIntentCancellationRecovery,
  enqueueRefundRequestRefundRecovery,
  processPaymentRecoveryOperations,
  queueSupersededPaymentIntentRefundRecovery,
} from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
} from "@/lib/payment-recovery-keys";

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
    allocationPlan: null,
    stripeKeyPrefix: null,
    idempotencyKey: "payment_recovery_cancel_txn-1_pi_superseded",
    attempts: 1,
    nextRetryAt: new Date("2026-05-23T00:00:00.000Z"),
    lastError: null,
    // #3181: only CREATE_ADDITIONAL_PAYMENT_INTENT rows carry the edit's frozen
    // answer, so the generic row's honest value is "not recorded".
    hadIssuedXeroInvoice: null,
    processingStartedAt: new Date("2026-05-23T00:00:00.000Z"),
    succeededAt: null,
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * `resetStaleProcessingOperations`'s own read, told apart from the worker's
 * queue read (#3220).
 *
 * It used to be told apart by `attempts: { gte: MAX }` - the filter the reaper's
 * SECOND arm used - and that predicate was copied into 24 `findMany` mocks in
 * this file. When the reaper's two arms became one read through the terminal
 * chokepoint, that filter stopped existing, every copy answered "this is the
 * queue read", and the sweep was handed the operation under test and failed it.
 * `processingStartedAt` is the filter only the sweep uses, and it lives here
 * once so the next change to that query has one place to correct.
 */
function isStaleWorkerSweep(args?: unknown) {
  // `unknown` rather than a shape, because the 24 mocks that ask this each
  // declare their own idea of the `where` they receive and none of them is the
  // real Prisma argument type.
  const where = (args as { where?: { processingStartedAt?: unknown } } | undefined)
    ?.where;
  return where?.processingStartedAt != null;
}

describe("payment recovery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlementModuleLoadFailure.current = null;
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        // resetStaleProcessingOperations queries for exhausted PROCESSING rows.
        if (isStaleWorkerSweep(args)) {
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
    // Default: no cooldown row exists yet, so the conditional claim matches
    // nothing and the create path wins (first alert ever).
    mockAlertCooldownUpdateMany.mockResolvedValue({ count: 0 });
    mockAlertCooldownCreate.mockResolvedValue({});
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
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [
        { paymentIntentId: "pi_original", refundId: "re_recovery", amountCents: 4000 },
      ],
      totalRefundedAmountCents: 4000,
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_original",
      transactions: [
        {
          id: "txn-1",
          stripePaymentIntentId: "pi_original",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
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
    // #2262 H2: the terminal close is a STATUS-FENCED updateMany, so a row a
    // manual mark-paid reversal deleted can never be resurrected (P2025-free).
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
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
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
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
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
      },
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
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
      },
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

  /**
   * #3220: the three failure transitions became ONE, so these pin what that one
   * transition guarantees for every caller rather than for the arm each used to
   * live in.
   */
  it("does not alert, or act, on a failure that matched no live operation", async () => {
    // The row a manual mark-paid reversal DELETED mid-flight. The worker still
    // holds its in-memory copy and still runs its catch; before the chokepoint
    // this was `update` by id, which throws P2025 - out of the loop's own catch,
    // abandoning every remaining operation in the batch.
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation({ attempts: 5 }));
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe still unavailable")
    );
    // Only the FAILURE write misses: the claim that put the row in PROCESSING
    // still has to succeed, or the worker never reaches its catch at all.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: { where?: { id?: string }; data?: { status?: string } }) =>
        Promise.resolve({
          count:
            args?.data?.status === PaymentRecoveryOperationStatus.FAILED ? 0 : 1,
        })
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The batch completes rather than throwing, and the tally is what it was
    // before this transition was centralised.
    expect(result).toMatchObject({ processed: 1, failed: 1, retried: 0 });
    // Nothing is alerted about a row that is gone or already finished.
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("never drags a SUCCEEDED operation back to FAILED", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe unavailable")
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    const failureWrites = mockPaymentRecoveryUpdateMany.mock.calls.filter(
      (call) =>
        (call[0] as { data?: { status?: string } })?.data?.status === "FAILED"
    );
    expect(failureWrites).toHaveLength(1);
    const where = (failureWrites[0][0] as {
      where: { status: { in: string[] } };
    }).where;
    expect(where.status.in).not.toContain(
      PaymentRecoveryOperationStatus.SUCCEEDED
    );
  });

  it("re-arms a stale PROCESSING row that still has attempts left, without alerting", async () => {
    // The arm that used to be a bulk `updateMany` over every stale row at once.
    // It is now the same fenced, per-row transition the exhausted arm takes -
    // with `terminal` false, which is the only thing that differs.
    const staleRetryable = makeOperation({
      id: "recovery-stale-2",
      attempts: 2,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { processingStartedAt?: unknown } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [staleRetryable] : [])
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-stale-2",
        status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
        // #3220 fix round: the exact attempt the sweep read. Status alone would
        // also match a row that has since been re-claimed.
        processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      data: {
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Payment recovery worker timed out before completion.",
        processingStartedAt: null,
        // A retry time, not null: this row is re-armed, not dead.
        nextRetryAt: expect.any(Date),
      },
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
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
        status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
        // #3220 fix round: as above - the read and the write are fenced to one
        // attempt, so a re-claimed row falls out instead of being killed.
        processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
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

  it("does not double-count a previously written refund when the recovery retries", async () => {
    // First attempt scenario: refund partially succeeded in Stripe and the
    // ledger entry was written, but the paymentTransaction row update never
    // committed. On retry, Stripe returns the same refund via idempotency
    // key; the ledger total is the truth source, so refundedAmountCents
    // should NOT be incremented by the same Stripe refund again.
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
      }),
    );
    mockPaymentTransactionFindUnique.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      stripePaymentIntentId: "pi_superseded",
      amountCents: 10000,
      refundedAmountCents: 3000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });
    mockProcessRefund.mockResolvedValue({
      id: "re_idempotent",
      amount: 3000,
      currency: "nzd",
      status: "succeeded",
      payment_intent: "pi_superseded",
    });
    mockSumRecordedRefundsForTransaction.mockResolvedValue(3000);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockSumRecordedRefundsForTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "txn-1",
    );
    expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: "txn-1" },
      data: expect.objectContaining({
        refundedAmountCents: 3000,
      }),
    });
  });

  it("alerts admins when a PENDING recovery op has been queued > 30 minutes", async () => {
    const ancientOperation = {
      ...makeOperation({
        id: "recovery-ancient",
        status: PaymentRecoveryOperationStatus.PENDING,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
      booking: {
        id: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        member: { firstName: "Alice", lastName: "Example" },
      },
    };

    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValueOnce(ancientOperation);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.PENDING,
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        errorMessage: expect.stringContaining("queue is stalled"),
        paymentIntentId: "pi_superseded",
      }),
    );
  });

  function makeStaleQueueOperation() {
    return {
      ...makeOperation({
        id: "recovery-ancient",
        status: PaymentRecoveryOperationStatus.PENDING,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
      booking: {
        id: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        member: { firstName: "Alice", lastName: "Example" },
      },
    };
  }

  it("shared cooldown fires the stale-queue alert once, then suppresses a re-tick within the window (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    // Both ticks see the same stale op.
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeStaleQueueOperation());
    // No row within the window matches the conditional claim on either tick,
    // so the create path decides ownership: the first tick creates the row and
    // sends; the second tick loses the unique-constraint race and stays silent.
    const uniqueViolation = Object.assign(
      new Error("Unique constraint failed on the fields: (`key`)"),
      { code: "P2002" },
    );
    mockAlertCooldownCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(uniqueViolation);

    await processPaymentRecoveryOperations({ limit: 1 });
    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownCreate).toHaveBeenCalledTimes(2);
    expect(mockAlertCooldownCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "payment-recovery:stale-queue",
        lastAlertedAt: expect.any(Date),
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("queue is stalled"),
      }),
    );
  });

  it("re-sends the stale-queue alert once the shared cooldown window has elapsed (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeStaleQueueOperation());
    // The existing row's lastAlertedAt is older than the window, so the
    // conditional claim matches and this caller wins the write directly.
    mockAlertCooldownUpdateMany.mockResolvedValue({ count: 1 });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownUpdateMany).toHaveBeenCalledWith({
      where: {
        key: "payment-recovery:stale-queue",
        lastAlertedAt: { lt: expect.any(Date) },
      },
      data: { lastAlertedAt: expect.any(Date) },
    });
    // The claim already won, so no create fallback is attempted.
    expect(mockAlertCooldownCreate).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("queue is stalled"),
      }),
    );
  });

  it("neither claims the cooldown nor alerts when no stale op exists (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownUpdateMany).not.toHaveBeenCalled();
    expect(mockAlertCooldownCreate).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("processes a booking modification refund recovery by replaying refundPaymentTransactions", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-mod-refund",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "payment_recovery_modification_refund_mod-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-mod-refund",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "payment_recovery_modification_refund_mod-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        // The allocation derived on first processing is frozen on the row and
        // executed as explicit slices (#1097).
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        metadata: {
          bookingId: "booking-1",
          reason: "booking_modification_refund_recovery",
        },
        idempotencyKeyPrefix: expect.stringContaining(
          "payment_recovery_modification_refund_",
        ),
      }),
    );
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recovery-mod-refund" },
        data: {
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 4000 },
          ],
        },
      }),
    );
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-mod-refund",
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("replays a frozen allocation plan on retry instead of re-deriving it (#1097)", async () => {
    const planned = makeOperation({
      id: "recovery-mod-planned",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      // A previous attempt froze this plan, then died mid-refund. The current
      // payment state would derive a different allocation — the frozen slices
      // must win so the original Stripe keys are replayed.
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 1500 }],
      idempotencyKey: "payment_recovery_modification_refund_mod-2",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(planned);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...planned, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1500,
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 1500 }],
      }),
    );
    // No re-derivation: the only operation update is the completion.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
  });

  it("replays the route's stored Stripe key prefix on modification refund recovery (#1152)", async () => {
    const stored = makeOperation({
      id: "recovery-mod-prefixed",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      idempotencyKey: "payment_recovery_modification_refund_mod-3",
      stripeKeyPrefix: "mod_dates_refund_bk1_mod-3",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(stored);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...stored, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The route's exact prefix is replayed: a refund Stripe already holds
    // under these keys is returned, not re-minted.
    // #1507: the metadata reason is ALSO reconstructed from that stored prefix
    // (mod_dates_refund_* -> "date_change_price_decrease"), so the body is
    // byte-identical to the inline date-change refund and Stripe replays the
    // original instead of rejecting the reused key.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKeyPrefix: "mod_dates_refund_bk1_mod-3",
        metadata: {
          bookingId: "booking-1",
          reason: "date_change_price_decrease",
        },
      }),
    );
  });

  it("replays a byte-identical modification-refund Stripe body from the stored key prefix, so it converges instead of hitting idempotency_error (#1507)", async () => {
    // Regression for #1507 (booking_modification half of the #1494 pattern). The
    // inline settlement helper stamps a per-path reason (here guest removal) and
    // stores the Stripe key prefix on the recovery row (#1152). If the inline
    // Stripe refund succeeded but the local recording was lost, the cron replays
    // under that same prefix — which only converges if the request BODY matches
    // byte-for-byte. Before #1507 the cron sent
    // reason:"booking_modification_refund_recovery" while the inline path sent
    // reason:"guest_removed_price_decrease", so Stripe rejected the reused key
    // with idempotency_error and the operation retried to exhaustion. The cron
    // now reconstructs the inline reason from the persisted prefix.
    const crashed = makeOperation({
      id: "recovery-mod-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "payment_recovery_modification_refund_mod-9",
      stripeKeyPrefix: "guest_remove_refund_bk1_mod-9",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Exact-object assertion: the body is byte-identical to what the inline
    // guest-removal path sent (asserted against the real shared builder).
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.metadata).toEqual(
      buildBookingModificationRefundMetadata(
        "booking-1",
        "guest_removed_price_decrease",
      ),
    );
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "guest_removed_price_decrease",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("guest_remove_refund_bk1_mod-9");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
  });

  it("replays a byte-identical refund-request Stripe body after a lost inline recording, so it converges instead of hitting idempotency_error (#1507)", async () => {
    // Regression for #1507 (refund_request half of the #1494 pattern). The admin
    // approve route creates the appeal refund under refund_request_<id>; if it
    // fails the cron replays under the same prefix (#1039). Before #1507 the cron
    // sent reason:"refund_request_refund_recovery" while the route sent
    // reason:"refund_appeal_approved", so a Stripe-succeeded-but-unrecorded
    // refund hit idempotency_error on replay. Both now build from the shared
    // buildRefundRequestRefundMetadata helper.
    const crashed = makeOperation({
      id: "recovery-refund-request-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "refund_request_refund_refund-7",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    // Byte-identical to the inline appeal body asserted in
    // admin-refund-request-review-route.test.ts.
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-7"),
    );
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "refund_appeal_approved",
      refundRequestId: "refund-7",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-7");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
  });

  it("derives every inline modification-refund reason from its stored key prefix (#1507 freeze)", () => {
    // Freezes the derivation against the exact (idempotencyKeyPrefix, reason)
    // pairs the three inline callers pass to executeBookingModificationRefund. A
    // new modification refund path (or a renamed prefix/reason) breaks this until
    // its prefix is added to bookingModificationRefundReasonForKeyPrefix, keeping
    // the recovery replay byte-identical to the inline refund.
    expect(
      bookingModificationRefundReasonForKeyPrefix("mod_dates_refund_bk_mod"),
    ).toBe("date_change_price_decrease");
    expect(
      bookingModificationRefundReasonForKeyPrefix("mod_batch_refund_bk_mod"),
    ).toBe("batch_modification");
    expect(
      bookingModificationRefundReasonForKeyPrefix("guest_remove_refund_bk_mod"),
    ).toBe("guest_removed_price_decrease");
    // Legacy rows (pre-#1152, no stored prefix) keep the historical recovery
    // reason — they were never shared-key with the inline refund.
    expect(bookingModificationRefundReasonForKeyPrefix(null)).toBe(
      "booking_modification_refund_recovery",
    );
    expect(
      bookingModificationRefundReasonForKeyPrefix(
        "payment_recovery_modification_refund_op-1",
      ),
    ).toBe("booking_modification_refund_recovery");
  });

  it("replays a refund-request recovery with the route's original Stripe key prefix (#1039)", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-refund-request",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "refund_request_refund_refund-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-refund-request",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "refund_request_refund_refund-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Reusing refund_request_<id> means a refund that succeeded on Stripe but
    // was never recorded locally is replayed by Stripe, not issued again.
    // #1507: the metadata is ALSO byte-identical to the inline appeal body
    // (reason "refund_appeal_approved", built from the shared helper), so the
    // reused key replays the original refund instead of being rejected as an
    // idempotency_error.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        metadata: {
          bookingId: "booking-1",
          reason: "refund_appeal_approved",
          refundRequestId: "refund-1",
        },
        idempotencyKeyPrefix: "refund_request_refund-1",
      }),
    );
  });

  it("replays a multi-transaction refund-request recovery from its frozen plan, sending slices deep-equal to the frozen plan rather than re-deriving (#1510)", async () => {
    // #1510: the approve route freezes the inline attempt's per-transaction
    // slices on the operation BEFORE the Stripe call. On a multi-transaction
    // payment with partial refund progress, re-deriving a newest-first plan at
    // replay time — over ledger state a completed slice has already moved —
    // would shift the slice amounts and mint fresh
    // refund_request_<id>_<txn>_<amount> keys, creating NEW refunds instead of
    // replaying the originals. The frozen plan is replayed verbatim.
    const frozenPlan = [
      { paymentTransactionId: "txn-new", amountCents: 3000 },
      { paymentTransactionId: "txn-old", amountCents: 1000 },
    ];
    const crashed = makeOperation({
      id: "recovery-refund-request-multi",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: frozenPlan,
      idempotencyKey: "refund_request_refund_refund-11",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );
    // The current payment state has DIFFERENT refundable amounts than when the
    // plan was frozen: the inline attempt already fully refunded txn-new, so a
    // re-derivation would skip it and put all 4000 on txn-old — different
    // slices, different keys.
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_new",
      transactions: [
        {
          id: "txn-new",
          stripePaymentIntentId: "pi_new",
          amountCents: 3000,
          refundedAmountCents: 3000,
          status: PaymentStatus.REFUNDED,
          createdAt: new Date("2026-05-10T00:00:00.000Z"),
        },
        {
          id: "txn-old",
          stripePaymentIntentId: "pi_old",
          amountCents: 5000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    // Verbatim frozen slices — NOT a re-derivation over the moved ledger state.
    expect(refundArgs.allocation).toEqual(frozenPlan);
    expect(refundArgs.amountCents).toBe(4000);
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-11");
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-11"),
    );
    // The frozen plan is authoritative — no re-derivation/re-freeze.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
  });

  it("falls back to derive-at-replay for a pre-#1510 refund-request recovery with no frozen plan", async () => {
    // Operations enqueued before #1510 carry no allocationPlan. The replay
    // derives a newest-first plan from current payment state and freezes it —
    // unchanged behaviour, and post-#1507 single-transaction payments already
    // share slice keys with the inline refund, so old rows are no worse off.
    const legacy = makeOperation({
      id: "recovery-refund-request-legacy",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: null,
      idempotencyKey: "refund_request_refund_refund-legacy",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(legacy);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...legacy, status: "PENDING" }]);
      },
    );
    // Default payment: a single captured txn-1 (10000, refunded 0).

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Derived newest-first from current state and frozen on the row.
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recovery-refund-request-legacy" },
        data: {
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        },
      }),
    );
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
    // Still the shared refund_request prefix + byte-identical inline body.
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-legacy");
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-legacy"),
    );
  });

  it("enqueueRefundRequestRefundRecovery persists the route-frozen allocation plan (#1510)", async () => {
    await enqueueRefundRequestRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      refundRequestId: "refund-1",
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: "refund_request_refund_refund-1" },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        }),
        update: expect.objectContaining({
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        }),
      }),
    );
  });

  it("replays the inline cancel Stripe key prefix on booking cancellation refund recovery (#1160)", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-cancel-refund",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "booking_cancel_refund_recovery_booking-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-cancel-refund",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "booking_cancel_refund_recovery_booking-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The recovery reconstructs booking_cancel_refund_<bookingId> (the inline
    // cancel key), so a refund Stripe already holds under those keys is
    // replayed, not re-minted. #1494: the metadata is ALSO byte-identical to
    // the inline body — { bookingId, reason: "cancellation" }, no
    // refundPercentage — so Stripe replays the original refund instead of
    // rejecting the reused key with idempotency_error.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        metadata: {
          bookingId: "booking-1",
          reason: "cancellation",
        },
        idempotencyKeyPrefix: "booking_cancel_refund_booking-1",
      }),
    );
  });

  it("replays a byte-identical Stripe body (metadata + key) after a lost inline recording, so it converges instead of hitting idempotency_error (#1494)", async () => {
    // Regression for #1494. The frozen-plan design promises that if the inline
    // Stripe refund succeeds but the local recording is lost (crash window),
    // the cron replays the identical slices under the identical idempotency
    // key and Stripe answers with the ORIGINAL refund. That only holds if the
    // request BODY matches byte-for-byte too. Before #1494 the cron sent
    // metadata.reason = "booking_cancellation_refund_recovery" (and no
    // refundPercentage) while the inline path sent reason = "cancellation" +
    // refundPercentage, so Stripe rejected the reused key with
    // idempotency_error and the operation retried to exhaustion. Both callers
    // now build the body from buildBookingCancellationRefundMetadata, so the
    // replay is exactly what the inline path first sent.
    const crashed = makeOperation({
      id: "recovery-cancel-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "booking_cancel_refund_recovery_booking-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Exact-object assertion (not objectContaining): the body is byte-identical
    // to the inline cancel body asserted in booking-cancel.test.ts.
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "cancellation",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("booking_cancel_refund_booking-1");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
    // The shape reconstructs purely from the persisted bookingId, so an
    // operation enqueued BEFORE this fix (no persisted metadata) replays the
    // same converged body through this same path — no fallback branch needed.
    expect(refundArgs.metadata).toEqual(
      buildBookingCancellationRefundMetadata("booking-1"),
    );
  });

  it("replays a claim-frozen allocation plan for a crashed booking cancellation refund (#1349)", async () => {
    // #1349: booking-cancel persists this operation INSIDE the claim
    // transaction, with the allocation frozen from the under-lock read. A
    // process death before (or during) the inline Stripe call leaves it
    // PENDING; the cron must execute EXACTLY the frozen slices under the
    // inline cancel key prefix — identical Stripe idempotency keys — so any
    // slice the inline path already completed is replayed by Stripe, never
    // repeated.
    const crashed = makeOperation({
      id: "recovery-cancel-crash",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "booking_cancel_refund_recovery_booking-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        idempotencyKeyPrefix: "booking_cancel_refund_booking-1",
      }),
    );
    // The frozen plan is authoritative — no re-derivation/re-freeze.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
    // Replayed to completion.
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-cancel-crash",
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("enqueueBookingCancellationRefundRecovery persists the claim-frozen allocation plan (#1349)", async () => {
    await enqueueBookingCancellationRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: "booking_cancel_refund_recovery_booking-1" },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        }),
        update: expect.objectContaining({
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        }),
      }),
    );
  });

  it("enqueueCapacityClaimFailedRefundRecovery persists the claim-frozen plan and the inline capacity_claim_failed Stripe key prefix", async () => {
    await enqueueCapacityClaimFailedRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: "pi_original",
      amountCents: 10000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey:
            "capacity_claim_failed_refund_recovery_booking-1_pi_original",
        },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 10000,
          stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 10000 },
          ],
        }),
        update: expect.objectContaining({
          amountCents: 10000,
          stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 10000 },
          ],
        }),
      }),
    );
  });

  it("replays a capacity-race refund recovery under the stored inline Stripe key prefix with the reconstructed inline metadata", async () => {
    const capacityOp = makeOperation({
      id: "recovery-capacity",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 10000,
      idempotencyKey:
        "capacity_claim_failed_refund_recovery_booking-1_pi_original",
      stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
      paymentTransactionId: null,
      paymentIntentId: "pi_original",
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(capacityOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...capacityOp, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The replay executes the FROZEN slices under the inline
    // `capacity_claim_failed_<bookingId>_<pi>` prefix with the byte-identical
    // metadata the inline path sent — Stripe answers a refund that already
    // succeeded with the original refund instead of idempotency_error, and
    // the ledger dedupes on refund id (never a double refund).
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 10000,
      allocation: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
      metadata: { bookingId: "booking-1", reason: "capacity_claim_failed" },
      idempotencyKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
    });
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-capacity",
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("dispatches a group settlement refund recovery to the frozen-plan executor (#1351)", async () => {
    const groupOp = makeOperation({
      id: "recovery-group-settlement",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 9000,
      idempotencyKey: "group_settlement_refund_recovery_settle-1",
      paymentTransactionId: null,
      paymentIntentId: "pi_settle_1",
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(groupOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...groupOp, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockExecuteGroupSettlementRefundPlan).toHaveBeenCalledWith(
      "settle-1",
    );
    // The anchor payment is never read and no refund is derived from it.
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-group-settlement",
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("retries a group settlement replay whose Stripe call failed, alerting only on exhaustion (#1351)", async () => {
    const groupOp = makeOperation({
      id: "recovery-group-settlement-fail",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 9000,
      attempts: 1,
      idempotencyKey: "group_settlement_refund_recovery_settle-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(groupOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...groupOp, status: "PENDING" }]);
      },
    );
    mockExecuteGroupSettlementRefundPlan.mockRejectedValueOnce(
      new Error("stripe still down"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.retried).toBe(1);
    // Not exhausted yet: retry scheduled, NO admin alert.
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "recovery-group-settlement-fail",
        }),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.FAILED,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });

  it("enqueueGroupSettlementRefundRecovery upserts a delayed operation and re-arms it on inline failure (#1351)", async () => {
    await enqueueGroupSettlementRefundRecovery({
      organiserBookingId: "org-booking-1",
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 9000,
      retryDelayMs: 10 * 60 * 1000,
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey: "group_settlement_refund_recovery_settle-1",
        },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "org-booking-1",
          paymentId: "org-payment-1",
          paymentIntentId: "pi_settle_1",
          amountCents: 9000,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
    const created = mockPaymentRecoveryUpsert.mock.calls[0][0].create;
    expect(created.nextRetryAt.getTime()).toBeGreaterThan(
      Date.now() + 9 * 60 * 1000,
    );

    // Inline failure re-arms for immediate retry with the error recorded.
    await enqueueGroupSettlementRefundRecovery({
      organiserBookingId: "org-booking-1",
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 9000,
      retryDelayMs: 0,
      lastError: "stripe down",
    });
    const rearm = mockPaymentRecoveryUpsert.mock.calls[1][0].update;
    expect(rearm.lastError).toBe("stripe down");
    expect(rearm.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("skips the Stripe call when the outstanding refund balance has already been settled", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-mod-settled",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-mod-settled",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            paymentTransactionId: null,
          }),
        ]);
      },
    );
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_original",
      transactions: [
        {
          id: "txn-1",
          stripePaymentIntentId: "pi_original",
          amountCents: 10000,
          refundedAmountCents: 10000,
          status: PaymentStatus.REFUNDED,
        },
      ],
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("alerts admins when a booking modification refund recovery exhausts its retries", async () => {
    const exhaustedOperation = makeOperation({
      id: "recovery-mod-fail",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      attempts: 5,
      amountCents: 4000,
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(exhaustedOperation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { ...exhaustedOperation, status: "PENDING" },
        ]);
      },
    );
    mockRefundPaymentTransactions.mockRejectedValue(
      new Error("Stripe is unavailable"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4000,
        errorMessage: expect.stringContaining(
          "REFUND_BOOKING_MODIFICATION failed after",
        ),
      }),
    );
  });

  it("enqueueBookingModificationRefundRecovery picks the latest captured PaymentIntent", async () => {
    mockPaymentFindUnique.mockResolvedValueOnce({
      id: "payment-1",
      stripePaymentIntentId: "pi_legacy",
      transactions: [
        {
          id: "txn-additional",
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: "pi_additional",
          amountCents: 5000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
        {
          id: "txn-primary",
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: "pi_primary",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
      ],
    });

    await enqueueBookingModificationRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      bookingModificationId: "mod-7",
      amountCents: 4000,
      stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey: "payment_recovery_modification_refund_mod-7",
        },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          paymentIntentId: "pi_additional",
          amountCents: 4000,
          stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
        }),
      }),
    );
  });

  describe("additional PaymentIntent recovery (#1096)", () => {
    function additionalIntentOperation(overrides: Record<string, unknown> = {}) {
      return makeOperation({
        id: "recovery-additional",
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        amountCents: 3000,
        // The stored Stripe idempotency key until the intent exists.
        paymentIntentId: "mod_guest_bk1_mod-9",
        idempotencyKey: "payment_recovery_additional_intent_mod-9",
        paymentTransactionId: null,
        // #3181: this edit HAD a primary Xero invoice when it dispatched, which
        // is what makes a deferred supplementary invoice the right completion.
        hadIssuedXeroInvoice: true,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        ...overrides,
      });
    }

    function primeQueue(operation: ReturnType<typeof makeOperation>) {
      mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ ...operation, status: "PENDING" }]);
        },
      );
    }

    beforeEach(() => {
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        stripePaymentIntentId: "pi_original",
        transactions: [
          {
            id: "txn-1",
            kind: "PRIMARY",
            stripePaymentIntentId: "pi_original",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: PaymentStatus.SUCCEEDED,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });
      mockCreatePaymentIntent.mockResolvedValue({
        id: "pi_recovered",
        client_secret: "secret_recovered",
      });
    });

    it("re-creates the intent with the stored modification-scoped Stripe key", async () => {
      primeQueue(additionalIntentOperation());

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          customerId: "cus_123",
          idempotencyKey: "mod_guest_bk1_mod-9",
          metadata: expect.objectContaining({
            bookingId: "booking-1",
            type: "modification_additional",
          }),
        }),
      );
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-1",
          paymentIntentId: "pi_recovered",
          amountCents: 3000,
          status: PaymentStatus.PENDING,
        }),
      );
      expect(mockQueueSupersededAdditionalIntentCancellations).toHaveBeenCalledWith({
        bookingId: "booking-1",
        paymentId: "payment-1",
        newPaymentIntentId: "pi_recovered",
      });
      // The waiting supplementary Xero op is pointed at the recovered intent.
      expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith({
        bookingModificationId: "mod-9",
        paymentIntentId: "pi_recovered",
      });
      // The row's placeholder key is replaced by the real intent id.
      expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "recovery-additional" },
          data: { paymentIntentId: "pi_recovered" },
        }),
      );
    });

    it("completes without creating when a later edit already minted a newer additional intent", async () => {
      primeQueue(additionalIntentOperation());
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        transactions: [
          {
            id: "txn-newer",
            kind: "ADDITIONAL",
            stripePaymentIntentId: "pi_later_edit",
            amountCents: 4500,
            refundedAmountCents: 0,
            status: PaymentStatus.PENDING,
            // Created after the operation was enqueued: it superseded ours.
            createdAt: new Date("2026-06-02T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
    });

    // #1358 (F29): a booking cancelled after the modification has no increase
    // left to collect — the cancel flow tore down its additional intents, so
    // recovery must complete without minting a live intent or re-arming the
    // waiting supplementary Xero operation.
    it("completes without creating anything when the booking is CANCELLED (#1358)", async () => {
      primeQueue(additionalIntentOperation());
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        stripePaymentIntentId: "pi_original",
        transactions: [
          {
            id: "txn-1",
            kind: "PRIMARY",
            stripePaymentIntentId: "pi_original",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: PaymentStatus.SUCCEEDED,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          status: "CANCELLED",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockQueueSupersededAdditionalIntentCancellations).not.toHaveBeenCalled();
      expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
    });

    /**
     * #3181: THE INVOICE THE INLINE PATH DEFERRED IS RAISED HERE, OR NOWHERE.
     *
     * The edit path skips the supplementary invoice while no additional
     * PaymentIntent exists and defers to this replay, and the replay used only to
     * ATTACH the recovered intent to an operation already waiting - which, on
     * exactly the edits that skipped, does not exist. The member could pay and
     * the club's books never saw the charge.
     */
    describe("the deferred supplementary invoice (#3181)", () => {
      function paymentWithIssuedInvoice(
        overrides: Record<string, unknown> = {},
      ) {
        return {
          id: "payment-1",
          stripeCustomerId: "cus_123",
          stripePaymentIntentId: "pi_original",
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: "xero-inv-1",
          transactions: [
            {
              id: "txn-1",
              kind: "PRIMARY",
              stripePaymentIntentId: "pi_original",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: PaymentStatus.SUCCEEDED,
              createdAt: new Date("2026-05-01T00:00:00.000Z"),
            },
          ],
          booking: {
            id: "booking-1",
            memberId: "m1",
            member: {
              id: "m1",
              email: "alice@test.com",
              firstName: "Alice",
              lastName: "Smith",
            },
          },
          ...overrides,
        };
      }

      it("raises it against the recovered intent once the mint succeeds", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledTimes(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({
            bookingId: "booking-1",
            bookingModificationId: "mod-9",
            paymentIntentId: "pi_recovered",
            hasIssuedXeroInvoice: true,
          }),
        );
      });

      /**
       * #3181 fix round: THE EDIT'S ANSWER, NOT THE PASSAGE OF TIME.
       *
       * The booking's primary Xero invoice had NOT been minted when the edit
       * committed, so the edit queued nothing - correctly, because the primary
       * invoice reads the booking's CURRENT state when its own outbox operation
       * finally runs and therefore bills the edit itself. By the time the replay
       * arrives that invoice exists and `payment.xeroInvoiceId` is set, so a
       * replay that re-derived the flag would raise a SECOND ask for money the
       * primary invoice already carries: $600 of Xero income and a $50
       * receivable for a $550 booking, and only because Stripe blinked.
       *
       * The payment row below deliberately CARRIES the invoice id. That is the
       * whole point: the fact that would mislead a re-derivation is present, and
       * the frozen `hadIssuedXeroInvoice: false` is what stops it.
       */
      it("bills the edit's own answer when the payment row now says otherwise", async () => {
        primeQueue(additionalIntentOperation({ hadIssuedXeroInvoice: false }));
        // Deliberately CARRYING the invoice id: this is the fact that would
        // mislead a re-derivation, and the frozen `false` is what stops it. A
        // `false` reaches the dispatcher rather than short-circuiting here,
        // because "no primary invoice means no supplementary invoice" is
        // `classifyXeroBookingEditSettlement`'s decision and belongs in one
        // place (`INV-SSOT`); the outbox suite's control proves it queues
        // nothing.
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({ hasIssuedXeroInvoice: false }),
        );
      });

      /**
       * A row enqueued before that answer was recorded cannot be asked, so it is
       * not guessed. The asymmetry is the argument: an invoice this pass fails to
       * raise is surfaced by the booking-vs-Xero repair pass as a critical,
       * one-click finding, while a duplicate it raises in error is surfaced by
       * nobody and lands on the member.
       */
      it("raises nothing when the edit's answer was never recorded", async () => {
        primeQueue(additionalIntentOperation({ hadIssuedXeroInvoice: null }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * The recovery row carries what STRIPE is collecting; the invoice bills the
       * edit's two SIGNED components (#1356), which a price reduction plus a
       * larger late-change fee separates. Reaching for `operation.amountCents`
       * would gross-bill the fee and drop the reduction, and would read as
       * correct on every single-component edit.
       */
      it("bills the modification's signed components, not the row's collectable amount", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000 }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockResolvedValue({
          priceDiffCents: -500,
          changeFeeCents: 1000,
        });

        await processPaymentRecoveryOperations({ limit: 1 });

        expect(mockBookingModificationFindUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "mod-9" } }),
        );
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({ priceDiffCents: -500, changeFeeCents: 1000 }),
        );
      });

      /**
       * CONTROL. The cancel flow retired this booking's additional intents, so
       * nothing is minted - and an invoice for money that must never be captured
       * would be worse than the silence this issue removes.
       */
      it("raises nothing when the booking was cancelled", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(
          paymentWithIssuedInvoice({
            booking: {
              id: "booking-1",
              memberId: "m1",
              status: "CANCELLED",
              member: {
                id: "m1",
                email: "alice@test.com",
                firstName: "Alice",
                lastName: "Smith",
              },
            },
          }),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * CONTROL. A later edit repriced from current state and minted its own
       * collectable, so this modification's ask is gone; billing for it would
       * invoice money nobody is being asked to pay.
       */
      it("raises nothing when a later edit already superseded this one", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(
          paymentWithIssuedInvoice({
            transactions: [
              {
                id: "txn-newer",
                kind: "ADDITIONAL",
                stripePaymentIntentId: "pi_later_edit",
                amountCents: 4500,
                refundedAmountCents: 0,
                status: PaymentStatus.PENDING,
                createdAt: new Date("2026-06-02T00:00:00.000Z"),
              },
            ],
          }),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * A failure to queue must not re-open the recovery row. The replay has
       * already written this edit's ADDITIONAL transaction, and the processor's
       * own "a LATER edit superseded this one" check would read that very row as
       * a supersession on the next pass - so a retry would complete having done
       * nothing, turning a missing invoice into a missing invoice plus a spurious
       * FAILED row. The intent, which is this operation's actual job, succeeded.
       */
      it("still closes the operation when the invoice could not be queued", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
          new Error("outbox unavailable"),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { paymentIntentId: "pi_recovered" },
          }),
        );
      });

      it("raises nothing when the modification anchor no longer exists", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockResolvedValue(null);

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * #3181 fix round: THE MODIFICATION READ HAPPENS WHERE A THROW IS STILL A
       * RETRY, and this test is about WHERE, not about whether.
       *
       * Reading the edit's signed components is a plain database query, and a
       * plain database query can fail transiently. Below the
       * `upsertPaymentIntentTransaction` that throw is unrecoverable in the exact
       * way this file's docblock spells out: the ADDITIONAL row now exists, so on
       * the next pass the "a LATER edit superseded this one" check finds the row
       * THIS replay wrote, reads it as a supersession, and completes the
       * operation having done nothing at all. A $50 guest add collected with no
       * invoice behind it, and a recovery row reading SUCCEEDED.
       *
       * So the read is hoisted above the mint, and the two assertions below are
       * what pin it there: the operation is left retryable, and NOTHING has been
       * written that a retry would trip over. Move the read back down and the
       * second assertion fails, because the transaction is written before the
       * read that throws.
       */
      it("retries without writing anything when the modification read fails", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockRejectedValueOnce(
          new Error("database connection reset"),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result).toMatchObject({ succeeded: 0, retried: 1, failed: 0 });
        // Nothing a second pass could mistake for a later edit's collectable.
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
        // And no provider round trip paid for on the way to the failure.
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      });

      /**
       * #3181 fix round: A MODULE THAT FAILS TO LOAD IS A FAILURE TO QUEUE, not
       * an escape hatch out of this worker.
       *
       * The settlement module is reached through `await import`, and that line
       * used to sit OUTSIDE the `try` whose `catch` turns a failed enqueue into a
       * recorded one. An import throws like anything else - a chunk that will not
       * resolve, a module whose own top level fails - and the throw escaped into
       * `failPaymentRecoveryOperation`, buying the retry the docblock explains
       * cannot work. The operation must close on its actual job (the intent, which
       * was minted) with the invoice recorded as unraised.
       */
      it("still closes the operation when the settlement module cannot be loaded", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        settlementModuleLoadFailure.current = new Error(
          "Cannot find module '@/lib/xero-booking-edit-settlement'",
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result).toMatchObject({ succeeded: 1, retried: 0, failed: 0 });
        expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
        expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { paymentIntentId: "pi_recovered" },
          }),
        );
      });
    });

    it("enqueues exactly one recovery row per booking modification", async () => {
      const { enqueueAdditionalPaymentIntentRecovery } = await import(
        "@/lib/payment-recovery"
      );

      await enqueueAdditionalPaymentIntentRecovery({
        bookingId: "booking-1",
        paymentId: "payment-1",
        // #3170: the key is passed rather than derived, so the review-completion
        // charge can scope its own to the TASK. The ordinary edit path still
        // builds the modification-scoped key and this asserts the same string.
        idempotencyKey: "payment_recovery_additional_intent_mod-9",
        amountCents: 3000,
        stripeIdempotencyKey: "mod_guest_bk1_mod-9",
        hadIssuedXeroInvoice: true,
      });

      // #3181: the edit's answer is frozen on CREATE and deliberately absent
      // from UPDATE - a colliding second caller for one debt must not rewrite a
      // fact the cron may already be acting on, so first-writer-wins keeps the
      // earliest edit-time answer.
      {
        const upsert = mockPaymentRecoveryUpsert.mock.calls[0][0] as {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        };
        expect(upsert.create).toMatchObject({ hadIssuedXeroInvoice: true });
        expect(upsert.update).not.toHaveProperty("hadIssuedXeroInvoice");
      }

      expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            idempotencyKey: "payment_recovery_additional_intent_mod-9",
          },
          create: expect.objectContaining({
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            status: PaymentRecoveryOperationStatus.PENDING,
            bookingId: "booking-1",
            paymentId: "payment-1",
            paymentIntentId: "mod_guest_bk1_mod-9",
            amountCents: 3000,
          }),
        }),
      );
    });

    it("never rewrites an existing debt's amount on a colliding upsert (#3170)", async () => {
      /*
        The update clause used to carry `amountCents`, so a second caller landing
        on the same key silently rewrote a debt the recovery cron might already be
        part way through. That is the hazard
        `buildEditFinancialReviewRefundRecoveryIdempotencyKey` was task-scoped to
        avoid on the REFUND side, and it sat unremarked on the charge side - where
        one edit raising two review tasks over one BookingModification row would
        have collided by construction.

        Under a correct key a repeat carries the same amount, so dropping it from
        the update changes nothing that is right and makes the wrong thing
        unrepresentable.
      */
      const { enqueueAdditionalPaymentIntentRecovery } = await import(
        "@/lib/payment-recovery"
      );

      await enqueueAdditionalPaymentIntentRecovery({
        bookingId: "booking-1",
        paymentId: "payment-1",
        idempotencyKey: "edit_financial_review_additional_intent_recovery_task-1",
        amountCents: 3000,
        stripeIdempotencyKey: "edit_financial_review_additional_task-1",
        hadIssuedXeroInvoice: true,
      });

      const call = mockPaymentRecoveryUpsert.mock.calls[0][0] as {
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      };
      expect(call.update).not.toHaveProperty("amountCents");
      // A CONTROL: the update clause still exists and still refreshes what a
      // repeat cannot change, so the assertion above is about the amount rather
      // than about the clause having been emptied.
      expect(call.update).toMatchObject({
        bookingId: "booking-1",
        paymentId: "payment-1",
      });
      // And the amount is still written when the row is CREATED - the debt has
      // to start life with a figure.
      expect(call.create).toMatchObject({ amountCents: 3000 });
    });
  });

  describe("#1992 duplicate-capture refund recovery replay (#2008)", () => {
    function makeDuplicateCaptureOp() {
      return makeOperation({
        id: "recovery-dup",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId: "booking-1",
        paymentId: "payment-1",
        // The op's paymentIntentId is the FIRST captured intent, not necessarily
        // the duplicate; the duplicate is the suffix of the idempotency key.
        paymentIntentId: "pi_settled",
        idempotencyKey: "duplicate_capture_booking-1_pi_dup",
        stripeKeyPrefix: "duplicate_capture_refund_booking-1_pi_dup",
        amountCents: 5000,
        allocationPlan: [{ paymentTransactionId: "txn-dup", amountCents: 5000 }],
      });
    }

    it("records the admin-only history event EXACTLY ONCE on a successful cron replay, keyed off the terminal SUCCEEDED transition", async () => {
      const dupOp = makeDuplicateCaptureOp();
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([dupOp]);
        },
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(dupOp);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      // Replays the frozen slice under the shared duplicate_capture_refund prefix.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKeyPrefix: "duplicate_capture_refund_booking-1_pi_dup",
          allocation: [
            { paymentTransactionId: "txn-dup", amountCents: 5000 },
          ],
        }),
      );
      // The event lands exactly once, with the duplicate intent parsed from the
      // key and a null settling intent (not persisted on the operation).
      expect(mockRecordDuplicateCaptureRefundEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordDuplicateCaptureRefundEvent).toHaveBeenCalledWith({
        bookingId: "booking-1",
        amountCents: 5000,
        duplicatePaymentIntentId: "pi_dup",
        settledPaymentIntentId: null,
      });
    });

    it("does NOT record the event when the terminal transition finds the operation already SUCCEEDED (count 0)", async () => {
      const dupOp = makeDuplicateCaptureOp();
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([dupOp]);
        },
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(dupOp);
      // The claim updateMany (status IN [PENDING,FAILED]) still flips, but the
      // duplicate-capture terminal transition (status: { not: SUCCEEDED }) finds
      // the row already SUCCEEDED — the inline path won the race and recorded it.
      mockPaymentRecoveryUpdateMany.mockImplementation(
        (args: { where?: { status?: unknown; id?: string } }) => {
          const status = args.where?.status;
          if (status && typeof status === "object" && "not" in status) {
            return Promise.resolve({ count: 0 });
          }
          return Promise.resolve({ count: args.where?.id ? 1 : 0 });
        },
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockRecordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
    });
  });
});

/**
 * #2262 H1/H2 — the manual mark-paid reversal DELETES the settle's hygiene
 * operations, and every write that could act on a stale in-memory copy of one
 * is status-fenced so a deleted operation is inert everywhere:
 *  - the webhook-side handoff finder simply finds nothing (the capture settles
 *    the booking normally);
 *  - the succeeded-intent handoff re-claims before flipping money state and
 *    ABANDONS when the claim matches nothing;
 *  - the terminal completion is a fenced updateMany that cannot P2025-throw or
 *    resurrect a deleted row;
 *  - a re-mark re-arms cancel hygiene through the enqueue upsert's CREATE arm.
 */
describe("#2262 — deleted-operation coherence (H1/H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentTransactionUpdate.mockResolvedValue({});
    mockReconcilePaymentAggregates.mockResolvedValue(undefined);
  });

  it("H1 — after the reversal's delete, a post-reversal capture is NOT handed to the superseded-refund machinery (webhook side settles normally)", async () => {
    // The reversal deleted the CANCEL_PAYMENT_INTENT row, so the liveness
    // finder (status != SUCCEEDED) finds nothing and the webhook handler falls
    // through to the ordinary settlement path.
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({
        paymentIntentId: "pi_stale_pay_tab",
        amountCents: 10000,
        paymentMethodId: "pm_1",
      }),
    ).resolves.toBe(false);

    // No transaction flip, no refund enqueued — the capture is the caller's to
    // settle as ordinary money.
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  it("H2 — the succeeded-intent handoff re-claims before moving money and ABANDONS when the reversal deleted the operation mid-PROCESSING", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    // The handoff's own claim (data -> PROCESSING) matches nothing: the row
    // was deleted between the worker's Stripe call and this write.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: { data?: { status?: unknown }; where?: { id?: string } }) => {
        if (args.data?.status === PaymentRecoveryOperationStatus.PROCESSING) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: args.where?.id ? 1 : 0 });
      },
    );

    await expect(
      queueSupersededPaymentIntentRefundRecovery({
        paymentIntentId: "pi_superseded",
        amountCents: 6000,
        paymentMethodId: "pm_1",
      }),
    ).resolves.toBe(true);

    // Abandoned loudly: no SUCCEEDED flip on the transaction, no fresh
    // REFUND_SUPERSEDED_PAYMENT the reversal's disarm never covered.
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  it("H2 — the fenced completion cannot resurrect a deleted operation (count 0 is handled, never a P2025 throw)", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([op]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation());
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });
    // Every fenced write (including the terminal completion) matches nothing —
    // the reversal deleted the row under the worker.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: {
        where?: { id?: string; status?: unknown; nextRetryAt?: unknown };
      }) =>
        // Only the initial cron claim (which carries nextRetryAt) still wins.
        Promise.resolve({ count: args.where?.nextRetryAt ? 1 : 0 }),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // No throw, no update-by-id resurrection: the worker records success for
    // its own run and the deleted row stays deleted.
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalled();
  });

  it("M2 — enqueuePaymentIntentCancellationRecovery's CREATE arm re-arms a deleted operation fresh (PENDING, immediate retry)", async () => {
    await enqueuePaymentIntentCancellationRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentTransactionId: "txn-1",
      paymentIntentId: "pi_live",
      amountCents: 10000,
    });

    // The reversal DELETED the old row, so the upsert cannot land in its
    // update arm: the create arm mints a fresh PENDING op with nextRetryAt now
    // — mark -> reverse -> re-mark keeps its durable cancel hygiene.
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "payment_recovery_cancel_txn-1_pi_live" },
      create: expect.objectContaining({
        type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        nextRetryAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        paymentIntentId: "pi_live",
      }),
    });
  });
});

describe("#2262 L3 — the recovery dispatcher is exhaustive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
  });

  it("FAILS an operation of an unhandled type loudly instead of executing it as a superseded-payment refund", async () => {
    const rogue = makeOperation({
      id: "recovery-rogue",
      type: "SOME_FUTURE_TYPE" as PaymentRecoveryOperationType,
      status: PaymentRecoveryOperationStatus.PENDING,
    });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([rogue]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(rogue);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.retried).toBe(1);
    // Never dispatched to the superseded-refund executor: no transaction read,
    // no Stripe refund.
    expect(mockPaymentTransactionFindUnique).not.toHaveBeenCalled();
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-rogue",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: expect.stringContaining(
          "Unhandled payment recovery operation type",
        ),
      }),
    });
  });
});

/**
 * #3170 (epic #2797): the recovery half of ONE EDIT, ONE REQUEST.
 *
 * The worker used to derive a `BookingModification` id by slicing the ORDINARY
 * edit key's prefix off whatever key the operation carried. That is correct for
 * the ordinary key and silently wrong for every other shape - a review-charge key
 * sliced to `"tent_recovery_<taskId>"`, and the Xero attach then looked for
 * waiting operations under an id that cannot exist. The builder had been moved
 * into `payment-recovery-keys.ts` and made a required argument; the parser was
 * left behind, which is the half-move `INV-SSOT` exists to stop.
 */
describe("additional-intent recovery keys read back to their edit (#3170)", () => {
  it("round-trips BOTH shapes of the key, and refuses anything else", () => {
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        buildAdditionalIntentRecoveryIdempotencyKey("mod-9"),
      ),
    ).toBe("mod-9");
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-9"),
      ),
    ).toBe("mod-9");
    // A CONTROL on the claim above: the two keys are genuinely different
    // strings, so a parser that understood only one of them would have to fail
    // here rather than agree by coincidence.
    expect(buildAdditionalIntentRecoveryIdempotencyKey("mod-9")).not.toBe(
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-9"),
    );
    // FAIL-CLOSED: an unrecognised key yields null and the caller does nothing,
    // rather than a slice of a string that is not an id.
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        "payment_recovery_cancel_txn-1_pi_x",
      ),
    ).toBeNull();
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        "payment_recovery_additional_intent_",
      ),
    ).toBeNull();
    expect(bookingModificationIdForAdditionalIntentRecoveryKey(null)).toBeNull();
  });
});

describe("edit-financial-review charge recovery (#3170)", () => {
  function chargeOperation(overrides: Record<string, unknown> = {}) {
    return makeOperation({
      id: "recovery-review-charge",
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      amountCents: 20000,
      paymentIntentId:
        buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1"),
      paymentTransactionId: null,
      // #3181: frozen by the settlement that raised this charge.
      hadIssuedXeroInvoice: true,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const operation = chargeOperation();
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...operation, status: "PENDING" }]);
      },
    );
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockBookingFindUnique.mockResolvedValue({
      status: "PAID",
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: {
        stripeCustomerId: "cus_123",
        // #3181: the invoice's local paid/refunded state is classified from
        // this. Whether an invoice EXISTS is deliberately NOT read here - the
        // recovery row carries the edit's own answer.
        status: PaymentStatus.SUCCEEDED,
      },
    });
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "raised",
      paymentIntentId: "pi_additional_1",
      totalCents: 23000,
    });
  });

  /** Did this run mark the operation SUCCEEDED? */
  function wasClosedSuccessfully() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some(
      (call) =>
        (call[0] as { data?: { status?: string } })?.data?.status ===
        "SUCCEEDED",
    );
  }

  /** Did this run leave the operation FAILED with a retry still to come? */
  function wasLeftForRetry() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some((call) => {
      const args = call[0] as {
        where?: { id?: string };
        data?: Record<string, unknown>;
      };
      // Scoped to THIS operation (#3220). Every failure transition is one
      // fenced `updateMany` now, and the stale-worker reaper writes the same
      // shape - so a helper matching on the data alone would answer for a row
      // this test never asked about.
      if (args?.where?.id !== "recovery-review-charge") return false;
      const data = args?.data;
      return data?.status === "FAILED" && data?.nextRetryAt != null;
    });
  }

  it("re-derives the edit's combined total instead of replaying the frozen amount", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The replay asks the SHARES what is owed, so a row carrying a stale $200
    // cannot mint for the wrong figure. That is what makes ONE edit-scoped
    // recovery row safe where the first round needed one row per task.
    expect(mockSyncEditFinancialReviewChargeRequest).toHaveBeenCalledWith({
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      // #3181: the settlement's own answer, read back off this row rather than
      // re-derived - a second, disagreeing answer in the one place the frozen
      // one exists to prevent.
      hasIssuedXeroInvoice: true,
      paymentId: "payment-1",
      member: {
        id: "m1",
        email: "alice@test.com",
        name: "Alice Smith",
        stripeCustomerId: "cus_123",
      },
    });
    // It must NOT fall through to the ordinary path, whose "a newer additional
    // supersedes this one" check would see the request this very edit already
    // minted and complete having minted nothing - exactly how the first round's
    // second share was dropped.
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(
      mockQueueSupersededAdditionalIntentCancellations,
    ).not.toHaveBeenCalled();
    // The waiting supplementary Xero op is pointed at the request, under the
    // anchor the shared parser read back - never a slice of the key.
    expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith({
      bookingModificationId: "mod-1",
      paymentIntentId: "pi_additional_1",
    });
  });

  /**
   * #3170 fix round (F1) - THE REPLAY MUST NOT CLOSE A DEBT IT DID NOT RAISE.
   *
   * The provider is still down when the cron replays. The mint arm swallows its
   * failure and re-enqueues - and the row it re-enqueues is THIS row, whose
   * upsert `update` branch deliberately does not reset `status`, so that
   * re-enqueue is a no-op on a PROCESSING row. Completing here marked the
   * operation SUCCEEDED having minted nothing: two shares of $200 and $30 both
   * read COMPLETED and the club collected neither.
   */
  it("leaves the operation open when the replay raised no request", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // NOT closed, and NOT counted as a success.
    expect(result.succeeded).toBe(0);
    expect(wasClosedSuccessfully()).toBe(false);
    // Handed to the machinery that already exists for this: back off, retry, and
    // on exhaustion mark it FAILED and raise the admin payment-failure alert. The
    // $230 stays owed, visible and recoverable.
    expect(result.retried).toBe(1);
    expect(wasLeftForRetry()).toBe(true);
    // Nothing was attached to a Xero operation either, because there is no intent
    // to attach.
    expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
  });

  /**
   * The CONTROL for the guard above. A replay that DID raise the request must
   * still close - a check that refused everything would pass the test above and
   * would wedge every recovered charge in a retry loop.
   */
  it("closes the operation when the replay did raise the request", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
    expect(wasLeftForRetry()).toBe(false);
  });

  /**
   * The other two outcomes are terminal rather than recoverable, and closing on
   * them is the point: retrying would loop for ever on a question no retry can
   * answer.
   */
  it("closes the operation when there is nothing owed", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "nothing-owed",
      paymentIntentId: null,
      totalCents: 0,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
  });

  it("closes the operation when the member had already paid the request", async () => {
    // The remaining share is collected by hand; the charge module writes the
    // audit row that tells an officer so. Nothing a retry can improve.
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
  });

  /**
   * #3181: the review charge re-enters the ordinary price-increase path, so it
   * deferred its supplementary invoice for the same reason and this replay has to
   * complete it for the same reason. The issue reported one defect and predicted
   * one fix would close both halves; the worker forks on the recovery key, so
   * both forks needed the completion.
   */
  it("raises the deferred supplementary invoice for the edit's combined total", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledTimes(1);
    expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        bookingModificationId: "mod-1",
        paymentIntentId: "pi_additional_1",
        // The COMBINED total the sync re-derived from the settled shares - one
        // edit, one ask - never the row's advisory $200.
        priceDiffCents: 23000,
        changeFeeCents: 0,
        hasIssuedXeroInvoice: true,
      }),
    );
  });

  /**
   * The enqueue's own verdict, recorded through the one function that decides
   * what counts as short. `short-sent` means this edit's invoice had already
   * gone out and could not be raised to the settled total, so the difference has
   * to be billed by hand and an officer has to be able to find that.
   */
  it("records a short ask when the invoice had already left the queue", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockResolvedValueOnce("short-sent");

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordShortEditReviewChargeInvoice).toHaveBeenCalledWith({
      outcome: "short-sent",
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      /**
       * #3193: BOTH NULL, and that is a refusal rather than an omission.
       *
       * Since the owner's 31 Aug 2026 decision a sent-short ask raises a SECOND,
       * separate invoice for the difference - but only where the caller holds
       * the single settled share to bill, because billing anything else asks
       * the member for money they have already been asked for. This replay
       * holds no task: it re-derives the edit's COMBINED total across every
       * share and cannot say which part of it the sent invoice already carries,
       * so the only figure it could invoice is the whole $230 on top of the
       * $200 already with the member. Passing the total here would be the
       * double-bill the decision is explicitly bounded away from.
       */
      reviewTaskId: null,
      shareCents: null,
      memberId: "m1",
      totalCents: 23000,
    });
  });

  /**
   * #3181 fix round: THE REVIEW FORK LEAVES A DURABLE TRACE WHEN THE ENQUEUE
   * THROWS, because it is the one fork that cannot fall back on the repair pass.
   *
   * A parked edit's `BookingModification` carries only the readable strands'
   * money, so an edit whose only money-affecting strand was the parked one has
   * `priceDiffCents + changeFeeCents == 0` - and the booking-vs-Xero repair pass
   * gates its missing-supplementary finding on `netAmountCents > 0`, so it never
   * looks. Without this record an officer settles at $230, the member pays it,
   * and the club's only account of the charge is a `logger.error`. `INV-PAY`: a
   * log line is not a durable trace.
   */
  it("records the unraised invoice when the enqueue throws", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
      new Error("outbox unavailable"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The intent - this operation's actual job - succeeded, so the row closes.
    expect(result.succeeded).toBe(1);
    expect(mockRecordShortEditReviewChargeInvoice).not.toHaveBeenCalled();
    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith({
      leg: "xero-invoice",
      // Not `ask-closed`: no invoice exists to bill the earlier figure, so the
      // whole settled total is unbilled rather than under-billed.
      cause: "ask-not-raised",
      // #3193: no ask exists here for a second one to follow, so the second-ask
      // question does not arise at all. `null`, not `unavailable`, which is
      // specifically "an ask exists and its difference cannot be worked out".
      secondAsk: null,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      memberId: "m1",
      derivedTotalCents: 23000,
      requestedTotalCents: null,
    });
  });

  /**
   * The same trace for the other way of raising nothing, UNDER A DIFFERENT CAUSE,
   * and the difference is the point (#3181 delta review).
   *
   * A row enqueued before the edit's answer was recorded is not guessed at, and
   * silence about a charge the member has been asked for is exactly what this
   * issue removed - but the two silences are not the same fact. `ask-not-raised`
   * tells an officer, in the audit body, that no invoice could be raised and to
   * raise one by hand. That is right when an invoice was owed and the queue
   * refused it. It is WRONG here: a NULL row is the club saying it cannot tell
   * whether an invoice was owed, and on a booking whose primary Xero invoice had
   * not been minted when the edit committed that invoice bills the charge itself
   * - so a hand-raised supplementary is a second ask for the same money.
   * `ask-owed-unknown` says that, and names the booking-vs-Xero repair pass as
   * the instrument that can actually answer it.
   */
  it("records the unraised invoice under an unknown-owing cause when the edit's answer was never recorded", async () => {
    const operation = chargeOperation({ hadIssuedXeroInvoice: null });
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...operation, status: "PENDING" }]);
      },
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "ask-owed-unknown",
        derivedTotalCents: 23000,
      }),
    );
  });

  /**
   * CONTROL for that split: the enqueue THROWING still files `ask-not-raised`.
   * An invoice was owed - the row froze `hadIssuedXeroInvoice: true` - and the
   * queue refused it, so raising one by hand is the right instruction and the
   * cause that carries it is the right cause. Without this control, collapsing
   * both outcomes onto `ask-owed-unknown` would pass the test above.
   */
  it("still records a throw under the invoice-was-owed cause", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
      new Error("outbox unavailable"),
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "ask-not-raised" }),
    );
  });

  /**
   * #3181 fix round: AN ALREADY-PAID ASK GETS NO WAITING_PAYMENT ROW.
   *
   * `already-paid` is the sync saying this edit's request was captured before the
   * replay reached it - its webhook has fired and cannot fire again. An invoice
   * queued WAITING_PAYMENT against that intent is a row nothing will ever
   * release, cancelled by the 14-day reaper with no invoice raised at all. Worse,
   * while it sits there the repair pass reads the anchor as
   * `BLOCKED_BY_XERO_OPERATION` - warning, not auto-appliable, no action offered,
   * reported as waiting for a payment that has already happened - instead of the
   * critical, one-click `MISSING_SUPPLEMENTARY_INVOICE`. The share that could not
   * join the ask already has its record, written by the sync on the
   * `payment-request` leg, so nothing is lost by staying out of the way.
   */
  it("queues no invoice against an ask that was already paid", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    // Not an unraised-invoice record either: the sync has already written the
    // `payment-request` leg for this exact share, and two records for one fact
    // is how an officer learns to distrust both.
    expect(mockRecordUncollectedEditReviewChargeShare).not.toHaveBeenCalled();
  });

  /**
   * CONTROL for the two records above: on an ordinary run the covered verdict is
   * passed through, and the function that owns the mapping is what stays silent.
   * A caller re-deriving "is this short" is how the two legs came to disagree.
   */
  it("passes a covered verdict through to the same record function", async () => {
    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordShortEditReviewChargeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "covers-total" }),
    );
  });

  it("raises no invoice when the replay raised no request", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
  });

  it("mints nothing for a cancelled booking", async () => {
    // #1358, applied to the charge: the cancel flow retired this booking's
    // additional intents, so resurrecting one here would re-arm a collectable
    // that must never be captured.
    mockBookingFindUnique.mockResolvedValue({
      status: "CANCELLED",
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: { stripeCustomerId: "cus_123" },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockSyncEditFinancialReviewChargeRequest).not.toHaveBeenCalled();
    expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
  });
});

/**
 * #3220: A DEAD RECOVERY WITHDRAWS THE ASK IT LEFT STANDING.
 *
 * A `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery is the club still owing itself
 * the job of asking a member for money a booking edit raised. While it is alive
 * the booking-vs-Xero repair tool defers; the moment it dies the repair raises
 * that edit's supplementary invoice UNPAID (`OPEN_PAYMENT_RECOVERY_STATUSES`,
 * the #3202 control). So an ask still standing at the terminal transition is a
 * SECOND live instrument for one debt, and paying it leaves the club holding a
 * payment and an unpaid invoice for the same money.
 *
 * Everything here is about the TERMINAL transition specifically, and about the
 * cancel being unable to make the recovery worse than not trying.
 */
describe("#3220 - the terminal transition withdraws a stranded ask", () => {
  const MOD = "mod-3220";
  const RECOVERY_ID = "recovery-3220";

  function deadOnThisAttempt(overrides: Record<string, unknown> = {}) {
    return makeOperation({
      id: RECOVERY_ID,
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      // The claim has already burnt the last attempt, so this failure is the
      // one that ends the operation.
      attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      amountCents: 20000,
      paymentIntentId: buildEditFinancialReviewAdditionalIntentStripeKey(MOD),
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(MOD),
      paymentTransactionId: null,
      hadIssuedXeroInvoice: true,
      ...overrides,
    });
  }

  /** The ask as the ledger holds it, i.e. what a live intent looks like. */
  function liveAsk(overrides: Record<string, unknown> = {}) {
    return {
      paymentTransactionId: "txn-ask",
      stripePaymentIntentId: "pi_stranded_ask",
      amountCents: 23000,
      status: PaymentStatus.PENDING,
      ...overrides,
    };
  }

  function markedTerminallyFailed() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some((call) => {
      const args = call[0] as {
        where?: { id?: string };
        data?: Record<string, unknown>;
      };
      if (args?.where?.id !== RECOVERY_ID) return false;
      return args?.data?.status === "FAILED" && args?.data?.nextRetryAt === null;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    settlementModuleLoadFailure.current = null;
    const operation = deadOnThisAttempt();
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args) ? [] : [{ ...operation, status: "PENDING" }],
      ),
    );
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockBookingFindUnique.mockResolvedValue({
      status: "PAID",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: { stripeCustomerId: "cus_123", status: PaymentStatus.SUCCEEDED },
    });
    // The replay's own work fails, which is what drives the terminal
    // transition. WHY it failed is not this block's subject.
    mockSyncEditFinancialReviewChargeRequest.mockRejectedValue(
      new Error("Stripe is unavailable"),
    );
    mockFindEditReviewChargeRequest.mockResolvedValue(liveAsk());
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_stranded_ask", status: "canceled" },
    });
  });

  it("cancels the stranded ask, and says abandoned rather than blaming the member", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(markedTerminallyFailed()).toBe(true);
    /**
     * `requested_by_customer` - what the helper hard-coded before #3220 - would
     * be a lie in the club's own Stripe record. The member never declined this
     * ask; the club ran out of attempts to raise it.
     */
    expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith(
      "pi_stranded_ask",
      { cancellationReason: "abandoned" },
    );
  });

  it("leaves an ask the member has ALREADY PAID completely alone", async () => {
    // The acceptance criterion from the decision comment. The Stripe helper
    // would refuse a `succeeded` intent anyway, so this is the second lock on
    // the same door - but getting it wrong here would take money back off a
    // member who paid, so the door has two locks.
    mockFindEditReviewChargeRequest.mockResolvedValue(
      liveAsk({ status: PaymentStatus.SUCCEEDED }),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(markedTerminallyFailed()).toBe(true);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  it("makes no provider call at all when the mint never produced an ask", async () => {
    // The ORDINARY ending: the recovery existed precisely because nothing was
    // minted, so there is no second instrument and nothing to withdraw. A
    // provider call here would be a round trip on every dead recovery.
    mockFindEditReviewChargeRequest.mockResolvedValue(null);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  it("does not touch the ask while the recovery still has attempts left", async () => {
    // A retry is not a death. Withdrawing the ask here would cancel an intent
    // the very next attempt is going to raise.
    const retryable = deadOnThisAttempt({ attempts: 1 });
    mockPaymentRecoveryFindUnique.mockResolvedValue(retryable);
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args) ? [] : [{ ...retryable, status: "PENDING" }],
      ),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.retried).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  /**
   * THE REFUSAL PATH, which the decision comment singles out: `processing` is in
   * Stripe's cancellable set and Stripe routinely refuses to cancel a processing
   * intent, so this is a live path rather than a theoretical one.
   */
  it("records a refused cancel and still leaves the recovery dead, not blocked", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("You cannot cancel this PaymentIntent because it is processing"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The status write happened BEFORE the cancel and cannot be undone by it.
    // If a Stripe refusal could hold the row out of FAILED, the repair tool
    // would defer this edit's invoice for ever - the #3202 control.
    expect(markedTerminallyFailed()).toBe(true);
    expect(result.failed).toBe(1);

    // A logger.error is not a record an officer can find, and this one asks
    // them to do something before the member pays an already-invoiced ask.
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment.recovery.strandedIntentCancellationRefused",
        category: "payment",
        outcome: "failure",
        entityId: "booking-1",
      }),
    );
  });

  it("never lets a refused cancel abandon the rest of the batch", async () => {
    /**
     * `failPaymentRecoveryOperation` is called from inside the worker loop's own
     * `catch`. A throw from there escapes the loop and abandons every remaining
     * operation - the exact bug the chokepoint was built to fix - so the cancel
     * is best-effort in the strongest sense: even the AUDIT write failing must
     * not propagate.
     */
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe refused"),
    );
    mockCreateAuditLog.mockRejectedValue(new Error("the audit write also died"));

    const first = deadOnThisAttempt({ id: RECOVERY_ID });
    const second = deadOnThisAttempt({ id: "recovery-3220-second" });
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args)
          ? []
          : [
              { ...first, status: "PENDING" },
              { ...second, status: "PENDING" },
            ],
      ),
    );
    mockPaymentRecoveryFindUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === second.id ? second : first),
    );

    const result = await processPaymentRecoveryOperations({ limit: 5 });

    // BOTH were processed. One failing cancel must not cost the other one its
    // terminal transition, its alert, or its own withdrawal.
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
  });

  it("is idempotent on replay: an already-cancelled ask makes no second cancel", async () => {
    /**
     * Idempotency here is STRUCTURAL rather than defensive.
     * `cancelPaymentIntentIfCancellableWithResult` reads the intent first and
     * returns `canceled: false` without calling Stripe at all unless the status
     * is one it can cancel - so a replay of this transition finds `canceled`,
     * makes no provider mutation, and cannot error or double-cancel. This pins
     * that the caller treats that answer as success rather than retrying it.
     */
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_stranded_ask", status: "canceled" },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).toHaveBeenCalledTimes(1);
    // Not an error, so no officer is asked to chase a non-problem.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});

/**
 * #3220 fix round: THE STALE-WORKER REAPER FENCES THE ATTEMPT IT READ.
 *
 * Folding the reaper's two arms into the terminal chokepoint turned one bulk
 * `updateMany` into read-then-write. The bulk form's `where` carried
 * `processingStartedAt < staleBefore`; a fence of `status: PROCESSING` alone
 * does not, and matches a row that left `PROCESSING` and came straight back -
 * a concurrent reaper marks it failed with a `nextRetryAt` of NOW and the very
 * next queue read claims it. Taking that path kills a live attempt and acts on
 * terminality one attempt out of date.
 */
describe("#3220 - the stale-worker reaper cannot kill a re-claimed attempt", () => {
  it("pins the exact attempt it read, not merely the status", async () => {
    vi.clearAllMocks();
    const readAt = new Date("2026-06-01T00:00:00.000Z");
    const stale = makeOperation({
      id: "recovery-stale-fence",
      status: PaymentRecoveryOperationStatus.PROCESSING,
      attempts: 1,
      processingStartedAt: readAt,
    });
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(isStaleWorkerSweep(args) ? [stale] : []),
    );
    mockPaymentRecoveryUpdateMany.mockResolvedValue({ count: 1 });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-stale-fence",
          status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
          // Without this the reaper matches a row that has since been failed,
          // re-armed and re-claimed - and kills the live attempt.
          processingStartedAt: readAt,
        },
      }),
    );
  });
});
