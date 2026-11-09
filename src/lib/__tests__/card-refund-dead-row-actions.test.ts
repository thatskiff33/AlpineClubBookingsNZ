// #4368 (owner decision, 25 Oct 2026: "build as shown in the mock-up"): the
// two settlements of a card refund Stripe gave up on that record no money -
// "Nothing left owed" and "Try the card again". The order of the writes is the
// safety property, so the transaction client records every call in one list.
// The real-PostgreSQL races are `card-refund-dead-row-actions.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  claim: vi.fn(),
  findPayment: vi.fn(),
  findBooking: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: () => {
    calls.push("lock-payment-row");
    return Promise.resolve();
  },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => {
    calls.push("audit");
    return mocks.createAuditLog(...args);
  },
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: (strings: TemplateStringsArray) => {
      calls.push(strings.join("").includes("pg_advisory_xact_lock(1)") ? "lock(1)" : "raw");
      return Promise.resolve(1);
    },
    paymentRecoveryOperation: {
      findUnique: (...args: unknown[]) => {
        calls.push("read-operation");
        return mocks.findOperation(...args);
      },
      updateMany: (...args: unknown[]) => {
        calls.push("claim");
        return mocks.claim(...args);
      },
    },
    payment: {
      findUnique: (...args: unknown[]) => {
        calls.push("read-payment");
        return mocks.findPayment(...args);
      },
    },
    booking: { findUnique: (...args: unknown[]) => mocks.findBooking(...args) },
  };
  return { prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } };
});

import {
  closeCardRefundNothingLeftOwed,
  DeadCardRefundActionError,
  NOTHING_LEFT_OWED_MARKER,
  tryDeadCardRefundAgain,
} from "@/lib/card-refund-dead-row-actions";
import { deadCardRefundOperationWhere, tryCardAgainRefusal } from "@/lib/card-refund-dead-row";
import { rearmedPaymentRecoveryOperationData } from "@/lib/payment-recovery-constants";

const CREATED = new Date("2026-06-20T00:00:00.000Z");
const PLAN = [{ paymentTransactionId: "txn-1", amountCents: 15_000 }];

function deadOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    attempts: 5,
    idempotencyKey: "booking_cancel_refund_recovery_b-1",
    bookingId: "b-1",
    paymentId: "p-1",
    paymentIntentId: "pi_1",
    stripeKeyPrefix: null,
    paymentTransactionId: null,
    allocationPlan: PLAN,
    amountCents: 15_000,
    createdAt: CREATED,
    succeededAt: null as Date | null,
    lastError: "Stripe: connection reset",
    ...overrides,
  };
}

/** A cancelled $200.00 card booking whose $150.00 refund Stripe gave up on. */
function payment(operations: unknown[] = [deadOperation()], overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    xeroInvoiceId: "inv-1",
    bookingId: "b-1",
    status: "SUCCEEDED",
    amountCents: 20_000,
    refundedAmountCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    transactions: [],
    source: "STRIPE",
    _count: { transactions: 1 },
    recoveryOperations: operations,
    refunds: [],
    booking: {
      deletedAt: null,
      status: "CANCELLED",
      creditsApplied: [],
      creditsFromCancellation: [],
      manualRefundTasks: [],
      organiserSettled: false,
      parentBookingId: null,
    },
    ...overrides,
  };
}

