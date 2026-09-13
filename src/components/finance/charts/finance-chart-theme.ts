import {
  formatCompactDollarsDisplay,
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceRatio,
} from "@/lib/finance-format";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import {
  DEFAULT_CLUB_THEME_VALUES,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";
import { CHART_FINANCE_8SLOT } from "@/lib/theme/aliases";

/**
 * Ordered palette for mix/breakdown charts (pies, stacked bars).
 *
 * #2190 P4 (D15/J7): the eight slots are now DERIVED from the signed-off
 * CATEGORICAL scales rather than hand-picked brand hex (the old palette led with
 * a fork's brand gold and carried seven other literals). The mapping is the
 * `chart_finance_8slot` order recorded in `docs/theme/phase0/data/aliases.json`
 * and encoded once as `CHART_FINANCE_8SLOT`: series 1–5 = cat1–5 step 9, series
 * 6–8 = cat1–3 step 7.
 *
 * WHY a fixed reference build. These values feed Recharts `fill` / `stroke`
 * PRESENTATION ATTRIBUTES, where `var()` does not resolve, so a resolved hex is
 * required. The categorical scales are club-INDEPENDENT at step 9 (the seed sits
 * unbanded at step 9 by construction) and vary only by ≤1/255 at step 7 (the A1
 * band snaps to the club's neutral ramp), so building them once from the shipping
 * default reference seeds (`DEFAULT_CLUB_THEME_VALUES`, the single source of truth
 * — no hand-copied triple) yields the categorical intent: a palette that stays
 * mutually distinguishable regardless of the admin-configured site colours. The
 * exact eight hexes are pinned by `finance-chart-theme.test.ts`, which recomputes
 * them from the substrate so a generator change surfaces as a test diff.
 *
 * KNOWN EDGE CASE at the tail: series 6–8 (step 7) are LIGHT tints of the
 * series 1–3 hues, so a chart that actually reaches a 6th–8th category renders a
 * lighter variant of an earlier slice. `mix-pie-chart.tsx` draws its Cells
 * without a stroke, so treat the first five vivid tones as the safe set; a stroke
 * or a different tail mapping needs an owner decision.
 *
 * Chart NEUTRALS (grid, axis, ticks) are handled differently: `trend-chart.tsx`
 * still passes literal `stroke="#e2e8f0"` / `"#94a3b8"` for the same
 * SVG-attribute reason, but those literals are only the light-mode fallback —
 * `globals.css` overrides them for real via `.finance-trend-chart .recharts-*`
 * selectors, which DO follow the theme (including dark mode). See the in-file
 * comment at `trend-chart.tsx` `sharedAxes`.
 */
function buildFinanceMixColors(): readonly string[] {
  const light = buildThemeSubstrate(
    themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES),
    "light",
  );
  return CHART_FINANCE_8SLOT.map(({ scale, step }) => {
    const hex = light.scales[scale]?.hex[step - 1];
    if (hex === undefined) {
      // Every CHART_FINANCE_8SLOT entry names a real categorical scale and a
      // real step that buildThemeSubstrate always populates (12 hexes per
      // scale; CHART_FINANCE_8SLOT only ever asks for step 7 or 9). `scale`
      // is typed as plain `string`, so the type can't see that closed-set
      // fact — but this runs once at module load, so a contract break here
      // fails loudly at startup rather than shipping a silently wrong chart
      // colour.
      throw new Error(
        `finance-chart-theme: no built colour for scale "${scale}" step ${step}`,
      );
    }
    return hex;
  });
}

export const FINANCE_MIX_COLORS = buildFinanceMixColors();

export type FinanceValueType = "currency" | "count" | "percent" | "ratio";

// Every number shape here comes from `@/lib/finance-format`, which reads the
// club's configured locale; this file used to hold three hard-coded `en-NZ`
// instances of its own (#3325).

/** Display value for tooltips and labels (currency: whole dollars). */
export function formatFinanceValue(
  value: number,
  valueType: FinanceValueType
): string {
  switch (valueType) {
    case "currency":
      return formatDollarsDisplay(value);
    case "percent":
      return formatFinancePercent(value);
    case "ratio":
      return formatFinanceRatio(value);
    case "count":
    default:
      return formatFinanceNumber(value);
  }
}

/** Compact value for chart axis ticks (e.g. "$10k", "1.2k", "5%"). */
export function formatFinanceAxisTick(
  value: number,
  valueType: FinanceValueType
): string {
  if (valueType === "percent") {
    return formatFinancePercent(value);
  }

  if (valueType === "ratio") {
    return formatFinanceRatio(value);
  }

  if (valueType === "currency") {
    return formatCompactDollarsDisplay(value);
  }

  const abs = Math.abs(value);
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatFinanceNumber(value);
}
