/**
 * The integer-only GST split (#4626, Ledger M3a; D3). At the rates a club
 * uses, a floating-point split happens to agree with this one for every
 * representable cent value, so no value sweep can tell them apart: the source
 * guard at the end is what holds `INV-MONEY-003` here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clubTaxCode, type ClubTaxTreatment } from "@/lib/club-tax-settings";
import { allocateTaxAcrossLines, splitTaxInclusiveGross } from "@/lib/member-money";
import { MAX_INTEGER_CENTS as MAX_MEMBER_MONEY_CENTS } from "@/lib/money-input";
import { stripComments } from "./support/strip-comments";

const registered = (rateBasisPoints: number): ClubTaxTreatment => ({ registered: true, rateBasisPoints, taxCode: clubTaxCode(rateBasisPoints), xeroTaxType: "OUTPUT2" });

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
    // #5208: the allocator divides a BigInt product by the BigInt gross, and nothing else.
    for (const division of source.matchAll(/\b(\w+)\s*[/%]\s*(\w+)\b/g)) expect([division[1], division[2]]).toEqual(["scaled", "gross"]);
  });
});

describe("allocateTaxAcrossLines (#5208, Option A)", () => {
  const shares = (tax: number, lines: number[]) => {
    const allocation = allocateTaxAcrossLines(tax, lines);
    if ("problem" in allocation) throw new Error(allocation.problem);
    return allocation.lineTaxCents;
  };

  it("shares the decision's worked example as the owner was shown it", () => {
    // 20000c at 15%: the journal's tax is 2609c; Xero's own per-line sum is 1043 + 1043 + 522 = 2608c.
    expect(splitTaxInclusiveGross(20_000, registered(1500))!.taxCents).toBe(2609);
    expect(shares(2609, [8000, 8000, 4000])).toEqual([1044, 1043, 522]);
  });

  it("gives tied remainders to the earliest lines", () => {
    const tax = splitTaxInclusiveGross(48_000, registered(1500))!.taxCents;
    expect(tax).toBe(6261);
    expect(shares(tax, [8000, 8000, 8000, 8000, 8000, 8000])).toEqual([1044, 1044, 1044, 1043, 1043, 1043]);
  });

  it("takes signed tax off a promo line, and none on a zero line", () => {
    const lines = [8000, 8000, 0, -2000];
    const tax = splitTaxInclusiveGross(14_000, registered(1500))!.taxCents;
    const result = shares(tax, lines);
    expect(result.reduce((a, b) => a + b, 0)).toBe(tax);
    expect(result[2]).toBe(0);
    expect(result[3]).toBeLessThan(0);
  });

  it.each([1500, 1250, 900])("sums to the component's tax, each line within a cent of its exact share, at %i basis points", (rate) => {
    const values = [...spread(400)].map((v) => v % 500_000);
    for (let start = 0; start + 5 <= values.length; start += 5) {
      const lines = values.slice(start, start + 5).map((v, i) => (i === 4 ? -(v % 3000) : v));
      const gross = lines.reduce((a, b) => a + b, 0);
      if (gross <= 0) continue;
      const tax = splitTaxInclusiveGross(gross, registered(rate))!.taxCents;
      const result = shares(tax, lines);
      expect(result.reduce((a, b) => a + b, 0)).toBe(tax);
      lines.forEach((line, i) => {
        // |share − tax × line / gross| < 1, held in integers: |share·gross − tax·line| < gross.
        const error = BigInt(result[i]!) * BigInt(gross) - BigInt(tax) * BigInt(line);
        expect(error < BigInt(gross) && error > -BigInt(gross)).toBe(true);
      });
    }
  });

  it("shares nothing when there is nothing to share", () => {
    expect(shares(0, [0, 0])).toEqual([0, 0]);
    expect(shares(0, [])).toEqual([]);
    expect(shares(0, [500, -500])).toEqual([0, 0]);
  });

  it.each([
    [-1, [100]],
    [101, [100]],
    [1, [0]],
    [1, [100, -200]],
    [0.5, [100]],
    [1, [Number.NaN]],
  ])("refuses tax %s across %j", (tax, lines) => {
    expect(allocateTaxAcrossLines(tax, lines)).toHaveProperty("problem");
  });
});
