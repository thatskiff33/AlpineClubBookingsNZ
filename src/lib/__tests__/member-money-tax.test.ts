/**
 * The integer-only GST split (#4626, Ledger M3a; D3). At the rates a club
 * uses, a floating-point split happens to agree with this one for every
 * representable cent value, so no value sweep can tell them apart: the source
 * guard at the end is what holds `INV-MONEY-003` here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clubTaxCode, type ClubTaxTreatment } from "@/lib/club-tax-settings";
import { splitTaxInclusiveGross } from "@/lib/member-money";
import { MAX_MEMBER_MONEY_CENTS } from "@/lib/member-money/internal/tax";
import { stripComments } from "./support/strip-comments";

const registered = (rateBasisPoints: number): ClubTaxTreatment => ({ registered: true, rateBasisPoints, taxCode: clubTaxCode(rateBasisPoints) });

/** Deterministic large values across the column's range (no Math.random in tests). */
function* spread(count: number): Generator<number> {
  let state = 4626n;
  for (let index = 0; index < count; index++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    yield Number(state % BigInt(MAX_MEMBER_MONEY_CENTS + 1));
  }
}

describe("splitTaxInclusiveGross", () => {
  it("splits today's 15% inclusive charges as the invoices show them", () => {
    expect(splitTaxInclusiveGross(11500, registered(1500))).toEqual({ grossCents: 11500, netCents: 10000, taxCents: 1500, taxCode: "GST_INCLUSIVE_1500BP" });
    expect(splitTaxInclusiveGross(100, registered(1500))).toMatchObject({ netCents: 87, taxCents: 13 });
    expect(splitTaxInclusiveGross(1, registered(1500))).toMatchObject({ netCents: 1, taxCents: 0 });
    expect(splitTaxInclusiveGross(0, registered(1500))).toMatchObject({ netCents: 0, taxCents: 0 });
  });

  it("rounds an exact half up", () => {
    // 1 cent at 100%: the tax is exactly half a cent.
    expect(splitTaxInclusiveGross(1, registered(10_000))).toMatchObject({ taxCents: 1, netCents: 0 });
    expect(splitTaxInclusiveGross(3, registered(10_000))).toMatchObject({ taxCents: 2, netCents: 1 });
  });

  it.each([0, 1, 900, 1250, 1500, 2000, 9999, 10_000])("keeps integer gross = net + tax, correctly rounded, at %i basis points", (rate) => {
    const values = [...Array.from({ length: 30_001 }, (_, cents) => cents), ...spread(2_000), MAX_MEMBER_MONEY_CENTS];
    for (const grossCents of values) {
      const split = splitTaxInclusiveGross(grossCents, registered(rate))!;
      expect(Number.isSafeInteger(split.netCents) && Number.isSafeInteger(split.taxCents)).toBe(true);
      expect(split.netCents + split.taxCents).toBe(grossCents);
      expect(split.netCents).toBeGreaterThanOrEqual(0);
      // tax is the nearest integer to gross × rate / (10000 + rate), halves up:
      // |2·tax·d − 2·gross·rate| ≤ d, with equality only when rounding up.
      const d = 10_000n + BigInt(rate);
      const error = 2n * BigInt(split.taxCents) * d - 2n * BigInt(grossCents) * BigInt(rate);
      expect(error <= d && error > -d, `${grossCents} at ${rate}`).toBe(true);
    }
  });

  it("records no split for a club that is not GST-registered", () => {
    for (const grossCents of [0, 1, 11500, MAX_MEMBER_MONEY_CENTS]) {
      expect(splitTaxInclusiveGross(grossCents, { registered: false })).toBeNull();
    }
  });

  it.each([-1, 0.5, Number.NaN, MAX_MEMBER_MONEY_CENTS + 1])("refuses %s as a gross amount", (grossCents) => {
    expect(() => splitTaxInclusiveGross(grossCents, registered(1500))).toThrow(/integer cents/);
  });

  it("computes in integers only: BigInt arithmetic, no Math, decimals or float parsing (INV-MONEY-003)", () => {
    const source = stripComments(readFileSync("src/lib/member-money/internal/tax.ts", "utf8"));
    expect(source).toMatch(/BigInt\(/);
    expect(source).not.toMatch(/\bMath\.|parseFloat|toFixed|Number\.parseFloat/);
    expect(source).not.toMatch(/\b\d+\.\d+\b/);
    // Every division is between BigInt operands: its divisor is a parenthesised product ending in a bigint literal or variable.
    for (const division of source.matchAll(/\)\s*\/\s*([^/\n;]+)/g)) expect(division[1]).toMatch(/^\(2n \* divisor\)/);
  });
});
