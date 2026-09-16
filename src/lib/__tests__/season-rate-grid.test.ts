/**
 * The nightly-rate grid, and what copying a season carries (#2938, #2933).
 *
 * The rule under nearly every case here is that ABSENCE AND ZERO ARE DIFFERENT
 * AMOUNTS. A cell with no rate has no `MembershipTypeSeasonRate` row: the
 * pricing engine refuses a booking that needs it, and the Hut Fees screen warns
 * about it in advance. A cell holding `0` has a row saying $0.00: the engine
 * reads it and the guest is charged nothing. Before #2933 the form seeded every
 * blank cell to zero and sent all of them, so pressing Save on the season the
 * warning had just named silenced the warning by housing those guests free.
 *
 * The copy action is where that rule could most easily be lost a second time,
 * in bulk, across a whole new season — so `copySeasonConfiguration` gets the
 * absent case, the zero case, and a frozen source proving it reads and never
 * writes.
 */

import { describe, expect, it } from "vitest";

import {
  FLAT_RATE_CELL_KEY,
  amountFieldValue,
  cellsForRateType,
  copySeasonConfiguration,
  emptyRateCells,
  parseRateCellKey,
  rateCellKey,
  rateCellsFromSeason,
  rateRowsFromCells,
  resolvedTierRate,
  type RateGridTier,
  type RateGridType,
  type SeasonRateRow,
} from "@/lib/season-rate-grid";

const FULL: RateGridType = { id: "type-full", ageGroupsApply: true };
const NON_MEMBER: RateGridType = { id: "type-non-member", ageGroupsApply: false };
const TYPES = [FULL, NON_MEMBER];
const TIERS: RateGridTier[] = [{ tier: "CHILD" }, { tier: "ADULT" }];

describe("grid keys", () => {
  it("round-trips a tier cell and a flat cell", () => {
    expect(parseRateCellKey(rateCellKey(FULL.id, "ADULT"))).toEqual({
      membershipTypeId: FULL.id,
      ageTier: "ADULT",
    });
    expect(parseRateCellKey(rateCellKey(NON_MEMBER.id, FLAT_RATE_CELL_KEY))).toEqual({
      membershipTypeId: NON_MEMBER.id,
      ageTier: null,
    });
  });

  it("gives an age-keyed type one cell per tier and a flat type one cell", () => {
    expect(cellsForRateType(FULL, TIERS)).toEqual(["CHILD", "ADULT"]);
    expect(cellsForRateType(NON_MEMBER, TIERS)).toEqual([FLAT_RATE_CELL_KEY]);
  });
});

describe("emptyRateCells", () => {
  it("seeds every cell ABSENT, never zero", () => {
    // The single character this whole module exists to protect. Seeded to `0`,
    // a form that sends every cell writes a real $0.00 nightly rate for each
    // blank box — and because the payload is replace-all, that is how the
    // missing-rates warning used to be silenced by charging guests nothing.
    const cells = emptyRateCells(TYPES, TIERS);
    expect(Object.values(cells)).toEqual([null, null, null]);
    expect(Object.values(cells)).not.toContain(0);
  });
});

describe("rateCellsFromSeason", () => {
  it("reads stored cents onto the grid and leaves unpriced cells absent", () => {
    const cells = rateCellsFromSeason(
      [
        { membershipTypeId: FULL.id, ageTier: "ADULT", pricePerNightCents: 4500 },
        { membershipTypeId: NON_MEMBER.id, ageTier: null, pricePerNightCents: 6500 },
      ],
      TYPES,
      TIERS,
    );
    expect(cells[rateCellKey(FULL.id, "ADULT")]).toBe(4500);
    expect(cells[rateCellKey(NON_MEMBER.id, FLAT_RATE_CELL_KEY)]).toBe(6500);
    expect(cells[rateCellKey(FULL.id, "CHILD")]).toBeNull();
  });

  it("keeps a stored zero as a zero, not as an absence", () => {
    const cells = rateCellsFromSeason(
      [{ membershipTypeId: FULL.id, ageTier: "CHILD", pricePerNightCents: 0 }],
      TYPES,
      TIERS,
    );
    expect(cells[rateCellKey(FULL.id, "CHILD")]).toBe(0);
  });

  it("keeps a row the grid has no box for, rather than dropping it", () => {
    // A tier the club retired, or a type that no longer carries its own rates.
    // Dropping it reads as tidier and would make saving the form DELETE stored
    // rate rows the officer was never shown and never asked about.
    const cells = rateCellsFromSeason(
      [{ membershipTypeId: FULL.id, ageTier: "INFANT", pricePerNightCents: 1000 }],
      TYPES,
      TIERS,
    );
    expect(cells[rateCellKey(FULL.id, "INFANT")]).toBe(1000);
  });
});

