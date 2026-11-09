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
  lateCaptureIntent: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
  receipt: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: "recorded", invoiceId: "inv-receipt" })),
  enqueueNote: vi.fn<(...args: unknown[]) => Promise<{ queueOperationId: string }>>(async () => ({ queueOperationId: "xop-1" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0, unreadableOperationIds: mocks.unreadable() }),
  sumRefundCreditNoteCoverageCents: (...args: unknown[]) => mocks.coveredCents(...args),
}));
vi.mock("@/lib/refund-note-eligible-cash", () => ({
  resolveRefundNoteEligibleCash: async (...args: unknown[]) => ({ eligibleCashCents: await mocks.eligibleCashCents(...args) }),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  lateCaptureIntentOfCardRefundOperation: (...args: unknown[]) => mocks.lateCaptureIntent(...args),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findKeptLateCaptureInvoiceIdForPayment: async () => null,
  readPaidAnotherWayLateCaptureXeroReceipt: (...args: unknown[]) => mocks.receipt(...args),
}));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  keptLateCaptureDocumentDate: () => "2026-06-19",
  lockKeptLateCaptureTask: vi.fn(),
}));
vi.mock("@/lib/kept-late-capture-receipt-rows", () => ({ keptReceiptHeldForOfficer: async () => false }));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => mocks.enqueueNote(...args) }));

import {
  paidAnotherWayXeroPlan,
  paidAnotherWayCardNoteCoversCents,
  paidAnotherWayXeroPromise,
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
  it("MUTATION: while its card note still covers it - notes exceed the card cash by at least the refund - no second note", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    // The ordinary `now` close (MM1): its record counts as noted, so the bank
    // transfer takes up the card note's excess and a later refund's note is
    // sized as it would have been.
    expect(xeroPlan).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 4_000 });
    expect(paidAnotherWayXeroPromise(xeroPlan)).toBe("covered-by-card-note");
    expect(await queue(xeroPlan, 4_000)).toBe("covered-by-card-note");
    expect(mocks.enqueueNote).not.toHaveBeenCalled();
    expect(xeroQueuedMessage("covered-by-card-note", "Bank transfer")).toMatch(/already in Xero records what you paid back/);
  });

  it("MUTATION (ML1): a card note covering part of it answers that part; the close's note is for the rest", async () => {
    mocks.coveredCents.mockResolvedValue(7_500);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "now", cardNoteCoversCents: 1_500 });
    expect(await queue(xeroPlan, 4_000)).toBe("refund-note-beyond-card-note");
    expect(noteCents()).toBe(2_500);
    expect(mocks.enqueueNote.mock.calls[0]?.[2]).toMatchObject({ paidAnotherWayTaskId: "task-1", refundMethod: "internet-banking" });
    expect(xeroQueuedMessage("refund-note-beyond-card-note", "Bank transfer")).toMatch(/records part of what you paid back; .* "Bank transfer" is queued for the rest/);
  });

  it("MUTATION (MM2): a close for less than the card note covers queues nothing, and says the note credits more than went back", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(await queue(xeroPlan, 1_000)).toBe("covered-by-card-note");
    expect(mocks.enqueueNote).not.toHaveBeenCalled();
    // A-F1: the close's record keeps only what it paid back, never the whole cover.
    expect(paidAnotherWayCardNoteCoversCents(xeroPlan, 1_000)).toBe(1_000);
    expect(paidAnotherWayCardNoteCoversCents({ xeroRefundNote: "none" }, 1_000)).toBe(0);
    // D4: the dialog says so before the close, for a part close as for a full one.
    const promise = xeroRefundNotePromise("covered-by-card-note", "Bank transfer", "$40.00");
    expect(promise).toMatch(/card refund credit note for \$40\.00 of this refund/);
    expect(promise).toMatch(/If you pay back less than \$40\.00, Xero's note credits more than went back: the Xero reconciliation report lists the difference/);
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
    expect(await queue(xeroPlan, 7_000)).toBe("covered-by-card-note");
    expect(mocks.enqueueNote).not.toHaveBeenCalled();
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
