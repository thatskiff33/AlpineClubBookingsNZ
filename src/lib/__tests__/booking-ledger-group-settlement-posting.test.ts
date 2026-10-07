/**
 * Which lines a group organiser's settlement posts on its children (#3854):
 * one share per child, summing exactly to what the settlement collected, and
 * the refund an organiser cancel's plan hands back.
 */
import { describe, expect, it } from "vitest";

import { ledgerLineAmountCents } from "@/lib/booking-ledger-write";
import {
  planGroupSettlementRefundLine,
  planGroupSettlementShareLines,
} from "@/lib/booking-ledger-group-settlement-posting";
import { groupSettlementRefundKey, groupSettlementShareKey } from "@/lib/booking-ledger-posting-keys";

const card = { id: "gs1", source: "STRIPE" as const, amountCents: 10_000 };
const bank = { id: "gs2", source: "INTERNET_BANKING" as const, amountCents: 10_000 };
const child = (bookingId: string, shareCents: number) => ({ bookingId, lodgeId: "l1", shareCents });
const sum = (postings: ReturnType<typeof planGroupSettlementShareLines>["postings"]) =>
  postings.reduce((total, posting) => total + ledgerLineAmountCents(posting), 0);

describe("planGroupSettlementShareLines", () => {
  it("posts one card capture per child, anchored on the settlement, and the shares sum exactly to it", () => {
    const plan = planGroupSettlementShareLines({
      settlement: card,
      children: [child("c1", 4_500), child("c2", 5_500)],
    });
    expect(plan.reconciles).toBe(true);
    expect(sum(plan.postings)).toBe(10_000);
    expect(plan.postings).toEqual([
      expect.objectContaining({
        bookingId: "c1",
        side: "SETTLEMENT",
        kind: "CARD_CAPTURE",
        settlementMethod: "CARD",
        sign: 1,
        quantity: 1,
        unitCents: 4_500,
        anchorKind: "GROUP_SETTLEMENT",
        anchorId: "gs1",
        postingKey: groupSettlementShareKey("gs1", "c1"),
      }),
      expect.objectContaining({ bookingId: "c2", unitCents: 5_500, postingKey: groupSettlementShareKey("gs1", "c2") }),
    ]);
  });

  it("posts an Internet Banking settlement as bank receipts", () => {
    const plan = planGroupSettlementShareLines({ settlement: bank, children: [child("c1", 10_000)] });
    expect(plan.postings).toEqual([
      expect.objectContaining({ kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING", anchorId: "gs2" }),
    ]);
  });

  it("never divides the total: odd-cent prices post as they are, and a one-cent gap posts nothing", () => {
    const odd = planGroupSettlementShareLines({
      settlement: card,
      children: [child("c1", 3_333), child("c2", 3_333), child("c3", 3_334)],
    });
    expect(odd.postings.map((posting) => posting.unitCents)).toEqual([3_333, 3_333, 3_334]);
    expect(sum(odd.postings)).toBe(10_000);

    const short = planGroupSettlementShareLines({
      settlement: card,
      children: [child("c1", 3_333), child("c2", 3_333), child("c3", 3_333)],
    });
    expect(short).toEqual({ postings: [], reconciles: false, totalShareCents: 9_999 });
  });

  it("a child cancelled before the settlement is on no bill: its price still in the total posts nothing; a re-sized total posts the rest", () => {
    // c2 cancelled while the bill was open, so it is not among the children paid.
    const stale = planGroupSettlementShareLines({
      settlement: card,
      children: [child("c1", 4_500), child("c3", 2_000)],
    });
    expect(stale.reconciles).toBe(false);
    expect(stale.postings).toEqual([]);

    const resized = planGroupSettlementShareLines({
      settlement: { ...card, amountCents: 6_500 },
      children: [child("c1", 4_500), child("c3", 2_000)],
    });
    expect(resized.postings.map((posting) => posting.bookingId)).toEqual(["c1", "c3"]);
    expect(sum(resized.postings)).toBe(6_500);
  });

  it("a $0 child moves no money and posts nothing, while the rest still post", () => {
    const plan = planGroupSettlementShareLines({
      settlement: { ...card, amountCents: 4_500 },
      children: [child("c1", 4_500), child("c2", 0)],
    });
    expect(plan.reconciles).toBe(true);
    expect(plan.postings.map((posting) => posting.bookingId)).toEqual(["c1"]);
  });

  it("is deterministic, so a replay or the back-post mints the same keys", () => {
    const input = { settlement: card, children: [child("c1", 4_500), child("c2", 5_500)] };
    expect(planGroupSettlementShareLines(input)).toEqual(planGroupSettlementShareLines(input));
  });
});

describe("planGroupSettlementRefundLine", () => {
  it("posts a card plan's refund as a negative card refund under the settlement", () => {
    expect(
      planGroupSettlementRefundLine({ settlement: card, bookingId: "c1", lodgeId: "l1", refundCents: 2_250 }),
    ).toEqual(
      expect.objectContaining({
        side: "SETTLEMENT",
        kind: "CARD_REFUND",
        settlementMethod: "CARD",
        sign: -1,
        unitCents: 2_250,
        anchorKind: "GROUP_SETTLEMENT",
        anchorId: "gs1",
        postingKey: groupSettlementRefundKey("gs1", "c1"),
      }),
    );
  });

  it("posts an Internet Banking plan's refund as a bank refund, and nothing for nothing", () => {
    expect(
      planGroupSettlementRefundLine({ settlement: bank, bookingId: "c1", lodgeId: "l1", refundCents: 100 }),
    ).toEqual(expect.objectContaining({ kind: "BANK_REFUND", settlementMethod: "INTERNET_BANKING", sign: -1 }));
    expect(planGroupSettlementRefundLine({ settlement: bank, bookingId: "c1", lodgeId: "l1", refundCents: 0 })).toBeNull();
  });

  it("keys a share and a refund apart, so both post on one child", () => {
    expect(groupSettlementShareKey("gs1", "c1")).not.toBe(groupSettlementRefundKey("gs1", "c1"));
  });
});
