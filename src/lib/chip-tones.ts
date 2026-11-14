/**
 * Single source of truth for chip / pill colour classes (#156).
 *
 * The admin tables render many small status and label chips: the shared
 * `StatusChip`, the payments/bookings `MiniChip`, and the members `InfoChip`.
 * Each of those previously carried its OWN private copy of the same tone -> class
 * map, so they could silently drift. This module holds the one map they all use.
 *
 * There are two families of tone, both backed by CSS tokens in `globals.css`:
 *
 *  - SEMANTIC tones (`neutral | info | success | warning | danger`) carry MEANING
 *    and back `StatusChip`. Every pair dark-adapts and clears WCAG AA (verified
 *    in `src/lib/__tests__/status-chip.test.tsx`).
 *  - CATEGORICAL scales (`cat1..cat6`) exist only to keep sibling values within
 *    one column visually DISTINCT (e.g. the settlement kinds, the payment states,
 *    the booking statuses). They are the generated substrate scales, so they
 *    follow the club theme and stay AA by construction.
 *
 * Meaning is always carried by icon + label, never colour alone.
 */

/** Meaning-carrying tones used by StatusChip. */
export type SemanticTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Distinguishing-only categorical scales (#2188 P2, #2218 P4 added cat6). These
 *  are the generated cat1..cat6 12-step scales exposed as utilities in
 *  `globals.css` (the plan-lock "numbered steps stay exposed" clause). They are
 *  the ONLY categorical chip vocabulary: sibling column values that carry no
 *  severity (booking/payment sub-states, audit categories, member badges) reach a
 *  distinct, theme-following hue through cat1..cat6. cat6 (#2218) supplied the
 *  6th booking distinguisher and let the legacy ad-hoc `--hue-*` accent pairs
 *  retire entirely. */
export type CategoricalScale =
  | "cat1"
  | "cat2"
  | "cat3"
  | "cat4"
  | "cat5"
  | "cat6";

/** Every tone a chip can render. */
export type ChipTone = SemanticTone | CategoricalScale;

/** Tone -> `bg-*-muted text-*` utility classes.
 *
 *  Neutral pairs `--foreground` with `--muted` rather than `--muted-foreground`.
 *  The original reason was that `--muted-foreground` failed AA on `--muted`;
 *  inside `app-theme-scope` that is no longer true, because #2145 replaced the
 *  inert `--muted-foreground` (an alias of `--foreground`) with a derived tone
 *  that is CLAMPED to clear AA on `--muted` in both modes. The pairing stays on
 *  `--foreground` for a different and still-valid reason: a status chip carries
 *  MEANING, so it reads at full text weight like its four coloured siblings —
 *  each of which uses its own accent, not a de-emphasised one. It also keeps the
 *  chip readable in the default (non-club-themed) shadcn scope, where
 *  `--muted-foreground` is a mid-grey this project does not gate. */
//  #2188 P2 — the semantic and categorical tones render on the generated 12-step
//  scales via the signed-off chip pattern `bg-<scale>-3 text-<scale>-11` (step-3
//  tint / step-11 accent text). This is the pattern P1's guarantee sweep pins as
//  G2b (`bg step-3 / text step-11` clears WCAG AA for every scale, both modes), so
//  the chips follow the club theme and stay AA by construction. `neutral` keeps
//  the shadcn role tokens (neutrals are not exposed as numbered steps). #2218 P4
//  added cat6 and RETIRED the legacy `--hue-*` accent pairs entirely — every
//  former hue consumer now reaches a cat scale.
export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-3 text-info-11",
  success: "bg-success-3 text-success-11",
  warning: "bg-warning-3 text-warning-11",
  danger: "bg-danger-3 text-danger-11",
  cat1: "bg-cat1-3 text-cat1-11",
  cat2: "bg-cat2-3 text-cat2-11",
  cat3: "bg-cat3-3 text-cat3-11",
  cat4: "bg-cat4-3 text-cat4-11",
  cat5: "bg-cat5-3 text-cat5-11",
  cat6: "bg-cat6-3 text-cat6-11",
};

/** Tone -> solid `bg-<scale>-9` swatch fill, for TEXT-FREE marks only: legend
 *  swatches, a bar's status stripe, a list dot (#4466). Step-9 is not an AA text
 *  background, so a mark that carries text takes `CHIP_TONE_CLASSES` instead;
 *  `brand-color-source-contract.test.ts` rejects a step-9 fill paired with a text
 *  utility. `neutral` has no numbered scale, so it takes the theme's `bg-muted`. */
export const CHIP_TONE_SWATCH_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-muted",
  info: "bg-info-9",
  success: "bg-success-9",
  warning: "bg-warning-9",
  danger: "bg-danger-9",
  cat1: "bg-cat1-9",
  cat2: "bg-cat2-9",
  cat3: "bg-cat3-9",
  cat4: "bg-cat4-9",
  cat5: "bg-cat5-9",
  cat6: "bg-cat6-9",
};
