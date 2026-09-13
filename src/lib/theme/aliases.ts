/*
 * Shadcn/app token alias map — DATA (#2187 P1, mirrors docs/theme/phase0/data/aliases.json).
 *
 * Component token names are unchanged; they are declared here as aliases onto
 * generated scale steps. This is data, not code: the aliases.json artifact is the
 * source of record and aliases.test.ts pins that this table matches it.
 *
 * R9 — computed entries are NOT literals:
 *  - `from: "A2"` (--input/--ring/--sidebar-ring) resolves to neutral step 10
 *    UNIFORMLY (J1 pin), overriding the marginal neutral-9 light first-pass that
 *    aliases.json's note describes. We encode the rule; we do not copy an A2 hex.
 *  - `from: "A4"` (solid-foreground entries) resolves via a4SolidForeground: keep
 *    the generator's on-solid pick iff ≥4.5:1, else white → light neutral-12 → black.
 *  - `from: "D11.*"` (border) — P1 ships the signed-off variant (b) Radix-subtle:
 *    --border = neutral step 6.
 */
import type { BuiltTheme } from "./theme-substrate";
import { a4SolidForeground } from "./theme-substrate";
import { must } from "./index-guards";

export interface StepRef {
  scale: string;
  step: number; // 1-based
  note?: string;
}
export interface ComputedRef {
  from: "A2" | "A4" | "D11.variant_a_computed_3to1";
  scale?: string; // A4 references a scale's solid step
  note?: string;
}
export type AliasEntry = StepRef | ComputedRef;

function isStepRef(e: AliasEntry): e is StepRef {
  return (e as StepRef).scale !== undefined && (e as ComputedRef).from === undefined;
}

/** Neutral step (1-based) that --input/--ring/--sidebar-ring pin to (J1). */
export const A2_INPUT_RING_NEUTRAL_STEP = 10;
/** Border step (1-based) for the signed-off variant (b) Radix-subtle. */
export const BORDER_NEUTRAL_STEP = 6;
/** Neutral step (1-based) for `--accent` — one band off `--muted`/`--secondary`
 * (neutral-3), the #2144 hover-surface fix. Exported so the derived
 * muted-foreground clamp (`deriveAppMutedForeground`) checks the SAME step this
 * table paints, rather than a copied literal that could drift. */
export const ACCENT_NEUTRAL_STEP = 4;

/** Core shadcn tokens. `--accent` = neutral-4 is one band off `--muted`/`--secondary`
 * = neutral-3 — the structural fix for the seven hover-dead #2144 buttons. */
/*
 * `satisfies` (not `: Record<string, AliasEntry>`) keeps each key's literal
 * name in the inferred type, so `CORE_ALIASES["--background"]` resolves to
 * `AliasEntry`, not `AliasEntry | undefined` — the lookups below are always
 * one of these named tokens, never an arbitrary string. Still checked against
 * `Record<string, AliasEntry>`, so a typo'd entry still fails to typecheck.
 */
export const CORE_ALIASES = {
  "--background": { scale: "neutral", step: 2 },
  "--card": { scale: "neutral", step: 1 },
  "--popover": { scale: "neutral", step: 1 },
  "--muted": { scale: "neutral", step: 3 },
  "--accent": { scale: "neutral", step: ACCENT_NEUTRAL_STEP, note: "hover/neutral accent surface" },
  "--primary": { scale: "accent", step: 9 },
  "--muted-foreground": { scale: "neutral", step: 11 },
  "--foreground": { scale: "neutral", step: 12 },
  "--secondary": { scale: "neutral", step: 3, note: "D13: quiet neutral surface, aligns with --muted" },
  "--input": { from: "A2", note: "J1 pin: neutral-10 uniformly" },
  "--ring": { from: "A2", note: "J1 pin: neutral-10 uniformly (same as --input)" },
} as const satisfies Record<string, AliasEntry>;

export const DESTRUCTIVE_DANGER_ALIASES = {
  "--destructive": { scale: "danger", step: 9, note: "D14: exactly one red" },
  "--danger": { scale: "danger", step: 9 },
  "--destructive-foreground": { from: "A4", scale: "danger", note: "recomputed on-solid fg" },
} as const satisfies Record<string, AliasEntry>;

