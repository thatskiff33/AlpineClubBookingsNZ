// #3372 (owner, 7 Oct 2026: "Count + add close action"; 8 Oct: "Keep it
// together"): closing a card refund Stripe gave up on, because the treasurer
// paid the member back another way. The order of the writes is the safety
// property, so the transaction client records every call in one list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  claim: vi.fn(),
  findPayment: vi.fn(),
  findBooking: vi.fn(),
  findTransaction: vi.fn(),
  createRecord: vi.fn(),
  writeLedgerRows: vi.fn(),
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
  lockPaymentForRefundedTotal: () => {
    calls.push("lock-payment-row");
    return Promise.resolve();
  },
  RefundAllocationRacedError: class RefundAllocationRacedError extends Error {},
  RefundAllocationExceedsCapturedError: class RefundAllocationExceedsCapturedError extends Error {},
}));
vi.mock("@/lib/booking-ledger-write", () => ({
  buildBookingLedgerRows: (postings: unknown[]) => postings,
  writeBookingLedgerRows: (_store: unknown, rows: unknown[]) => {
    calls.push("ledger-line");
    return mocks.writeLedgerRows(rows);
  },
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
    payment: {
      findUnique: (...args: unknown[]) => {
        calls.push("read-payment");
        return mocks.findPayment(...args);
      },
    },
    booking: { findUnique: (...args: unknown[]) => mocks.findBooking(...args) },
    paymentTransaction: { findUnique: (...args: unknown[]) => mocks.findTransaction(...args) },
    manualRefundTask: {
      create: (...args: unknown[]) => {
        calls.push("record");
        return mocks.createRecord(...args);
      },
    },
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
    succeededAt: null as Date | null,
    lastError: "Stripe: card_declined",
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
  mocks.findBooking.mockResolvedValue({ id: "b-1", lodgeId: "lodge-1", memberId: "member-1" });
  mocks.findTransaction.mockResolvedValue({ paymentId: "p-1", amountCents: 15_000, refundedAmountCents: 0 });
  mocks.createRecord.mockResolvedValue({ id: "task-1" });
  mocks.writeLedgerRows.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.applyLocalRefundAllocation.mockResolvedValue(undefined);
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "xop-1" });
  mocks.kick.mockResolvedValue(undefined);
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("closing a dead card refund as paid another way", () => {
  it("takes lock(1), re-reads, locks the payment row BEFORE reading it, claims, and only then records the money, the record, its line, the Xero note and the audit", async () => {
    const result = await close();

    expect(calls).toEqual([
      "lock(1)",
      "read-operation",
      "lock-payment-row",
      "read-payment",
      "claim",
      "allocate",
      "record",
      "ledger-line",
      "xero-note",
      "audit",
    ]);
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

  it("M7: prefers only the charges it still had to refund, not a slice Stripe already sent", async () => {
    const twoSlices = deadOperation({
      amountCents: 15_000,
      allocationPlan: [
        { paymentTransactionId: "txn-1", amountCents: 5_000 },
        { paymentTransactionId: "txn-2", amountCents: 10_000 },
      ],
    });
    mocks.findOperation.mockResolvedValue(twoSlices);
    mocks.findPayment.mockResolvedValue(
      payment(twoSlices, {
        refundedAmountCents: 5_000,
        status: "PARTIALLY_REFUNDED",
        refunds: [
          { paymentTransactionId: "txn-1", amountCents: 5_000, status: "succeeded", createdAt: new Date("2026-06-20T01:00:00.000Z") },
        ],
      }),
    );

    const result = await close(10_000);

    expect(result.owedCents).toBe(10_000);
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000, preferTransactionIds: ["txn-2"] }),
    );
  });

  it("M2: writes the persisted record, born COMPLETED under its own key, for the amount paid back", async () => {
    await close(10_000);

    expect(mocks.createRecord).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "b-1",
        paymentId: "p-1",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: "card-refund-paid-another-way:op-1",
        amountCents: 10_000,
        raisedAmountCents: 15_000,
        status: "COMPLETED",
        completedByMemberId: "treasurer-1",
        note: "Bank transfer, ref 123",
      }),
      select: { id: true },
    });
  });

  it("M2: posts the ledger's bank-refund line on that record, keyed on it", async () => {
    await close(10_000);

    expect(mocks.writeLedgerRows).toHaveBeenCalledWith([
      expect.objectContaining({
        bookingId: "b-1",
        lodgeId: "lodge-1",
        kind: "BANK_REFUND",
        sign: -1,
        unitCents: 10_000,
        anchorKind: "REVIEW_TASK",
        anchorId: "task-1",
        settlementMethod: "INTERNET_BANKING",
        postingKey: expect.stringContaining("task-1"),
      }),
    ]);
  });

  it("audits the close under the payment category, with the note, the amounts and the record", async () => {
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
        metadata: expect.objectContaining({ amountCents: 15_000, owedCents: 15_000, manualRefundTaskId: "task-1" }),
      }),
      expect.anything(),
    );
  });

  it("M3: a cancellation's card refund queues its own bank-transfer note for exactly the amount, keyed on the record", async () => {
    await close(10_000);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "p-1",
      10_000,
      expect.objectContaining({
        refundMethod: "internet-banking",
        createdByMemberId: "treasurer-1",
        paidAnotherWayTaskId: "task-1",
      }),
    );
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it("M3: says honestly when no note was queued", async () => {
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: null });
    const result = await close();
    expect(result.xeroRefundNoteQueued).toBe(false);
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("an edit's refund queues no note: its edit's credit note already corrected the invoice", async () => {
    const editRefund = deadOperation({ idempotencyKey: "booking_modification_refund_recovery_mod-1" });
    mocks.findOperation.mockResolvedValue(editRefund);
    mocks.findPayment.mockResolvedValue(payment(editRefund));
    const result = await close();
    expect(result.xeroRefundNoteQueued).toBe(false);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
    // The record and its line are still written: the money moved.
    expect(mocks.createRecord).toHaveBeenCalledTimes(1);
    expect(mocks.writeLedgerRows).toHaveBeenCalledTimes(1);
  });

  it("a refund that owes nothing closes with no money, record, line or note", async () => {
    const sent = deadOperation();
    mocks.findOperation.mockResolvedValue(sent);
    mocks.findPayment.mockResolvedValue(
      payment(sent, {
        refundedAmountCents: 15_000,
        status: "PARTIALLY_REFUNDED",
        refunds: [
          { paymentTransactionId: "txn-1", amountCents: 15_000, status: "succeeded", createdAt: new Date("2026-06-20T01:00:00.000Z") },
        ],
      }),
    );
    const result = await close(0);
    expect(result).toMatchObject({ amountCents: 0, owedCents: 0, xeroRefundNoteQueued: false });
    expect(calls).toEqual(["lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim", "audit"]);
  });

  it("a whole superseded payment's refund closes when its charge still holds exactly that", async () => {
    const superseded = deadOperation({
      type: "REFUND_SUPERSEDED_PAYMENT",
      idempotencyKey: "superseded_refund_pi_1",
      allocationPlan: null,
      paymentTransactionId: "txn-1",
    });
    mocks.findOperation.mockResolvedValue(superseded);
    mocks.findPayment.mockResolvedValue(payment(superseded));
    await close(15_000);
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 15_000, preferTransactionIds: ["txn-1"] }),
    );
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
    expect(calls).toEqual(["lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim"]);
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
    const { RefundAllocationExceedsCapturedError } = await import("@/lib/payment-transactions");
    mocks.applyLocalRefundAllocation.mockRejectedValue(new RefundAllocationExceedsCapturedError());
    await expect(close()).rejects.toMatchObject({ status: 409 });
    expect(mocks.createRecord).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("an allocation raced by another writer is a 409 too", async () => {
    const { RefundAllocationRacedError } = await import("@/lib/payment-transactions");
    mocks.applyLocalRefundAllocation.mockRejectedValue(new RefundAllocationRacedError());
    await expect(close()).rejects.toMatchObject({ status: 409 });
  });

  it("C3: any other allocation failure is a fault, not a refusal - it reaches the route's 500", async () => {
    const fault = new Error("connection reset");
    mocks.applyLocalRefundAllocation.mockRejectedValue(fault);
    const outcome = close();
    await expect(outcome).rejects.toBe(fault);
    await expect(outcome).rejects.not.toBeInstanceOf(CardRefundPaidAnotherWayError);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("M7: a superseded payment's refund whose charge no longer holds exactly what it owes", async () => {
    const superseded = deadOperation({
      type: "REFUND_SUPERSEDED_PAYMENT",
      idempotencyKey: "superseded_refund_pi_1",
      allocationPlan: null,
      paymentTransactionId: "txn-1",
    });
    mocks.findOperation.mockResolvedValue(superseded);
    mocks.findPayment.mockResolvedValue(payment(superseded));
    // $20 of the charge was handed back locally (no refund row), so it holds $130, not $150.
    mocks.findTransaction.mockResolvedValue({ paymentId: "p-1", amountCents: 15_000, refundedAmountCents: 2_000 });
    await expectRefusal(close(15_000), 409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("a payment that belongs to another booking", async () => {
    mocks.findBooking.mockResolvedValue({ id: "b-other", lodgeId: "lodge-1", memberId: "member-1" });
    await expectRefusal(close(), 409);
    expect(mocks.claim).not.toHaveBeenCalled();
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
      expect.objectContaining({
        operationId: "op-1",
        bookingId: "b-1",
        owedCents: 15_000,
        wholeAmountOnly: false,
        takesXeroRefundNote: true,
        lastError: "Stripe: card_declined",
      }),
    ]);
    expect(mocks.listOperations).toHaveBeenCalledWith(expect.objectContaining({ where: deadCardRefundOperationWhere }));
  });
});

describe("a closed refund leaves both figures (owner, 7 Oct 2026)", () => {
  it("Net Collected and Refunds owed no longer count it, and the refunded total holds the money", () => {
    const before = payment();
    const closed = {
      ...deadOperation(),
      status: "SUCCEEDED",
      succeededAt: new Date("2026-06-25T00:00:00.000Z"),
      lastError: PAID_ANOTHER_WAY_MARKER,
    };
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
