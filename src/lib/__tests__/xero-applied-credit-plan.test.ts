import { describe, expect, it } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  fillLotsInOrder,
  freeCreditLots,
  planAppliedCreditAllocation,
  type AppliedCreditLot,
} from "@/lib/xero-applied-credit-plan";

type CreditLotRow = Parameters<typeof freeCreditLots>[0][number];

/**
 * #4220: the engine's free-credit arithmetic and the planner's fill, each one pure
 * function the engine and the early warning share (`INV-SSOT`).
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

describe("the planner is its fill, refused on a shortfall (#4220)", () => {
  /** A small deterministic generator, so a failure names a reproducible seed. */
  function random(seed: number) {
    let state = seed >>> 0;
    return (max: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % (max + 1);
    };
  }
  const types = ["CANCELLATION_REFUND", "ADMIN_ADJUSTMENT"] as const;

  it.each(Array.from({ length: 200 }, (_, seed) => seed))("matches fillLotsInOrder for generated lots and amounts (seed %i)", (seed) => {
    const next = random(seed);
    const lots: AppliedCreditLot[] = Array.from({ length: next(6) }, (_, index) => ({
      memberCreditId: `lot_${index}`,
      creditType: types[next(1)]!,
      xeroCreditNoteId: next(2) === 0 ? null : `note_${index}`,
      // Zero and negative free credit too: the fill skips them, as the planner always did.
      remainingCents: next(10_000) - 500,
    }));
    const free = lots.reduce((sum, l) => sum + Math.max(0, l.remainingCents), 0);
    const applied = next(free + 2_000);
    const { slices, outstanding } = fillLotsInOrder(lots, applied);
    // The fill's own contract, independent of the planner that wraps it: positive slices, in
    // the lots' order, each within its lot, covering all it can and nothing more.
    expect(slices.every((slice) => slice.amountCents > 0 && slice.amountCents <= slice.lot.remainingCents)).toBe(true);
    expect(slices.map((slice) => lots.indexOf(slice.lot))).toEqual([...slices.map((slice) => lots.indexOf(slice.lot))].sort((x, y) => x - y));
    expect(slices.reduce((sum, slice) => sum + slice.amountCents, 0)).toBe(Math.min(applied, free));
    expect(outstanding).toBe(Math.max(0, applied - free));
    // Every lot before the last one used is used up.
    const last = slices.at(-1);
    for (const slice of slices.slice(0, -1)) expect(slice.amountCents).toBe(slice.lot.remainingCents);
    if (last && outstanding === 0) expect(last.amountCents).toBeLessThanOrEqual(last.lot.remainingCents);
    if (outstanding > 0) {
      expect(() => planAppliedCreditAllocation(lots, applied, CLUB_FORMAT_TEST)).toThrow(/member-credit ledger inconsistency/);
      return;
    }
    const plan = planAppliedCreditAllocation(lots, applied, CLUB_FORMAT_TEST);
    expect(plan.noteAllocations).toEqual(
      slices.filter((s) => s.lot.xeroCreditNoteId).map((s) => ({ memberCreditId: s.lot.memberCreditId, xeroCreditNoteId: s.lot.xeroCreditNoteId, amountCents: s.amountCents })),
    );
    expect(plan.mintSlices).toEqual(
      slices.filter((s) => !s.lot.xeroCreditNoteId).map((s) => ({ memberCreditId: s.lot.memberCreditId, creditType: s.lot.creditType, amountCents: s.amountCents })),
    );
    expect(plan.coveredCents).toBe(applied);
  });

  it("reports a shortfall as outstanding where the planner refuses, with the same message as before", () => {
    const lots: AppliedCreditLot[] = [{ memberCreditId: "a", creditType: "CANCELLATION_REFUND", xeroCreditNoteId: "NA", remainingCents: 4_000 }];
    expect(fillLotsInOrder(lots, 5_000)).toEqual({ slices: [{ lot: lots[0], amountCents: 4_000 }], outstanding: 1_000 });
    expect(() => planAppliedCreditAllocation(lots, 5_000, CLUB_FORMAT_TEST)).toThrow(
      "Applied credit $50.00 exceeds available credit-lot remaining by $10.00 — member-credit ledger inconsistency",
    );
  });
});
