import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import {
  DEFAULT_CLUB_THEME_VALUES,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";

// #2190 P4 (D15/J7): the trend/bar series colours are DERIVED from the generated
// substrate rather than hand-picked hex (the old set led with a fork's brand gold
// and its support orange). Like FINANCE_MIX_COLORS these feed Recharts
// `fill`/`stroke` presentation attributes where `var()` does not resolve, so a
// resolved hex is required; the scales chosen are club-independent at step 9 and
// distinct from each other and from FINANCE_MIX_COLORS' first slots reused here
// (cat1/cat3/cat4-9 read as the SAME hue across the two charts on purpose). Built
// once from the shipping default reference seeds; pinned by
// finance-dashboard-series-colors.test.ts. The dead `neutral`/`negative` slots
// (zero references) were removed.
function buildFinanceSeriesColors() {
  const light = buildThemeSubstrate(themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES), "light");
  const step9 = (scale: string) => light.scales[scale].hex[8];
  return {
    revenue: step9("cat1"), // headline revenue — categorical chart-1 tone
    costs: step9("cat4"), // orange, reads as outflow; distinct from revenue
    bookings: step9("cat3"), // magenta, distinct from revenue and costs
    cash: step9("info"), // semantic info blue
    positive: step9("success"), // semantic success green
    comparison: light.neutralHex[8], // neutral-9: a muted grey reference line
  } as const;
}

// Exported for finance-dashboard-series-colors.test.ts (pin to the default seeds).
export const SERIES_COLORS = buildFinanceSeriesColors();
