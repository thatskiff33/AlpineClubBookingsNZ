import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

// #1992 — the duplicate-capture auto-refund. The residual #1967 split-child
// window lets an in-flight /pay link PaymentIntent (client secret already in
// the member's browser) and the settlement cron's saved-card charge BOTH
// capture. markBookingPaymentSucceeded must:
//   - refund the arriving capture when it is a DIFFERENT intent from the one
//     that settled the already-PAID booking (durable enqueue-then-execute,
//     exactly the duplicate's captured amount, pinned to its own transaction);
//   - keep `already_paid` byte-identical for a SAME-intent replay from every
//     legitimate caller path (webhook redelivery, confirm-payment route,
//     payment-link reconcile, charge-saved-method rerun, cron-confirm-pending
//     rerun, create-payment-intent recovery, confirm-pending-guests retry);
//   - never refund BOTH sides when the two captures' webhooks replay
//     (adjudication marker on the recovery-operation key prefix);
//   - preserve the #1765 refunded-history guard, including the
//     repay-generation case (a fully REFUNDED prior capture is history, not a
//     settlement the repay duplicates).

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  paymentRecoveryOperationFindFirst: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  enqueueDuplicateCaptureRefundRecovery: vi.fn(),
  findOtherDuplicateCaptureRefundOperation: vi.fn(),
  markDuplicateCaptureRefundRecoverySucceeded: vi.fn(),
  recordDuplicateCaptureRefundRecoveryInlineError: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  sendAdminDuplicateCaptureRefundAlert: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  recordDuplicateCaptureRefundEvent: vi.fn(),
  lodgeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
  planStripeRefundAllocation: (...args: unknown[]) =>
    mocks.planStripeRefundAllocation(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueCapacityClaimFailedRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueCapacityClaimFailedRefundRecovery(...args),
  markCapacityClaimFailedRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markCapacityClaimFailedRefundRecoverySucceeded(...args),
  recordCapacityClaimFailedRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordCapacityClaimFailedRefundRecoveryInlineError(...args),
  enqueueDuplicateCaptureRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueDuplicateCaptureRefundRecovery(...args),
  findOtherDuplicateCaptureRefundOperation: (...args: unknown[]) =>
    mocks.findOtherDuplicateCaptureRefundOperation(...args),
  markDuplicateCaptureRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markDuplicateCaptureRefundRecoverySucceeded(...args),
  recordDuplicateCaptureRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordDuplicateCaptureRefundRecoveryInlineError(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mocks.sendAdminPaymentFailureAlert(...args),
  sendAdminDuplicateCaptureRefundAlert: (...args: unknown[]) =>
    mocks.sendAdminDuplicateCaptureRefundAlert(...args),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
  recordDuplicateCaptureRefundEvent: (...args: unknown[]) =>
    mocks.recordDuplicateCaptureRefundEvent(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// #2576 §9. Mocked at the module boundary, like the other collaborators this suite
// already stubs. The real seam reads the booking and the lodge policy through the
// CONFIRMING transaction's client, and this suite drives that transaction with a fake
// that carries only the delegates the money path itself needs — so without this the
// enqueue throws and the settlement fails. Failing closed is the correct production
// behaviour (§8 wants the obligation to commit WITH the transition), so the fixture is
// what changes. Whether an uncovered booking becomes an incident belongs to the hosting
// suites; that this path reaches a seam at all is pinned tree-wide by
// `adult-member-hosting-call-sites.test.ts`.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(async () => null),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));


import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking,
  buildDuplicateCaptureRefundStripeKeyPrefix,
  bookingModificationRefundReasonForKeyPrefix,
} from "@/lib/payment-recovery-keys";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: {
    findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args),
  },
  // #2286: the capacity engines read bed-holding hut-leader assignments
  // (custodian occupancy). None in these cases.
  hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
  },
  paymentTransaction: {
    findFirst: (...args: unknown[]) => mocks.paymentTransactionFindFirst(...args),
  },
  // #1992 superseded-handoff exclusion: guards (b′)/(c′) read the recovery
  // operations inside the same lock(1) transaction. Deliberately NO write
  // methods here — the reconciliation path must never touch (complete, retry,
  // clobber) a superseded-machinery operation, so any write would crash a test.
  paymentRecoveryOperation: {
    findMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindMany(...args),
    findFirst: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindFirst(...args),
  },
};

