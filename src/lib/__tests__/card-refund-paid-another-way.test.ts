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
  readLateCaptureXeroReceipt: vi.fn(),
  findKeptLateCaptureInvoiceIdForPayment: vi.fn(),
  listRecords: vi.fn(),
  findApprovalTask: vi.fn(),
  findCapture: vi.fn(),
  enqueueKeptReceipt: vi.fn(),
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
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  readLateCaptureXeroReceipt: mocks.readLateCaptureXeroReceipt,
  findKeptLateCaptureInvoiceIdForPayment: mocks.findKeptLateCaptureInvoiceIdForPayment,
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: () => Promise.resolve("Pacific/Auckland"),
}));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  lockKeptLateCaptureTask: () => {
    calls.push("lock-approval-task");
    return Promise.resolve();
  },
  keptLateCaptureDocumentDate: () => "2026-06-19",
  enqueueXeroKeptLateCaptureInvoiceOperation: (...args: unknown[]) => {
    calls.push("xero-receipt");
    return mocks.enqueueKeptReceipt(...args);
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
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.findTransaction(...args),
      findFirst: (...args: unknown[]) => mocks.findCapture(...args),
    },
    manualRefundTask: {
      create: (...args: unknown[]) => {
        calls.push("record");
        return mocks.createRecord(...args);
      },
      findUnique: (...args: unknown[]) => {
        calls.push("read-approval-task");
        return mocks.findApprovalTask(...args);
      },
    },
  };
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      paymentRecoveryOperation: { findMany: mocks.listOperations },
      manualRefundTask: { findMany: mocks.listRecords, findUnique: (...args: unknown[]) => mocks.findApprovalTask(...args) },
      paymentTransaction: { findFirst: (...args: unknown[]) => mocks.findCapture(...args) },
    },
  };
});

