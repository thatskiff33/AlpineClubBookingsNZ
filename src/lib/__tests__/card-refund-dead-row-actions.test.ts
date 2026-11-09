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
  // #4368 review B: the re-arm's unlocked read of the row's charges, and Stripe's refunds on them.
  preReadOperation: vi.fn(),
  preReadCharges: vi.fn(),
  listRefunds: vi.fn<(intent: string, options?: unknown) => Promise<unknown[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({
  listRefundsForPaymentIntent: (intent: string, options?: unknown) => {
    calls.push("stripe-list");
    return mocks.listRefunds(intent, options);
  },
}));
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
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      // Unlocked, before the transaction: the re-arm's read of the charges it would refund (review B).
      paymentRecoveryOperation: { findUnique: (...args: unknown[]) => mocks.preReadOperation(...args) },
      paymentTransaction: { findMany: (...args: unknown[]) => mocks.preReadCharges(...args) },
    },
  };
});

import {
  closeCardRefundNothingLeftOwed,
  DeadCardRefundActionError,
  NOTHING_LEFT_OWED_MARKER,
  tryDeadCardRefundAgain,
} from "@/lib/card-refund-dead-row-actions";
import { deadCardRefundOperationWhere, laterStripeRefundsCovering, tryCardAgainRefusal } from "@/lib/card-refund-dead-row";
import { cardRefundOperationRefundMetadata } from "@/lib/payment-recovery-keys";
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
    lastError: "Stripe: card_declined",
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
  mocks.preReadOperation.mockResolvedValue({ paymentId: "p-1", paymentTransactionId: null, allocationPlan: PLAN });
  mocks.preReadCharges.mockResolvedValue([{ stripePaymentIntentId: "pi_1" }]);
  mocks.listRefunds.mockResolvedValue([]);
});

