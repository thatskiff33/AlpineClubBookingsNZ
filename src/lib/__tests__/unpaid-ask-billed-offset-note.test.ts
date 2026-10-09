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

const tx = { marker: "the edit's transaction" } as unknown as Parameters<typeof queueUnpaidAskBilledOffsetNote>[0];
const NO_ASK = NO_ADDITIONAL_ASK;

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
});

describe("queueUnpaidAskBilledOffsetNote", () => {
  it("MUTATION: queues exactly the billed offset on the reducing edit, scoped, worded as an invoice correction, in the edit's transaction", async () => {
    await expect(
      queueUnpaidAskBilledOffsetNote(tx, { bookingId: "booking_1", bookingModificationId: "mod_reduction", unpaidAskBilledOffsetCents: 2_000 }),
    ).resolves.toBe("op_billed_offset");

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(
      {
        bookingId: "booking_1",
        refundAmountCents: 2_000,
        bookingModificationId: "mod_reduction",
        noteWording: "invoice-correction",
        reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
      },
      { store: tx },
    );
  });

  it("MUTATION: queues nothing where Xero billed none of the offset (the increase's own invoice was retired instead, or no primary invoice)", async () => {
    await expect(
      queueUnpaidAskBilledOffsetNote(tx, { bookingId: "booking_1", bookingModificationId: "mod_reduction", unpaidAskBilledOffsetCents: 0 }),
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
    const settled = { additionalAsk: NO_ASK, hasIssuedXeroInvoice: true, unpaidAskBilledOffsetCents: 2_000 };
    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });

    expect(h.reissue).toHaveBeenCalledWith(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ refundAmountCents: 2_000, bookingModificationId: "mod_reduction" }), { store: tx });
    expect(h.calls).toEqual(["reissue", "note"]);
  });

  it("an edit with no billed offset makes only its re-issue durable", async () => {
    const settled = { additionalAsk: NO_ASK, hasIssuedXeroInvoice: true, unpaidAskBilledOffsetCents: 0 };
    await queueReductionAskFollowUps(tx, { bookingId: "booking_1", paymentId: "payment_1", bookingModificationId: "mod_reduction", settled });

    expect(h.calls).toEqual(["reissue"]);
  });
});
