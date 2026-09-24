/**
 * Which settlement lines a payment's rows imply (#3581): posting what is
 * missing, reversing what no longer holds, and nothing twice.
 */
import { describe, expect, it } from "vitest";
import {
  planSettlementLines,
  type PostedSettlementLine,
  type SettlementPlanInput,
} from "@/lib/booking-ledger-settlement-posting";

function input(overrides: Partial<SettlementPlanInput> = {}): SettlementPlanInput {
  return {
    bookingId: "b1",
    lodgeId: "l1",
    manuallySettled: false,
    manualActorMemberId: null,
    transactions: [],
    refunds: [],
    postedLines: [],
    ...overrides,
  };
}

const card = (id: string, amountCents = 10_000, status = "SUCCEEDED" as const) => ({
  id,
  source: "STRIPE" as const,
  status,
  amountCents,
});
const bank = (id: string, amountCents = 10_000, status: "SUCCEEDED" | "FAILED" | "PENDING" = "SUCCEEDED") => ({
  id,
  source: "INTERNET_BANKING" as const,
  status,
  amountCents,
});

function posted(overrides: Partial<PostedSettlementLine> & Pick<PostedSettlementLine, "id" | "postingKey">): PostedSettlementLine {
  return {
    reversesLineId: null,
    kind: "CASH_RECORDED",
    sign: 1,
    quantity: 1,
    unitCents: 10_000,
    anchorKind: "PAYMENT_TRANSACTION",
    anchorId: "t1",
    settlementMethod: "CASH",
    narration: "Payment recorded by an officer",
    ...overrides,
  };
}