describe("the locks both actions take (INV-LOCK-001/002)", () => {
  it.each([
    ["Nothing left owed", () => nothingLeftOwed(), coveredPayment()],
    ["Try the card again", () => tryAgain(), payment()],
  ] as const)("MUTATION: %s takes lock(1), re-reads the row, locks the Payment row BEFORE reading it, then claims and audits", async (_label, act, read) => {
    mocks.findPayment.mockResolvedValue(read);
    await act();
    expect(calls.filter((call) => call !== "stripe-list")).toEqual(["lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim", "audit"]);
  });

  it("MUTATION (review B): the re-arm reads Stripe's refunds on the row's charges before it takes any lock - never under them", async () => {
    await tryAgain();
    expect(calls).toEqual(["stripe-list", "lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim", "audit"]);
    expect(mocks.listRefunds).toHaveBeenCalledWith("pi_1", { timeoutMs: 10_000, singlePage: true });
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

  it("MUTATION (review C): a $0 off the payment's cap alone - its own slice unsent - names nothing and is refused, for a developer", async () => {
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
    expect(error.message).toMatch(/No Stripe refund on this payment is matched to this card refund/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION (review C): a row part paid by its matched refund, the rest unsent but capped to $0, names nothing and is refused", async () => {
    // Two slices: the first filled by a refund matched to it, the second still unsent - and the payment holds nothing more.
    const twoSlices = deadOperation({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 7_500 }, { paymentTransactionId: "txn-2", amountCents: 7_500 }] });
    mocks.findOperation.mockResolvedValue(twoSlices);
    const read = payment([twoSlices], {
      refundedAmountCents: 20_000,
      status: "REFUNDED",
      refunds: [{ ...LATER_REFUND, amountCents: 7_500 }],
    });
    expect(laterStripeRefundsCovering(read as never, "op-1")).toEqual([]);
    mocks.findPayment.mockResolvedValue(read);
    await expect(nothingLeftOwed(["re_later_1"])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/No Stripe refund on this payment is matched/) });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION (review C): names only the refunds the attribution gives this row, never another later refund on the payment", async () => {
    // A second later refund, of another amount, fills no slice of this row: it is not named.
    const other = { ...LATER_REFUND, stripeRefundId: "re_other_door", amountCents: 1_000 };
    const read = coveredPayment([LATER_REFUND, other]);
    expect(laterStripeRefundsCovering(read as never, "op-1").map((refund) => refund.stripeRefundId)).toEqual(["re_later_1"]);
    mocks.findPayment.mockResolvedValue(read);
    await expect(nothingLeftOwed(["re_later_1", "re_other_door"])).rejects.toMatchObject({ status: 409 });
    expect((await nothingLeftOwed(["re_later_1"])).coveredBy.map((refund) => refund.stripeRefundId)).toEqual(["re_later_1"]);
  });

  it("MUTATION: refused when a refund that no longer counts is the only cover", async () => {
    mocks.findPayment.mockResolvedValue(
      payment([deadOperation()], { refundedAmountCents: 20_000, status: "REFUNDED", refunds: [{ ...LATER_REFUND, status: "failed" }] }),
    );
    const error = await refusal(nothingLeftOwed());
    expect(error.message).toMatch(/No Stripe refund on this payment is matched/);
  });

  it("MUTATION: refused when the refunds it names are not the ones under the locks", async () => {
    const error = await refusal(nothingLeftOwed(["re_someone_else"]));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/Stripe refunds on this payment changed/);
    const more = await refusal(nothingLeftOwed(["re_later_1", "re_later_2"]));
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
        metadata: expect.objectContaining({ owedCents: 15_000, previousAttempts: 5, previousStatus: "FAILED", previousLastError: "Stripe: card_declined" }),
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
    expect(error.message).toMatch(/failed later is on this payment/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  describe("review B: a refund this row's own request made that Stripe holds and nothing here accounts for", () => {
    /** A refund on the row's charge, as Stripe lists it: this row's door metadata unless a case says otherwise. */
    const listed = (overrides: Record<string, unknown> = {}) => ({
      id: "re_lost_answer",
      object: "refund",
      amount: 15_000,
      status: "succeeded",
      payment_intent: "pi_1",
      metadata: cardRefundOperationRefundMetadata(deadOperation()),
      ...overrides,
    });

    it("MUTATION: one with no slice key, counted, adopted by no slice and attributed to none, refuses the re-arm", async () => {
      mocks.listRefunds.mockResolvedValue([listed()]);
      const error = await refusal(tryAgain());
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/Stripe holds a refund made by this booking's same kind of refund \(re_lost_answer\)/);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it.each([
      ["it carries a slice key (the runner adopts it)", { metadata: { ...cardRefundOperationRefundMetadata(deadOperation()), refundSliceKey: "k" } }],
      ["another door made it (other metadata)", { metadata: { bookingId: "b-1", reason: "something_else" } }],
      ["it failed (no money went back)", { status: "failed" }],
      ["it is on another intent", { payment_intent: "pi_other" }],
    ])("MUTATION: allowed when %s", async (_label, overrides) => {
      mocks.listRefunds.mockResolvedValue([listed(overrides)]);
      await expect(tryAgain()).resolves.toMatchObject({ operationId: "op-1" });
    });

    it("MUTATION (review F1): refused even when the owed figure's attribution matches it to a row - the runner sends by marks", async () => {
      // Recorded, and matched to this row's slice by the attribution, but never marked on it.
      mocks.listRefunds.mockResolvedValue([listed({ id: "re_later_1" })]);
      const twoSlices = deadOperation({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 15_000 }, { paymentTransactionId: "txn-1", amountCents: 15_000 }], amountCents: 30_000 });
      mocks.findOperation.mockResolvedValue(twoSlices);
      mocks.preReadOperation.mockResolvedValue({ paymentId: "p-1", paymentTransactionId: null, allocationPlan: twoSlices.allocationPlan });
      mocks.findPayment.mockResolvedValue(payment([twoSlices], { amountCents: 40_000, refundedAmountCents: 15_000, refunds: [LATER_REFUND] }));
      await expect(tryAgain()).rejects.toMatchObject({ status: 409 });
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION (review F1): refused when a sibling row of the same kind holds the attribution - only a mark clears it", async () => {
      // A later cancellation row of the same booking (same metadata), closed, whose slice the recorded refund matched -
      // never marked. This row's own figure and what its runner would send agree, so only the Stripe evidence refuses.
      const sibling = deadOperation({ id: "op-sibling", idempotencyKey: "booking_cancel_refund_recovery_b-1_second", status: "SUCCEEDED", attempts: 1, createdAt: new Date("2026-06-22T00:00:00.000Z") });
      mocks.findPayment.mockResolvedValue(payment([deadOperation(), sibling], { amountCents: 40_000, refundedAmountCents: 15_000, refunds: [LATER_REFUND] }));
      mocks.listRefunds.mockResolvedValue([listed({ id: "re_later_1" })]);
      const error = await refusal(tryAgain());
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/this booking's same kind of refund \(re_later_1\)/);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION (review F4): refused when the plan Stripe was read for is not the one under the locks", async () => {
      mocks.preReadOperation.mockResolvedValue({ paymentId: "p-1", paymentTransactionId: null, allocationPlan: [{ paymentTransactionId: "txn-9", amountCents: 15_000 }] });
      const error = await refusal(tryAgain());
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/changed while you were settling it/);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: allowed when a slice of a row is marked with it", async () => {
      mocks.listRefunds.mockResolvedValue([listed()]);
      const marked = deadOperation({ id: "op-done", status: "SUCCEEDED", attempts: 1, idempotencyKey: "booking_modification_refund_m9", allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 15_000, madeRefundId: "re_lost_answer" }] });
      mocks.findPayment.mockResolvedValue(payment([deadOperation(), marked], { amountCents: 40_000 }));
      await expect(tryAgain()).resolves.toMatchObject({ operationId: "op-1" });
    });

    it("MUTATION: a Stripe list it cannot read in full refuses the re-arm before any lock", async () => {
      mocks.listRefunds.mockRejectedValue(new Error("Stripe refund preflight is incomplete"));
      const error = await refusal(tryAgain());
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/could not be read just now/);
      expect(calls).toEqual(["stripe-list"]);
    });

    it("reads every charge of a legacy row with no plan", async () => {
      mocks.preReadOperation.mockResolvedValue({ paymentId: "p-1", paymentTransactionId: null, allocationPlan: null });
      mocks.preReadCharges.mockResolvedValue([{ stripePaymentIntentId: "pi_1" }, { stripePaymentIntentId: "pi_2" }]);
      mocks.findOperation.mockResolvedValue(deadOperation({ allocationPlan: null }));
      await tryAgain().catch(() => undefined);
      expect(mocks.preReadCharges).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ paymentId: "p-1", source: "STRIPE" }) }));
      expect(mocks.listRefunds.mock.calls.map(([intent]) => intent)).toEqual(["pi_1", "pi_2"]);
    });
  });
});

