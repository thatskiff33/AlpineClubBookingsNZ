import { describe, expect, it } from "vitest";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";
import { FINANCE_MIX_COLORS } from "@/components/finance/charts/finance-chart-theme";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import {
  DEFAULT_CLUB_THEME_VALUES,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";

/*
 * #2190 P4 — the finance trend/bar SERIES_COLORS are DERIVED from the generated
 * substrate (D15), not hand-picked hex (the old set carried a fork's brand gold
 * #ffcb05 and its #ff7c12 support). Computed pins tie the resolved values to the
 * shipping default seeds, so a default-seed or generator change surfaces here.
 */
describe("finance SERIES_COLORS (derived trend/bar palette)", () => {
  const light = buildThemeSubstrate(
    themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES),
    "light",
  );

  it("resolves each series from its substrate scale step", () => {
    expect(SERIES_COLORS).toEqual({
      revenue: light.scales.cat1.hex[8],
      costs: light.scales.cat4.hex[8],
      bookings: light.scales.cat3.hex[8],
      cash: light.scales.info.hex[8],
      positive: light.scales.success.hex[8],
      comparison: light.neutralHex[8],
    });
  });

  it("pins the exact resolved hexes", () => {
    expect(SERIES_COLORS).toEqual({
      revenue: "#7c5cff",
      costs: "#e8730c",
      bookings: "#d6409f",
      cash: "#2563eb",
      positive: "#1f9d55",
      comparison: "#818782",
    });
  });

  it("carries no fork-brand literal and keeps every series distinct", () => {
    const values = Object.values(SERIES_COLORS);
    expect(values).not.toContain("#ffcb05");
    expect(values).not.toContain("#ff7c12");
    expect(new Set(values).size).toBe(values.length);
    for (const hex of values) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("has no dead neutral/negative slots", () => {
    expect("neutral" in SERIES_COLORS).toBe(false);
    expect("negative" in SERIES_COLORS).toBe(false);
  });

  it("shares its reused cat tones with the mix chart (revenue/costs/bookings)", () => {
    // revenue/costs/bookings intentionally reuse cat1/cat4/cat3-9, matching the
    // mix chart's first slots so the two finance charts read as one hue system.
    expect(SERIES_COLORS.revenue).toBe(FINANCE_MIX_COLORS[0]); // cat1-9
    expect(SERIES_COLORS.bookings).toBe(FINANCE_MIX_COLORS[2]); // cat3-9
    expect(SERIES_COLORS.costs).toBe(FINANCE_MIX_COLORS[3]); // cat4-9
  });
});
