import { describe, expect, it } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  freeCreditLots,
  planAppliedCreditAllocation,
  plannedDrawFromLot,
  type AppliedCreditLot,
  type CreditLotRow,
} from "@/lib/xero-applied-credit-plan";

/**
 * #4220 (review S1): the engine's free-credit arithmetic, one pure function the
 * engine's loader and the early warning share, and the planner's fill in closed
 * form, checked against the planner itself.
 */

const lot = (id: string, amountCents: number, xeroCreditNoteId: string | null = null): CreditLotRow => ({ id, amountCents, type: "CANCELLATION_REFUND", xeroCreditNoteId });

describe("freeCreditLots (#4220)", () => {
  it("takes each lot's slices and its note's write-down, the write-down once per note, oldest lot first", () => {
    const free = freeCreditLots(
      [lot("a", 5_000, "N"), lot("b", 4_000, "N"), lot("c", 3_000), lot("d", 2_000, "M")],
      new Map([["a", 1_000], ["d", 2_000]]),
      new Map([["N", 6_000]]),
    );
    // a: 5,000 - 1,000 slices = 4,000, all of it written down; b: the other 2,000 of N's write-down.
    expect(free).toEqual([
      { memberCreditId: "b", creditType: "CANCELLATION_REFUND", xeroCreditNoteId: "N", remainingCents: 2_000 },
      { memberCreditId: "c", creditType: "CANCELLATION_REFUND", xeroCreditNoteId: null, remainingCents: 3_000 },
    ]);
  });

  it("does not change the write-down map it is given", () => {
    const writtenDown = new Map([["N", 6_000]]);
    freeCreditLots([lot("a", 5_000, "N")], new Map(), writtenDown);
    expect(writtenDown.get("N")).toBe(6_000);
  });
});

describe("plannedDrawFromLot agrees with the planner's fill (#4220)", () => {
  const lots: AppliedCreditLot[] = [
    { memberCreditId: "a", creditType: "CANCELLATION_REFUND", xeroCreditNoteId: "NA", remainingCents: 4_000 },
    { memberCreditId: "b", creditType: "ADMIN_ADJUSTMENT", xeroCreditNoteId: null, remainingCents: 1_500 },
    { memberCreditId: "c", creditType: "CANCELLATION_REFUND", xeroCreditNoteId: "NC", remainingCents: 6_000 },
  ];
  const total = lots.reduce((sum, l) => sum + l.remainingCents, 0);

  it.each([0, 1, 3_999, 4_000, 4_001, 5_500, 5_501, 9_000, total])("for %i cents applied", (applied) => {
    const plan = planAppliedCreditAllocation(lots, applied, CLUB_FORMAT_TEST);
    const planned = new Map<string, number>([
      ...plan.noteAllocations.map((na) => [na.memberCreditId, na.amountCents] as const),
      ...plan.mintSlices.map((ms) => [ms.memberCreditId, ms.amountCents] as const),
    ]);
    for (const l of lots) expect(plannedDrawFromLot(lots, applied, l.memberCreditId)).toBe(planned.get(l.memberCreditId) ?? 0);
  });

  it("gives what is free when more is applied than the lots hold, where the planner refuses", () => {
    expect(() => planAppliedCreditAllocation(lots, total + 1, CLUB_FORMAT_TEST)).toThrow();
    expect(plannedDrawFromLot(lots, total + 1, "c")).toBe(6_000);
    expect(plannedDrawFromLot(lots, total, "missing")).toBe(0);
  });
});