describe("rateRowsFromCells", () => {
  it("does NOT send a cell with no rate", () => {
    const rows = rateRowsFromCells({
      [rateCellKey(FULL.id, "ADULT")]: 4500,
      [rateCellKey(FULL.id, "CHILD")]: null,
    });
    expect(rows).toEqual([
      { membershipTypeId: FULL.id, ageTier: "ADULT", pricePerNightCents: 4500 },
    ]);
  });

  it("DOES send a cell somebody set to zero", () => {
    // A rate typed as 0.00 is real configuration, and the club that means it
    // keeps it. Only an absence is withheld.
    const rows = rateRowsFromCells({
      [rateCellKey(FULL.id, "CHILD")]: 0,
    });
    expect(rows).toEqual([
      { membershipTypeId: FULL.id, ageTier: "CHILD", pricePerNightCents: 0 },
    ]);
  });

  it("sends a flat cell with a null ageTier", () => {
    expect(
      rateRowsFromCells({ [rateCellKey(NON_MEMBER.id, FLAT_RATE_CELL_KEY)]: 6500 }),
    ).toEqual([
      { membershipTypeId: NON_MEMBER.id, ageTier: null, pricePerNightCents: 6500 },
    ]);
  });

  it("sends nothing at all for a grid with every cell empty", () => {
    expect(rateRowsFromCells(emptyRateCells(TYPES, TIERS))).toEqual([]);
  });
});

describe("amountFieldValue", () => {
  it("shows an empty box for no rate and 0.00 for a zero rate", () => {
    // These used to be the same empty box, which is what made "never had a row"
    // indistinguishable from "typed zero".
    expect(amountFieldValue(undefined, null)).toBe("");
    expect(amountFieldValue(undefined, 0)).toBe("0.00");
  });

  it("prefers what the admin typed over the stored cents", () => {
    expect(amountFieldValue("45.0", 4500)).toBe("45.0");
    expect(amountFieldValue("", 4500)).toBe("");
  });

  it("renders stored cents exactly, with no rounding of its own", () => {
    expect(amountFieldValue(undefined, 4500)).toBe("45.00");
    expect(amountFieldValue(undefined, 4505)).toBe("45.05");
    expect(amountFieldValue(undefined, 1)).toBe("0.01");
  });
});