describe("tryCardAgainRefusal: when a re-arm could pay the member more than is owed", () => {
  const owed = { ownCents: 15_000, owedCents: 15_000 };
  const own = {
    id: "op-1",
    idempotencyKey: "booking_cancel_refund_recovery_b-1",
    lastError: "Stripe: card_declined",
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 15_000 }] as unknown,
  };
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
    expect(tryCardAgainRefusal(others(), { ...own, id: "op-y", idempotencyKey: "card_refund_failed_later_re_x" }, owed)).toMatch(/for a person to settle/);
    expect(tryCardAgainRefusal(others(), { ...own, id: "op-r", idempotencyKey: "card_refund_still_owed_task-1" }, owed)).toMatch(/for a person to settle/);
  });

  it("MUTATION (review F1): refuses unless what the runner would send - every unmarked slice - is exactly the row's own unsent figure", () => {
    // $50 + $50: the first made by a refund nobody marked (filled by it in the owed figure), the second dead.
    const unmarked = { ...own, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 5_000 }, { paymentTransactionId: "txn-1", amountCents: 5_000 }] };
    expect(tryCardAgainRefusal(others(), unmarked, { ownCents: 5_000, owedCents: 5_000 })).toMatch(/already refunded without being marked/);
    // Marked: the runner sends only the second, which is what is confirmed.
    const marked = { ...own, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 5_000, madeRefundId: "re_made" }, { paymentTransactionId: "txn-1", amountCents: 5_000 }] };
    expect(tryCardAgainRefusal(others(), marked, { ownCents: 5_000, owedCents: 5_000 })).toBeNull();
    // No stored plan: what it would send cannot be checked.
    expect(tryCardAgainRefusal(others(), { ...own, allocationPlan: null }, owed)).toMatch(/keeps no record of exactly what it would send/);
  });

  it("MUTATION (review B): refuses where its last failure says Stripe may have refunded after all", () => {
    expect(tryCardAgainRefusal(others(), { ...own, lastError: "StripeConnectionError: socket hang up" }, owed)).toMatch(/Stripe may have made this refund after all/);
  });

  it("MUTATION: #4492 (review A): refuses beside any failed-later row on the payment - live, dead or paid - but not beside another plain row", () => {
    const failedLater = { id: "op-y", idempotencyKey: "card_refund_failed_later_re_x" };
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "PENDING" }), own, owed)).toMatch(/failed later is on this payment/);
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "FAILED" }), own, owed)).toMatch(/failed later is on this payment/);
    // Review A: re-sent and paid, the row reads owed again - re-sending it would pay twice.
    expect(tryCardAgainRefusal(others({ ...failedLater, status: "SUCCEEDED" }), own, owed)).toMatch(/failed later is on this payment/);
    expect(tryCardAgainRefusal(others({ id: "op-2", idempotencyKey: "booking_modification_refund_m2", status: "FAILED" }), own, owed)).toBeNull();
  });
});
