// #4104 review (money 2 and 3): what a "Paid another way" close of a card
// refund that Stripe failed later records in Xero. Its card refund note was
// raised while the refund counted, so while that note stands a bank note would
// credit the invoice twice; and a late capture's refund keeps INV-PAY-110's
// routing whichever row owes it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coveredCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  unreadable: vi.fn((): string[] => []),
  eligibleCashCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  // #5017 review (money M1): earlier closes' bank notes not yet linked, and reversals not yet linked.
  closesUnnotedCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  pendingReversalCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  lateCaptureIntent: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
  receipt: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: "recorded", invoiceId: "inv-receipt" })),
  enqueueNote: vi.fn<(...args: unknown[]) => Promise<{ queueOperationId: string | null; message?: string }>>(async () => ({ queueOperationId: "xop-1" })),
  enqueueReversal: vi.fn<(...args: unknown[]) => Promise<{ queueOperationId: string | null; message: string }>>(async () => ({
    queueOperationId: "rev-1",
    message: "Stripe reversal invoice queued for background processing.",
  })),
  // #4381: the keep's reading, the receipt enqueue's gates and the enqueue itself.
  readKeptCaptureRecord: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ firstCut: "kept-invoice" })),
  captureReceiptRefusal: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
  enqueueCaptureReceipt: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ outcome: "queued", queueOperationId: "rcpt-1" })),
  enqueueKeptInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ queueOperationId: "kept-1", message: "queued" })),
  returnToPending: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ outcome: "pending", requestWritten: false })),
  receiptOwed: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0, unreadableOperationIds: mocks.unreadable() }),
  sumRefundCreditNoteCoverageCents: (...args: unknown[]) => mocks.coveredCents(...args),
}));
vi.mock("@/lib/refund-note-eligible-cash", () => ({
  resolveRefundNoteEligibleCash: async (...args: unknown[]) => ({ eligibleCashCents: await mocks.eligibleCashCents(...args) }),
}));
// #4383 review M1: no capped capture carries a note raised before #4383 here; the realdb proof covers one.
vi.mock("@/lib/late-capture-card-notes-in-xero", () => ({ readLateCapturePreCapOverNoteCents: async () => 0 }));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  lateCaptureIntentOfCardRefundOperation: (...args: unknown[]) => mocks.lateCaptureIntent(...args),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findKeptLateCaptureInvoiceIdForPayment: async () => null,
  readPaidAnotherWayLateCaptureXeroReceipt: (...args: unknown[]) => mocks.receipt(...args),
}));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: (...args: unknown[]) => mocks.enqueueKeptInvoice(...args),
  keptLateCaptureDocumentDate: () => "2026-06-19",
  lockKeptLateCaptureTask: vi.fn(),
}));
vi.mock("@/lib/late-capture-kept-xero", () => ({ readKeptCaptureRecord: (...args: unknown[]) => mocks.readKeptCaptureRecord(...args) }));
vi.mock("@/lib/additional-capture-receipt-enqueue", () => ({
  paidAnotherWayCaptureReceiptRefusal: (...args: unknown[]) => mocks.captureReceiptRefusal(...args),
  enqueueAdditionalCaptureReceiptOperation: (...args: unknown[]) => mocks.enqueueCaptureReceipt(...args),
}));
vi.mock("@/lib/kept-late-capture-change-receipt", () => ({
  lockKeptCaptureAnchor: async () => true,
  lateCaptureReceiptOwed: (...args: unknown[]) => mocks.receiptOwed(...args),
}));
vi.mock("@/lib/xero-outbox-pending-request", () => ({
  UNCLAIMED: { startedAt: null },
  returnOutboxRowToPending: (...args: unknown[]) => mocks.returnToPending(...args),
}));
vi.mock("@/lib/kept-late-capture-receipt-rows", () => ({ keptReceiptHeldForOfficer: async () => false }));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => mocks.enqueueNote(...args) }));
vi.mock("@/lib/xero-card-refund-reversal-invoice", () => ({
  enqueueCardRefundReversalInvoiceOperation: (...args: unknown[]) => mocks.enqueueReversal(...args),
}));
vi.mock("@/lib/card-refund-paid-another-way-cash", () => ({
  readPaidAnotherWayUncoveredCents: (...args: unknown[]) => mocks.closesUnnotedCents(...args),
}));
vi.mock("@/lib/xero-card-refund-reversal-outbox", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPendingCardRefundReversalCents: (...args: unknown[]) => mocks.pendingReversalCents(...args),
}));