type LedgerRow = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
};

function ledgerRow(overrides: Partial<LedgerRow> & { id: string }): LedgerRow {
  return {
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.SUCCEEDED,
    stripePaymentIntentId: null,
    amountCents: 10000,
    refundedAmountCents: 0,
    ...overrides,
  };
}

/**
 * True once the duplicate-capture candidate query has actually MATCHED a
 * sibling row. The `already_paid` guard tests assert this, so a mock that
 * silently stopped understanding the predicate shape would fail them loudly
 * instead of making them pass for the wrong reason.
 */
let reachedSibling = false;

/**
 * Drive both ledger lookups from one transaction list so the tests exercise
 * the REAL where-clause semantics of the duplicate-capture predicate:
 * `findFirst` honours kind/source/status filters and the arriving-intent
 * exclusion; `findPaymentTransactionByIntentId` resolves by intent id.
 */
function primeLedger(transactions: LedgerRow[]) {
  // #2262 widened the predicate to an OR: the STRIPE arm keeps the
  // arriving-intent + superseded exclusions, and a second arm matches ANY
  // settled non-Stripe PRIMARY row (a cash settlement, or a Xero-inbound
  // internet-banking one). The mock interprets that shape rather than the old
  // flat one; interpreting only the old shape would make the `already_paid`
  // guard tests pass VACUOUSLY (no sibling would ever be returned), which is
  // why reachedSibling below is asserted by those tests.
  mocks.paymentTransactionFindFirst.mockImplementation(
    async (args: {
      where: {
        kind: PaymentTransactionKind;
        status: { in: PaymentStatus[] };
        OR: Array<{
          source?: PaymentSource | { not: PaymentSource };
          stripePaymentIntentId?: { not: string; notIn: string[] };
        }>;
      };
    }) => {
      const { where } = args;
      const matchesArm = (
        transaction: LedgerRow,
        arm: {
          source?: PaymentSource | { not: PaymentSource };
          stripePaymentIntentId?: { not: string; notIn: string[] };
        }
      ) => {
        if (typeof arm.source === "string") {
          if (transaction.source !== arm.source) return false;
        } else if (arm.source && "not" in arm.source) {
          if (transaction.source === arm.source.not) return false;
        }
        if (arm.stripePaymentIntentId) {
          if (transaction.stripePaymentIntentId === null) return false;
          if (transaction.stripePaymentIntentId === arm.stripePaymentIntentId.not) {
            return false;
          }
          if (
            arm.stripePaymentIntentId.notIn.includes(
              transaction.stripePaymentIntentId
            )
          ) {
            return false;
          }
        }
        return true;
      };
      const match =
        transactions.find(
          (transaction) =>
            transaction.kind === where.kind &&
            where.status.in.includes(transaction.status) &&
            where.OR.some((arm) => matchesArm(transaction, arm))
        ) ?? null;
      if (match) reachedSibling = true;
      return match;
    }
  );
  mocks.findPaymentTransactionByIntentId.mockImplementation(
    async ({ paymentIntentId }: { paymentIntentId: string }) =>
      transactions.find(
        (transaction) => transaction.stripePaymentIntentId === paymentIntentId
      ) ?? null
  );
}

type RecoveryOperationRow = {
  id: string;
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentId: string;
  paymentIntentId: string;
};

/**
 * Drive BOTH superseded-machinery guard lookups (b′ findMany scoped to the
 * payment, c′ findFirst by intent id) from one operation list with the REAL
 * where-clause semantics: type-in filter, non-SUCCEEDED ("live") status
 * filter, payment scoping / intent-id equality. This makes the regression
 * tests exercise the actual predicates rather than a canned return value.
 */
