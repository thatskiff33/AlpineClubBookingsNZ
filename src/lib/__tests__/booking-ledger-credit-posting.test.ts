/**
 * Which lines a booking's account-credit rows and a hand-back imply (#3599).
 * Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";

import { ledgerLineAmountCents } from "@/lib/booking-ledger-write";
import { planCreditLines, planHandBackLine, type BookingCreditRow } from "@/lib/booking-ledger-credit-posting";

const base = { bookingId: "b1", lodgeId: "l1" };
const row = (over: Partial<BookingCreditRow> & Pick<BookingCreditRow, "id" | "type" | "amountCents">): BookingCreditRow => ({
  restoredFromBookingId: null,
  ...over,
});

describe("planCreditLines", () => {
  it("posts credit consumed as CREDIT_APPLIED, settling the booking by the negation of the row", () => {
    const { postings } = planCreditLines({
      ...base,
      credits: [row({ id: "c1", type: "BOOKING_APPLIED", amountCents: -2_275 })],
      postedLines: [],
    });
    expect(postings).toEqual([
      expect.objectContaining({
        side: "SETTLEMENT",
        kind: "CREDIT_APPLIED",
        sign: 1,
        quantity: 1,
        unitCents: 2_275,
        settlementMethod: "ACCOUNT_CREDIT",
        anchorKind: "MEMBER_CREDIT",
        anchorId: "c1",
        postingKey: "credit:c1",
      }),
    ]);
  });

  it("posts a clamp give-back (a POSITIVE applied row) as a negative CREDIT_APPLIED, so the lines net as the rows do", () => {
    const { postings } = planCreditLines({
      ...base,
      credits: [
        row({ id: "c1", type: "BOOKING_APPLIED", amountCents: -4_000 }),
        row({ id: "c2", type: "BOOKING_APPLIED", amountCents: 1_000 }),
      ],
      postedLines: [],
    });
    expect(postings.map((p) => [p.kind, ledgerLineAmountCents(p)])).toEqual([
      ["CREDIT_APPLIED", 4_000],
      ["CREDIT_APPLIED", -1_000],
    ]);
    // The parity C4 checks: Σ CREDIT_APPLIED == deriveBookingAppliedCreditCents.
    expect(postings.reduce((sum, p) => sum + ledgerLineAmountCents(p), 0)).toBe(3_000);
  });

  it("posts credit minted on a cancellation or a reduction as CREDIT_ISSUED against its own row", () => {
    const { postings } = planCreditLines({
      ...base,
      credits: [
        row({ id: "c1", type: "CANCELLATION_REFUND", amountCents: 5_000 }),
        row({ id: "c2", type: "BOOKING_MODIFICATION_REFUND", amountCents: 1_250 }),
      ],
      postedLines: [],
    });
    expect(postings.map((p) => [p.kind, ledgerLineAmountCents(p), p.anchorKind, p.anchorId])).toEqual([
      ["CREDIT_ISSUED", -5_000, "MEMBER_CREDIT", "c1"],
      ["CREDIT_ISSUED", -1_250, "MEMBER_CREDIT", "c2"],
    ]);
  });

  it("posts a restore for EXACTLY what was restored — never a reversal of the applied line — anchored on the cancellation", () => {
    // A tiered restore gives back less than was applied (#1164). A reversal
    // would copy the applied line in full and over-state it.
    const { postings } = planCreditLines({
      ...base,
      credits: [
        row({ id: "c1", type: "BOOKING_APPLIED", amountCents: -4_000 }),
        row({ id: "r1", type: "CANCELLATION_REFUND", amountCents: 2_000, restoredFromBookingId: "b1" }),
      ],
      postedLines: [],
    });
    const restore = postings.find((p) => p.postingKey === "credit:r1");
    expect(restore).toMatchObject({ kind: "CREDIT_ISSUED", sign: -1, unitCents: 2_000, anchorKind: "CANCELLATION", anchorId: "b1" });
    expect(restore?.reversesLineId).toBeUndefined();
    expect(postings.every((p) => p.reversesLineId == null)).toBe(true);
  });

  it("posts nothing for a row whose key is already on the ledger, and names drift rather than correcting it", () => {
    const { postings, amountDrift } = planCreditLines({
      ...base,
      credits: [
        row({ id: "c1", type: "BOOKING_APPLIED", amountCents: -2_000 }),
        row({ id: "c2", type: "CANCELLATION_REFUND", amountCents: 700 }),
      ],
      postedLines: [
        { postingKey: "credit:c1", amountCents: 2_000 },
        { postingKey: "credit:c2", amountCents: -600 },
      ],
    });
    expect(postings).toEqual([]);
    expect(amountDrift).toEqual([{ postingKey: "credit:c2", postedCents: -600, sourceCents: -700 }]);
  });

  it("posts nothing for a $0 row — there is no direction to give it", () => {
    const { postings } = planCreditLines({
      ...base,
      credits: [row({ id: "c1", type: "BOOKING_APPLIED", amountCents: 0 })],
      postedLines: [],
    });
    expect(postings).toEqual([]);
  });

  it("refuses an admin adjustment, which names no booking — in pure code, where refusing is safe", () => {
    expect(() =>
      planCreditLines({
        ...base,
        credits: [row({ id: "a1", type: "ADMIN_ADJUSTMENT", amountCents: 500 })],
        postedLines: [],
      }),
    ).toThrow(/INV-MONEY-035/);
  });
});

describe("planHandBackLine", () => {
  it("posts one negative BANK_REFUND, keyed by the task and naming the officer", () => {
    const posting = planHandBackLine({
      ...base,
      manualRefundTaskId: "t1",
      amountCents: 3_500,
      settlementMethod: "INTERNET_BANKING",
      officerMemberId: "officer-1",
    });
    expect(posting).toMatchObject({
      side: "SETTLEMENT",
      kind: "BANK_REFUND",
      sign: -1,
      unitCents: 3_500,
      settlementMethod: "INTERNET_BANKING",
      anchorKind: "REVIEW_TASK",
      anchorId: "t1",
      postedByMemberId: "officer-1",
      postingKey: "handback:t1",
    });
  });
});