import {
  PaidAnotherWayXeroChangedError,
  paidAnotherWayXeroPlan,
  paidAnotherWayCardNoteCoversCents,
  paidAnotherWayXeroPromise,
  queueMissingPaidAnotherWayReceipt,
  queuePaidAnotherWayXero,
} from "@/lib/card-refund-paid-another-way-xero";
import { xeroQueuedMessage, xeroRefundNotePromise } from "@/components/admin/dead-card-refunds-xero-copy";

const db = {
  payment: { findUnique: vi.fn(async () => ({ id: "p-1", bookingId: "b-1", refundedAmountCents: 0 })) },
  manualRefundTask: { findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null) },
  // #4516 review M4: a still-owed rest's origin, through its close's record.
  paymentRecoveryOperation: { findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null) },
};
const PAYMENT = { id: "p-1", xeroInvoiceId: "inv-1" };
const failedLater: { idempotencyKey: string; paymentIntentId: string; amountCents: number; allocationPlan?: unknown } = {
  idempotencyKey: "card_refund_failed_later_re_1",
  paymentIntentId: "pi_1",
  amountCents: 4_000,
};
const plan = (operation = failedLater) => paidAnotherWayXeroPlan(db as never, operation as never, PAYMENT, { lockApprovalTask: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unreadable.mockReturnValue([]);
  mocks.coveredCents.mockResolvedValue(0);
  mocks.eligibleCashCents.mockResolvedValue(0);
  mocks.closesUnnotedCents.mockResolvedValue(0);
  mocks.pendingReversalCents.mockResolvedValue(0);
  mocks.enqueueNote.mockResolvedValue({ queueOperationId: "xop-1" });
  mocks.enqueueReversal.mockResolvedValue({
    queueOperationId: "rev-1",
    message: "Stripe reversal invoice queued for background processing.",
  });
  mocks.lateCaptureIntent.mockResolvedValue(null);
});

const CLOSE = {
  operationId: "op-1",
  bookingId: "b-1",
  paymentId: "p-1",
  recordId: "task-1",
  actingMemberId: "m-1",
  clubZone: "Pacific/Auckland" as never,
  closedAt: new Date("2026-07-01T00:00:00.000Z"),
};
const queue = (xeroPlan: Awaited<ReturnType<typeof plan>>, amountCents: number) =>
  queuePaidAnotherWayXero({} as never, xeroPlan, { ...CLOSE, amountCents });
const noteCents = () => mocks.enqueueNote.mock.calls[0]?.[1];

