// #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit";
// `INV-PAY-122`): a late capture's approved refund closed as paid another way -
// finding the close from the capture, the receipt gate the cash evidence asks,
// and the note the receipt's worker queues.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  findOperations: vi.fn(),
  lateIntents: vi.fn<(...args: unknown[]) => Promise<Set<string>>>(async () => new Set<string>()),
  findClose: vi.fn(),
  readLateCaptureXeroReceipt: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  findAskedNote: vi.fn(),
  findRecord: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  // Round 11: a paid-another-way path never reads the card-refund verdict.
  readLateCaptureXeroReceipt: () => {
    throw new Error("a paid-another-way path read readLateCaptureXeroReceipt");
  },
  readPaidAnotherWayLateCaptureXeroReceipt: (...args: unknown[]) => mocks.readLateCaptureXeroReceipt(...args),
  findLateCapturePaymentIntents: (...args: unknown[]) => mocks.lateIntents(...args),
  hasXeroReceiptForLateCapture: async (...args: unknown[]) =>
    ((await mocks.readLateCaptureXeroReceipt(...args)) as { kind: string }).kind === "recorded",
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => mocks.enqueueXeroRefundCreditNoteOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: async () => false }));

import {
  findLateCaptureRefundPaidAnotherWay,
  paidAnotherWayCloseReceiptRecorded,
} from "@/lib/late-capture-paid-another-way";
import { notePaidAnotherWayCloseOnReceipt } from "@/lib/late-capture-refund-credit-note";
import { cardRefundPaidAnotherWayOccurrenceKey, type PaidAnotherWayXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import type { ClubTimeZone } from "@/lib/club-time";

const store = {
  paymentRecoveryOperation: {
    findUnique: (...args: unknown[]) => mocks.findOperation(...args),
    findMany: (...args: unknown[]) => mocks.findOperations(...args),
  },
  // #4516 (round-2 review A): every close of the capture's refund, oldest first.
  manualRefundTask: {
    findMany: async (...args: unknown[]) => {
      const found = (await mocks.findClose(...args)) as unknown;
      return Array.isArray(found) ? found : found ? [found] : [];
    },
    findUnique: (...args: unknown[]) => mocks.findRecord(...args),
  },
  xeroSyncOperation: { findFirst: (...args: unknown[]) => mocks.findAskedNote(...args) },
};

function closeRecord(xeroRefundNote: PaidAnotherWayXeroNote, overrides: Record<string, unknown> = {}) {
  return {
    id: "close-1",
    kind: "CANCELLED_BOOKING_HAND_BACK",
    occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-dead", { xeroRefundNote }),
    paymentId: "p-1",
    amountCents: 24_000,
    completedAt: new Date("2026-06-20T02:00:00.000Z"),
    completedByMemberId: "treasurer-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOperation.mockResolvedValue({ id: "op-dead", idempotencyKey: "late_capture_approval_refund_recovery_pi_late" });
  mocks.findOperations.mockResolvedValue([{ id: "op-dead", idempotencyKey: "late_capture_approval_refund_recovery_pi_late", paymentIntentId: "pi_late" }]);
  mocks.findRecord.mockResolvedValue(null);
  mocks.lateIntents.mockResolvedValue(new Set<string>());
  mocks.findClose.mockResolvedValue(null);
  mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "none" });
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "xop-note" });
  mocks.findAskedNote.mockResolvedValue(null);
});

