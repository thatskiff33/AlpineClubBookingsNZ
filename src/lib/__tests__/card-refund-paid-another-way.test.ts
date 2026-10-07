// #3372 (owner, 7 Oct 2026: "Count + add close action"): closing a card refund
// Stripe gave up on, because the treasurer paid the member back another way.
// The order of the writes is the safety property, so the transaction client
// records every call in one list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  claim: vi.fn(),
  findPayment: vi.fn(),
  findBooking: vi.fn(),
  listOperations: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kick: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/payment-recovery", () => ({
  CLAIMABLE_PAYMENT_RECOVERY_STATUSES: ["PENDING", "FAILED"],
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: (...args: unknown[]) => {
    calls.push("allocate");
    return mocks.applyLocalRefundAllocation(...args);
  },
  RefundAllocationRacedError: class RefundAllocationRacedError extends Error {},
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => {
    calls.push("xero-note");
    return mocks.enqueueXeroRefundCreditNoteOperation(...args);
  },
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kick,
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
    payment: { findUnique: (...args: unknown[]) => mocks.findPayment(...args) },
    booking: { findUnique: (...args: unknown[]) => mocks.findBooking(...args) },
  };
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      paymentRecoveryOperation: { findMany: mocks.listOperations },
    },
  };
});

import {
  CardRefundPaidAnotherWayError,
  closeCardRefundPaidAnotherWay,
  deadCardRefundOperationWhere,
  listDeadCardRefunds,
  PAID_ANOTHER_WAY_MARKER,
} from "@/lib/card-refund-paid-another-way";
import { getNetCollectedPaymentParts } from "@/lib/payment-net-collected";
import { openCardRefundOwedCents } from "@/lib/open-card-refund-owed";

const CREATED = new Date("2026-06-20T00:00:00.000Z");

function deadOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    attempts: 5,
    idempotencyKey: "booking_cancel_refund_recovery_b-1",
    bookingId: "b-1",
    paymentId: "p-1",
    paymentTransactionId: null,
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 15_000 }],
    amountCents: 15_000,
    createdAt: CREATED,
    ...overrides,
  };
}

/** A cancelled $200.00 card booking whose $150.00 refund Stripe gave up on. */
function payment(operation = deadOperation(), overrides: Record<string, unknown> = {}) {
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
    recoveryOperations: [operation],
    refunds: [],
    booking: {
      deletedAt: null,
      status: "CANCELLED",
      creditsApplied: [],
      creditsFromCancellation: [],
      manualRefundTasks: [],
    },
    ...overrides,
  };
}