describe("a failed-later row closed as paid another way (#4104, money 2; delta MH, MM1, MM2, ML1)", () => {
  it("MUTATION: a card note that covers the close queues a Stripe reversal for the cover and a bank note for the whole close", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 4_000 });
    expect(paidAnotherWayXeroPromise(xeroPlan)).toBe("covered-by-card-note");
    expect(await queue(xeroPlan, 4_000)).toBe("stripe-reversal-and-bank-note");
    expect(mocks.enqueueReversal).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4_000, closeTaskId: "task-1", paymentId: "p-1", closedOn: "2026-07-01" }),
    );
    expect(noteCents()).toBe(4_000);
    expect(mocks.enqueueNote.mock.calls[0]?.[2]).toMatchObject({ paidAnotherWayTaskId: "task-1", refundMethod: "internet-banking" });
    expect(mocks.enqueueReversal.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueueNote.mock.invocationCallOrder[0]!);
    const queued = xeroQueuedMessage("stripe-reversal-and-bank-note", "Bank transfer");
    expect(queued).toMatch(/money back in the Stripe account/);
    expect(queued).toMatch(/full amount paid back/);
    expect(queued).not.toMatch(/needs no new note|already records what you paid back/);
  });

  it("MUTATION: a card note covering part of the close reverses that part and notes the whole close, not the remainder", async () => {
    mocks.coveredCents.mockResolvedValue(7_500);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 1_500 });
    expect(await queue(xeroPlan, 4_000)).toBe("stripe-reversal-and-bank-note");
    expect(mocks.enqueueReversal).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1_500 }));
    expect(noteCents()).toBe(4_000);
  });

  it("a close for less than the card note covers queues both documents for that part, and says the note credits more than went back", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(await queue(xeroPlan, 1_000)).toBe("stripe-reversal-and-bank-note");
    expect(mocks.enqueueReversal).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1_000 }));
    expect(noteCents()).toBe(1_000);
    expect(paidAnotherWayCardNoteCoversCents(xeroPlan, 1_000)).toBe(1_000);
    expect(paidAnotherWayCardNoteCoversCents({ xeroRefundNote: "none" }, 1_000)).toBe(0);
    const promise = xeroRefundNotePromise("covered-by-card-note", "Bank transfer", "$40.00");
    expect(promise).toMatch(/invoice for \$40\.00 recording the failed card refund's money back in the Stripe account/);
    expect(promise).toMatch(/full amount you pay back/);
    expect(promise).toMatch(/If you pay back less than \$40\.00, Xero's note credits more than went back: the Xero reconciliation report lists the difference/);
    expect(promise).not.toMatch(/needs no new note/);
  });

  it("a bank note that will not queue leaves the reversal uncommitted: the close throws", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    mocks.enqueueNote.mockResolvedValue({ queueOperationId: null, message: "the hand-resolved note cannot be read" });
    const xeroPlan = await plan();
    await expect(queue(xeroPlan, 4_000)).rejects.toThrow(/bank-transfer refund note was not queued/);
    expect(mocks.enqueueReversal).toHaveBeenCalledTimes(1);
  });

  it("with no card note left over for it (never raised, or credited back), the bank note is queued as for any close", async () => {
    mocks.coveredCents.mockResolvedValue(6_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "now" });
    expect(await queue(xeroPlan, 4_000)).toBe("refund-note");
    expect(noteCents()).toBe(4_000);
  });

  it("decides nothing on an unreadable note resolved by hand: the note's own enqueue refuses on it", async () => {
    mocks.unreadable.mockReturnValue(["xop-resolved"]);
    mocks.coveredCents.mockResolvedValue(10_000);
    expect(await plan()).toEqual({ xeroRefundNote: "now" });
  });

  it("MUTATION (MH): a re-planned door row's slices that record a failed refund are read the same way", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const replanned = {
      idempotencyKey: "booking_cancel_refund_recovery_b-1",
      paymentIntentId: "pi_1",
      amountCents: 7_000,
      allocationPlan: [
        { paymentTransactionId: "txn-1", amountCents: 3_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] },
        { paymentTransactionId: "txn-2", amountCents: 4_000 },
      ],
    };
    // Only the failed slice's 3,000 can have a card note in Xero; the unsent 4,000 never did.
    expect(await plan(replanned)).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 3_000 });
  });

  it("any other row - nothing it owes failed later - is never read for it", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    expect(
      await plan({
        idempotencyKey: "booking_cancel_refund_recovery_b-1",
        paymentIntentId: "pi_1",
        amountCents: 4_000,
        allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1" }],
      } as never),
    ).toEqual({ xeroRefundNote: "now" });
    expect(mocks.coveredCents).not.toHaveBeenCalled();
  });

  it("MUTATION (#4516 review M4b): a still-owed rest of a failed-later row is answered by that row's card note, never noted twice", async () => {
    // $100 failed later with its $100 card note in Xero; $30 paid back in part, $70 still owed. Closing the $70:
    // the notes exceed the cash standing behind them ($100 noted, $30 counted) by exactly the rest.
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(3_000);
    db.manualRefundTask.findUnique.mockResolvedValueOnce({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "card-refund-paid-another-way:op-failed" });
    db.paymentRecoveryOperation.findUnique.mockResolvedValueOnce({ ...failedLater, id: "op-failed", amountCents: 10_000, allocationPlan: null });
    const rest = { idempotencyKey: "card_refund_still_owed_task-1", paymentIntentId: "pi_1", amountCents: 7_000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 7_000 }] };
    const xeroPlan = await plan(rest);
    expect(xeroPlan).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 7_000 });
    expect(await queue(xeroPlan, 7_000)).toBe("stripe-reversal-and-bank-note");
    expect(mocks.enqueueReversal).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 7_000 }));
    expect(noteCents()).toBe(7_000);
  });

  // #5017 review (money M1): a second close is sized as if the first close's
  // documents had all reached Xero, whichever worker ran first.
  it("MUTATION (#5017 M1): an earlier close's reversal linked but its bank note not yet: the rest is still reversed", async () => {
    // $80 failed later with its $80 card note. Close 1 paid $50 (reversal $50 linked; bank note FAILED); closing the $30 rest.
    // Coverage 80 - 50 = 30, eligible 50, close 1's unlinked note 50: excess 30, not 0.
    mocks.coveredCents.mockResolvedValue(3_000);
    mocks.eligibleCashCents.mockResolvedValue(5_000);
    mocks.closesUnnotedCents.mockResolvedValue(5_000);
    const rest = { ...failedLater, amountCents: 3_000 };
    expect(await plan(rest)).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 3_000 });
    expect(mocks.closesUnnotedCents).toHaveBeenCalledWith(db, "p-1");
  });

  it("MUTATION (#5017 M1): an earlier close's bank note linked but its reversal not yet: nothing is reversed twice", async () => {
    // R1 $30 with its card note, R2 $20 failed later with none. Close R1 queued a $30 reversal (FAILED) and a $30
    // bank note (linked). Closing R2: coverage 60, eligible 30, the pending reversal 30: excess 0, not 20.
    mocks.coveredCents.mockResolvedValue(6_000);
    mocks.eligibleCashCents.mockResolvedValue(3_000);
    mocks.pendingReversalCents.mockResolvedValue(3_000);
    const r2 = { ...failedLater, idempotencyKey: "card_refund_failed_later_re_2", amountCents: 2_000 };
    expect(await plan(r2)).toEqual({ xeroRefundNote: "now" });
    expect(mocks.pendingReversalCents).toHaveBeenCalledWith(db, "p-1");
  });

  it("a close with no invoice to credit queues nothing, card note or not", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await paidAnotherWayXeroPlan(db as never, failedLater as never, { id: "p-1", xeroInvoiceId: null }, { lockApprovalTask: false });
    expect(xeroPlan).toEqual({ xeroRefundNote: "none" });
    expect(await queue(xeroPlan, 4_000)).toBe("nothing");
  });
});

