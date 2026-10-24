import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import type { HeldNightPrice } from "@/lib/stored-sold-price-evidence";
import { valueStrandNights } from "@/lib/strand-night-valuation";

/**
 * #4305 (epic #4302, owner decision D1): `valueStrandNights`, the INV-MOD-028
 * valuation rule. Pure, so no clock is read; the dates sit just after the
 * frozen test day only so they read like real stays.
 */

const D1 = requireCalendarDate("2026-07-10");
const D2 = requireCalendarDate("2026-07-11");
const D3 = requireCalendarDate("2026-07-12");
const D4 = requireCalendarDate("2026-07-13");

function night(
  date: CalendarDate,
  priceCents: number | null | undefined,
  priceSource?: HeldNightPrice["priceSource"],
): HeldNightPrice {
  return { date, priceCents, ...(priceSource ? { priceSource } : {}) };
}

function values(result: ReturnType<typeof valueStrandNights>): number[] {
  return result.nights.map((n) => n.valueCents);
}

describe("valueStrandNights — the issue's worked examples (#4305)", () => {
  it("E1: rows $50/$50/$50 against $150 are the values (R1); the dropped night is worth $50", () => {
    const result = valueStrandNights(
      [night(D1, 5000, "EVEN_SPLIT"), night(D2, 5000, "EVEN_SPLIT"), night(D3, 5000, "EVEN_SPLIT")],
      15000,
    );
    expect(result.rule).toBe("R1_STORED_ROWS");
    expect(result.flag).toBeNull();
    expect(values(result)).toEqual([5000, 5000, 5000]);
    expect(result.nights.every((n) => n.basis === "STORED_ROW")).toBe(true);
    expect(result.totalCents).toBe(15000);
  });

  it("E2: $120 SOLD, $120 SOLD, blank against $240 keeps the rows and values the blank at $0 (R2)", () => {
    const result = valueStrandNights(
      [night(D1, 12000, "SOLD"), night(D2, 12000, "SOLD"), night(D3, null)],
      24000,
    );
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(result.nights).toEqual([
      { date: D1, valueCents: 12000, basis: "STORED_ROW" },
      { date: D2, valueCents: 12000, basis: "STORED_ROW" },
      { date: D3, valueCents: 0, basis: "SPLIT" },
    ]);
    // Giving back the second night credits $120.
    expect(result.nights[1].valueCents).toBe(12000);
  });

  it("E3: rows $50/$50/$60 (sum $160) against $150 fall back to an even split (R3)", () => {
    const result = valueStrandNights(
      [night(D1, 5000, "SOLD"), night(D2, 5000, "SOLD"), night(D3, 6000, "SOLD")],
      15000,
    );
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([5000, 5000, 5000]);
    expect(result.nights.every((n) => n.basis === "SPLIT")).toBe(true);
  });
});

describe("valueStrandNights — R1, rows add up", () => {
  it("uses the rows whatever their provenance, including UNKNOWN and a $0 comped night", () => {
    const result = valueStrandNights(
      [night(D1, 0, "SOLD"), night(D2, 7000, "UNKNOWN"), night(D3, 3000, "RATE_DERIVED")],
      10000,
    );
    expect(result.rule).toBe("R1_STORED_ROWS");
    expect(values(result)).toEqual([0, 7000, 3000]);
  });

  it("values a single night at its row", () => {
    const result = valueStrandNights([night(D1, 4321, "SOLD")], 4321);
    expect(result.rule).toBe("R1_STORED_ROWS");
    expect(values(result)).toEqual([4321]);
  });

  it("values an all-zero strand at $0 a night", () => {
    const result = valueStrandNights([night(D1, 0), night(D2, 0)], 0);
    expect(result.rule).toBe("R1_STORED_ROWS");
    expect(values(result)).toEqual([0, 0]);
  });

  it("returns an empty valuation for a strand holding no nights and no money", () => {
    expect(valueStrandNights([], 0)).toEqual({
      rule: "R1_STORED_ROWS",
      flag: null,
      nights: [],
      totalCents: 0,
    });
  });
});