/** D13 light sidebar surfaces from neutral 1–4 light steps. */
export const SIDEBAR_ALIASES = {
  "--sidebar": { scale: "neutral", step: 1 },
  "--sidebar-foreground": { scale: "neutral", step: 12 },
  "--sidebar-accent": { scale: "neutral", step: 3 },
  "--sidebar-accent-foreground": { scale: "neutral", step: 12 },
  "--sidebar-border": { scale: "neutral", step: 4, note: "D13: sidebar surfaces from neutral 1–4" },
  "--sidebar-primary": { scale: "accent", step: 9 },
  "--sidebar-primary-foreground": { from: "A4", scale: "accent" },
  "--sidebar-ring": { from: "A2" },
} as const satisfies Record<string, AliasEntry>;

/** D15/J7 chart mapping: --chart-1..5 = cat1–5 step 9. */
export const CHART_ALIASES: Array<{ token: string; scale: string; step: number }> = [1, 2, 3, 4, 5].map(
  (i) => ({ token: `--chart-${i}`, scale: `cat${i}`, step: 9 }),
);

/** J7 finance 8-slot: cat1–5 step 9, then cat1–3 step 7. */
export const CHART_FINANCE_8SLOT: Array<{ series: number; scale: string; step: number }> = [
  { series: 1, scale: "cat1", step: 9 },
  { series: 2, scale: "cat2", step: 9 },
  { series: 3, scale: "cat3", step: 9 },
  { series: 4, scale: "cat4", step: 9 },
  { series: 5, scale: "cat5", step: 9 },
  { series: 6, scale: "cat1", step: 7 },
  { series: 7, scale: "cat2", step: 7 },
  { series: 8, scale: "cat3", step: 7 },
];

/**
 * Resolve an alias entry against a built theme to a concrete hex.
 * @param lightNeutral12 the SAME seed set's light-mode neutral-12, for the A4 ladder.
 */
export function resolveAlias(entry: AliasEntry, theme: BuiltTheme, lightNeutral12: string): string {
  if (isStepRef(entry)) {
    const scale = theme.scales[entry.scale];
    if (!scale) throw new Error(`resolveAlias: no scale ${entry.scale}`);
    return must(scale.hex[entry.step - 1], `resolveAlias: scale ${entry.scale} has no step ${entry.step}`);
  }
  switch (entry.from) {
    case "A2":
      return must(
        theme.neutralHex[A2_INPUT_RING_NEUTRAL_STEP - 1],
        `resolveAlias A2: no neutral step ${A2_INPUT_RING_NEUTRAL_STEP}`,
      );
    case "D11.variant_a_computed_3to1": {
      // Not shipped in P1 (variant b is); resolve for completeness.
      const surface = must(theme.neutralHex[1], "resolveAlias D11: no neutral step 2");
      for (const c of theme.neutralHex) {
        if (contrastLum(c, surface) >= 3) return c;
      }
      return must(
        theme.neutralHex[BORDER_NEUTRAL_STEP - 1],
        `resolveAlias D11: no neutral step ${BORDER_NEUTRAL_STEP}`,
      );
    }
    case "A4": {
      if (!entry.scale) throw new Error("resolveAlias A4: missing scale");
      const s = theme.scales[entry.scale];
      if (!s) throw new Error(`resolveAlias A4: no scale ${entry.scale}`);
      return a4SolidForeground(
        must(s.hex[8], `resolveAlias A4: scale ${entry.scale} has no step 9`),
        s.generatorContrast as string,
        lightNeutral12,
      ).pick;
    }
  }
}

// local luminance-contrast (kept private; theme-substrate exposes the shared one)
function relLumChannel(full: string, byteOffset: number): number {
  const c = parseInt(full.slice(byteOffset, byteOffset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLum(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return 0.2126 * relLumChannel(full, 0) + 0.7152 * relLumChannel(full, 2) + 0.0722 * relLumChannel(full, 4);
}
function contrastLum(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