function primeRecoveryOperations(operations: RecoveryOperationRow[]) {
  mocks.paymentRecoveryOperationFindMany.mockImplementation(
    async (args: {
      where: {
        paymentId: string;
        type: { in: PaymentRecoveryOperationType[] };
        status: { not: PaymentRecoveryOperationStatus };
      };
    }) =>
      operations
        .filter(
          (operation) =>
            operation.paymentId === args.where.paymentId &&
            args.where.type.in.includes(operation.type) &&
            operation.status !== args.where.status.not
        )
        .map((operation) => ({ paymentIntentId: operation.paymentIntentId }))
  );
  mocks.paymentRecoveryOperationFindFirst.mockImplementation(
    async (args: {
      where: {
        paymentIntentId: string;
        type: { in: PaymentRecoveryOperationType[] };
        status: { not: PaymentRecoveryOperationStatus };
      };
    }) =>
      operations.find(
        (operation) =>
          operation.paymentIntentId === args.where.paymentIntentId &&
          args.where.type.in.includes(operation.type) &&
          operation.status !== args.where.status.not
      ) ?? null
  );
}

function makePaidBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PAID,
    lodgeId: "lodge-1",
    checkIn: parseDateOnly("2026-08-10"),
    checkOut: parseDateOnly("2026-08-12"),
    finalPriceCents: 10000,
    parentBookingId: "parent-1",
    guests: [],
    member: {
      firstName: "Alice",
      lastName: "Member",
      email: "alice@example.com",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reachedSibling = false;
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.bookingFindUnique.mockResolvedValue(makePaidBooking());
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  // Default: no live superseded-machinery operations (guards b′/c′ find none).
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationFindFirst.mockResolvedValue(null);
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.sendAdminDuplicateCaptureRefundAlert.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.recordDuplicateCaptureRefundEvent.mockResolvedValue(undefined);
  mocks.refundPaymentTransactions.mockResolvedValue({ refunds: [] });
  mocks.enqueueDuplicateCaptureRefundRecovery.mockResolvedValue({
    id: "dup-op-1",
  });
  mocks.findOtherDuplicateCaptureRefundOperation.mockResolvedValue(null);
  mocks.markDuplicateCaptureRefundRecoverySucceeded.mockResolvedValue({
    count: 1,
  });
  mocks.recordDuplicateCaptureRefundRecoveryInlineError.mockResolvedValue({
    count: 1,
  });
});

// The settled auto-charge capture and the arriving in-flight link capture.
const SETTLED_PI = "pi_auto_charge";
const DUPLICATE_PI = "pi_link_intent";

function primeDuplicateCaptureLedger(
  options: { duplicateAmountCents?: number } = {}
) {
  const duplicateAmountCents = options.duplicateAmountCents ?? 10000;
  primeLedger([
    ledgerRow({
      id: "txn-settled",
      stripePaymentIntentId: SETTLED_PI,
      amountCents: 10000,
    }),
    ledgerRow({
      id: "txn-duplicate",
      stripePaymentIntentId: DUPLICATE_PI,
      status: PaymentStatus.PROCESSING,
      amountCents: duplicateAmountCents,
    }),
  ]);
}