describe("valueStrandNights — R2, some nights unvalued", () => {
  it("treats a missing row (undefined) exactly as a NULL row", () => {
    const missing = valueStrandNights([night(D1, 6000), night(D2, undefined)], 10000);
    const nulled = valueStrandNights([night(D1, 6000), night(D2, null)], 10000);
    expect(missing).toEqual(nulled);
    expect(missing.rule).toBe("R2_FILL_UNVALUED");
    expect(values(missing)).toEqual([6000, 4000]);
  });

  it("treats a negative row as unvalued, never as a negative night", () => {
    const result = valueStrandNights([night(D1, 6000), night(D2, -500)], 10000);
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(values(result)).toEqual([6000, 4000]);
  });

  it("treats a non-integer row as unvalued", () => {
    const result = valueStrandNights([night(D1, 6000), night(D2, 12.5)], 10000);
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(values(result)).toEqual([6000, 4000]);
  });

  it("keeps a $0 row as a real price, not an unvalued night", () => {
    const result = valueStrandNights([night(D1, 0), night(D2, null)], 10000);
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(result.nights).toEqual([
      { date: D1, valueCents: 0, basis: "STORED_ROW" },
      { date: D2, valueCents: 10000, basis: "SPLIT" },
    ]);
  });

  it("splits the remainder over the unvalued nights with leftover cents on the earliest", () => {
    // $10 kept, $100.00 left over three blanks: 3334 / 3333 / 3333.
    const result = valueStrandNights(
      [night(D1, null), night(D2, 1000), night(D3, null), night(D4, null)],
      11000,
    );
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(values(result)).toEqual([3334, 1000, 3333, 3333]);
  });

  it("puts leftover cents on the earliest unvalued nights even when the nights arrive out of order", () => {
    const result = valueStrandNights(
      [night(D4, null), night(D2, 1000), night(D3, null), night(D1, null)],
      11003,
    );
    expect(result.nights).toEqual([
      { date: D4, valueCents: 3334, basis: "SPLIT" },
      { date: D2, valueCents: 1000, basis: "STORED_ROW" },
      { date: D3, valueCents: 3334, basis: "SPLIT" },
      { date: D1, valueCents: 3335, basis: "SPLIT" },
    ]);
    const odd = valueStrandNights([night(D3, null), night(D1, null)], 101);
    expect(odd.nights).toEqual([
      { date: D3, valueCents: 50, basis: "SPLIT" },
      { date: D1, valueCents: 51, basis: "SPLIT" },
    ]);
  });

  it("applies with no usable row at all, splitting the whole total", () => {
    const result = valueStrandNights([night(D1, null), night(D2, undefined), night(D3, -1)], 10000);
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(values(result)).toEqual([3334, 3333, 3333]);
  });

  it("values a single unvalued night at the whole total", () => {
    const result = valueStrandNights([night(D1, null)], 9999);
    expect(result.rule).toBe("R2_FILL_UNVALUED");
    expect(values(result)).toEqual([9999]);
  });
});

describe("valueStrandNights — R3, fallback", () => {
  it("splits $100 over three nights as 3334 / 3333 / 3333 when complete rows sum below the total", () => {
    const result = valueStrandNights([night(D1, 3000), night(D2, 3000), night(D3, 3000)], 10000);
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([3334, 3333, 3333]);
  });

  it("splits evenly when complete rows sum above the total", () => {
    const result = valueStrandNights([night(D1, 4000), night(D2, 4000)], 7001);
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([3501, 3500]);
  });

  it("splits evenly when the usable rows alone already exceed the total and other nights are blank", () => {
    const result = valueStrandNights([night(D1, 9000), night(D2, null), night(D3, 2000)], 10000);
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([3334, 3333, 3333]);
    expect(result.nights.every((n) => n.basis === "SPLIT")).toBe(true);
  });

  it("values a single night whose row disagrees with the total at the total", () => {
    const result = valueStrandNights([night(D1, 5000, "SOLD")], 4500);
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([4500]);
  });

  it("values every night at $0 when the total is $0 and the rows say otherwise", () => {
    const result = valueStrandNights([night(D1, 100), night(D2, 200)], 0);
    expect(result.rule).toBe("R3_EVEN_SPLIT");
    expect(values(result)).toEqual([0, 0]);
  });
});

describe("valueStrandNights — negative stored total (D11)", () => {
  it("values every night at $0 and flags it, whatever the rows say", () => {
    const result = valueStrandNights([night(D1, 5000, "SOLD"), night(D2, null), night(D3, -2000)], -1500);
    expect(result).toEqual({
      rule: "NEGATIVE_TOTAL",
      flag: "NEGATIVE_STORED_TOTAL",
      nights: [
        { date: D1, valueCents: 0, basis: "NEGATIVE_TOTAL" },
        { date: D2, valueCents: 0, basis: "NEGATIVE_TOTAL" },
        { date: D3, valueCents: 0, basis: "NEGATIVE_TOTAL" },
      ],
      totalCents: 0,
    });
  });

  it("flags a negative total even on a strand holding no nights", () => {
    const result = valueStrandNights([], -1);
    expect(result.flag).toBe("NEGATIVE_STORED_TOTAL");
    expect(result.nights).toEqual([]);
  });

  it("flags only a negative total", () => {
    expect(valueStrandNights([night(D1, null)], 0).flag).toBeNull();
  });
});

