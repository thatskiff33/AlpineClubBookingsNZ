/*
 * Fixed-seed kiosk token set (#2189 P3, epic #2181 A5/J4).
 *
 * The kiosk / wall-display surfaces are the deliberately literalist, glare-proof,
 * NON-brand-following exception (plan-lock A5). Unlike every club-themed surface,
 * the kiosk does NOT follow the club accent and does NOT vary by light/dark mode:
 * it is authored ONCE from a FIXED kiosk seed (pinned in P1 as
 * `PINS.kiosk` — near-black background `#0a0a0b`, neutral grey seed `#808080`,
 * accent `#7dd3fc`) and renders identically on every club and in either mode.
 *
 * This module derives that fixed token set from the shipping substrate:
 *  - NEUTRAL surfaces + text tiers and the ACCENT action colour come straight
 *    from `buildKioskTheme()` (the A5 dark-only kiosk substrate);
 *  - the STATUS hues (danger / success / warning / orange) are generated in the
 *    SAME fixed kiosk context (kiosk graySeed + kiosk near-black background,
 *    dark appearance), so the status tints sit correctly on the near-black page
 *    and are themselves club-independent.
 *
 * Because the values are static and mode-invariant, `globals.css` carries them as
 * literal `--kiosk-*` custom properties (a standalone, mode-agnostic block) plus
 * the `@theme` `--color-kiosk-*` utilities. `kiosk-token-contract.test.ts` pins
 * every literal against `buildKioskTokens()` (P1's fallback-pin pattern), so the
 * CSS and this derivation can never drift.
 */
import {
  PINS,
  buildKioskTheme,
  a4SolidForeground,
  oklch,
  fromOklch,
} from "./theme-substrate";
import { generateRadixColors } from "./generate-radix-colors";
import { must } from "./index-guards";

/** A1 banding, replicated from theme-substrate (the export is module-private). */
const BAND_STEPS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 10, 11]);
function bandScale(hex12: string[], bandL: number[]): string[] {
  return hex12.map((hex, i) => {
    if (!BAND_STEPS.has(i)) return hex;
    // `bandL` is the kiosk neutral ramp's per-step lightness, always built
    // with one entry per step of `hex12` (both are always the fixed kiosk
    // context's 12 steps).
    const l = must(bandL[i], `bandScale: no band-source lightness at index ${i}`);
    const [, C, H] = oklch(hex);
    return fromOklch(l, C, H);
  });
}

/** One named step of a fixed-12-step scale array — always present by construction. */
function step(scale: readonly string[], i: number, label: string): string {
  return must(scale[i], `buildKioskTokens: ${label} has no step ${i + 1} of its 12`);
}

/**
 * A status scale generated in the fixed kiosk context (dark, kiosk graySeed +
 * near-black background), A1-banded to the kiosk neutral ramp — the same
 * treatment `buildKioskTheme` gives the kiosk accent.
 */
function kioskStatusScale(seed: string, bandL: number[]): string[] {
  const c = generateRadixColors({
    appearance: "dark",
    accent: seed,
    gray: PINS.kiosk.graySeed,
    background: PINS.kiosk.background,
  });
  return bandScale(c.accentScale, bandL);
}

/**
 * The full fixed kiosk token map (token name without the `--kiosk-` prefix →
 * hex). Deterministic, pure, club- and mode-independent.
 */