const close = (amountCents = 15_000, note: string | null = "Bank transfer, ref 123") =>
  closeCardRefundPaidAnotherWay({ operationId: "op-1", amountCents, note, actingMemberId: "treasurer-1" });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.findOperation.mockResolvedValue(deadOperation());
  mocks.findPayment.mockResolvedValue(payment());
  mocks.findBooking.mockResolvedValue({ memberId: "member-1" });
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.applyLocalRefundAllocation.mockResolvedValue(undefined);
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "xop-1" });
  mocks.kick.mockResolvedValue(undefined);
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("closing a dead card refund as paid another way", () => {
  it("takes lock(1) first, re-reads, claims, and only then records the money, the Xero note and the audit", async () => {
    const result = await close();

    expect(calls).toEqual(["lock(1)", "read-operation", "claim", "allocate", "xero-note", "audit"]);
    expect(result).toMatchObject({ amountCents: 15_000, owedCents: 15_000, xeroRefundNoteQueued: true });
  });

  it("claims only a dead card refund, and closes it to SUCCEEDED with the marker and no retry time", async () => {
    await close();

    expect(mocks.claim).toHaveBeenCalledWith({
      where: { id: "op-1", ...deadCardRefundOperationWhere },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: PAID_ANOTHER_WAY_MARKER,
      }),
    });
    expect(deadCardRefundOperationWhere).toMatchObject({
      status: { in: ["PENDING", "FAILED"] },
      attempts: { gte: 5 },
    });
  });

  it("records the money on the charges the refund was meant to come off", async () => {
    await close(10_000);

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "p-1", amountCents: 10_000, preferTransactionIds: ["txn-1"] }),
    );
  });

  it("audits the close under the payment category, with the note and the amounts", async () => {
    await close();

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.paid-another-way",
        category: "payment",
        actorMemberId: "treasurer-1",
        subjectMemberId: "member-1",
        entityType: "PaymentRecoveryOperation",
        entityId: "op-1",
        details: "Bank transfer, ref 123",
        metadata: expect.objectContaining({ amountCents: 15_000, owedCents: 15_000 }),
      }),
      expect.anything(),
    );
  });

  it("mirrors a cancellation's bank-transfer hand-back in Xero, and only that", async () => {
    await close();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "p-1",
      15_000,
      expect.objectContaining({ refundMethod: "internet-banking", createdByMemberId: "treasurer-1" }),
    );
    expect(mocks.kick).toHaveBeenCalledTimes(1);

    // An edit's refund: its edit's credit note already corrected the invoice.
    vi.clearAllMocks();
    const editRefund = deadOperation({ idempotencyKey: "booking_modification_refund_recovery_mod-1" });
    mocks.findOperation.mockResolvedValue(editRefund);
    mocks.findPayment.mockResolvedValue(payment(editRefund));
    mocks.claim.mockResolvedValue({ count: 1 });
    mocks.findBooking.mockResolvedValue({ memberId: "member-1" });
    const result = await close();
    expect(result.xeroRefundNoteQueued).toBe(false);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("queues no Xero note on a payment with no invoice", async () => {
    mocks.findPayment.mockResolvedValue(payment(deadOperation(), { xeroInvoiceId: null }));
    const result = await close();
    expect(result.xeroRefundNoteQueued).toBe(false);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});

describe("a close that must not happen writes nothing", () => {
  async function expectRefusal(promise: Promise<unknown>, status: number) {
    await expect(promise).rejects.toBeInstanceOf(CardRefundPaidAnotherWayError);
    await expect(promise).rejects.toMatchObject({ status });
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  }

  it("a lost claim - a second click, or the row moved since the read - records no money", async () => {
    mocks.claim.mockResolvedValue({ count: 0 });
    await expectRefusal(close(), 409);
    expect(calls).toEqual(["lock(1)", "read-operation", "claim"]);
  });

  it("a second click that reads the refund already closed never reaches the claim", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ status: "SUCCEEDED" }));
    await expectRefusal(close(), 409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("a refund still being retried", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ attempts: 4 }));
    await expectRefusal(close(), 409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("more than it still owes", async () => {
    await expectRefusal(close(15_001), 409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("nothing, when something is owed", async () => {
    await expectRefusal(close(0), 400);
  });

  it("no note", async () => {
    await expectRefusal(close(15_000, "   "), 400);
    expect(calls).toEqual([]);
  });

  it("part of a superseded payment's refund", async () => {
    const superseded = deadOperation({
      type: "REFUND_SUPERSEDED_PAYMENT",
      idempotencyKey: "superseded_refund_pi_1",
      allocationPlan: null,
      paymentTransactionId: "txn-1",
    });
    mocks.findOperation.mockResolvedValue(superseded);
    mocks.findPayment.mockResolvedValue(payment(superseded));
    await expectRefusal(close(10_000), 400);
  });

  it("an organiser child's refund, which has no ledger of its own to record against", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ idempotencyKey: "organiser_child_refund_mod_m1" }));
    await expectRefusal(close(), 409);
  });

  it("a group settlement's refund, which is not owed on the payment it hangs on", async () => {
    mocks.findOperation.mockResolvedValue(deadOperation({ idempotencyKey: "group_settlement_refund_recovery_s1" }));
    await expectRefusal(close(), 409);
  });

  it("an allocation the payment can no longer hold rolls the claim back with it", async () => {
    mocks.applyLocalRefundAllocation.mockRejectedValue(new Error("Refund amount exceeds captured payments"));
    await expect(close()).rejects.toMatchObject({ status: 409 });
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});

describe("the list on the stuck-states page", () => {
  it("lists only what the close accepts, with what each still owes", async () => {
    const own = deadOperation();
    mocks.listOperations.mockResolvedValue([
      { ...own, payment: payment(own) },
      { ...deadOperation({ id: "op-group", idempotencyKey: "group_settlement_refund_recovery_s1" }), payment: payment() },
      { ...deadOperation({ id: "op-child", idempotencyKey: "organiser_child_refund_mod_m1" }), payment: payment() },
    ]);

    const rows = await listDeadCardRefunds();

    expect(rows).toEqual([
      expect.objectContaining({ operationId: "op-1", bookingId: "b-1", owedCents: 15_000, wholeAmountOnly: false }),
    ]);
    expect(mocks.listOperations).toHaveBeenCalledWith(expect.objectContaining({ where: deadCardRefundOperationWhere }));
  });
});

describe("a closed refund leaves both figures (owner, 7 Oct 2026)", () => {
  it("Net Collected and Refunds owed no longer count it, and the refunded total holds the money", () => {
    const before = payment();
    const closed = { ...deadOperation(), status: "SUCCEEDED", lastError: PAID_ANOTHER_WAY_MARKER };
    const after = payment(closed, { refundedAmountCents: 15_000 });

    const owedBefore = getNetCollectedPaymentParts(before);
    const owedAfter = getNetCollectedPaymentParts(after);

    expect(openCardRefundOwedCents(before)).toBe(15_000);
    expect(owedBefore.cardRefundOwedCents).toBe(15_000);
    expect(openCardRefundOwedCents(after)).toBe(0);
    expect(owedAfter.cardRefundOwedCents).toBe(0);
    // Net Collected reads the same $50.00 before and after: the money moved from
    // "owed back" to "refunded".
    expect(owedBefore.heldCashCents).toBe(5_000);
    expect(owedAfter.heldCashCents).toBe(5_000);
  });
});