describe("findLateCaptureRefundPaidAnotherWay", () => {
  it("joins the capture to the close through its approval's card refund row, under any of the three keys", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    await expect(findLateCaptureRefundPaidAnotherWay("pi_late", store as never)).resolves.toMatchObject({ id: "close-1" });
    // #4104: its approval row, or a row owing a refund of it that Stripe failed later.
    expect(mocks.findOperations).toHaveBeenCalledWith({
      where: {
        OR: [
          { idempotencyKey: { in: ["late_capture_approval_refund_recovery_pi_late"] } },
          { idempotencyKey: { startsWith: "card_refund_failed_later_" }, paymentIntentId: { in: ["pi_late"] } },
          // #4516 (round-2 review A): a still-owed rest of either, kept where its origin is this capture's.
          { idempotencyKey: { startsWith: "card_refund_still_owed_" }, paymentIntentId: { in: ["pi_late"] } },
        ],
      },
      select: { id: true, idempotencyKey: true, paymentIntentId: true },
    });
    const [{ where }] = mocks.findClose.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(where).toMatchObject({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      status: "COMPLETED",
      occurrenceKey: {
        in: [
          "card-refund-paid-another-way:op-dead",
          "card-refund-paid-another-way:op-dead:note-after-receipt",
          "card-refund-paid-another-way:op-dead:no-xero-note",
        ],
      },
    });
  });

  it("is null when the capture's refund was never raised", async () => {
    mocks.findOperations.mockResolvedValue([]);
    await expect(findLateCaptureRefundPaidAnotherWay("pi_late", store as never)).resolves.toBeNull();
    expect(mocks.findClose).not.toHaveBeenCalled();
  });
});

describe("paidAnotherWayCloseReceiptRecorded: the cash evidence's gate", () => {
  it("MUTATION: asks the late capture's own receipt, read off the close's operation", async () => {
    mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv-receipt" });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(true);
    expect(mocks.findOperation).toHaveBeenCalledWith({ where: { id: "op-dead" }, select: { idempotencyKey: true, paymentIntentId: true } });
    expect(mocks.readLateCaptureXeroReceipt).toHaveBeenCalledWith("pi_late", store);

    mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "none" });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
  });

  // #3924 round 8 (money review): a change's invoice released for the capture
  // is "recorded" from the moment it is queued, but has nothing to credit yet.
  it("MUTATION: a receipt recorded but not yet in Xero (no invoice id) is not in Xero", async () => {
    mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: null });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
  });

  it("is false for a close that is not a late capture's, or not a close at all", async () => {
    mocks.findOperation.mockResolvedValue({ idempotencyKey: "booking_cancel_refund_recovery_b-1" });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
    await expect(
      paidAnotherWayCloseReceiptRecorded({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null }, store as never),
    ).resolves.toBe(false);
    expect(mocks.readLateCaptureXeroReceipt).not.toHaveBeenCalled();
  });
});

