/*
 * App-scope substrate emission (#2187 P1, epic #2181) — the RESTYLE wire-up.
 *
 * The per-club theme lives in the DB, so the generated substrate is emitted at
 * RENDER time: `buildClubThemeAppCss` (app shells) and the wizard preview both
 * call in here to turn a club's three seeds into the full generated
 * custom-property set, for BOTH light and dark, as `.app-theme-scope` custom
 * properties. `globals.css`'s static `.app-theme-scope` (light) and
 * `.dark .app-theme-scope` (dark) blocks then CONSUME those props via
 * `var(--gen-<token>, <static-fallback>)` / `var(--gen-<token>-dark, …)`, so a
 * no-stylesheet page still paints the shipped default palette.
 *
 * What is emitted, per mode:
 *  - the raw generated scale steps `--gen-<scale>-<n>` (light) /
 *    `--gen-<scale>-dark-<n>` (dark) for neutral + every hue scale (the tail
 *    consumers of D15's "numbered steps stay exposed");
 *  - the resolved ALIAS role tokens `--gen-<role>` / `--gen-<role>-dark` per
 *    `aliases.ts` (J1 neutral-10 input/ring, D13 sidebar, chart map), plus the
 *    role FOREGROUND pairs the app block needs that aliases.ts does not name
 *    (card/popover/secondary/accent foreground = neutral-12; primary-foreground
 *    = A4 on-solid recompute; --app-accent-text = neutral-12 ink; --border =
 *    neutral-6);
 *  - the A6 candidate-ii card treatment is the neutral-1 card / neutral-2 page
 *    separation the alias map already gives, plus the J8 card shadow variables.
 *
 * `--muted-foreground` is deliberately NOT routed through here: it stays on the
 * measured-AA derived tone (`deriveAppMutedForeground`, #2145), which is a
 * gate-measurable solid endpoint rather than a raw neutral step.
 */
import {
  buildThemeSubstrate,
  HUE_SCALES,
  type BuiltTheme,
  type ThemeSeeds,
} from "./theme-substrate";
import {
  CORE_ALIASES,
  SIDEBAR_ALIASES,
  CHART_ALIASES,
  resolveAlias,
  type AliasEntry,
} from "./aliases";
import { must } from "./index-guards";

/**
 * J8 card shadow (A6 candidate ii, from measurements.json). Mode-specific.
 *
 * Emitted as `--gen-card-shadow` / `--gen-card-shadow-dark` and consumed by the
 * `.app-theme-scope .bg-card.shadow` rule in `globals.css`, whose static
 * fallbacks are pinned against these literals by `app-theme-layout-contract.test.ts`.
 * `CARD_SHADOW.light` is the same string as `G5A_CARD_SEPARATION.boxShadow`.
 */
export const CARD_SHADOW = {
  light: "0 1px 2px 0 #040a054a, 0 1px 3px 0 #020b037b",
  dark: "0 1px 2px 0 #00000066, 0 1px 3px 0 #000000a6",
} as const;

/**
 * Role tokens the `.app-theme-scope` block declares, in emission order, mapped
 * to their alias entry. Sourced from the data alias map where it names them,
 * with the foreground/ink pairs the block also needs added explicitly (these
 * are text-on-surface roles aliases.ts does not enumerate). `--muted-foreground`
 * is intentionally absent (see the module header).
 */
const APP_ROLE_ALIASES: Record<string, AliasEntry> = {
  background: CORE_ALIASES["--background"],
  foreground: CORE_ALIASES["--foreground"],
  card: CORE_ALIASES["--card"],
  "card-foreground": { scale: "neutral", step: 12 },
  popover: CORE_ALIASES["--popover"],
  "popover-foreground": { scale: "neutral", step: 12 },
  primary: CORE_ALIASES["--primary"],
  "primary-foreground": { from: "A4", scale: "accent" },
  secondary: CORE_ALIASES["--secondary"],
  "secondary-foreground": { scale: "neutral", step: 12 },
  muted: CORE_ALIASES["--muted"],
  accent: CORE_ALIASES["--accent"],
  "accent-foreground": { scale: "neutral", step: 12 },
  "app-accent-text": { scale: "neutral", step: 12 },
  border: { scale: "neutral", step: 6 },
  input: CORE_ALIASES["--input"],
  ring: CORE_ALIASES["--ring"],
  sidebar: SIDEBAR_ALIASES["--sidebar"],
  "sidebar-foreground": SIDEBAR_ALIASES["--sidebar-foreground"],
  "sidebar-primary": SIDEBAR_ALIASES["--sidebar-primary"],
  "sidebar-primary-foreground": SIDEBAR_ALIASES["--sidebar-primary-foreground"],
  "sidebar-accent": SIDEBAR_ALIASES["--sidebar-accent"],
  "sidebar-accent-foreground": SIDEBAR_ALIASES["--sidebar-accent-foreground"],
  "sidebar-border": SIDEBAR_ALIASES["--sidebar-border"],
  "sidebar-ring": SIDEBAR_ALIASES["--sidebar-ring"],
  ...Object.fromEntries(
    CHART_ALIASES.map((c) => [
      c.token.slice(2),
      { scale: c.scale, step: c.step } as AliasEntry,
    ]),
  ),
};

