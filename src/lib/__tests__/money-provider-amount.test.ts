import { describe, expect, it } from "vitest";
import {
  exactProviderAmountToCents,
  parseProviderReportAmountToCents,
  providerAmountToCents,
  providerAmountToTenThousandths,
} from "@/lib/money-provider-amount";

/**
 * #2685 — the provider boundary's contract, and the proof that routing the
 * twenty-five inline Xero conversions through it moved nothing.
 */
describe("providerAmountToCents", () => {
  it.each([
    [0, 0],
    [1, 100],
    [12.34, 1234],
    [0.01, 1],
    [1234.56, 123456],
    [999999.99, 99999999],
    [-12.34, -1234],
    [-0.01, -1],
  ])("converts the provider amount %s to %s cents", (value, expected) => {
    expect(providerAmountToCents(value)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    ["12.34"],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    [{}],
    [[]],
    [true],
  ])("refuses %s rather than substituting a zero", (value) => {
    expect(providerAmountToCents(value)).toBeNull();
  });

  it("always returns an integer", () => {
    for (const value of [0.005, 1.005, 12.345, 99.999, -1.005]) {
      const cents = providerAmountToCents(value);
      expect(Number.isInteger(cents)).toBe(true);
    }
  });

  /*
    THE FROZEN RULE. The rounding is `Math.round(value * 100)` and nothing else,
    because that is character-for-character what every call site this boundary
    replaced already did. Changing it — including "improving" it to a
    decimal-exact half-up — moves live Xero reconciliation results and is a
    money-behaviour decision for the repository owner, not a refactor.

    These expectations therefore pin the double's own boundary behaviour on
    purpose, including the two cases where it lands the "wrong" way. If one of
    them fails, the rounding rule changed: escalate, do not edit the number.
  */
  it("rounds exactly as Math.round(value * 100) does, boundaries included", () => {
    const cases: Array<[number, number]> = [
      [1.005, 100], // 1.005 * 100 === 100.49999999999999, so it rounds DOWN
      [1.015, 101], // 101.49999999999999 — down again
      [8.165, 816], // 816.4999999999999 — down again
      [0.145, 14], // 14.499999999999998 — down again
      [2.675, 268], // 267.5 exactly, so this one rounds UP
      [-1.005, -100], // Math.round(-100.49999999999999) === -100
      [-1.5, -150], // Math.round is half-UP, so -150.0 stays -150
      [-12.345, -1234], // -1234.5 rounds toward +Infinity, not away from zero
    ];
    for (const [value, expected] of cases) {
      expect(providerAmountToCents(value)).toBe(expected);
      expect(providerAmountToCents(value)).toBe(Math.round(value * 100));
    }
  });

  it("agrees with the inline conversion it replaced across a wide sweep", () => {
    for (let hundredths = -50_000; hundredths <= 50_000; hundredths += 7) {
      const value = hundredths / 100;
      expect(providerAmountToCents(value)).toBe(Math.round(value * 100));
    }
  });
});

/**
 * #3724 — the grain a currency's own precision survives, for asking "is
 * anything owing" of a Xero balance and for showing it.
 */
describe("providerAmountToTenThousandths", () => {
  it.each([
    [0, 0],
    [12.34, 123400],
    [1.234, 12340],
    [0.004, 40],
    [0.0001, 1],
    [1200, 12000000],
    [-1.234, -12340],
  ])("converts %s to %s ten-thousandths", (value, expected) => {
    expect(providerAmountToTenThousandths(value)).toBe(expected);
  });

  it("keeps a figure that rounds to zero hundredths", () => {
    expect(providerAmountToCents(0.004)).toBe(0);
    expect(providerAmountToTenThousandths(0.004)).toBe(40);
  });

  it("reads a double's representation residue as zero", () => {
    const residue = 0.4 - 0.1 - 0.3;
    expect(residue).toBeGreaterThan(0);
    expect(providerAmountToTenThousandths(residue)).toBe(0);
  });

  it.each([null, undefined, "1.23", Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s rather than substituting a zero",
    (value) => {
      expect(providerAmountToTenThousandths(value)).toBeNull();
    },
  );
});

describe("exactProviderAmountToCents", () => {
  it("accepts amounts that land on a whole cent", () => {
    expect(exactProviderAmountToCents(12.34)).toBe(1234);
    expect(exactProviderAmountToCents(0)).toBe(0);
    expect(exactProviderAmountToCents(-12.34)).toBe(-1234);
    expect(exactProviderAmountToCents(1234.5)).toBe(123450);
  });

  it("refuses sub-cent precision rather than rounding it into agreement", () => {
    for (const value of [12.345, 0.001, 1.005, -12.345]) {
      expect(exactProviderAmountToCents(value)).toBeNull();
    }
  });

  it("refuses anything that is not a finite number", () => {
    for (const value of [null, undefined, "12.34", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(exactProviderAmountToCents(value)).toBeNull();
    }
  });
});

/**
 * The Xero report-cell parser, and the proof that collapsing the two
 * byte-identical copies in `finance-cash-snapshot.ts` and
 * `finance-pnl-snapshot.ts` changed no published accounting figure.
 */
describe("parseProviderReportAmountToCents", () => {
  /** The implementation both finance snapshots carried before #2685, verbatim. */
  function legacyParse(value: string | null): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const isBracketNegative =
      trimmed.startsWith("(") && trimmed.endsWith(")") && trimmed.length > 2;
    const normalized = (isBracketNegative ? trimmed.slice(1, -1) : trimmed).replace(
      /,/g,
      "",
    );
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.round((isBracketNegative ? parsed * -1 : parsed) * 100);
  }

  const CORPUS = [
    null,
    "",
    "   ",
    "0",
    "0.00",
    "1",
    "1.5",
    "12.34",
    "1234.50",
    "1,234.50",
    "12,345,678.90",
    "(1,234.50)",
    "(0.01)",
    "-1234.50",
    "-1,234.50",
    "(-5.00)",
    "+12.34",
    " 99.99 ",
    "0.07",
    "0.29",
    "8.87",
    // Outside the canonical grammar: these take the preserved legacy path.
    "1234.5678",
    ".50",
    "007.50",
    "1e5",
    "99999999999.99",
    // A SIGN DETACHED FROM ITS DIGITS. `parseFloat` reads none of these, so the
    // parser this replaced returned `null` for every one — and the exact path
    // must too. Before the fix it read `"- 5"` as -500, and `"(- 5)"` came back
    // POSITIVE because the bracket negated an already-negative magnitude
    // (#2685 review). These four are the reason the equality assertion below
    // is worth running rather than assumed.
    "- 5",
    "+ 5",
    "(- 5)",
    "(+ 5)",
    "-  1,234.50",
    "- ",
    // Not amounts at all.
    "Total",
    "abc",
    "()",
    "(x)",
  ];

  it("agrees with the parser it replaced on every corpus entry", () => {
    for (const cell of CORPUS) {
      expect([cell, parseProviderReportAmountToCents(cell)]).toEqual([
        cell,
        legacyParse(cell),
      ]);
    }
  });

  it.each([
    ["1,234.50", 123450],
    ["(1,234.50)", -123450],
    ["-1,234.50", -123450],
    ["(-5.00)", 500],
    ["0.00", 0],
    ["12.34", 1234],
  ])("reads %s as %s cents", (cell, expected) => {
    expect(parseProviderReportAmountToCents(cell)).toBe(expected);
  });

  it("keeps a bracketed zero canonical rather than returning -0", () => {
    expect(Object.is(parseProviderReportAmountToCents("(0.00)"), 0)).toBe(true);
  });

  it("returns null for a cell that is not an amount", () => {
    for (const cell of [null, "", "   ", "Total", "abc", "()"]) {
      expect(parseProviderReportAmountToCents(cell)).toBeNull();
    }
  });

  it("refuses a sign detached from its digits, as the parser it replaced did", () => {
    // Pinned separately from the corpus equality above because both halves are
    // load-bearing: an exact path that accepted `"- 5"` would widen what counts
    // as an amount — and `readRowAmountCents` picks the RIGHT-MOST cell that
    // parses, so widening changes WHICH cell is read — while the bracketed form
    // came back with the sign INVERTED (#2685 review).
    for (const cell of ["- 5", "+ 5", "(- 5)", "(+ 5)", "- ", "-  1,234.50"]) {
      expect([cell, parseProviderReportAmountToCents(cell)]).toEqual([cell, null]);
    }
  });

  it("takes the exact path for ordinary two-decimal cells", () => {
    // Every one of these is representable in the canonical grammar, so the
    // magnitude is read as integer digit groups rather than through a float.
    for (let hundredths = 0; hundredths <= 20_000; hundredths += 13) {
      const cents = hundredths;
      const cell = (cents / 100).toFixed(2);
      expect(parseProviderReportAmountToCents(cell)).toBe(cents);
      expect(parseProviderReportAmountToCents(`(${cell})`)).toBe(
        cents === 0 ? 0 : -cents,
      );
    }
  });
});