describe("planSettlementLines — what a capture posts", () => {
  it("posts a card capture as CARD_CAPTURE by card, anchored and keyed on its transaction", () => {
    const [line] = planSettlementLines(input({ transactions: [card("t1")] })).postings;
    expect(line).toMatchObject({
      side: "SETTLEMENT",
      kind: "CARD_CAPTURE",
      settlementMethod: "CARD",
      sign: 1,
      quantity: 1,
      unitCents: 10_000,
      anchorKind: "PAYMENT_TRANSACTION",
      anchorId: "t1",
      postingKey: "capture:t1",
      postedByMemberId: null,
    });
  });

  it("posts an Internet Banking receipt as BANK_RECEIPT", () => {
    const [line] = planSettlementLines(input({ transactions: [bank("t1")] })).postings;
    expect(line).toMatchObject({ kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING" });
  });

  it("posts a manually settled payment's row as CASH_RECORDED, naming the officer (INV-PAY-001)", () => {
    const [line] = planSettlementLines(
      input({ manuallySettled: true, manualActorMemberId: "officer-1", transactions: [bank("t1")] }),
    ).postings;
    expect(line).toMatchObject({ kind: "CASH_RECORDED", settlementMethod: "CASH", postedByMemberId: "officer-1" });
  });

  it("never names an officer on a card capture, even on a manually settled payment", () => {
    const [line] = planSettlementLines(
      input({ manuallySettled: true, manualActorMemberId: "officer-1", transactions: [card("t1")] }),
    ).postings;
    expect(line).toMatchObject({ kind: "CARD_CAPTURE", postedByMemberId: null });
  });

  it("posts nothing for a row that has not captured money, or captured nothing", () => {
    const plan = planSettlementLines(
      input({ transactions: [bank("pending", 10_000, "PENDING"), card("zero", 0)] }),
    );
    expect(plan.postings).toEqual([]);
  });

  it("keeps a refunded transaction captured — its capture happened; the refund is its own line", () => {
    const plan = planSettlementLines(
      input({
        transactions: [card("t1", 10_000, "REFUNDED" as never)],
        postedLines: [posted({ id: "L1", postingKey: "capture:t1", kind: "CARD_CAPTURE", settlementMethod: "CARD" })],
      }),
    );
    expect(plan.postings).toEqual([]);
  });
});

describe("planSettlementLines — idempotent by construction", () => {
  it("posts nothing for a source whose line is already on the ledger", () => {
    const plan = planSettlementLines(
      input({
        transactions: [bank("t1")],
        postedLines: [posted({ id: "L1", postingKey: "capture:t1", kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING" })],
      }),
    );
    expect(plan.postings).toEqual([]);
    expect(plan.amountDrift).toEqual([]);
  });

  it("reports, but does not correct, a posted line whose source amount has since changed", () => {
    // A line is never edited, and re-posting under the same key is a no-op by
    // design, so the only honest thing is to surface it (C4 counts it).
    const plan = planSettlementLines(
      input({
        transactions: [bank("t1", 12_000)],
        postedLines: [posted({ id: "L1", postingKey: "capture:t1", kind: "BANK_RECEIPT" })],
      }),
    );
    expect(plan.postings).toEqual([]);
    expect(plan.amountDrift).toEqual([{ postingKey: "capture:t1", postedCents: 10_000, sourceCents: 12_000 }]);
  });
});

describe("planSettlementLines — a source that stops holding is reversed, never edited", () => {
  it("reverses the cash line when a mark-paid reversal flips its row to FAILED (INV-PAY-045)", () => {
    const plan = planSettlementLines(
      input({
        manuallySettled: false, // the reversal cleared the provenance
        transactions: [bank("t1", 10_000, "FAILED")],
        postedLines: [posted({ id: "L1", postingKey: "capture:t1", postedByMemberId: undefined } as never)],
      }),
    );
    expect(plan.postings).toHaveLength(1);
    expect(plan.postings[0]).toMatchObject({
      kind: "CASH_RECORDED",
      // Copied from the line, NOT re-derived: the provenance now says "not
      // manual", and re-deriving would reverse a cash line as a bank receipt.
      settlementMethod: "CASH",
      sign: -1,
      quantity: 1,
      unitCents: 10_000,
      reversesLineId: "L1",
      postingKey: "reversal:L1",
      anchorKind: "PAYMENT_TRANSACTION",
      anchorId: "t1",
    });
  });

  it("posts nothing more for a line that is already reversed", () => {
    const plan = planSettlementLines(
      input({
        transactions: [bank("t1", 10_000, "FAILED")],
        postedLines: [
          posted({ id: "L1", postingKey: "capture:t1" }),
          posted({ id: "R1", postingKey: "reversal:L1", reversesLineId: "L1", sign: -1 }),
        ],
      }),
    );
    expect(plan.postings).toEqual([]);
  });

  it("reverses nothing for a source that never had a line", () => {
    expect(planSettlementLines(input({ transactions: [bank("t1", 10_000, "FAILED")] })).postings).toEqual([]);
  });

  it("a fresh mark-paid after a reversal posts its OWN line (the settle mints a new row)", () => {
    const plan = planSettlementLines(
      input({
        manuallySettled: true,
        manualActorMemberId: "officer-2",
        transactions: [bank("t1", 10_000, "FAILED"), bank("t2", 10_000, "SUCCEEDED")],
        postedLines: [
          posted({ id: "L1", postingKey: "capture:t1" }),
          posted({ id: "R1", postingKey: "reversal:L1", reversesLineId: "L1", sign: -1 }),
        ],
      }),
    );
    expect(plan.postings.map((p) => p.postingKey)).toEqual(["capture:t2"]);
  });
});

describe("planSettlementLines — a source can hold, stop, and hold again (review of #3604)", () => {
  /*
    A mark-paid is reversed (its row flips to FAILED, the cash line is
    reversed), an invoice is minted onto that same row, and the member pays
    through Xero — the inbound path revives the FAILED row to SUCCEEDED. The
    first cut saw `capture:t1` already posted and posted nothing: the real
    receipt was silently lost. The chain fixes it.
  */
  const cash = posted({ id: "L1", postingKey: "capture:t1" });
  const reversal = posted({ id: "R1", postingKey: "reversal:L1", reversesLineId: "L1", sign: -1 });

  it("posts the revived source afresh, keyed off the reversal that retired its predecessor", () => {
    const plan = planSettlementLines(
      input({ transactions: [bank("t1", 10_000, "SUCCEEDED")], postedLines: [cash, reversal] }),
    );
    expect(plan.postings).toHaveLength(1);
    // Provenance was cleared by the reversal, so this is a genuine receipt.
    expect(plan.postings[0]).toMatchObject({
      kind: "BANK_RECEIPT",
      sign: 1,
      unitCents: 10_000,
      postingKey: "capture:t1:after:R1",
      anchorId: "t1",
    });
  });

  it("posts nothing more once the revived line is there — a replay finds its own key", () => {
    const revived = posted({ id: "L2", postingKey: "capture:t1:after:R1", kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING" });
    const plan = planSettlementLines(
      input({ transactions: [bank("t1", 10_000, "SUCCEEDED")], postedLines: [cash, reversal, revived] }),
    );
    expect(plan.postings).toEqual([]);
  });

  it("reverses the LIVE line of the chain, never one already reversed", () => {
    const revived = posted({ id: "L2", postingKey: "capture:t1:after:R1", kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING" });
    const plan = planSettlementLines(
      input({ transactions: [bank("t1", 10_000, "FAILED")], postedLines: [cash, reversal, revived] }),
    );
    expect(plan.postings).toHaveLength(1);
    expect(plan.postings[0]).toMatchObject({ reversesLineId: "L2", postingKey: "reversal:L2", kind: "BANK_RECEIPT", sign: -1 });
  });

  it("nets to exactly what is captured now, however many times the source flipped", () => {
    const revived = posted({ id: "L2", postingKey: "capture:t1:after:R1", kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING" });
    const lines = [cash, reversal, revived];
    const settled = lines.reduce((sum, line) => sum + line.sign * line.unitCents * line.quantity, 0);
    expect(settled).toBe(10_000);
  });
});

describe("planSettlementLines — refunds", () => {
  it("posts a recorded card refund as CARD_REFUND, negative, keyed on the refund", () => {
    const [line] = planSettlementLines(
      input({ refunds: [{ id: "r1", status: "succeeded", amountCents: 2_500 }] }),
    ).postings;
    expect(line).toMatchObject({
      kind: "CARD_REFUND",
      settlementMethod: "CARD",
      sign: -1,
      unitCents: 2_500,
      anchorKind: "PAYMENT_REFUND",
      anchorId: "r1",
      postingKey: "refund:r1",
    });
  });

  it("counts a pending refund as recorded, exactly as the mirror does, and not a failed or canceled one", () => {
    // The mirror's own predicate, imported: a refund is excluded only when it
    // failed or was canceled (`isRecordedRefundStatus`).
    const plan = planSettlementLines(
      input({
        refunds: [
          { id: "pending", status: "pending", amountCents: 100 },
          { id: "failed", status: "failed", amountCents: 100 },
          { id: "canceled", status: "canceled", amountCents: 100 },
        ],
      }),
    );
    expect(plan.postings.map((p) => p.postingKey)).toEqual(["refund:pending"]);
  });

  it("reverses a refund line when the refund later fails", () => {
    const plan = planSettlementLines(
      input({
        refunds: [{ id: "r1", status: "failed", amountCents: 2_500 }],
        postedLines: [
          posted({
            id: "F1",
            postingKey: "refund:r1",
            kind: "CARD_REFUND",
            sign: -1,
            unitCents: 2_500,
            anchorKind: "PAYMENT_REFUND",
            anchorId: "r1",
            settlementMethod: "CARD",
            narration: "Card refund",
          }),
        ],
      }),
    );
    expect(plan.postings[0]).toMatchObject({ kind: "CARD_REFUND", sign: 1, reversesLineId: "F1", postingKey: "reversal:F1" });
  });
});

describe("planSettlementLines — the sums the census will check", () => {
  it("settles to captured minus refunded, which is the mirror's own arithmetic", () => {
    const plan = planSettlementLines(
      input({
        transactions: [card("t1", 10_000), bank("t2", 5_000), bank("t3", 999, "PENDING")],
        refunds: [{ id: "r1", status: "succeeded", amountCents: 2_500 }],
      }),
    );
    const settled = plan.postings.reduce((sum, p) => sum + p.sign * p.unitCents * p.quantity, 0);
    expect(settled).toBe(10_000 + 5_000 - 2_500);
  });
});