/** Resolve every role token for one built mode. `lightNeutral12` feeds A4. */
function resolveRoleTokens(
  theme: BuiltTheme,
  lightNeutral12: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, entry] of Object.entries(APP_ROLE_ALIASES)) {
    out[role] = resolveAlias(entry, theme, lightNeutral12);
  }
  return out;
}

export interface AppThemeTokenSet {
  /** `--gen-*` (light) and `--gen-*-dark` (dark) → hex, in emission order. */
  tokens: Record<string, string>;
}

/**
 * The full generated custom-property set for a club's seeds, ready to serialise
 * onto `.app-theme-scope`. Deterministic pure function of the seeds.
 */
export function buildAppThemeTokens(seeds: ThemeSeeds): AppThemeTokenSet {
  const light = buildThemeSubstrate(seeds, "light");
  const dark = buildThemeSubstrate(seeds, "dark");
  const lightNeutral12 = must(light.neutralHex[11], "buildAppThemeTokens: light neutral ramp has no step 12");

  const tokens: Record<string, string> = {};

  // Raw scale steps (the exposed tail): neutral + every hue scale, both modes.
  const scaleNames = ["neutral", ...HUE_SCALES] as const;
  for (const scale of scaleNames) {
    const l = must(light.scales[scale], `buildAppThemeTokens: light theme has no "${scale}" scale`);
    const d = must(dark.scales[scale], `buildAppThemeTokens: dark theme has no "${scale}" scale`);
    l.hex.forEach((hex, i) => {
      tokens[`--gen-${scale}-${i + 1}`] = hex;
    });
    d.hex.forEach((hex, i) => {
      tokens[`--gen-${scale}-dark-${i + 1}`] = hex;
    });
  }

  // Resolved role tokens (what the static blocks consume).
  const roleLight = resolveRoleTokens(light, lightNeutral12);
  const roleDark = resolveRoleTokens(dark, lightNeutral12);
  for (const role of Object.keys(APP_ROLE_ALIASES)) {
    tokens[`--gen-${role}`] = must(roleLight[role], `buildAppThemeTokens: role "${role}" missing from light role tokens`);
    tokens[`--gen-${role}-dark`] = must(roleDark[role], `buildAppThemeTokens: role "${role}" missing from dark role tokens`);
  }

  // J8 card shadow variables (A6 candidate ii).
  tokens["--gen-card-shadow"] = CARD_SHADOW.light;
  tokens["--gen-card-shadow-dark"] = CARD_SHADOW.dark;

  return { tokens };
}

/** Serialise the token set as CSS declarations (`--gen-x:hex;…`), no wrapper. */
export function serializeAppThemeTokens(seeds: ThemeSeeds): string {
  const { tokens } = buildAppThemeTokens(seeds);
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
}

/**
 * The semantic + categorical scales exposed as consumable step utilities in
 * globals.css (#2188 P2). Neutral steps are deliberately NOT exposed.
 */
export const EXPOSED_STEP_SCALES = [
  "success",
  "warning",
  "info",
  "danger",
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "cat6",
] as const;

/**
 * Light-mode step variables (`--<scale>-<step>:<hex>;…`) for the exposed scales,
 * for a scope that consumes the step utilities but sits OUTSIDE `.app-theme-scope`
 * — i.e. the website (`.website-theme`). The website scope is light-only, so only
 * the light values are emitted. Same generated club values as the app scope, so a
 * `bg-danger-3` validation callout on a public page follows the club exactly like
 * its admin twin (and the @theme static fallback still stands in with no sheet).
 */
export function serializeWebsiteStepTokens(seeds: ThemeSeeds): string {
  const { tokens } = buildAppThemeTokens(seeds);
  let out = "";
  for (const scale of EXPOSED_STEP_SCALES) {
    for (let step = 1; step <= 12; step += 1) {
      out += `--${scale}-${step}:${tokens[`--gen-${scale}-${step}`]};`;
    }
  }
  return out;
}

/**
 * The default palette's resolved role tokens, for the static globals.css
 * fallbacks. Keyed by the role name (no `--gen-` prefix). Used by the contract
 * test to pin `var(--gen-<role>, <fallback>)` against the derivation so the CSS
 * literal and the code cannot drift.
 */
export function defaultAppRoleFallbacks(seeds: ThemeSeeds): {
  light: Record<string, string>;
  dark: Record<string, string>;
} {
  const light = buildThemeSubstrate(seeds, "light");
  const dark = buildThemeSubstrate(seeds, "dark");
  const lightNeutral12 = must(light.neutralHex[11], "defaultAppRoleFallbacks: light neutral ramp has no step 12");
  return {
    light: resolveRoleTokens(light, lightNeutral12),
    dark: resolveRoleTokens(dark, lightNeutral12),
  };
}

