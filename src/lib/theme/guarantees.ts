/*
 * Theme guarantees — the programme's compliance-by-construction layer (#2187 P1).
 *
 * Every guarantee is a HARD floor swept over every scale × mode × seed (+ kiosk).
 * A failing cell is a blunt stop-and-report (the sweep test fails), never a silent
 * walk-back. The Phase-0 measurements.json guarantee_sweep is the coverage target;
 * this module reproduces it and adds G2b (R11).
 *
 *  G1  foreground (neutral-12) on scale steps 1–5      ≥ 4.5:1 (AA text)
 *  G2  muted-fg  (neutral-11) on scale steps 1–3       ≥ 4.5:1 (AA text)
 *  G2b status-chip text (step-11) on chip surface (step-3), every scale ≥ 4.5:1 (R11)
 *  G2c SHIPPED derived --muted-foreground tone on neutral steps 1–4 ≥ 4.5:1 (AA text)
 *      (the app-scope muted role's real endpoint, not the raw neutral-11 of G2)
 *  G3  muted-fg (neutral-11) vs foreground (neutral-12): distinctness ratio (recorded)
 *  G4  A4 solid-foreground on step-9 / step-10 fills    ≥ 4.5:1 (AA text)
 *  G5a card/page separation (neutral-1 vs neutral-2): ΔL floor + pinned shadow (J8)
 *  G5b --input/--ring (neutral-10) vs surfaces 1–3      ≥ 3:1
 */
import { contrast, oklch, a4SolidForeground, type BuiltTheme } from "./theme-substrate";
import { A2_INPUT_RING_NEUTRAL_STEP, ACCENT_NEUTRAL_STEP } from "./aliases";
import { must } from "./index-guards";

/** WCAG AA minimum for normal-size body text. */
export const AA_TEXT = 4.5;

/**
 * G2c surface reach: the neutral steps the app-scope `--muted-foreground` tone can
 * actually land on — `--card`/`--popover` (1), `--background` (2),
 * `--muted`/`--secondary` (3), and `--accent` (4, the #2144 hover surface). The
 * ceiling is `ACCENT_NEUTRAL_STEP` so the sweep tracks the alias map rather than a
 * copied literal.
 */
export const DERIVED_MUTED_SURFACE_STEPS = ACCENT_NEUTRAL_STEP;
/** G5b floor: interactive-boundary contrast against adjacent surfaces. */
export const INPUT_RING_MIN = 3;
/** G2b floor: status-chip text must clear AA (4.5:1) on its pale chip surface. */
export const CHIP_TEXT_FLOOR = 4.5;

/**
 * G5a card separation — signed-off A6 candidate ii (tint + shadow). The measured
 * default-light numbers are the pinned floor; the shadow is the pinned J8 value.
 */
export const G5A_CARD_SEPARATION = {
  /** neutral-1 (card) vs neutral-2 (page) minimum lightness delta. */
  minDeltaL: 0.012,
  /** neutral-1 vs neutral-2 minimum contrast ratio. */
  minContrast: 1.04,
  /** J8 pinned box-shadow. */
  boxShadow: "0 1px 2px 0 #040a054a, 0 1px 3px 0 #020b037b",
} as const;

export interface SweepFailure {
  guarantee: "G1" | "G2" | "G2b" | "G2c" | "G4" | "G5a" | "G5b";
  cell: string;
  ratio: number;
  floor: number;
}

/** True oklch lightness (matches the Phase-0 ΔL space). */
const oklchL = (hex: string): number => oklch(hex)[0];

/**
 * Sweep every guarantee over one built theme. `lightNeutral12` is the SAME seed
 * set's light-mode neutral-12 (for the A4 ladder). Returns the failure list —
 * empty means the theme is compliant by construction.
 */