export function buildKioskTokens(): Record<string, string> {
  const { theme, lightNeutral12 } = buildKioskTheme();
  const n = theme.neutralHex; // 12-step kiosk neutral ramp (dark)
  const accentScale = must(theme.scales.accent, "buildKioskTokens: kiosk theme has no accent scale");
  const a = accentScale.hex; // 12-step kiosk accent ramp (dark)
  const accentOnSolid = accentScale.generatorContrast ?? "#ffffff";
  const bandL = theme.bandL;

  const danger = kioskStatusScale(
    must(PINS.semanticSeeds.danger, "buildKioskTokens: no semantic seed for danger"),
    bandL,
  );
  const success = kioskStatusScale(
    must(PINS.semanticSeeds.success, "buildKioskTokens: no semantic seed for success"),
    bandL,
  );
  const warning = kioskStatusScale(
    must(PINS.semanticSeeds.warning, "buildKioskTokens: no semantic seed for warning"),
    bandL,
  );
  const orange = kioskStatusScale(
    must(PINS.categoricalSeeds.cat4, "buildKioskTokens: no categorical seed for cat4"),
    bandL,
  );

  const statusTriplet = (scale: readonly string[], prefix: string) => ({
    [`${prefix}-bg`]: step(scale, 2, `${prefix} scale`), // step 3 — dark tinted background
    [`${prefix}-fg`]: step(scale, 10, `${prefix} scale`), // step 11 — light accent text (AA on bg + page)
    [`${prefix}-border`]: step(scale, 6, `${prefix} scale`), // step 7 — visible border
  });

  const statusSolid = (scale: readonly string[], prefix: string) => ({
    [`${prefix}-solid`]: step(scale, 8, `${prefix} scale`), // step 9 — solid fill
    [`${prefix}-solid-fg`]: a4SolidForeground(
      step(scale, 8, `${prefix} scale`),
      // step-9 fill has no generatorContrast here (accent-only field); recompute.
      "#ffffff",
      lightNeutral12,
    ).pick,
  });

  // Interactive states for a text-bearing status SOLID button. A `/90` opacity
  // modifier would composite the fill toward the near-black page and DARKEN it,
  // dropping a dark on-solid label below AA on hover. Instead these LIGHTEN the
  // step-9 fill by a fixed OKLCH lightness step (chroma/hue held), mirroring the
  // intent of the accent-hover/accent-active pair — so a dark label only GAINS
  // contrast when hovered/pressed. (The scale's own step 10 runs darker here, so
  // it cannot serve; a derived lighten is deterministic and monotonic.)
  const lighten = (hex: string, dL: number) => {
    const [L, C, H] = oklch(hex);
    return fromOklch(Math.min(1, L + dL), C, H);
  };
  const statusSolidStates = (scale: readonly string[], prefix: string) => ({
    [`${prefix}-solid-hover`]: lighten(step(scale, 8, `${prefix} scale`), 0.06),
    [`${prefix}-solid-active`]: lighten(step(scale, 8, `${prefix} scale`), 0.12),
  });

  return {
    // --- Neutral surfaces (page darkest → chip lightest) + hover/borders. ---
    page: PINS.kiosk.background, // A5 fixed near-black page background
    card: step(n, 2, "neutral ramp"), // step 3
    inset: step(n, 3, "neutral ramp"), // step 4
    chip: step(n, 5, "neutral ramp"), // step 6
    hover: step(n, 6, "neutral ramp"), // step 7 — hover/active feedback surface
    border: step(n, 6, "neutral ramp"), // step 7 — visible rules
    "border-muted": step(n, 3, "neutral ramp"), // step 4 — faint/disabled borders

    // --- Text tiers. ---
    fg: step(n, 11, "neutral ramp"), // step 12 — primary text (near-white)
    "muted-fg": step(n, 10, "neutral ramp"), // step 11 — secondary labels
    "faint-fg": step(n, 8, "neutral ramp"), // step 9 — disabled / tertiary text

    // --- Fixed accent (the kiosk action colour; #7dd3fc seed, NOT brand). ---
    accent: step(a, 8, "accent ramp"), // step 9 — solid fill / text / ring
    "accent-hover": step(a, 9, "accent ramp"), // step 10
    "accent-active": step(a, 10, "accent ramp"), // step 11
    "accent-fg": accentOnSolid, // on-accent text (generator on-solid pick)
    "accent-bg": step(a, 2, "accent ramp"), // step 3 — tinted selected/active background
    "accent-border": step(a, 6, "accent ramp"), // step 7 — selected/active border

    // --- Status hues (generated in the fixed kiosk context). ---
    ...statusTriplet(danger, "danger"),
    ...statusSolid(danger, "danger"),
    ...statusTriplet(success, "success"),
    ...statusSolid(success, "success"),
    ...statusSolidStates(success, "success"),
    ...statusTriplet(warning, "warning"),
    ...statusSolid(warning, "warning"),
    ...statusTriplet(orange, "orange"),
  };
}

/** Emission order for the `--kiosk-*` block + `@theme` entries (stable). */
export const KIOSK_TOKEN_ORDER = [
  "page",
  "card",
  "inset",
  "chip",
  "hover",
  "border",
  "border-muted",
  "fg",
  "muted-fg",
  "faint-fg",
  "accent",
  "accent-hover",
  "accent-active",
  "accent-fg",
  "accent-bg",
  "accent-border",
  "danger-bg",
  "danger-fg",
  "danger-border",
  "danger-solid",
  "danger-solid-fg",
  "success-bg",
  "success-fg",
  "success-border",
  "success-solid",
  "success-solid-fg",
  "success-solid-hover",
  "success-solid-active",
  "warning-bg",
  "warning-fg",
  "warning-border",
  "warning-solid",
  "warning-solid-fg",
  "orange-bg",
  "orange-fg",
  "orange-border",
] as const;