describe("valueStrandNights — refuses rather than invents", () => {
  it("refuses money on a strand holding no nights", () => {
    expect(() => valueStrandNights([], 100)).toThrow(/holding no nights/);
  });

  it("refuses a night listed twice", () => {
    expect(() => valueStrandNights([night(D1, 100), night(D1, 100)], 200)).toThrow(/listed twice/);
  });

  it("refuses a non-integer total", () => {
    expect(() => valueStrandNights([night(D1, 100)], 100.5)).toThrow(/integer cents/);
  });
});

describe("valueStrandNights — properties", () => {
  const ALL_DATES = Array.from({ length: 14 }, (_, i) =>
    requireCalendarDate(`2026-07-${String(10 + i).padStart(2, "0")}`),
  );
  const rowArb = fc.oneof(
    fc.integer({ min: 0, max: 50_000 }),
    fc.constant(null),
    fc.constant(undefined),
    fc.integer({ min: -50_000, max: -1 }),
  );
  const sourceArb = fc.constantFrom(
    undefined,
    "SOLD",
    "OFFICER_PRICED",
    "RATE_DERIVED",
    "EVEN_SPLIT",
    "UNKNOWN",
  ) satisfies fc.Arbitrary<HeldNightPrice["priceSource"]>;
  const strandArb = fc
    .tuple(
      fc.shuffledSubarray(ALL_DATES, { minLength: 1 }),
      fc.array(rowArb, { minLength: 14, maxLength: 14 }),
      fc.array(sourceArb, { minLength: 14, maxLength: 14 }),
      fc.integer({ min: -100_000, max: 300_000 }),
    )
    .map(([dates, rows, sources, total]) => ({
      nights: dates.map((date, i) => night(date, rows[i], sources[i])),
      total,
    }));
  // Half the strands get the total their usable rows add up to, so R1 and R2's
  // equality boundary are exercised and not only reached by chance.
  const reconcilingStrandArb = strandArb.map(({ nights }) => ({
    nights,
    total: nights.reduce(
      (sum, n) => (isUsable(n.priceCents) ? sum + n.priceCents : sum),
      0,
    ),
  }));
  const anyStrandArb = fc.oneof(strandArb, reconcilingStrandArb);

  function isUsable(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  it("always values every night held, in integer cents, summing to the stored total (or $0 for a negative one)", () => {
    fc.assert(
      fc.property(anyStrandArb, ({ nights, total }) => {
        const result = valueStrandNights(nights, total);
        const sum = result.nights.reduce((acc, n) => acc + n.valueCents, 0);
        const expected = total < 0 ? 0 : total;
        expect(sum).toBe(expected);
        expect(result.totalCents).toBe(expected);
        expect(result.nights.map((n) => n.date)).toEqual(nights.map((n) => n.date));
        for (const n of result.nights) {
          expect(Number.isInteger(n.valueCents)).toBe(true);
          expect(n.valueCents).toBeGreaterThanOrEqual(0);
        }
        expect(result.flag === "NEGATIVE_STORED_TOTAL").toBe(total < 0);
      }),
      { numRuns: 500 },
    );
  });

  it("never moves a usable row unless the rows cannot reconcile (R1 and R2 keep every usable row)", () => {
    fc.assert(
      fc.property(anyStrandArb, ({ nights, total }) => {
        const result = valueStrandNights(nights, total);
        if (result.rule !== "R1_STORED_ROWS" && result.rule !== "R2_FILL_UNVALUED") return;
        result.nights.forEach((valued, i) => {
          const stored = nights[i].priceCents;
          if (isUsable(stored)) {
            expect(valued).toEqual({ date: valued.date, valueCents: stored, basis: "STORED_ROW" });
          } else {
            expect(valued.basis).toBe("SPLIT");
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("splits within one cent, with the larger shares on the earliest split nights", () => {
    fc.assert(
      fc.property(anyStrandArb, ({ nights, total }) => {
        const result = valueStrandNights(nights, total);
        const split = result.nights
          .filter((n) => n.basis === "SPLIT")
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .map((n) => n.valueCents);
        for (let i = 1; i < split.length; i++) {
          expect(split[i - 1] - split[i]).toBeGreaterThanOrEqual(0);
          expect(split[0] - split[i]).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("picks the rule D1 states, read from the rows alone and never from their provenance", () => {
    fc.assert(
      fc.property(anyStrandArb, ({ nights, total }) => {
        const usable = nights.filter((n) => isUsable(n.priceCents));
        const rowSum = usable.reduce((sum, n) => sum + (n.priceCents as number), 0);
        const expected =
          total < 0
            ? "NEGATIVE_TOTAL"
            : usable.length === nights.length && rowSum === total
              ? "R1_STORED_ROWS"
              : usable.length < nights.length && rowSum <= total
                ? "R2_FILL_UNVALUED"
                : "R3_EVEN_SPLIT";
        expect(valueStrandNights(nights, total).rule).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });
});
