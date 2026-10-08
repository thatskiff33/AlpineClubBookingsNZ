// #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit";
// `INV-PAY-121`): a late capture's approved refund closed as paid another way -
// finding the close from the capture, the receipt gate the cash evidence asks,
// and the note the receipt's worker queues.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  findClose: vi.fn(),
  hasXeroReceiptForLateCapture: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  hasXeroReceiptForLateCapture: (...args: unknown[]) => mocks.hasXeroReceiptForLateCapture(...args),
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
  paymentRecoveryOperation: { findUnique: (...args: unknown[]) => mocks.findOperation(...args) },
  manualRefundTask: { findFirst: (...args: unknown[]) => mocks.findClose(...args) },
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
  mocks.findClose.mockResolvedValue(null);
  mocks.hasXeroReceiptForLateCapture.mockResolvedValue(false);
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "xop-note" });
});

describe("findLateCaptureRefundPaidAnotherWay", () => {
  it("joins the capture to the close through its approval's card refund row, under any of the three keys", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    await expect(findLateCaptureRefundPaidAnotherWay("pi_late", store as never)).resolves.toMatchObject({ id: "close-1" });
    expect(mocks.findOperation).toHaveBeenCalledWith({
      where: { idempotencyKey: "late_capture_approval_refund_recovery_pi_late" },
      select: { id: true },
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
    mocks.findOperation.mockResolvedValue(null);
    await expect(findLateCaptureRefundPaidAnotherWay("pi_late", store as never)).resolves.toBeNull();
    expect(mocks.findClose).not.toHaveBeenCalled();
  });
});

describe("paidAnotherWayCloseReceiptRecorded: the cash evidence's gate", () => {
  it("MUTATION: asks the late capture's own receipt, read off the close's operation", async () => {
    mocks.hasXeroReceiptForLateCapture.mockResolvedValue(true);
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(true);
    expect(mocks.findOperation).toHaveBeenCalledWith({ where: { id: "op-dead" }, select: { idempotencyKey: true } });
    expect(mocks.hasXeroReceiptForLateCapture).toHaveBeenCalledWith("pi_late", store);

    mocks.hasXeroReceiptForLateCapture.mockResolvedValue(false);
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
  });

  it("is false for a close that is not a late capture's, or not a close at all", async () => {
    mocks.findOperation.mockResolvedValue({ idempotencyKey: "booking_cancel_refund_recovery_b-1" });
    await expect(paidAnotherWayCloseReceiptRecorded(closeRecord("after-receipt"), store as never)).resolves.toBe(false);
    await expect(
      paidAnotherWayCloseReceiptRecorded({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null }, store as never),
    ).resolves.toBe(false);
    expect(mocks.hasXeroReceiptForLateCapture).not.toHaveBeenCalled();
  });
});

describe("notePaidAnotherWayCloseOnReceipt: the second step, run by the receipt's worker", () => {
  const ZONE = "Pacific/Auckland" as ClubTimeZone;
  const note = () => notePaidAnotherWayCloseOnReceipt({ paymentIntentId: "pi_late", clubZone: ZONE, store: store as never });

  it("queues the waiting close's bank-transfer note for the amount paid back, keyed on the close, dated the day it closed", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    await expect(note()).resolves.toBe("xop-note");
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("p-1", 24_000, {
      refundMethod: "internet-banking",
      paidAnotherWayTaskId: "close-1",
      documentDate: "2026-06-20",
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it.each(["now", "none"] as const)(
    "MUTATION: leaves a close whose note is '%s' alone - it queued its own, or raises none",
    async (xeroRefundNote) => {
      mocks.findClose.mockResolvedValue(closeRecord(xeroRefundNote));
      await expect(note()).resolves.toBeNull();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    },
  );

  it("queues nothing with no close, no payment, or nothing paid back", async () => {
    await expect(note()).resolves.toBeNull();
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt", { paymentId: null }));
    await expect(note()).resolves.toBeNull();
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt", { amountCents: 0 }));
    await expect(note()).resolves.toBeNull();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("throws what the enqueue throws, so the receipt's link rolls back with it", async () => {
    mocks.findClose.mockResolvedValue(closeRecord("after-receipt"));
    mocks.enqueueXeroRefundCreditNoteOperation.mockRejectedValue(new Error("database blip"));
    await expect(note()).rejects.toThrow("database blip");
  });
});