describe("notePaidAnotherWayCloseOnReceipt: the second step, run by the receipt's worker", () => {
  const ZONE = "Pacific/Auckland" as ClubTimeZone;
  const note = () =>
    notePaidAnotherWayCloseOnReceipt({
      paymentIntentId: "pi_late",
      receiptInvoiceId: "kept-inv-1",
      clubZone: ZONE,
      store: store as never,
    });

  it("queues the waiting close's bank-transfer note for the amount paid back, keyed on the close, dated the day it closed, crediting the receipt", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    await expect(note()).resolves.toEqual(["xop-note"]);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("p-1", 24_000, {
      refundMethod: "internet-banking",
      paidAnotherWayTaskId: "close-1",
      creditsInvoiceId: "kept-inv-1",
      documentDate: "2026-06-20",
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it("MUTATION: C9 (round 7): at most once - a note already asked for this close, in any state but withdrawn, is returned, never a second", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    mocks.findAskedNote.mockResolvedValue({ id: "xop-failed-note" });
    await expect(note()).resolves.toEqual(["xop-failed-note"]);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.findAskedNote).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localId: "p-1",
          status: { not: "CANCELLED" },
          requestPayload: { path: ["paidAnotherWayTaskId"], equals: "close-1" },
        }),
      }),
    );
  });

  it.each(["now", "none"] as const)(
    "MUTATION: leaves a close whose note is '%s' alone - it queued its own, or raises none",
    async (xeroRefundNote) => {
      mocks.findClose.mockResolvedValue(closeRecord(xeroRefundNote));
      await expect(note()).resolves.toEqual([]);
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    },
  );

  it("queues nothing with no close, no payment, or nothing paid back", async () => {
    await expect(note()).resolves.toEqual([]);
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt", { paymentId: null }));
    await expect(note()).resolves.toEqual([]);
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt", { amountCents: 0 }));
    await expect(note()).resolves.toEqual([]);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("MUTATION (#4516 round-2 review A): a part close and the close of its still-owed rest, both waiting on the receipt, each get their own note", async () => {
    // 300 owed: C1 paid 100 back, the rest stayed owed on its own row; C2 then closed that 200, the receipt still not in Xero.
    mocks.findOperations.mockResolvedValue([
      { id: "op-dead", idempotencyKey: "late_capture_approval_refund_recovery_pi_late", paymentIntentId: "pi_late" },
      { id: "op-rest", idempotencyKey: "card_refund_still_owed_close-1", paymentIntentId: "pi_late" },
    ]);
    // The rest's origin: its close's record, then the approval row it closed.
    mocks.findRecord.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-dead", { xeroRefundNote: "after-receipt" }) });
    mocks.findOperation.mockResolvedValue({ id: "op-dead", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: "late_capture_approval_refund_recovery_pi_late", paymentIntentId: "pi_late" });
    mocks.findClose.mockResolvedValue([
      closeRecord("after-receipt", { id: "close-1", amountCents: 10_000 }),
      closeRecord("after-receipt", { id: "close-2", amountCents: 20_000, occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-rest", { xeroRefundNote: "after-receipt" }) }),
    ]);
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValueOnce({ queueOperationId: "xop-c1" }).mockResolvedValueOnce({ queueOperationId: "xop-c2" });
    await expect(note()).resolves.toEqual(["xop-c1", "xop-c2"]);
    expect(mocks.enqueueXeroRefundCreditNoteOperation.mock.calls.map((call) => [call[1], (call[2] as { paidAnotherWayTaskId: string }).paidAnotherWayTaskId]))
      .toEqual([[10_000, "close-1"], [20_000, "close-2"]]);
    // Both rows were searched for closes, the rest's because its origin is this capture's approval row.
    const [{ where }] = mocks.findClose.mock.calls[0] as [{ where: { occurrenceKey: { in: string[] } } }];
    expect(where.occurrenceKey.in).toEqual(expect.arrayContaining(["card-refund-paid-another-way:op-dead", "card-refund-paid-another-way:op-rest"]));
  });

  it("a still-owed row whose origin is another capture's refund is not this capture's", async () => {
    mocks.findOperations.mockResolvedValue([{ id: "op-rest", idempotencyKey: "card_refund_still_owed_close-9", paymentIntentId: "pi_late" }]);
    mocks.findRecord.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op-other", { xeroRefundNote: "now" }) });
    mocks.findOperation.mockResolvedValue({ id: "op-other", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: "booking_cancel_refund_recovery_b-1", paymentIntentId: "pi_late" });
    await expect(findLateCaptureRefundPaidAnotherWay("pi_late", store as never)).resolves.toBeNull();
    expect(mocks.findClose).not.toHaveBeenCalled();
  });

  it("throws what the enqueue throws, so the receipt's worker fails its row and its retry runs this again", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    mocks.enqueueXeroRefundCreditNoteOperation.mockRejectedValue(new Error("database blip"));
    await expect(note()).rejects.toThrow("database blip");
  });
});

// #4104 review (money 3): a late capture's refund that Stripe failed later is
// owed by a row of its own; its close keeps INV-PAY-110's routing.
describe("a late capture's refund that failed later (#4104)", () => {
  it("MUTATION: a failed-later row on a late capture's intent is that capture's, for the receipt gate", async () => {
    mocks.findOperation.mockResolvedValue({ idempotencyKey: "card_refund_failed_later_re_late", paymentIntentId: "pi_late" });
    mocks.lateIntents.mockResolvedValue(new Set(["pi_late"]));
    mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv-receipt" });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(true);
    expect(mocks.readLateCaptureXeroReceipt).toHaveBeenCalledWith("pi_late", store);
  });

  it("a failed-later row on an ordinary intent is no late capture's", async () => {
    mocks.findOperation.mockResolvedValue({ idempotencyKey: "card_refund_failed_later_re_x", paymentIntentId: "pi_booking" });
    mocks.lateIntents.mockResolvedValue(new Set());
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
    expect(mocks.readLateCaptureXeroReceipt).not.toHaveBeenCalled();
  });
});