import {
  CardRefundPaidAnotherWayError,
  closeCardRefundPaidAnotherWay,
  deadCardRefundOperationWhere,
  lastErrorSuggestsStripeMayHaveRefunded,
  listCardRefundsPaidTwice,
  listDeadCardRefunds,
  PAID_ANOTHER_WAY_MARKER,
  type PaidBackChoice,
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

/** Full when the amount is the whole $150.00 owed, part otherwise - unless a case says which. */
const close = (
  amountCents = 15_000,
  note: string | null = "Bank transfer, ref 123",
  paidBack: PaidBackChoice = amountCents === 15_000 ? "full" : "partial",
) => closeCardRefundPaidAnotherWay({ operationId: "op-1", amountCents, paidBack, note, actingMemberId: "treasurer-1" });

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
  mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "none" });
  mocks.findKeptLateCaptureInvoiceIdForPayment.mockResolvedValue(null);
  mocks.listRecords.mockResolvedValue([]);
  mocks.findApprovalTask.mockResolvedValue({ id: "approval-1", status: "COMPLETED", createdAt: CREATED });
  mocks.findCapture.mockResolvedValue({ status: "SUCCEEDED", amountCents: 15_000 });
  mocks.enqueueKeptReceipt.mockResolvedValue({ queueOperationId: "xop-receipt" });
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
    expect(result).toMatchObject({ amountCents: 15_000, owedCents: 15_000, xeroQueued: "refund-note" });
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

    const result = await close(10_000, "Bank transfer", "full");

    expect(result.owedCents).toBe(10_000);
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000, preferTransactionIds: ["txn-2"] }),
    );
  });

  it("M2: writes the persisted record, born COMPLETED under its own key, for the amount paid back - and says it was part", async () => {
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
        reason: expect.stringContaining("paid back in part another way by the treasurer; the rest is no longer owed"),
      }),
      select: { id: true },
    });
  });

  it("a full close's record says it was paid back in full", async () => {
    await close(15_000);
    expect(mocks.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 15_000, raisedAmountCents: 15_000, reason: expect.stringContaining("paid back in full another way") }),
      }),
    );
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
        metadata: expect.objectContaining({
          paidBack: "full",
          amountCents: 15_000,
          owedCents: 15_000,
          noLongerOwedCents: 0,
          manualRefundTaskId: "task-1",
        }),
      }),
      expect.anything(),
    );
  });

  it("C: audits a part close as part, with what stopped being owed", async () => {
    await close(10_000);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("paid back in part"),
        metadata: expect.objectContaining({ paidBack: "partial", amountCents: 10_000, owedCents: 15_000, noLongerOwedCents: 5_000 }),
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
    expect(result.xeroQueued).toBe("nothing");
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  // Owner, 8 Oct 2026: "Raise a refund note for all".
  it.each([
    ["an approved refund request's", "refund_request_refund_rr-1"],
    ["an edit's", "booking_modification_refund_recovery_mod-1"],
    ["an edit review's on a cancelled booking", "edit_financial_review_refund_task-9"],
  ])("MUTATION: %s refund queues its own bank-transfer note too, keyed on the record", async (_kind, idempotencyKey) => {
    const other = deadOperation({ idempotencyKey });
    mocks.findOperation.mockResolvedValue(other);
    mocks.findPayment.mockResolvedValue(payment(other));
    const result = await close(10_000);
    expect(result.xeroQueued).toBe("refund-note");
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "p-1",
      10_000,
      expect.objectContaining({ refundMethod: "internet-banking", paidAnotherWayTaskId: "task-1" }),
    );
    expect(mocks.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ occurrenceKey: "card-refund-paid-another-way:op-1" }) }),
    );
  });

  it("a superseded payment's refund queues its note too", async () => {
    const superseded = deadOperation({
      type: "REFUND_SUPERSEDED_PAYMENT",
      idempotencyKey: "superseded_refund_pi_1",
      allocationPlan: null,
      paymentTransactionId: "txn-1",
    });
    mocks.findOperation.mockResolvedValue(superseded);
    mocks.findPayment.mockResolvedValue(payment(superseded));
    const result = await close(15_000);
    expect(result.xeroQueued).toBe("refund-note");
  });

  describe("F4: a note only where there is an invoice to credit", () => {
    it("MUTATION: no invoice: no note, the record's key says so, and the money and line are still recorded", async () => {
      mocks.findPayment.mockResolvedValue(payment(deadOperation(), { xeroInvoiceId: null }));
      const result = await close();
      expect(result.xeroQueued).toBe("nothing");
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.kick).not.toHaveBeenCalled();
      expect(mocks.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ occurrenceKey: "card-refund-paid-another-way:op-1:no-xero-note" }),
        }),
      );
      expect(mocks.writeLedgerRows).toHaveBeenCalledTimes(1);
    });

    it("no invoice of its own, but a kept late capture's: the note credits that", async () => {
      mocks.findPayment.mockResolvedValue(payment(deadOperation(), { xeroInvoiceId: null }));
      mocks.findKeptLateCaptureInvoiceIdForPayment.mockResolvedValue("kept-inv-1");
      const result = await close();
      expect(result.xeroQueued).toBe("refund-note");
    });
  });

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  describe("a late card charge's refund: record the receipt, then credit it", () => {
    const LATE_KEY = "late_capture_approval_refund_recovery_pi_late";
    function lateCharge() {
      const late = deadOperation({ idempotencyKey: LATE_KEY });
      mocks.findOperation.mockResolvedValue(late);
      mocks.findPayment.mockResolvedValue(payment(late));
      mocks.readLateCaptureXeroReceipt.mockImplementation(() => {
        calls.push("read-receipt");
        return Promise.resolve({ kind: "none" });
      });
    }

    it("MUTATION: no receipt in Xero: the approval task is locked BEFORE the receipt is read, the receipt is queued, and the note waits for it", async () => {
      lateCharge();
      const result = await close();

      expect(calls).toEqual([
        "lock(1)",
        "read-operation",
        "lock-payment-row",
        "read-payment",
        "read-approval-task",
        "lock-approval-task",
        "read-receipt",
        "claim",
        "allocate",
        "record",
        "ledger-line",
        "xero-receipt",
        "audit",
      ]);
      expect(result.xeroQueued).toBe("receipt-then-refund-note");
      // Never the note now: it is the receipt's worker's, once the receipt is in Xero.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueKeptReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          manualRefundTaskId: "approval-1",
          bookingId: "b-1",
          paymentIntentId: "pi_late",
          // The receipt is the GROSS charge, as for a kept one (`INV-PAY-110`).
          capturedCents: 15_000,
          capturedOn: "2026-06-19",
          createdByMemberId: "treasurer-1",
        }),
      );
      expect(mocks.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ occurrenceKey: "card-refund-paid-another-way:op-1:note-after-receipt" }),
        }),
      );
      expect(mocks.kick).toHaveBeenCalledTimes(1);
    });

    it("a part close still records the GROSS charge as the receipt; the note is for what was paid back", async () => {
      lateCharge();
      const result = await close(10_000);
      expect(result).toMatchObject({ amountCents: 10_000, xeroQueued: "receipt-then-refund-note" });
      expect(mocks.enqueueKeptReceipt).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 15_000 }));
    });

    it("MUTATION: a receipt the app already recorded takes its note now, and queues no second receipt", async () => {
      lateCharge();
      mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "kept-inv-1" });
      const result = await close();
      expect(result.xeroQueued).toBe("refund-note");
      expect(mocks.enqueueKeptReceipt).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "p-1",
        15_000,
        expect.objectContaining({ refundMethod: "internet-banking", paidAnotherWayTaskId: "task-1" }),
      );
      expect(mocks.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ occurrenceKey: "card-refund-paid-another-way:op-1" }) }),
      );
    });

    it("never the booking's invoice: a receipt an officer resolved by hand in Xero gets no app note and no second receipt", async () => {
      lateCharge();
      mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "resolved-by-hand" });
      const result = await close();
      expect(result.xeroQueued).toBe("nothing");
      expect(mocks.enqueueKeptReceipt).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ occurrenceKey: "card-refund-paid-another-way:op-1:no-xero-note" }),
        }),
      );
    });

    it.each([
      ["the charge was never taken", () => mocks.findCapture.mockResolvedValue({ status: "FAILED", amountCents: 15_000 })],
      ["the charge is not on record", () => mocks.findCapture.mockResolvedValue(null)],
      ["no approval task owns it", () => mocks.findApprovalTask.mockResolvedValue(null)],
    ])("nothing to record when %s", async (_why, arrange) => {
      lateCharge();
      arrange();
      const result = await close();
      expect(result.xeroQueued).toBe("nothing");
      expect(mocks.enqueueKeptReceipt).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("a receipt the enqueue will not queue is a fault: the close fails rather than promise a note that never comes", async () => {
      lateCharge();
      mocks.enqueueKeptReceipt.mockResolvedValue({ queueOperationId: null, message: "no longer kept" });
      await expect(close()).rejects.toThrow(/receipt could not be queued/);
      expect(mocks.kick).not.toHaveBeenCalled();
    });

    it("the list says the receipt comes first, without taking the approval task's lock", async () => {
      const late = deadOperation({ idempotencyKey: LATE_KEY });
      mocks.listOperations.mockResolvedValue([{ ...late, payment: payment(late) }]);
      const rows = await listDeadCardRefunds();
      expect(rows).toEqual([expect.objectContaining({ operationId: "op-1", xeroRefundNote: "after-receipt" })]);
      expect(calls).not.toContain("lock-approval-task");
    });
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
    const result = await close(0, "Bank transfer, ref 123", "full");
    expect(result).toMatchObject({ amountCents: 0, owedCents: 0, xeroQueued: "nothing" });
    expect(calls).toEqual(["lock(1)", "read-operation", "lock-payment-row", "read-payment", "claim", "audit"]);
  });

  it("MUTATION: F3: a whole superseded payment's refund closes, through the fence, when its charge still holds exactly that", async () => {
    const superseded = deadOperation({
      type: "REFUND_SUPERSEDED_PAYMENT",
      idempotencyKey: "superseded_refund_pi_1",
      allocationPlan: null,
      paymentTransactionId: "txn-1",
    });
    mocks.findOperation.mockResolvedValue(superseded);
    mocks.findPayment.mockResolvedValue(payment(superseded));
    await close(15_000);
    expect(mocks.findTransaction).toHaveBeenCalledTimes(1);
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

  describe("C: the treasurer's full-or-part answer must agree with what is owed (owner, 8 Oct 2026)", () => {
    it("MUTATION: 'full' for less than is owed", async () => {
      await expectRefusal(close(10_000, "Bank transfer", "full"), 400);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: 'partial' for all of it", async () => {
      await expectRefusal(close(15_000, "Bank transfer", "partial"), 400);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: 'partial' for nothing", async () => {
      await expectRefusal(close(0, "Bank transfer", "partial"), 400);
    });

    it("an answer that is neither", async () => {
      await expectRefusal(close(15_000, "Bank transfer", "most" as PaidBackChoice), 400);
      expect(calls).toEqual([]);
    });
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

  describe("F3: a superseded payment's refund that cannot close whole", () => {
    const superseded = () =>
      deadOperation({
        type: "REFUND_SUPERSEDED_PAYMENT",
        idempotencyKey: "superseded_refund_pi_1",
        allocationPlan: null,
        paymentTransactionId: "txn-1",
      });

    it("MUTATION: capped below its own amount - the payment holds less than it owes", async () => {
      // $100 of the $200 payment already went back another way, so the cap is
      // $100 while the refund's own charge still owes $150.
      mocks.findOperation.mockResolvedValue(superseded());
      mocks.findPayment.mockResolvedValue(payment(superseded(), { refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" }));
      await expectRefusal(close(10_000, "Bank transfer", "full"), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: for nothing - its charge was refunded in full already - is refused, not closed with no record", async () => {
      mocks.findOperation.mockResolvedValue(superseded());
      mocks.findPayment.mockResolvedValue(
        payment(superseded(), {
          refundedAmountCents: 15_000,
          status: "PARTIALLY_REFUNDED",
          refunds: [
            { paymentTransactionId: "txn-1", amountCents: 15_000, status: "succeeded", createdAt: new Date("2026-06-20T01:00:00.000Z") },
          ],
        }),
      );
      // Its charge reads fully refunded, so the fence alone would let it through.
      mocks.findTransaction.mockResolvedValue({ paymentId: "p-1", amountCents: 15_000, refundedAmountCents: 15_000 });
      await expectRefusal(close(0, "Bank transfer", "full"), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });
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
  it("says which rows take no Xero note: no invoice to credit", async () => {
    const own = deadOperation();
    mocks.listOperations.mockResolvedValue([{ ...own, payment: payment(own, { xeroInvoiceId: null }) }]);
    const rows = await listDeadCardRefunds();
    expect(rows).toEqual([expect.objectContaining({ operationId: "op-1", xeroRefundNote: "none" })]);
  });

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
        xeroRefundNote: "now",
        stripeMayHaveRefunded: false,
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

describe("#3924 round 4 (M7): a failure that may have reached Stripe is flagged", () => {
  it.each([
    "Request timed out",
    "connect ETIMEDOUT 3.18.12.1:443",
    "read ECONNRESET",
    "An error occurred with our connection to Stripe (StripeConnectionError)",
    "Network error: socket hang up",
    "Stripe API error (status 502)",
    "statusCode: 503 Service Unavailable",
    "Charge ch_123 has already been refunded.",
    "Refund amount ($150.00) is greater than unrefunded amount on charge ($0.00)",
  ])("%s", (lastError) => {
    expect(lastErrorSuggestsStripeMayHaveRefunded(lastError)).toBe(true);
  });

  it.each([
    null,
    "",
    "Stripe: card_declined",
    "Your card has insufficient funds.",
    // F5: an amount is not a server error.
    "Refund of $500.00 failed: card_declined",
    "Refund of 512 cents declined",
  ])(
    "not %s",
    (lastError) => {
      expect(lastErrorSuggestsStripeMayHaveRefunded(lastError)).toBe(false);
    },
  );
});

describe("#3924 round 4 (M2): the close's record is told apart by kind and key, never by wording", () => {
  it("is a paid-another-way record, and a non-cancellation hand-back the cancellation readers leave out", async () => {
    const {
      cardRefundPaidAnotherWayOccurrenceKey,
      isCardRefundPaidAnotherWayTask,
      isNonCancellationHandBackTask,
      NOT_NON_CANCELLATION_HAND_BACK_WHERE,
      paidAnotherWayCloseXeroNote,
      paymentRecoveryOperationIdOfPaidAnotherWay,
    } = await import("@/lib/manual-refund-task-settlement-rules");
    const record = {
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-1", { xeroRefundNote: "now" }),
    };
    const unnoted = {
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-1", { xeroRefundNote: "none" }),
    };
    const afterReceipt = {
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-1", { xeroRefundNote: "after-receipt" }),
    };

    expect(record.occurrenceKey).toBe("card-refund-paid-another-way:op-1");
    expect(unnoted.occurrenceKey).toBe("card-refund-paid-another-way:op-1:no-xero-note");
    expect(afterReceipt.occurrenceKey).toBe("card-refund-paid-another-way:op-1:note-after-receipt");
    // Rounds 5 and 6: the key records how the close's note is raised; all three name the operation.
    expect(paidAnotherWayCloseXeroNote(record)).toBe("now");
    expect(paidAnotherWayCloseXeroNote(unnoted)).toBe("none");
    expect(paidAnotherWayCloseXeroNote(afterReceipt)).toBe("after-receipt");
    expect(paymentRecoveryOperationIdOfPaidAnotherWay(unnoted)).toBe("op-1");
    expect(paymentRecoveryOperationIdOfPaidAnotherWay(afterReceipt)).toBe("op-1");
    expect(isCardRefundPaidAnotherWayTask(unnoted)).toBe(true);
    expect(isCardRefundPaidAnotherWayTask(afterReceipt)).toBe(true);
    expect(paidAnotherWayCloseXeroNote({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBeNull();
    // A key that is only a suffix names no operation.
    expect(
      paymentRecoveryOperationIdOfPaidAnotherWay({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: "card-refund-paid-another-way::note-after-receipt",
      }),
    ).toBeNull();
    expect(isCardRefundPaidAnotherWayTask(record)).toBe(true);
    expect(isNonCancellationHandBackTask(record)).toBe(true);
    expect(paymentRecoveryOperationIdOfPaidAnotherWay(record)).toBe("op-1");
    expect(JSON.stringify(NOT_NON_CANCELLATION_HAND_BACK_WHERE)).toContain("card-refund-paid-another-way:");
    // A cancellation's own hand-back (no key) and another kind with the key are not.
    expect(isCardRefundPaidAnotherWayTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBe(false);
    expect(isCardRefundPaidAnotherWayTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: record.occurrenceKey })).toBe(false);
    expect(paymentRecoveryOperationIdOfPaidAnotherWay({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "edit-refund-hand-back:m" })).toBeNull();
  });
});

describe("#3924 round 5 (concurrency F2): a close Stripe paid as well is listed", () => {
  const closedAt = new Date("2026-06-25T00:00:00.000Z");
  function closedRecord(refunds: unknown[]) {
    const closed = { ...deadOperation(), status: "SUCCEEDED", succeededAt: closedAt, lastError: PAID_ANOTHER_WAY_MARKER };
    return {
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: "card-refund-paid-another-way:op-1",
      bookingId: "b-1",
      amountCents: 15_000,
      completedAt: closedAt,
      payment: payment(closed, { refundedAmountCents: 30_000, refunds }),
    };
  }

  it("MUTATION: a refund Stripe made before the close and the app recorded after it", async () => {
    mocks.listRecords.mockResolvedValue([
      closedRecord([
        {
          paymentTransactionId: "txn-1",
          amountCents: 15_000,
          status: "succeeded",
          stripeCreatedAt: new Date("2026-06-24T23:59:00.000Z"),
          createdAt: new Date("2026-06-26T00:00:00.000Z"),
        },
      ]),
    ]);
    expect(await listCardRefundsPaidTwice()).toEqual([
      {
        operationId: "op-1",
        bookingId: "b-1",
        bookingReference: expect.any(String),
        closedAt: closedAt.toISOString(),
        paidAnotherWayCents: 15_000,
        refundedByCardCents: 15_000,
      },
    ]);
  });

  it("not a refund Stripe made after the close: that is another operation's", async () => {
    mocks.listRecords.mockResolvedValue([
      closedRecord([
        {
          paymentTransactionId: "txn-1",
          amountCents: 15_000,
          status: "succeeded",
          stripeCreatedAt: new Date("2026-06-26T00:00:00.000Z"),
          createdAt: new Date("2026-06-26T00:00:01.000Z"),
        },
      ]),
    ]);
    expect(await listCardRefundsPaidTwice()).toEqual([]);
  });
});