describe("resolvedTierRate", () => {
  const rows: SeasonRateRow[] = [
    { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
    { membershipTypeId: FULL.id, ageTier: "CHILD", pricePerNightCents: 2000 },
  ];

  it("prefers the exact tier row", () => {
    expect(resolvedTierRate(rows, FULL.id, "CHILD")).toEqual({
      pricePerNightCents: 2000,
      fromFlatRate: false,
    });
  });

  it("falls back to the flat all-ages row, and says that it did", () => {
    expect(resolvedTierRate(rows, FULL.id, "ADULT")).toEqual({
      pricePerNightCents: 4500,
      fromFlatRate: true,
    });
  });

  it("answers null when the type has neither", () => {
    expect(resolvedTierRate(rows, NON_MEMBER.id, "ADULT")).toBeNull();
  });
});

describe("copySeasonConfiguration", () => {
  /** A source with one priced tier, one deliberate zero, and one hole. */
  function source() {
    return {
      type: "WINTER" as const,
      active: true,
      flatWholeLodgeNightCents: 60000,
      membershipTypeRates: [
        { membershipTypeId: FULL.id, ageTier: "ADULT" as const, pricePerNightCents: 4505 },
        { membershipTypeId: FULL.id, ageTier: "CHILD" as const, pricePerNightCents: 0 },
      ],
    };
  }

  it("carries every amount across as the exact integer cents stored", () => {
    // 4505 is deliberately not a round dollar: a copy that round-tripped an
    // amount through the box's displayed "45.05" and back would be the place
    // that loses the odd cent, and this is what refuses that route.
    const copy = copySeasonConfiguration(source(), TYPES, TIERS);
    expect(copy.rateCells[rateCellKey(FULL.id, "ADULT")]).toBe(4505);
    expect(copy.flatWholeLodgeNightCents).toBe(60000);
  });

  it("carries a deliberate $0.00 rate across as a zero", () => {
    const copy = copySeasonConfiguration(source(), TYPES, TIERS);
    expect(copy.rateCells[rateCellKey(FULL.id, "CHILD")]).toBe(0);
  });

  it("carries a HOLE across as a hole, and never as a zero row", () => {
    // The one that matters most. Non-Member has no rate on the source season —
    // the state the missing-rates panel warns about. Flattened to `0` here, the
    // copy would write a real $0.00 row for every non-member guest of the new
    // season, silence the warning, and do it on the screen whose job is to stop
    // exactly that.
    const copy = copySeasonConfiguration(source(), TYPES, TIERS);
    const flat = rateCellKey(NON_MEMBER.id, FLAT_RATE_CELL_KEY);
    expect(copy.rateCells[flat]).toBeNull();
    expect(rateRowsFromCells(copy.rateCells)).not.toContainEqual(
      expect.objectContaining({ membershipTypeId: NON_MEMBER.id }),
    );
  });

  it("carries the season's type, active flag and flat whole-lodge rate", () => {
    const copy = copySeasonConfiguration(
      { ...source(), type: "SUMMER", active: false },
      TYPES,
      TIERS,
    );
    expect(copy.type).toBe("SUMMER");
    expect(copy.active).toBe(false);
  });

  it("carries an ABSENT flat whole-lodge rate as absent", () => {
    // Same rule as a rate cell, for the building: `null` keeps whole-lodge
    // bookings priced per guest; `0` would let the officer give the lodge away.
    const copy = copySeasonConfiguration(
      { ...source(), flatWholeLodgeNightCents: null },
      TYPES,
      TIERS,
    );
    expect(copy.flatWholeLodgeNightCents).toBeNull();
  });

  it("carries NO identity — there is no field for an id, a name or a date", () => {
    // Asserted as a property of the returned object rather than of the type,
    // because the type alone is erased at runtime and a later `...source`
    // spread would satisfy it while carrying the identity through.
    const copy = copySeasonConfiguration(
      { ...source(), id: "season-1", name: "Winter 2026", startDate: "2026-06-01" } as ReturnType<
        typeof source
      >,
      TYPES,
      TIERS,
    );
    expect(Object.keys(copy).sort()).toEqual([
      "active",
      "flatWholeLodgeNightCents",
      "rateCells",
      "type",
    ]);
  });

  it("never mutates the season it copied", () => {
    // The issue's contract in one assertion: the source season is never
    // mutated. A deep freeze makes a write throw rather than pass unnoticed.
    const original = source();
    Object.freeze(original);
    Object.freeze(original.membershipTypeRates);
    original.membershipTypeRates.forEach((row) => Object.freeze(row));

    const copy = copySeasonConfiguration(original, TYPES, TIERS);
    copy.rateCells[rateCellKey(FULL.id, "ADULT")] = 9900;
    copy.flatWholeLodgeNightCents = 1;

    expect(original.membershipTypeRates[0]?.pricePerNightCents).toBe(4505);
    expect(original.flatWholeLodgeNightCents).toBe(60000);
  });
});