describe("#1992 duplicate-capture auto-refund", () => {
  it("refunds a DIFFERENT arriving capture on an already-PAID booking: durable op enqueued inside the transaction, inline refund pinned to the duplicate's own transaction under the shared Stripe key prefix", async () => {
    primeDuplicateCaptureLedger();

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result).toEqual({
      outcome: "duplicate_capture_refunded",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    // The arriving capture is still recorded in the ledger first (real money
    // moved), exactly as before this fix.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.SUCCEEDED,
      })
    );

    // Durable debt enqueued with the transaction client (atomic with the
    // detection, before any Stripe call), pinned to the duplicate transaction.
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      allocationPlan: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      store: tx,
    });

    // Inline refund executes the same frozen slice under the shared
    // duplicate_capture_refund key prefix and cron-reconstructible metadata.
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 10000,
      reason: "requested_by_customer",
      allocation: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      metadata: { bookingId: "booking-1", reason: "duplicate_capture" },
      idempotencyKeyPrefix: `duplicate_capture_refund_booking-1_${DUPLICATE_PI}`,
    });

    // Happy-path close + loud admin alert (money moved automatically).
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
      })
    );
    // #2007: the dedicated duplicate-capture template is sent (success variant),
    // NOT the generic payment-anomaly alert.
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        paymentIntentId: DUPLICATE_PI,
        settledPaymentIntentId: SETTLED_PI,
        refundFailed: false,
        operationReference: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
      })
    );
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();

    // The booking's status/settlement is untouched: no PAID/CANCELLED claim.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();

    // #2008 — the durable, admin-only history event is recorded EXACTLY ONCE on
    // the inline-success path (the mark flipped the operation to SUCCEEDED,
    // count 1). It is a REFUNDED event carrying the duplicate_capture_refund
    // discriminator (recordDuplicateCaptureRefundEvent), NOT a plain
    // recordBookingEvent that could masquerade as a cancellation's refund.
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.recordDuplicateCaptureRefundEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordDuplicateCaptureRefundEvent).toHaveBeenCalledWith({
      bookingId: "booking-1",
      amountCents: 10000,
      duplicatePaymentIntentId: DUPLICATE_PI,
      settledPaymentIntentId: SETTLED_PI,
    });
  });

  it("does NOT record the admin history event when the inline mark did not flip the operation (count 0 — the cron already closed it)", async () => {
    // A lost inline close raced the cron: the refund succeeded but the mark
    // reports count 0 because the operation is already SUCCEEDED. The inline
    // path must NOT record the event (the cron-replay path owns it), so the two
    // paths never double-record.
    primeDuplicateCaptureLedger();
    mocks.markDuplicateCaptureRefundRecoverySucceeded.mockResolvedValue({
      count: 0,
    });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.recordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
  });

  it("refunds exactly the duplicate's captured amount, not the booking price", async () => {
    // A stale-price duplicate: the link intent was minted at an older 8000
    // total. The refund must hand back the 8000 that was actually captured.
    primeDuplicateCaptureLedger({ duplicateAmountCents: 8000 });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 8000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 8000,
        allocationPlan: [
          { paymentTransactionId: "txn-duplicate", amountCents: 8000 },
        ],
      })
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 8000 })
    );
  });

  it("tolerates an inline refund failure: the pre-persisted operation stays for the recovery cron, the inline error is recorded, admins are alerted", async () => {
    primeDuplicateCaptureLedger();
    mocks.refundPaymentTransactions.mockRejectedValue(
      new Error("Stripe is unavailable (503)")
    );

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refund_failed");
    expect(result.refundError).toContain("503");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
    // #2008 — no history event on the failed inline path: the operation is
    // still PENDING and the cron-replay path will record it on success.
    expect(mocks.recordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
    expect(
      mocks.recordDuplicateCaptureRefundRecoveryInlineError
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        message: expect.stringContaining("503"),
      })
    );
    // #2007: the dedicated template is sent in its failed variant carrying the
    // inline error and the queued recovery-operation reference.
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: DUPLICATE_PI,
        refundFailed: true,
        operationReference: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
        errorMessage: expect.stringContaining("503"),
      })
    );
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("pins the distinctness predicate's where-clause: captured PRIMARY Stripe transactions with net cash only (SUCCEEDED/PARTIALLY_REFUNDED — never fully REFUNDED), excluding the arriving intent, NULL intent ids and superseded-machinery-owned intents", async () => {
    primeDuplicateCaptureLedger();

    await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentId: "payment-1",
          kind: PaymentTransactionKind.PRIMARY,
          status: {
            in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
          // #2262 guard 3: ANY settled PRIMARY row counts as the sibling. The
          // STRIPE arm keeps the arriving-intent and superseded exclusions; the
          // non-Stripe arm needs no arriving-row exclusion because
          // upsertPaymentIntentTransaction hardcodes source STRIPE on both its
          // create and update arms (pinned by its own test), so the row this
          // settlement just wrote can never match it.
          OR: [
            {
              source: PaymentSource.STRIPE,
              stripePaymentIntentId: { not: DUPLICATE_PI, notIn: [] },
              NOT: { stripePaymentIntentId: null },
            },
            { source: { not: PaymentSource.STRIPE } },
          ],
        },
      })
    );

    // Guard (b′) query shape: live (non-SUCCEEDED) CANCEL_PAYMENT_INTENT /
    // REFUND_SUPERSEDED_PAYMENT operations on this payment, run inside the
    // same lock(1) transaction (the tx client's own delegate was used).
    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        type: {
          in: [
            PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
            PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          ],
        },
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
      select: { paymentIntentId: true },
    });
  });

  it("still refunds the duplicate when the settling capture has since been PARTIALLY refunded (net cash is still held)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 2000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.PROCESSING,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
  });

  describe("SAME-intent replay stays already_paid with NO refund, from every legitimate caller path", () => {
    // Every caller invokes the same choke point with the SETTLED intent id;
    // what varies in production is only who carries it there. Pinning each
    // path by name documents that the duplicate-capture refund can never fire
    // for the normal exactly-once replay outcome of:
    const legitimateReplayPaths = [
      "stripe-webhook payment_intent.succeeded redelivery (stripe-webhook-service)",
      "confirm-payment route racing the webhook (bookings/[id]/confirm-payment)",
      "payment-link reconcile of an existing succeeded intent (createPaymentIntentForPaymentLink)",
      "charge-saved-method replaying its recorded attempt's own intent (#3267)",
      "cron-confirm-pending replaying its recorded attempt's own intent (#3267)",
      "create-payment-intent route recovery reconcile of a succeeded intent",
      "admin confirm-pending-guests retry of its recorded charge",
    ];

    it.each(legitimateReplayPaths)("%s", async () => {
      // Ledger holds ONLY the settled capture; the arriving intent IS it.
      primeLedger([
        ledgerRow({
          id: "txn-settled",
          stripePaymentIntentId: SETTLED_PI,
          amountCents: 10000,
        }),
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLED_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result).toEqual({
        outcome: "already_paid",
        bookingId: "booking-1",
        bumpedBookingIds: [],
      });
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // #2007: neither the generic anomaly alert NOR the dedicated
      // duplicate-capture template fires on a benign same-intent replay.
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
    });
  });

  it("never refunds BOTH sides: once a duplicate-capture refund is adjudicated against one intent, the OTHER capture's replay stays already_paid", async () => {
    // The duplicate refund of DUPLICATE_PI was already adjudicated (operation
    // row exists). Now the SETTLED intent's webhook redelivers: from the
    // ledger it looks symmetric (a different SUCCEEDED capture exists), so
    // without the adjudication marker this replay would refund the settlement
    // too and leave the booking PAID at zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
      }),
    ]);
    mocks.findOtherDuplicateCaptureRefundOperation.mockResolvedValue({
      id: "dup-op-1",
      idempotencyKey: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
    });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: SETTLED_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.findOtherDuplicateCaptureRefundOperation).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: SETTLED_PI,
      store: tx,
    });
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  // The BLOCKER regression: the pre-existing superseded-intent machinery
  // transiently creates a SUCCEEDED PRIMARY Stripe capture whose money is
  // already spoken for. Superseded intent X's late capture is diverted by the
  // webhook (queueSupersededPaymentIntentRefundRecovery) or by the recovery
  // cron's cancel-lost-race handoff into markSupersededTransactionSucceeded —
  // X becomes SUCCEEDED/refunded=0 with a queued REFUND_SUPERSEDED_PAYMENT
  // operation, and X never passes through markBookingPaymentSucceeded, so no
  // duplicate_capture adjudication marker exists. If the member then pays
  // fresh intent Y (booking → PAID via the route) and Y's own first webhook
  // delivery arrives (#772 route-vs-webhook race — event dedup does not
  // apply), the unguarded predicate would find X, see no adjudication marker,
  // and refund Y — the REAL settlement — in full, while the cron later
  // refunds X: booking PAID at zero net cash, both sides refunded.
  describe("superseded-intent handoff window: the arriving REAL settlement stays already_paid, never refunded (#1992 guards b′/c′)", () => {
    const SUPERSEDED_PI = "pi_superseded_x";
    const SETTLEMENT_PI = "pi_fresh_settlement_y";

    function primeHandoffLedger() {
      primeLedger([
        // X: the superseded intent's late capture after the handoff — from
        // the ledger alone, indistinguishable from a settlement.
        ledgerRow({
          id: "txn-superseded-x",
          stripePaymentIntentId: SUPERSEDED_PI,
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10000,
          refundedAmountCents: 0,
        }),
        // Y: the fresh intent that actually settled the booking via the route.
        ledgerRow({
          id: "txn-settlement-y",
          stripePaymentIntentId: SETTLEMENT_PI,
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10000,
        }),
      ]);
    }

    it("X handed off (SUCCEEDED + queued REFUND_SUPERSEDED_PAYMENT op): Y's webhook replay is already_paid — no refund op for Y, no refund, no admin email; X's queued refund op is left for the cron untouched", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([
        {
          id: "op-refund-superseded-x",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.PENDING,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result).toEqual({
        outcome: "already_paid",
        bookingId: "booking-1",
        bumpedBookingIds: [],
      });
      // The real settlement Y is NEVER refunded and no duplicate-capture
      // refund debt is opened against it.
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      // Admins are NOT emailed — this is the benign replay outcome, not an
      // anomaly. Neither the generic anomaly alert nor the #2007 dedicated
      // duplicate-capture template fires.
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
      // X's money still belongs to the superseded machinery: its queued
      // REFUND_SUPERSEDED_PAYMENT operation is read, never written (the tx
      // stub exposes NO write methods on paymentRecoveryOperation, so any
      // attempt to complete/clobber it would have crashed this test). The
      // cron then refunds X normally — that replay (including its
      // idempotency-by-ledger retry safety) is pinned in
      // payment-recovery.test.ts ("queues refund recovery when the superseded
      // PaymentIntent already succeeded" / "does not double-count a
      // previously written refund when the recovery retries").
      expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalled();
    });

    it("CANCEL_PAYMENT_INTENT variant: X mid-handoff (cancel op still live, refund op not yet enqueued) — Y's replay stays already_paid with no refund", async () => {
      primeHandoffLedger();
      // The cancel-lost-race handoff window: markSupersededTransactionSucceeded
      // has committed (X is SUCCEEDED) but the REFUND_SUPERSEDED_PAYMENT op is
      // not yet enqueued and the CANCEL_PAYMENT_INTENT op has not yet been
      // completed — it is the live marker that X's money is spoken for.
      primeRecoveryOperations([
        {
          id: "op-cancel-superseded-x",
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          status: PaymentRecoveryOperationStatus.PROCESSING,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
    });

    it("an exhausted (FAILED) superseded refund op still owns X's money: Y's replay stays already_paid", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([
        {
          id: "op-refund-superseded-x",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.FAILED,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    });

    it("guard (c′) belt-and-braces: even if the candidate slips the (b′) notIn exclusion, the direct intent-id re-check suppresses the refund", async () => {
      primeHandoffLedger();
      // Simulate a (b′) miss with a divergent query shape: the payment-scoped
      // findMany returns nothing, while the direct intent-id findFirst still
      // sees the live operation.
      mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
      mocks.paymentRecoveryOperationFindFirst.mockResolvedValue({
        id: "op-refund-superseded-x",
      });

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      // (c′) query shape: direct lookup by the CANDIDATE's intent id (X, the
      // matched "settlement"), the same live-status/type filter as (b′).
      expect(mocks.paymentRecoveryOperationFindFirst).toHaveBeenCalledWith({
        where: {
          paymentIntentId: SUPERSEDED_PI,
          type: {
            in: [
              PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
              PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
            ],
          },
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        select: { id: true },
      });
    });

    it("terminal (SUCCEEDED) superseded-machinery ops do NOT suppress the true double-charge path: the arriving distinct capture is still auto-refunded", async () => {
      // The true #1967 double-charge shape (auto-charge X vs link capture Y,
      // NEITHER owned by a live superseded/cancel op) must keep auto-refunding.
      // Long-completed superseded machinery elsewhere on the payment is
      // history, not ownership.
      primeDuplicateCaptureLedger();
      primeRecoveryOperations([
        {
          id: "op-old-cancel",
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
          paymentId: "payment-1",
          paymentIntentId: SETTLED_PI,
        },
        {
          id: "op-old-refund",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
          paymentId: "payment-1",
          paymentIntentId: SETTLED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("duplicate_capture_refunded");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(
        1
      );
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
      // #2262 non-vacuity control for the guard tests above: with the SAME
      // ledger and the SAME (rewritten) predicate mock, a sibling IS matched
      // once no live superseded operation owns it. So the already_paid
      // outcomes above come from the guards doing their job, not from a mock
      // that quietly stopped understanding the where-clause shape.
      expect(reachedSibling).toBe(true);
    });

    it("#2262 non-vacuity: the same handoff ledger DOES match a sibling once no live superseded operation owns the candidate", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(reachedSibling).toBe(true);
      expect(result.outcome).toBe("duplicate_capture_refunded");
    });
  });

  it("a redelivery of the duplicate AFTER its refund executed stays already_paid via the #1765 refunded-history guard (no second refund op, no ledger clobber)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    // #1765 — the refunded transaction row is never clobbered back to
    // SUCCEEDED, and no duplicate machinery runs for refund history.
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("repay-generation replay (#1765): the repay capture arriving alongside its fully REFUNDED predecessor is NOT a duplicate", async () => {
    // Paid via pi_old, deliberately refunded, repaid via pi_repay, booking
    // PAID again. A pi_repay webhook redelivery must stay already_paid: the
    // only other capture on the ledger is fully REFUNDED, which the
    // distinctness predicate excludes — auto-refunding the repay would strand
    // the booking PAID with zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-old",
        stripePaymentIntentId: "pi_old",
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
      ledgerRow({
        id: "txn-repay",
        stripePaymentIntentId: "pi_repay",
        amountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_repay",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a normal success on a not-yet-paid booking is untouched by the duplicate machinery", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...makePaidBooking(),
      status: BookingStatus.PENDING,
    });
    primeLedger([]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_fresh",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a duplicate whose transaction row cannot be resolved falls back to already_paid (no blind refund)", async () => {
    // Other settled capture exists, but the arriving intent has no ledger row
    // to pin the refund slice to — refuse to move money on a guess.
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      })
    );
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });
});

describe("#1992 recovery key builders and replay-metadata mapping", () => {
  it("the operation idempotency key is duplicate_capture_<bookingId>_<intentId> and shares the per-booking adjudication prefix", () => {
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-1", "pi_x")
    ).toBe("duplicate_capture_booking-1_pi_x");
    expect(
      buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
    ).toBe("duplicate_capture_booking-1_");
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        "booking-1",
        "pi_x"
      ).startsWith(
        buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
      )
    ).toBe(true);
  });

  it("the Stripe key prefix maps back to the inline metadata reason, so a cron replay reconstructs a byte-identical refund body", () => {
    const prefix = buildDuplicateCaptureRefundStripeKeyPrefix(
      "booking-1",
      "pi_x"
    );
    expect(prefix).toBe("duplicate_capture_refund_booking-1_pi_x");
    expect(bookingModificationRefundReasonForKeyPrefix(prefix)).toBe(
      "duplicate_capture"
    );
  });
});