/**
 * The public website's semantic role tokens (#2217, theme burndown ITEM A),
 * mapped onto generated substrate steps — the migration OFF the `--brand-*`
 * shims and `color-mix()` recipes the `.website-theme` block used to carry.
 *
 * This is NOT the app's neutral alias map: the public site keeps its BRANDED
 * look — a light page, a GOLD (accent) primary/action, and a DARK charcoal
 * (neutral-12) navigation — so the mapping is authored fresh here rather than
 * reusing `APP_ROLE_ALIASES` (whose sidebar is a LIGHT neutral-1 surface). The
 * three deliberately-accent roles are `--primary`, `--ring`, and the
 * `--sidebar-primary` pair; every other role is a neutral step so the chrome
 * stays quiet and the brand accent stays the one thing that pops.
 *
 * Light-only: the website scope has no dark mode (mirrors
 * `serializeWebsiteStepTokens`). `--destructive`/`--destructive-foreground` are
 * intentionally absent — they are fixed oklch values, not brand-derived, and
 * stay declared statically in the `.website-theme` globals.css block.
 */
export const WEBSITE_ROLE_ALIASES: Record<string, AliasEntry> = {
  // Light page surfaces: neutral-1 is the lightest step (page/card/popover).
  background: { scale: "neutral", step: 1 },
  foreground: { scale: "neutral", step: 12 },
  card: { scale: "neutral", step: 1 },
  "card-foreground": { scale: "neutral", step: 12 },
  popover: { scale: "neutral", step: 1 },
  "popover-foreground": { scale: "neutral", step: 12 },
  // Branded GOLD primary/action, with the AA-recomputed on-solid foreground.
  primary: { scale: "accent", step: 9 },
  "primary-foreground": { from: "A4", scale: "accent" },
  secondary: { scale: "neutral", step: 3 },
  "secondary-foreground": { scale: "neutral", step: 12 },
  muted: { scale: "neutral", step: 3 },
  "muted-foreground": { scale: "neutral", step: 11 },
  // Hover surface — one band darker than muted/secondary (neutral-3).
  accent: { scale: "neutral", step: 4 },
  "accent-foreground": { scale: "neutral", step: 12 },
  border: { scale: "neutral", step: 6 },
  input: { scale: "neutral", step: 7 },
  // KEEP a branded GOLD focus ring — the one deliberately-accent role among the
  // hairline tokens (the app scope pins --ring to neutral-10; the website does
  // not, because the gold ring is part of the public brand identity).
  ring: { scale: "accent", step: 9 },
  // KEEP the DARK charcoal nav: sidebar surface is neutral-12 with light ink.
  sidebar: { scale: "neutral", step: 12 },
  "sidebar-foreground": { scale: "neutral", step: 1 },
  "sidebar-primary": { scale: "accent", step: 9 },
  "sidebar-primary-foreground": { from: "A4", scale: "accent" },
  "sidebar-accent": { scale: "neutral", step: 11 },
  "sidebar-accent-foreground": { scale: "neutral", step: 1 },
  "sidebar-border": { scale: "neutral", step: 11 },
  "sidebar-ring": { scale: "accent", step: 9 },
};

/** Resolve every website role token against the LIGHT substrate. */
function resolveWebsiteRoleTokens(seeds: ThemeSeeds): Record<string, string> {
  const light = buildThemeSubstrate(seeds, "light");
  const lightNeutral12 = must(light.neutralHex[11], "resolveWebsiteRoleTokens: light neutral ramp has no step 12");
  const out: Record<string, string> = {};
  for (const [role, entry] of Object.entries(WEBSITE_ROLE_ALIASES)) {
    out[role] = resolveAlias(entry, light, lightNeutral12);
  }
  return out;
}

/**
 * The website's semantic role tokens (`--<role>:<hex>;…`) as RESOLVED light-mode
 * hexes, for a scope OUTSIDE `.app-theme-scope` — the public site
 * (`.website-theme`). Injected by `buildClubThemeCss` so per-club values override
 * the static default-palette fallbacks the `.website-theme` block declares in
 * globals.css. The branded look (gold primary/ring, dark nav) is preserved by
 * `WEBSITE_ROLE_ALIASES`. Light-only.
 */
export function serializeWebsiteRoleTokens(seeds: ThemeSeeds): string {
  const roles = resolveWebsiteRoleTokens(seeds);
  let out = "";
  for (const role of Object.keys(WEBSITE_ROLE_ALIASES)) {
    out += `--${role}:${roles[role]};`;
  }
  return out;
}

/**
 * The default palette's resolved website role hexes, for the static globals.css
 * `.website-theme` fallbacks. Keyed by role name (no prefix). Pinned by the
 * contract test so the CSS literal and the resolver cannot drift.
 */
export function defaultWebsiteRoleFallbacks(
  seeds: ThemeSeeds,
): Record<string, string> {
  return resolveWebsiteRoleTokens(seeds);
}