describe("a late capture's refund that failed later keeps INV-PAY-110's routing (#4104, money 3)", () => {
  it("MUTATION: its note credits the capture's own receipt, read off the row's intent", async () => {
    mocks.lateCaptureIntent.mockResolvedValue("pi_late");
    expect(await plan({ ...failedLater, paymentIntentId: "pi_late" })).toEqual({ xeroRefundNote: "now", creditsInvoiceId: "inv-receipt" });
    expect(mocks.lateCaptureIntent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "card_refund_failed_later_re_1", paymentIntentId: "pi_late" }), db);
    expect(mocks.receipt).toHaveBeenCalledWith("pi_late", db);
  });
});

describe("#4381: a late change capture's close is split as the keep splits it (INV-PAY-144)", () => {
  const TASK = { id: "approval-1", status: "COMPLETED", createdAt: new Date("2026-06-18T23:00:00.000Z"), bookingId: "b-1" };
  const CAPTURE = { status: "SUCCEEDED", amountCents: 8_000, kind: "ADDITIONAL", paymentId: "p-1", bookingModificationId: "mod-1", reason: null };
  const byEvidence = { firstCut: "by-change-evidence", anchorId: "mod-1", changeId: "mod-1", primaryInvoiceId: "inv-1" };
  const routed = (route: string, elsewhere: number | "all" = 0) => ({ ...byEvidence, liveKeptInvoice: null, receiptRow: null, decided: { route, elsewhere } });
  const approval = { idempotencyKey: "late_capture_approval_refund_recovery_pi_late", paymentIntentId: "pi_late", amountCents: 8_000 };
  const lateDb = {
    ...db,
    paymentTransaction: { findFirst: vi.fn(async () => CAPTURE) },
    xeroSyncOperation: { findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null) },
  };
  const closePlan = (lockApprovalTask = true) =>
    paidAnotherWayXeroPlan(lateDb as never, approval as never, PAYMENT, { lockApprovalTask });
  const closeQueue = (xeroPlan: Awaited<ReturnType<typeof closePlan>>) =>
    queuePaidAnotherWayXero(lateDb as never, xeroPlan, { ...CLOSE, amountCents: 8_000 });
  const receiptPlan = (capturedCents: number, document: "kept-invoice" | "capture-receipt") => ({
    xeroRefundNote: "after-receipt",
    receipt: { manualRefundTaskId: "approval-1", paymentIntentId: "pi_late", capturedCents, raisedAt: TASK.createdAt, document },
  });

  beforeEach(() => {
    mocks.lateCaptureIntent.mockResolvedValue("pi_late");
    mocks.receipt.mockResolvedValue({ kind: "none" });
    db.manualRefundTask.findUnique.mockResolvedValue(TASK);
    mocks.readKeptCaptureRecord.mockResolvedValue(routed("receipt"));
    mocks.captureReceiptRefusal.mockResolvedValue(null);
    mocks.enqueueCaptureReceipt.mockResolvedValue({ outcome: "queued", queueOperationId: "rcpt-1" });
    mocks.enqueueKeptInvoice.mockResolvedValue({ queueOperationId: "kept-1", message: "queued" });
    mocks.returnToPending.mockResolvedValue({ outcome: "pending", requestWritten: false });
    mocks.receiptOwed.mockResolvedValue(true);
  });

  it("MUTATION: the primary invoice bills the change - the capture's own receipt is queued, never a kept-capture invoice", async () => {
    const xeroPlan = await closePlan();
    expect(xeroPlan).toEqual(receiptPlan(8_000, "capture-receipt"));
    // The dialog's words are the receipt-then-note ones; the note follows the receipt.
    expect(paidAnotherWayXeroPromise(xeroPlan)).toBe("after-receipt");
    expect(await closeQueue(xeroPlan)).toBe("receipt-then-refund-note");
    expect(mocks.enqueueCaptureReceipt).toHaveBeenCalledWith("pi_late", { store: lateDb, keptLateCapture: true, createdByMemberId: "m-1" });
    expect(mocks.enqueueKeptInvoice).not.toHaveBeenCalled();
    expect(mocks.enqueueNote).not.toHaveBeenCalled();
  });

  it("reads the keep's evidence under the anchor for the close, and without it for the dialog", async () => {
    await closePlan(true);
    expect(mocks.readKeptCaptureRecord).toHaveBeenLastCalledWith(lateDb, expect.objectContaining({ lockAnchor: true, manualRefundTaskId: "approval-1", bookingId: "b-1" }));
    await closePlan(false);
    expect(mocks.readKeptCaptureRecord).toHaveBeenLastCalledWith(lateDb, expect.objectContaining({ lockAnchor: false }));
  });

  it("receipt route recorded by another writer (the credit-release sweep holds it): nothing is queued and the note waits", async () => {
    mocks.captureReceiptRefusal.mockResolvedValue("recorded-by-credit-release-sweep");
    const xeroPlan = await closePlan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "after-receipt", receipt: null });
    expect(paidAnotherWayXeroPromise(xeroPlan)).toBe("after-receipt-on-its-way");
    expect(await closeQueue(xeroPlan)).toBe("refund-note-after-receipt");
    expect(mocks.enqueueCaptureReceipt).not.toHaveBeenCalled();
    expect(mocks.enqueueKeptInvoice).not.toHaveBeenCalled();
  });

  it("receipt route the enqueue refuses for any other reason (internet banking): nothing, and no note promised", async () => {
    mocks.captureReceiptRefusal.mockResolvedValue("not-a-card-booking");
    expect(await closePlan()).toEqual({ xeroRefundNote: "none" });
  });

  it("change-unknown: nothing is queued (the repair tool names it)", async () => {
    mocks.readKeptCaptureRecord.mockResolvedValue(routed("change-unknown"));
    expect(await closePlan()).toEqual({ xeroRefundNote: "none" });
  });

  it("kept-invoice route: the kept-capture invoice for the capture less what other writers record", async () => {
    mocks.readKeptCaptureRecord.mockResolvedValue(routed("kept-invoice", 3_000));
    const xeroPlan = await closePlan();
    expect(xeroPlan).toEqual(receiptPlan(5_000, "kept-invoice"));
    expect(await closeQueue(xeroPlan)).toBe("receipt-then-refund-note");
    expect(mocks.enqueueKeptInvoice).toHaveBeenCalledWith(expect.objectContaining({ capturedCents: 5_000, requeueFailedUnsent: true }));
    expect(mocks.enqueueCaptureReceipt).not.toHaveBeenCalled();
  });

  it.each([["all" as const], [8_000]])("kept-invoice route recorded in full elsewhere (%s): nothing to queue, the note waits", async (elsewhere) => {
    mocks.readKeptCaptureRecord.mockResolvedValue(routed("kept-invoice", elsewhere));
    expect(await closePlan()).toEqual({ xeroRefundNote: "after-receipt", receipt: null });
  });

  it("change-invoice route: the kept-capture invoice for the gross capture, as before #4381", async () => {
    mocks.readKeptCaptureRecord.mockResolvedValue(routed("change-invoice"));
    expect(await closePlan()).toEqual(receiptPlan(8_000, "kept-invoice"));
  });

  it("the booking's own payment, or a kept-capture invoice already asked for: that invoice, as before #4381", async () => {
    mocks.readKeptCaptureRecord.mockResolvedValue({ firstCut: "kept-invoice" });
    expect(await closePlan()).toEqual(receiptPlan(8_000, "kept-invoice"));
    mocks.readKeptCaptureRecord.mockResolvedValue({ ...byEvidence, liveKeptInvoice: { id: "kept-0" }, receiptRow: null, decided: null });
    expect(await closePlan()).toEqual(receiptPlan(8_000, "kept-invoice"));
    expect(mocks.captureReceiptRefusal).not.toHaveBeenCalled();
  });

  it("the capture's own receipt row still undecided is its record; one that stood down for another writer is not re-queued", async () => {
    const row = { id: "rcpt-0", status: "PENDING", manuallyResolvedAt: null, requestPayload: {} };
    mocks.readKeptCaptureRecord.mockResolvedValue({ ...byEvidence, liveKeptInvoice: null, receiptRow: row, decided: null });
    expect(await closePlan()).toEqual(receiptPlan(8_000, "capture-receipt"));
    mocks.readKeptCaptureRecord.mockResolvedValue({ ...byEvidence, liveKeptInvoice: null, receiptRow: { ...row, status: "SUCCEEDED" }, decided: null });
    expect(await closePlan()).toEqual({ xeroRefundNote: "none" });
  });

  describe("the queue's answer to a receipt row already there", () => {
    const plan = receiptPlan(8_000, "capture-receipt") as Awaited<ReturnType<typeof closePlan>>;
    const existing = (row: Record<string, unknown>) => {
      mocks.enqueueCaptureReceipt.mockResolvedValue({ outcome: "already-queued", queueOperationId: "rcpt-0" });
      lateDb.xeroSyncOperation.findUnique.mockResolvedValueOnce({ status: "FAILED", manuallyResolvedAt: null, requestPayload: {}, ...row });
    };

    it("MUTATION: an undecided FAILED row is put back to run, guarded on the FAILED row read", async () => {
      existing({});
      expect(await closeQueue(plan)).toBe("receipt-then-refund-note");
      expect(mocks.returnToPending).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "rcpt-0", where: { status: "FAILED", manuallyResolvedAt: null }, request: { keep: true } }),
      );
    });

    it("a FAILED row that stored its decision may be in Xero: left for an officer, never run again", async () => {
      existing({ requestPayload: { plan: { legs: [] } } });
      expect(await closeQueue(plan)).toBe("receipt-held-for-officer");
      expect(mocks.returnToPending).not.toHaveBeenCalled();
    });

    it("a requeue lost to the outbox's claim answers the claimed row; one lost to an officer's resolve is a 409", async () => {
      existing({});
      mocks.returnToPending.mockResolvedValueOnce({ outcome: "lost" });
      lateDb.xeroSyncOperation.findUnique.mockResolvedValueOnce({ status: "RUNNING", manuallyResolvedAt: null });
      expect(await closeQueue(plan)).toBe("receipt-then-refund-note");
      existing({});
      mocks.returnToPending.mockResolvedValueOnce({ outcome: "lost" });
      lateDb.xeroSyncOperation.findUnique.mockResolvedValueOnce({ status: "FAILED", manuallyResolvedAt: new Date() });
      await expect(closeQueue(plan)).rejects.toBeInstanceOf(PaidAnotherWayXeroChangedError);
    });

    it("a queued or running row is the record: nothing is written", async () => {
      existing({ status: "PENDING" });
      expect(await closeQueue(plan)).toBe("receipt-then-refund-note");
      expect(mocks.returnToPending).not.toHaveBeenCalled();
    });
  });

  it("MUTATION: a refusal the plan did not predict is a fault - the close throws and nothing commits", async () => {
    mocks.enqueueCaptureReceipt.mockResolvedValue({ outcome: "not-eligible", reason: "capture-not-kept" });
    await expect(closeQueue(receiptPlan(8_000, "capture-receipt") as never)).rejects.toThrow(/could not be queued \(capture-not-kept\)/);
  });

  describe("the repair tool's queue of a close's missing receipt (queueMissingPaidAnotherWayReceipt)", () => {
    const repair = () =>
      queueMissingPaidAnotherWayReceipt(lateDb as never, { manualRefundTaskId: "approval-1", paymentIntentId: "pi_late", clubZone: "Pacific/Auckland" as never });

    beforeEach(() => {
      db.manualRefundTask.findUnique.mockResolvedValue({ ...TASK, lateCaptureApprovalIntentId: "pi_late" });
    });

    it("runs the close's split again under its locks: the receipt where the primary invoice bills the change", async () => {
      expect(await repair()).toBe("receipt-then-refund-note");
      expect(mocks.readKeptCaptureRecord).toHaveBeenCalledWith(lateDb, expect.objectContaining({ lockAnchor: true }));
      expect(mocks.enqueueCaptureReceipt).toHaveBeenCalledWith("pi_late", expect.objectContaining({ keptLateCapture: true, createdByMemberId: null }));
      expect(mocks.enqueueKeptInvoice).not.toHaveBeenCalled();
    });

    it("queues nothing for a stale snapshot: no receipt owed any more, or Xero already records it", async () => {
      mocks.receiptOwed.mockResolvedValueOnce(false);
      expect(await repair()).toBe("nothing");
      mocks.receipt.mockResolvedValueOnce({ kind: "recorded", invoiceId: null, recordedCents: 8_000 });
      expect(await repair()).toBe("nothing");
      expect(mocks.enqueueCaptureReceipt).not.toHaveBeenCalled();
    });
  });
});
