import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Payment } from "@prisma/client";

const { late, unrecorded, receipt, ordinaryNote, lateNote } = vi.hoisted(() => ({
  late: vi.fn(), unrecorded: vi.fn(), receipt: vi.fn(), ordinaryNote: vi.fn(), lateNote: vi.fn(),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({ findLateCapturePaymentIntents: late }));
vi.mock("@/lib/late-capture-unrecorded-refunds", () => ({ readUnrecordedLateCaptureRefund: unrecorded }));
vi.mock("@/lib/additional-capture-receipt-link", () => ({ findAdditionalCaptureReceiptInvoiceId: receipt }));
vi.mock("@/lib/card-refund-own-note", () => ({ queueWebhookCardRefundNotes: ordinaryNote }));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ queueLateCaptureRefundCreditNote: lateNote }));
import { queueRecordedCardRefundNotes, RecordedCardRefundNoteEnqueueError } from "@/lib/recorded-card-refund-notes";

const input = { payment: { id: "payment-test", source: "INTERNET_BANKING" } as Payment, paymentIntentId: "pi_test", deltaCents: 4000, newlyCountedRefundIds: ["re_test"], refunds: [{ id: "re_test", amount: 4000, metadata: {} }] };
beforeEach(() => {
  late.mockReset().mockResolvedValue(new Set());
  unrecorded.mockReset().mockResolvedValue("none");
  receipt.mockReset().mockResolvedValue(null);
  ordinaryNote.mockReset().mockResolvedValue({ queueOperationId: "note-test" });
  lateNote.mockReset().mockResolvedValue(undefined);
});
describe("recorded card refund accounting", () => {
  it("queues the existing dashboard-own-note rule even if the total did not increase", async () => {
    await expect(queueRecordedCardRefundNotes({ ...input, deltaCents: 0 })).resolves.toEqual({ queueOperationId: "note-test" });
    expect(ordinaryNote).toHaveBeenCalledExactlyOnceWith({ payment: input.payment, deltaCents: 0, refunds: input.refunds, newlyCountedRefundIds: ["re_test"] });
  });
  it("keeps a change capture's invoice identity", async () => {
    receipt.mockResolvedValue("invoice-test");
    await queueRecordedCardRefundNotes(input);
    expect(ordinaryNote).toHaveBeenCalledWith(expect.objectContaining({ creditsInvoiceId: "invoice-test" }));
  });
  it("routes late captures to their own receipt correction", async () => {
    late.mockResolvedValue(new Set(["pi_test"]));
    await queueRecordedCardRefundNotes(input);
    expect(lateNote).toHaveBeenCalledExactlyOnceWith({ paymentId: "payment-test", paymentIntentId: "pi_test" });
    expect(ordinaryNote).not.toHaveBeenCalled();
  });
  it("does not issue a generic note while the late-capture receipt is missing", async () => {
    unrecorded.mockResolvedValue("unrecorded");
    await queueRecordedCardRefundNotes(input);
    expect(ordinaryNote).not.toHaveBeenCalled();
  });
  it("preserves the webhook's retry boundary for a failed routing read", async () => {
    late.mockRejectedValue(new Error("routing unavailable"));
    await expect(queueRecordedCardRefundNotes(input)).rejects.toThrow("routing unavailable");
    await expect(queueRecordedCardRefundNotes(input)).rejects.not.toBeInstanceOf(RecordedCardRefundNoteEnqueueError);
    expect(ordinaryNote).not.toHaveBeenCalled();
  });
  it("identifies an ordinary note enqueue failure for the existing alert path", async () => {
    ordinaryNote.mockRejectedValue(new Error("outbox unavailable"));
    await expect(queueRecordedCardRefundNotes(input)).rejects.toBeInstanceOf(RecordedCardRefundNoteEnqueueError);
  });
  it("queues nothing for an already counted delivery", async () => {
    await queueRecordedCardRefundNotes({ ...input, deltaCents: 0, newlyCountedRefundIds: [] });
    expect(ordinaryNote).not.toHaveBeenCalled();
    expect(lateNote).not.toHaveBeenCalled();
  });
});