/** The same payment once a later Stripe refund of the whole $150.00 has been recorded on its charge. */
const LATER_REFUND = {
  stripeRefundId: "re_later_1",
  paymentTransactionId: "txn-1",
  amountCents: 15_000,
  status: "succeeded",
  createdAt: new Date("2026-06-25T00:00:00.000Z"),
  stripeCreatedAt: new Date("2026-06-25T00:00:00.000Z"),
};
const coveredPayment = (refunds: unknown[] = [LATER_REFUND]) =>
  payment([deadOperation()], { refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED", refunds });

const nothingLeftOwed = (expectedStripeRefundIds: string[] = ["re_later_1"]) =>
  closeCardRefundNothingLeftOwed({ operationId: "op-1", expectedStripeRefundIds, actingMemberId: "treasurer-1" });
const tryAgain = (expectedOwedCents = 15_000) =>
  tryDeadCardRefundAgain({ operationId: "op-1", expectedOwedCents, actingMemberId: "treasurer-1" });

async function refusal(promise: Promise<unknown>): Promise<DeadCardRefundActionError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DeadCardRefundActionError);
  return error as DeadCardRefundActionError;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.findOperation.mockResolvedValue(deadOperation());
  mocks.findPayment.mockResolvedValue(payment());
  mocks.findBooking.mockResolvedValue({ id: "b-1", memberId: "member-1" });
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("the locks both actions take (INV-LOCK-001/002)", () => {
  it.each([
    ["Nothing left owed", () => nothingLeftOwed(), coveredPayment()],
    ["Try the card again", () => tryAgain(), payment()],
  ] as const)("MUTATION: %s takes lock(1), re-reads the row, locks the Payment row BEFORE reading it, then claims and audits", async (_label, act, read) => {
    mocks.findPayment.mockResolvedValue(read);
    await act();
    expect(calls).toEqual(["lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim", "audit"]);
  });
});

describe("Nothing left owed", () => {
  beforeEach(() => mocks.findPayment.mockResolvedValue(coveredPayment()));

  it("MUTATION: claims only a dead row on the plan read, to SUCCEEDED with its marker and no retry - and moves no money", async () => {
    const result = await nothingLeftOwed();
    expect(mocks.claim).toHaveBeenCalledWith({
      where: { id: "op-1", ...deadCardRefundOperationWhere, allocationPlan: { equals: PLAN } },
      data: {
        status: "SUCCEEDED",
        succeededAt: expect.any(Date),
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: NOTHING_LEFT_OWED_MARKER,
      },
    });
    expect(result.coveredBy).toEqual([{ stripeRefundId: "re_later_1", amountCents: 15_000, madeAt: "2026-06-25T00:00:00.000Z" }]);
    // No allocation, no record, no ledger line, no journal, no Xero: the transaction client has nothing else.
    expect(calls).not.toContain("allocate");
  });

  it("MUTATION: audits the close under payment, naming the refund that covers it", async () => {
    await nothingLeftOwed();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.nothing-left-owed",
        category: "payment",
        severity: "important",
        actorMemberId: "treasurer-1",
        subjectMemberId: "member-1",
        entityType: "PaymentRecoveryOperation",
        entityId: "op-1",
        summary: expect.stringContaining("re_later_1"),
        metadata: expect.objectContaining({ owedCents: 0, coveredBy: [expect.objectContaining({ stripeRefundId: "re_later_1" })] }),
      }),
      expect.anything(),
    );
  });

  it("MUTATION: refused while anything is owed, under the locks, before any claim", async () => {
    mocks.findPayment.mockResolvedValue(payment());
    const error = await refusal(nothingLeftOwed());
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/Something is owed on this card refund again/);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("MUTATION: refused when no later Stripe refund covers it - one made before the row was raised does not", async () => {
    // The payment holds nothing more, so the row owes $0 - but the only refund was made the day before it was raised.
    mocks.findPayment.mockResolvedValue(
      payment([deadOperation()], {
        refundedAmountCents: 20_000,
        status: "REFUNDED",
        refunds: [{ ...LATER_REFUND, amountCents: 20_000, stripeCreatedAt: new Date("2026-06-19T00:00:00.000Z"), createdAt: new Date("2026-06-19T00:00:00.000Z") }],
      }),
    );
    const error = await refusal(nothingLeftOwed());
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/No later Stripe refund on this payment covers this card refund/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION: refused when a refund that no longer counts is the only cover", async () => {
    mocks.findPayment.mockResolvedValue(
      payment([deadOperation()], { refundedAmountCents: 20_000, status: "REFUNDED", refunds: [{ ...LATER_REFUND, status: "failed" }] }),
    );
    const error = await refusal(nothingLeftOwed());
    expect(error.message).toMatch(/No later Stripe refund/);
  });

  it("MUTATION: refused when the refunds it names are not the ones under the locks", async () => {
    const error = await refusal(nothingLeftOwed(["re_someone_else"]));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/Stripe refunds on this payment changed/);
    const more = await refusal(
      (mocks.findPayment.mockResolvedValue(coveredPayment([LATER_REFUND, { ...LATER_REFUND, stripeRefundId: "re_later_2", amountCents: 100 }])), nothingLeftOwed()),
    );
    expect(more.message).toMatch(/Stripe refunds on this payment changed/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("refuses naming no refund, or one twice, before any lock", async () => {
    expect((await refusal(nothingLeftOwed([]))).status).toBe(400);
    expect((await refusal(nothingLeftOwed(["re_later_1", "re_later_1"]))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("MUTATION: a lost claim writes nothing and says the row changed", async () => {
    mocks.claim.mockResolvedValue({ count: 0 });
    const error = await refusal(nothingLeftOwed());
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/changed while you were settling it/);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});

describe("Try the card again (decision 5)", () => {
  it("MUTATION: re-arms with the shared re-arm data, claimed only on a dead row on the plan read", async () => {
    const result = await tryAgain();
    expect(mocks.claim).toHaveBeenCalledWith({
      where: { id: "op-1", ...deadCardRefundOperationWhere, allocationPlan: { equals: PLAN } },
      data: rearmedPaymentRecoveryOperationData(expect.any(Date) as unknown as Date),
    });
    expect(mocks.claim.mock.calls[0]?.[0]).toMatchObject({ data: { status: "PENDING", attempts: 0, lastError: null, processingStartedAt: null, succeededAt: null } });
    expect(result).toEqual({ operationId: "op-1", bookingId: "b-1", paymentId: "p-1", owedCents: 15_000 });
  });

  it("MUTATION: audits it under payment, keeping what the row said before", async () => {
    await tryAgain();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.try-card-again",
        category: "payment",
        severity: "important",
        actorMemberId: "treasurer-1",
        entityId: "op-1",
        metadata: expect.objectContaining({ owedCents: 15_000, previousAttempts: 5, previousStatus: "FAILED", previousLastError: "Stripe: connection reset" }),
      }),
      expect.anything(),
    );
  });

  it("MUTATION: a closed row is never re-armed - and neither is one already being tried", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ status: "SUCCEEDED" }));
    const closed = await refusal(tryAgain());
    expect(closed.status).toBe(409);
    expect(closed.message).toBe("This card refund has already been closed.");
    mocks.findOperation.mockResolvedValue(deadOperation({ status: "PENDING", attempts: 0 }));
    expect((await refusal(tryAgain())).message).toMatch(/being tried again/);
    expect(calls).not.toContain("lock-payment-row");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION: never an organiser child's refund or a group settlement's - their executors skip the Stripe check", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ idempotencyKey: "organiser_child_refund_mod_m1" }));
    expect((await refusal(tryAgain())).status).toBe(409);
    mocks.findOperation.mockResolvedValue(deadOperation({ idempotencyKey: "group_settlement_refund_recovery_s1" }));
    expect((await refusal(tryAgain())).status).toBe(409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION: refused when the owed figure moved since the dialog opened", async () => {
    const error = await refusal(tryAgain(14_000));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/changed since you opened it/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("refuses an owed figure of nothing before any lock", async () => {
    expect((await refusal(tryAgain(0))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("MUTATION: a lost claim writes nothing", async () => {
    mocks.claim.mockResolvedValue({ count: 0 });
    expect((await refusal(tryAgain())).status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("MUTATION: #4492: refused while a refund Stripe failed later is open on the same payment, under the locks", async () => {
    const failedLater = deadOperation({ id: "op-y", idempotencyKey: "card_refund_failed_later_re_x", status: "PENDING", attempts: 0, nextRetryAt: CREATED });
    mocks.findPayment.mockResolvedValue(payment([deadOperation(), failedLater], { amountCents: 40_000 }));
    const error = await refusal(tryAgain());
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/failed later is still open on this payment/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe("tryCardAgainRefusal: when a re-arm could pay the member more than is owed", () => {
  const owed = { ownCents: 15_000, owedCents: 15_000 };
  const own = { id: "op-1", idempotencyKey: "booking_cancel_refund_recovery_b-1" };
  const others = (...rows: Array<{ id: string; idempotencyKey: string; status: string }>) => ({
    recoveryOperations: rows.map((row) => ({ type: "REFUND_BOOKING_MODIFICATION", ...row })),
  });

  it("allows an ordinary dead row on its own", () => {
    expect(tryCardAgainRefusal(others({ ...own, status: "FAILED" }), own, owed)).toBeNull();
  });

  it("MUTATION: refuses with nothing owed", () => {
    expect(tryCardAgainRefusal(others(), own, { ownCents: 0, owedCents: 0 })).toMatch(/Nothing is left owed/);
  });

  it("MUTATION: refuses where the payment holds less than the row would send", () => {
    expect(tryCardAgainRefusal(others(), own, { ownCents: 15_000, owedCents: 10_000 })).toMatch(/holds less than this refund would send/);
  });

  it("MUTATION: refuses a row the app raised dead for a person: a failed-later row, or a part close's still-owed rest", () => {
    expect(tryCardAgainRefusal(others(), { id: "op-y", idempotencyKey: "card_refund_failed_later_re_x" }, owed)).toMatch(/for a person to settle/);
    expect(tryCardAgainRefusal(others(), { id: "op-r", idempotencyKey: "card_refund_still_owed_task-1" }, owed)).toMatch(/for a person to settle/);
  });

  it("MUTATION: #4492: refuses beside an open failed-later row - live or dead - but not beside a closed one or another plain row", () => {
    const failedLater = { id: "op-y", idempotencyKey: "card_refund_failed_later_re_x" };
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "PENDING" }), own, owed)).toMatch(/failed later is still open/);
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "FAILED" }), own, owed)).toMatch(/failed later is still open/);
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "SUCCEEDED" }), own, owed)).toBeNull();
    expect(tryCardAgainRefusal(others({ id: "op-2", idempotencyKey: "booking_modification_refund_m2", status: "FAILED" }), own, owed)).toBeNull();
  });
});
