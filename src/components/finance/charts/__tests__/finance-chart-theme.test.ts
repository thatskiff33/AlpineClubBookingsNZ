import { describe, expect, it } from "vitest";
import { FINANCE_MIX_COLORS, formatFinanceValue } from "../finance-chart-theme";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import {
  DEFAULT_CLUB_THEME_VALUES,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";
import { CHART_FINANCE_8SLOT } from "@/lib/theme/aliases";

/*
 * #2190 P4 — FINANCE_MIX_COLORS is DERIVED from the signed-off categorical
 * scales (D15/J7), not hand-picked brand hex. These are computed pins: the
 * expected values are re-resolved from the substrate here, so a generator change
 * surfaces as a diff rather than shipping silently, and the palette can never
 * regress to a hardcoded literal (Tokoroa's gold #ffcb05 in particular). The
 * reference seeds come from the canonical DEFAULT_CLUB_THEME_VALUES (no
 * hand-copied triple) — the link assertion below fails if that mapping drifts.
 */
const REFERENCE_SEEDS = themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES);

describe("FINANCE_MIX_COLORS (derived categorical palette)", () => {
  it("derives its reference seeds from the canonical default palette", () => {
    expect(REFERENCE_SEEDS).toEqual({
      accent: DEFAULT_CLUB_THEME_VALUES.brandGold,
      neutralSource: DEFAULT_CLUB_THEME_VALUES.brandDeep,
      support: DEFAULT_CLUB_THEME_VALUES.brandSafety,
    });
  });

  it("resolves each of the 8 slots from its cat scale step (chart_finance_8slot)", () => {
    const light = buildThemeSubstrate(REFERENCE_SEEDS, "light");
    const expected = CHART_FINANCE_8SLOT.map(
      ({ scale, step }) => light.scales[scale].hex[step - 1],
    );
    expect([...FINANCE_MIX_COLORS]).toEqual(expected);
  });

  it("pins the exact eight hexes (cat1-5 step 9, then cat1-3 step 7)", () => {
    expect([...FINANCE_MIX_COLORS]).toEqual([
      "#7c5cff", // cat1 step 9
      "#189ab4", // cat2 step 9
      "#d6409f", // cat3 step 9
      "#e8730c", // cat4 step 9
      "#8aa614", // cat5 step 9
      "#c1bcff", // cat1 step 7
      "#8ad4e8", // cat2 step 7
      "#f0b2d3", // cat3 step 7
    ]);
  });

  it("carries no literal Tokoroa gold and no duplicate slot", () => {
    expect(FINANCE_MIX_COLORS).not.toContain("#ffcb05");
    expect(new Set(FINANCE_MIX_COLORS).size).toBe(FINANCE_MIX_COLORS.length);
    // Every slot is a well-formed 6-digit hex (Recharts fill attribute).
    for (const hex of FINANCE_MIX_COLORS) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// #3325: the three number shapes used to be this file's own hard-coded `en-NZ`
// `Intl.NumberFormat` instances; they now come from `@/lib/finance-format`,
// which reads the configured locale. Literal pins under the default (en-NZ),
// byte-identical to what the local instances produced.
describe("formatFinanceValue renders through the shared finance formatters (#3325)", () => {
  it("keeps count, percent, ratio and whole-dollar currency byte-identical", () => {
    expect(formatFinanceValue(1234567, "count")).toBe("1,234,567");
    expect(formatFinanceValue(0.125, "percent")).toBe("12.5%");
    expect(formatFinanceValue(1.35, "ratio")).toBe("1.35");
    expect(formatFinanceValue(123456, "currency")).toBe("$1,235");
  });
});