export function sweepGuarantees(
  theme: BuiltTheme,
  lightNeutral12: string,
  cellPrefix: string,
): SweepFailure[] {
  const failures: SweepFailure[] = [];
  const n = theme.neutralHex;
  const fg = must(n[11], "sweepGuarantees: neutral ramp has no step 12"); // neutral-12
  const mfg = must(n[10], "sweepGuarantees: neutral ramp has no step 11"); // neutral-11
  const surfaces1to3 = n.slice(0, 3);

  for (const [sname, s] of Object.entries(theme.scales)) {
    const h = s.hex;
    // G1: foreground on steps 1–5
    h.slice(0, 5).forEach((hex, i) => {
      const r = contrast(fg, hex);
      if (r < AA_TEXT) failures.push({ guarantee: "G1", cell: `${cellPrefix}/${sname}/step${i + 1}`, ratio: round2(r), floor: AA_TEXT });
    });
    // G2: muted-fg on steps 1–3
    h.slice(0, 3).forEach((hex, i) => {
      const r = contrast(mfg, hex);
      if (r < AA_TEXT) failures.push({ guarantee: "G2", cell: `${cellPrefix}/${sname}/step${i + 1}`, ratio: round2(r), floor: AA_TEXT });
    });
    // G2b: chip text (step-11) on chip surface (step-3) for EVERY scale
    const chipText = must(h[10], `sweepGuarantees: scale ${sname} has no step 11`);
    const chipSurface = must(h[2], `sweepGuarantees: scale ${sname} has no step 3`);
    const g2b = contrast(chipText, chipSurface);
    if (g2b < CHIP_TEXT_FLOOR) failures.push({ guarantee: "G2b", cell: `${cellPrefix}/${sname}/chip`, ratio: round2(g2b), floor: CHIP_TEXT_FLOOR });
    // G4: A4 solid-foreground on step-9 / step-10 (hue scales only)
    if (sname !== "neutral" && s.generatorContrast) {
      const generatorContrast = s.generatorContrast;
      [8, 9].forEach((idx) => {
        const stepHex = must(h[idx], `sweepGuarantees: scale ${sname} has no step ${idx + 1}`);
        const res = a4SolidForeground(stepHex, generatorContrast, lightNeutral12);
        if (!res.passAA) failures.push({ guarantee: "G4", cell: `${cellPrefix}/${sname}/step${idx + 1}`, ratio: res.ratio, floor: AA_TEXT });
      });
    }
  }

  // G5b: --input/--ring (neutral-10) vs surfaces 1–3
  const inputRing = must(
    n[A2_INPUT_RING_NEUTRAL_STEP - 1],
    `sweepGuarantees: neutral ramp has no step ${A2_INPUT_RING_NEUTRAL_STEP}`,
  );
  surfaces1to3.forEach((surface, i) => {
    const r = contrast(inputRing, surface);
    if (r < INPUT_RING_MIN) failures.push({ guarantee: "G5b", cell: `${cellPrefix}/inputring/surface${i + 1}`, ratio: round2(r), floor: INPUT_RING_MIN });
  });

  // G5a: card/page separation (light only — cards read via shadow+border in dark).
  if (theme.mode === "light") {
    const card = must(n[0], "sweepGuarantees: neutral ramp has no step 1");
    const page = must(n[1], "sweepGuarantees: neutral ramp has no step 2");
    // Compared at measurements.json precision (ΔL r3, contrast r2): both reference
    // seeds clear the pinned candidate-ii floor there; tokoroa sits right on the ΔL
    // floor, with the pinned J8 shadow the primary separation reinforcement.
    const dL = round3(Math.abs(oklchL(card) - oklchL(page)));
    const c = round2(contrast(card, page));
    if (dL < G5A_CARD_SEPARATION.minDeltaL) failures.push({ guarantee: "G5a", cell: `${cellPrefix}/card-deltaL`, ratio: dL, floor: G5A_CARD_SEPARATION.minDeltaL });
    if (c < G5A_CARD_SEPARATION.minContrast) failures.push({ guarantee: "G5a", cell: `${cellPrefix}/card-contrast`, ratio: c, floor: G5A_CARD_SEPARATION.minContrast });
  }

  return failures;
}

/** G3 distinctness ratio (recorded, not a hard floor): muted-fg vs foreground. */
export function g3Distinctness(theme: BuiltTheme): number {
  const mutedFg = must(theme.neutralHex[10], "g3Distinctness: neutral ramp has no step 11");
  const fg = must(theme.neutralHex[11], "g3Distinctness: neutral ramp has no step 12");
  return round2(contrast(mutedFg, fg));
}

/**
 * G2c — the SHIPPED app-scope `--muted-foreground` tone (the measured-AA endpoint
 * `deriveAppMutedForeground` produces, NOT the raw neutral-11 of G2) must clear AA
 * on every neutral surface it can land on, steps 1–`DERIVED_MUTED_SURFACE_STEPS`,
 * for `theme`'s mode. Caller passes the tone for that mode so this stays a pure
 * function of the built theme + the shipped tone (no schema import here); the
 * sweep test wires the real default/tokoroa tones through it, both modes.
 *
 * This is what makes the step-4 `--accent` case CI-visible: G2 only reaches
 * step-3 and measures the raw ramp, so a derived tone that lands sub-AA on the
 * hover surface (Tokoroa light was 4.37:1) passed every existing sweep cell.
 */
export function sweepDerivedMutedForeground(
  mutedTone: string,
  theme: BuiltTheme,
  cellPrefix: string,
): SweepFailure[] {
  const failures: SweepFailure[] = [];
  const n = theme.neutralHex;
  n.slice(0, DERIVED_MUTED_SURFACE_STEPS).forEach((surface, i) => {
    const r = contrast(mutedTone, surface);
    if (r < AA_TEXT) {
      failures.push({
        guarantee: "G2c",
        cell: `${cellPrefix}/muted-fg/step${i + 1}`,
        ratio: round2(r),
        floor: AA_TEXT,
      });
    }
  });
  return failures;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
