/**
 * #4312 review: a refund request's recovery replay notes EVERY card refund it
 * made, whatever the replay's own outcome (`replayNotingEachRefund`) - a
 * success, a slice Stripe refused (the replay then throws to retry it), or a
 * slice that threw after earlier ones were made (`PartialRefundError`). A row
 * an older approval wrote asks for nothing. Proven end to end on real
 * PostgreSQL by `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { updateMany: vi.fn() },
    payment: { findUnique: vi.fn(async () => ({ source: "INTERNET_BANKING" })) },
    paymentRefund: {
      findMany: vi.fn(async ({ where }: { where: { stripeRefundId: { in: string[] } } }) =>
        where.stripeRefundId.in.map((stripeRefundId) => ({ stripeRefundId, amountCents: 4_000, stripePaymentIntentId: "pi_card", stripeCreatedAt: null, createdAt: new Date(0) })),
      ),
    },
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: vi.fn() }));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ noteLateCaptureRefunds: vi.fn() }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({ findLateCapturePaymentIntents: vi.fn(async () => new Set()) }));
vi.mock("@/lib/additional-capture-receipt-link", () => ({ findAdditionalCaptureReceiptInvoiceId: vi.fn(async () => null) }));
vi.mock("@/lib/card-refund-resend-answer", () => ({ readFailedRefundsAnsweredBy: vi.fn(), pairResendRecordedFirst: vi.fn(async () => "none") }));
vi.mock("@/lib/card-refund-own-note-share", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/card-refund-own-note-share")),
  cardRefundNoteCutoverSeconds: async () => null,
}));

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { queueAnsweringRefundNotes, queueWebhookCardRefundNotes, replayNotingEachRefund } from "@/lib/card-refund-own-note";
import { pairResendRecordedFirst, readFailedRefundsAnsweredBy } from "@/lib/card-refund-resend-answer";
import { findAdditionalCaptureReceiptInvoiceId } from "@/lib/additional-capture-receipt-link";
import { noteLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { PaymentSource } from "@prisma/client";
import { PartialRefundError } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { refundPlanOrRetryRefusals } from "@/lib/refused-card-refund-retry";

const input = (notesEachRefund: boolean) => ({
  paymentId: "payment-1",
  operationId: "operation-1",
  notesEachRefund,
  plan: [{ madeRefundId: "re_inline" }, {}, {}],
});

describe("replayNotingEachRefund (#4312 review)", () => {
  it("a replay that succeeds asks for each refund made - the plan's and its own", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const result = await replayNotingEachRefund(input(true), async (send) => {
      await send(async () => ({ refunds: [{ refundId: "re_a", status: "succeeded" }, { refundId: "re_b", status: "pending" }] }));
      return "re_inline";
    }, queue);
    expect(result).toBe("re_inline");
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_a", "re_b"] });
  });

  it("a slice Stripe refused fails the replay, and the refunds it made beside it are still asked for", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const refused = new Error("refused");
    await expect(
      replayNotingEachRefund(input(true), async (send) => {
        await send(async () => ({ refunds: [{ refundId: "re_made", status: "succeeded" }, { refundId: "re_refused", status: "failed" }] }));
        throw refused;
      }, queue),
    ).rejects.toBe(refused);
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_made"] });
  });

  const partialFailure = () =>
    new PartialRefundError({
      completedRefundCents: 2_000,
      refunds: [
        { paymentIntentId: "pi_1", refundId: "re_before", amountCents: 2_000, status: "succeeded", slice: { paymentTransactionId: "txn_1", amountCents: 2_000 } },
        { paymentIntentId: "pi_1", refundId: "re_cancelled", amountCents: 500, status: "canceled", slice: { paymentTransactionId: "txn_2", amountCents: 500 } },
      ],
      cause: new Error("network"),
      format: CLUB_FORMAT_TEST,
    });

  it("a slice that threw after earlier ones were made: the made ones are read off the error and asked for", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const partial = partialFailure();
    await expect(replayNotingEachRefund(input(true), (send) => send(async () => { throw partial; }), queue)).rejects.toBe(partial);
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_before"] });
  });

  it("MUTATION: re-planning the row after a partial failure throws its own error - the refunds made are still asked for on this attempt", async () => {
    // `refundPlanOrRetryRefusals` re-plans the row from the partial failure's answers before
    // rethrowing it; when that write fails, the error the replay ends on carries no answers.
    vi.mocked(prisma.paymentRecoveryOperation.updateMany).mockRejectedValueOnce(new Error("database unavailable"));
    const queue = vi.fn().mockResolvedValue([]);
    const operation = { id: "operation-1", idempotencyKey: "refund_request_refund_rr_1", processingStartedAt: new Date(0), bookingId: "booking-1", paymentIntentId: "pi_1" };
    const plan: Array<{ paymentTransactionId: string; amountCents: number; madeRefundId?: string }> = [{ paymentTransactionId: "txn_1", amountCents: 2_000 }, { paymentTransactionId: "txn_2", amountCents: 500 }];
    await expect(
      replayNotingEachRefund({ ...input(true), plan }, (send) =>
        refundPlanOrRetryRefusals({ operation, plan, format: CLUB_FORMAT_TEST, refund: () => send(async () => { throw partialFailure(); }) }),
      queue),
    ).rejects.toThrow("database unavailable");
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_before"] });
  });

  it("MUTATION (round 6): any other row - an older approval's, a failed-later row - asks only by the one rule, never for each refund", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const answering = vi.fn().mockResolvedValue([]);
    await replayNotingEachRefund(input(false), (send) => send(async () => ({ refunds: [{ refundId: "re_a", status: "succeeded" }] })), queue, answering);
    expect(queue).not.toHaveBeenCalled();
    expect(answering).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_a"] });
  });

  it("a note that cannot be queued never fails the replay: the money has moved", async () => {
    const queue = vi.fn().mockRejectedValue(new Error("outbox down"));
    await expect(replayNotingEachRefund(input(true), async () => "done", queue)).resolves.toBe("done");
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe("one rule for a re-send's own note: the replay and charge.refunded agree (#4312 round 7)", () => {
  /** Which refunds the replay's record pairs with failures (`paired`), and whether one of those was noted on its own record. */
  const answers = (paired: Record<string, { ownNoted: boolean }>) =>
    vi.mocked(readFailedRefundsAnsweredBy).mockImplementation(async (_db, _paymentId, id) =>
      paired[id] ? { failedRefundIds: ["re_failed"], ownNoted: paired[id].ownNoted, coverCents: paired[id].ownNoted ? 4_000 : 0 } : { failedRefundIds: [], ownNoted: false, coverCents: 0 },
    );
  const appDoor = (id: string, reason = "card_refund_failed_later") => ({ id, amount: 4_000, metadata: { reason, bookingId: "booking-1" } });

  /** Which refunds each writer asks for on its own record, and the canonical delta charge.refunded queues, for one refund. */
  async function bothWriters(id: string, refund = appDoor(id)) {
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset().mockResolvedValue({ queueOperationId: "op" } as never);
    await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: [id] });
    const replayOwn = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls.filter(([, , options]) => options?.cardRefundId === id).length;
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockClear();
    await queueWebhookCardRefundNotes({ payment: { id: "payment-1", source: PaymentSource.INTERNET_BANKING }, deltaCents: 4_000, refunds: [refund], newlyCountedRefundIds: [id] });
    const calls = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls;
    return { replayOwn, webhookOwn: calls.filter(([, , options]) => options?.cardRefundId === id).length, webhookCanonicalCents: calls.filter(([, , options]) => !options?.cardRefundId).reduce((sum, [, cents]) => sum + cents, 0) };
  }

  it("MUTATION: a re-send the replay marked for an own-noted failure: both writers ask for its own note, neither for the canonical delta", async () => {
    answers({ re_s: { ownNoted: true } });
    expect(await bothWriters("re_s")).toEqual({ replayOwn: 1, webhookOwn: 1, webhookCanonicalCents: 0 });
  });

  it("MUTATION: a re-send the replay marked for a failure that folded: its fold answers it - no note from either writer, nor a canonical delta", async () => {
    answers({ re_s: { ownNoted: false } });
    expect(await bothWriters("re_s")).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 0 });
    // A re-planned slice's re-send carries its row's metadata, not the failed-later reason: the mark alone decides.
    expect(await bothWriters("re_s", appDoor("re_s", "duplicate_capture"))).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 0 });
    answers({ re_s: { ownNoted: true } });
    expect(await bothWriters("re_s", appDoor("re_s", "duplicate_capture"))).toEqual({ replayOwn: 1, webhookOwn: 1, webhookCanonicalCents: 0 });
  });

  it("MUTATION: a failed-later row's re-send charge.refunded records before the replay marks it is left to the replay - never the canonical delta", async () => {
    answers({});
    expect(await bothWriters("re_s")).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 0 });
  });

  it("MUTATION (round 8, F1): a re-planned slice's re-send charge.refunded records first, under its row's own reason, is left to the replay - never the canonical delta", async () => {
    answers({});
    vi.mocked(pairResendRecordedFirst).mockResolvedValueOnce("replay");
    expect(await bothWriters("re_s", appDoor("re_s", "duplicate_capture"))).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 0 });
    expect(pairResendRecordedFirst).toHaveBeenLastCalledWith("payment-1", appDoor("re_s", "duplicate_capture"));
  });

  it("MUTATION (round 8, F2): a dead row's re-send charge.refunded records first is marked there, and the one rule then notes it", async () => {
    // Before the mark the record pairs it with nothing; the pairing marks it, and the rule is read again.
    let marked = false;
    vi.mocked(readFailedRefundsAnsweredBy).mockImplementation(async () =>
      marked ? { failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 1_000 } : { failedRefundIds: [], ownNoted: false, coverCents: 0 },
    );
    vi.mocked(pairResendRecordedFirst).mockImplementationOnce(async () => {
      marked = true;
      return "marked";
    });
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset().mockResolvedValue({ queueOperationId: "op" } as never);
    await queueWebhookCardRefundNotes({ payment: { id: "payment-1", source: PaymentSource.INTERNET_BANKING }, deltaCents: 4_000, refunds: [appDoor("re_s", "duplicate_capture")], newlyCountedRefundIds: ["re_s"] });
    const calls = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls;
    expect(calls.map(([, cents, options]) => [cents, options?.cardRefundId])).toEqual([[4_000, "re_s"]]);
  });

  it("round 8: a re-send several dead rows could have sent is noted by nobody here - never the canonical delta", async () => {
    answers({});
    vi.mocked(pairResendRecordedFirst).mockResolvedValueOnce("ambiguous");
    expect(await bothWriters("re_s", appDoor("re_s", "duplicate_capture"))).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 0 });
  });

  it("another app door's refund no slice was sent again for stays in the canonical delta, as before", async () => {
    answers({});
    expect(await bothWriters("re_dup", appDoor("re_dup", "duplicate_capture"))).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 4_000 });
  });

  it("MUTATION: a dashboard refund gets its own note from charge.refunded, whatever the pairing says", async () => {
    answers({});
    const { webhookOwn, webhookCanonicalCents } = await bothWriters("re_d", { id: "re_d", amount: 4_000, metadata: {} } as never);
    expect({ webhookOwn, webhookCanonicalCents }).toEqual({ webhookOwn: 1, webhookCanonicalCents: 0 });
  });

  it("MUTATION (finding 4): the replay hands every late capture's refund it makes to the capture's note, as charge.refunded does", async () => {
    answers({});
    vi.mocked(findLateCapturePaymentIntents).mockResolvedValue(new Set(["pi_card"]));
    vi.mocked(noteLateCaptureRefunds).mockClear();
    try {
      await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: ["re_late"] });
      expect(noteLateCaptureRefunds).toHaveBeenCalledWith({ paymentId: "payment-1", paymentIntentId: "pi_card" });
    } finally {
      vi.mocked(findLateCapturePaymentIntents).mockResolvedValue(new Set());
    }
  });

  it("MUTATION (finding 5): every writer's own note names the invoice its capture's receipt paid, read from the refund", async () => {
    answers({ re_s: { ownNoted: true } });
    vi.mocked(findAdditionalCaptureReceiptInvoiceId).mockResolvedValue("invoice-capture");
    try {
      vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset().mockResolvedValue({ queueOperationId: "op" } as never);
      await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: ["re_s"] });
      await queueWebhookCardRefundNotes({ payment: { id: "payment-1", source: PaymentSource.INTERNET_BANKING }, deltaCents: 4_000, refunds: [appDoor("re_s")], newlyCountedRefundIds: ["re_s"] });
      const own = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls.filter(([, , options]) => options?.cardRefundId === "re_s");
      expect(own.map(([, , options]) => options?.creditsInvoiceId)).toEqual(["invoice-capture", "invoice-capture"]);
      expect(findAdditionalCaptureReceiptInvoiceId).toHaveBeenCalledWith("pi_card");
    } finally {
      vi.mocked(findAdditionalCaptureReceiptInvoiceId).mockResolvedValue(null);
    }
  });

  it("asks nothing on a card payment", async () => {
    answers({ re_s: { ownNoted: true } });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.payment.findUnique).mockResolvedValueOnce({ source: "STRIPE" } as never);
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset();
    expect(await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: ["re_s"] })).toEqual([]);
    expect(enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});
