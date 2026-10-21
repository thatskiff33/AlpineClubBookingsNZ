/**
 * #3954 (owner decision 10 Oct 2026, "Auto credit note", `INV-PAY-120`): a
 * reduction whose unpaid-ask offset the primary invoice had already billed
 * queues, in its own transaction, a scoped invoice-correction credit note for
 * exactly that part against the primary invoice - beside the re-issued ask's
 * recovery, never instead of it. The real enqueue's dedupe and the note's
 * transaction are proved on PostgreSQL (`additional-ask-reduction.realdb.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NO_ADDITIONAL_ASK } from "@/lib/additional-payment-ask";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  enqueue: vi.fn(async (...args: unknown[]) => {
    void args;
    h.calls.push("note");
    return { queueOperationId: "op_billed_offset", message: "queued" };
  }),
  reissue: vi.fn(async (...args: unknown[]) => {
    void args;
    h.calls.push("reissue");
  }),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroModificationCreditNoteOperation: h.enqueue }));
vi.mock("@/lib/additional-ask-reissue", () => ({ queueReissuedAskRecovery: h.reissue }));

const { queueReductionAskFollowUps, queueUnpaidAskBilledOffsetNote } = await import("@/lib/unpaid-ask-billed-offset-note");
const { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } = await import("@/lib/xero-review-task-key");
const { NO_FOLDED_REISSUED_ASKS, NO_UNPAID_ASK_SETTLEMENT, recordedBilledOffsetOwnNoteExpected, unpaidAskOffsetHistory } = await import(
  "@/lib/unpaid-ask-offset-marker"
);

const tx = { marker: "the edit's transaction" } as unknown as Parameters<typeof queueUnpaidAskBilledOffsetNote>[0];
const NO_ASK = NO_ADDITIONAL_ASK;

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
});

describe("queueUnpaidAskBilledOffsetNote", () => {
  it("MUTATION: queues exactly the billed offset on the reducing edit, scoped, worded as an invoice correction, in the edit's transaction", async () => {
    await expect(
      queueUnpaidAskBilledOffsetNote(tx, { bookingId: "booking_1", bookingModificationId: "mod_reduction", unpaidAskBilledOffsetCents: 2_000, ownNoteExpected: false }),
    ).resolves.toBe("op_billed_offset");

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(
      {
        bookingId: "booking_1",
        refundAmountCents: 2_000,
        bookingModificationId: "mod_reduction",
        noteWording: "invoice-correction",
        reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
        ownNoteExpected: false,
      },
      { store: tx },
    );
  });

  it("MUTATION: queues nothing where Xero billed none of the offset (the increase's own invoice was retired instead, or no primary invoice)", async () => {
    await expect(
      queueUnpaidAskBilledOffsetNote(tx, { bookingId: "booking_1", bookingModificationId: "mod_reduction", unpaidAskBilledOffsetCents: 0, ownNoteExpected: false }),
    ).resolves.toBeNull();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("the scope is the note's own, never a review task's or the give-back's", async () => {
    const { APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE, isGiveBackNoteScope } = await import("@/lib/xero-review-task-key");
    expect(UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE).not.toBe(APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE);
    expect(isGiveBackNoteScope(UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE)).toBe(false);
  });
});

describe("queueReductionAskFollowUps", () => {
  it("MUTATION: makes the re-issued ask's recovery and the billed offset's note durable together", async () => {
    const settled = { additionalAsk: NO_ASK, hasIssuedXeroInvoice: true, unpaidAskBilledOffsetCents: 2_000, xeroRefundAmountCents: 0, organiserChildRefund: null };
    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });

    expect(h.reissue).toHaveBeenCalledWith(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2_000, bookingModificationId: "mod_reduction", ownNoteExpected: false }),
      { store: tx },
    );
    expect(h.calls).toEqual(["reissue", "note"]);
  });

  it.each([
    ["a refund left after the ask, against an issued invoice", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 1_000, organiserChildRefund: null }, true],
    ["nothing left after the ask", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 0, organiserChildRefund: null }, false],
    ["an organiser's card refund, whose note comes later", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 1_000, organiserChildRefund: { amountCents: 1_000 } }, false],
  ])("MUTATION (round 7): records whether the edit's own note is expected - %s", async (_label, figures, expected) => {
    const settled = { additionalAsk: NO_ASK, unpaidAskBilledOffsetCents: 2_000, ...figures };
    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownNoteExpected: expected }), { store: tx });
  });

  it("an edit with no billed offset makes only its re-issue durable", async () => {
    const settled = { additionalAsk: NO_ASK, hasIssuedXeroInvoice: true, unpaidAskBilledOffsetCents: 0, xeroRefundAmountCents: 0, organiserChildRefund: null };
    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });

    expect(h.calls).toEqual(["reissue"]);
  });
});

/**
 * #4049: the edit's history row records the SAME answer its billed-offset
 * note's payload carries, so the repair pass reads the edit's rule rather than
 * recomputing a broader one. The two cases where no own note is ever raised -
 * a reduction settled by giving back applied credit with nothing captured
 * (the Xero leg returns nothing: `xeroRefundAmountCents` is 0), and an
 * organiser's card refund - record false.
 */
describe("the edit's history records whether its own note is expected (#4049)", () => {
  const offset = { ...NO_UNPAID_ASK_SETTLEMENT, unpaidAskOffsetCents: 2_000, unpaidAskBilledOffsetCents: 2_000, foldedReissuedAsks: NO_FOLDED_REISSUED_ASKS };

  it.each([
    ["a refund left after the ask, against an issued invoice", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 1_000, organiserChildRefund: null }, true],
    ["settled by giving back applied credit, nothing captured", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 0, organiserChildRefund: null }, false],
    ["an organiser's card refund, whose note comes later", { hasIssuedXeroInvoice: true, xeroRefundAmountCents: 1_000, organiserChildRefund: { amountCents: 1_000 } }, false],
    ["no issued primary invoice", { hasIssuedXeroInvoice: false, xeroRefundAmountCents: 1_000, organiserChildRefund: null }, false],
  ])("MUTATION: %s", async (_label, figures, expected) => {
    const settled = { ...offset, ...figures, additionalAsk: NO_ASK };
    const history = unpaidAskOffsetHistory(settled);
    expect(recordedBilledOffsetOwnNoteExpected(history)).toBe(expected);

    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownNoteExpected: expected }), { store: tx });
  });

  it("is recorded only beside a billed offset - no note, no answer", () => {
    const history = unpaidAskOffsetHistory({ ...offset, unpaidAskBilledOffsetCents: 0, hasIssuedXeroInvoice: true, xeroRefundAmountCents: 1_000 });
    expect(history).not.toHaveProperty("unpaidAskBilledOffsetOwnNoteExpected");
    expect(recordedBilledOffsetOwnNoteExpected(history)).toBeNull();
  });

  it("a history row written before #4049 records no answer (null), and only a boolean is an answer", () => {
    expect(recordedBilledOffsetOwnNoteExpected({ unpaidAskBilledOffsetCents: 2_000 })).toBeNull();
    expect(recordedBilledOffsetOwnNoteExpected({ unpaidAskBilledOffsetOwnNoteExpected: "true" })).toBeNull();
    expect(recordedBilledOffsetOwnNoteExpected(null)).toBeNull();
  });
});
