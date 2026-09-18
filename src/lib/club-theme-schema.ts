import {
  buildNeutralRamp,
  type ThemeSeeds,
} from "@/lib/theme/theme-substrate";
import { ACCENT_NEUTRAL_STEP } from "@/lib/theme/aliases";
import {
  serializeAppThemeTokens,
  serializeWebsiteStepTokens,
  serializeWebsiteRoleTokens,
} from "@/lib/theme/app-tokens";
import { must } from "@/lib/theme/index-guards";

export const CLUB_THEME_ID = "default";
/**
 * READ-PATH bound on the decoded logo data-URI, enforced by
 * `isValidLogoDataUrl` / `sanitiseLogoDataUrl` / `normaliseThemeValues`.
 *
 * Do NOT lower this to shrink page payloads (#2322). It gates what already-
 * stored rows are allowed to render, and deployments in the field hold logos
 * close to the limit (the Tokoroa fork stores ~860 KB). Tightening the read
 * path would silently null those logos the moment the deployment upgraded.
 * The smaller budget lives on the WRITE path instead
 * (`MAX_LOGO_DATA_URL_WRITE_BYTES` in `club-theme-update-schema.ts`), where it
 * rejects new oversized uploads without touching rows that already exist.
 */
export const MAX_LOGO_DATA_URL_BYTES = 900_000;

/**
 * The THREE seed colours a club picks (#2187 P1, D2/D17 — 1 required + 2
 * optional). The seven-colour hand-rolled palette is gone: these three seed the
 * vendored Radix generator, which derives the full 12-step light/dark substrate
 * (see `@/lib/theme/theme-substrate`). Stored verbatim in the `brandGold` /
 * `brandDeep` / `brandSafety` columns; the four former columns (the charcoal,
 * ridge, mist, and snow surfaces) are dead to code and derived at render time
 * from the substrate neutral ramp (see `deriveBrandShims`). They remain in the
 * DB (P4 drops them).
 *
 *  - `brandGold`   → generator ACCENT (the club's primary brand colour). Required.
 *  - `brandDeep`   → NEUTRAL CHARACTER source; its hue tints the grey ramp. Optional.
 *  - `brandSafety` → generator SUPPORT accent. Optional.
 */
export const CLUB_THEME_COLOUR_FIELDS = [
  {
    key: "brandGold",
    label: "Primary accent",
    role: "The club's main brand colour. Seeds every accent surface and action.",
    required: true,
  },
  {
    key: "brandDeep",
    label: "Neutral character",
    role: "Tints the grey ramp toward this hue. Leave to pair a neutral grey with the accent.",
    required: false,
  },
  {
    key: "brandSafety",
    label: "Support accent",
    role: "An optional secondary accent for highlights. Leave to omit a support colour.",
    required: false,
  },
] as const;

export type ClubThemeColourKey =
  (typeof CLUB_THEME_COLOUR_FIELDS)[number]["key"];

export const CLUB_THEME_FONT_KEYS = [
  "INTER",
  "LEAGUE_SPARTAN",
  "LORA",
  "SOURCE_SERIF_4",
  "NUNITO_SANS",
  "OSWALD",
] as const;

export type ClubThemeFontKey = (typeof CLUB_THEME_FONT_KEYS)[number];

export const CLUB_THEME_FONT_OPTIONS: Array<{
  key: ClubThemeFontKey;
  label: string;
  role: "Body" | "Heading" | "Flexible";
  cssVariable: string;
}> = [
  {
    key: "INTER",
    label: "Inter",
    role: "Body",
    cssVariable: "--font-theme-inter",
  },
  {
    key: "LEAGUE_SPARTAN",
    label: "League Spartan",
    role: "Heading",
    cssVariable: "--font-theme-league-spartan",
  },
  {
    key: "LORA",
    label: "Lora",
    role: "Heading",
    cssVariable: "--font-theme-lora",
  },
  {
    key: "SOURCE_SERIF_4",
    label: "Source Serif 4",
    role: "Heading",
    cssVariable: "--font-theme-source-serif-4",
  },
  {
    key: "NUNITO_SANS",
    label: "Nunito Sans",
    role: "Flexible",
    cssVariable: "--font-theme-nunito-sans",
  },
  {
    key: "OSWALD",
    label: "Oswald",
    role: "Heading",
    cssVariable: "--font-theme-oswald",
  },
];

export type ClubThemeValues = Record<ClubThemeColourKey, string> & {
  headingFontKey: ClubThemeFontKey;
  bodyFontKey: ClubThemeFontKey;
  /**
   * Served-image logo (#2322): a same-origin `/api/images/<id>` path. Takes
   * precedence over `logoDataUrl` everywhere the logo renders.
   */
  logoUrl: string | null;
  logoDataUrl: string | null;
  rawCss: string;
};

export const DEFAULT_CLUB_THEME_VALUES: ClubThemeValues = {
  // Generic "Aotearoa" default palette (#1807, contracted to 3 seeds in #2187):
  // a glacial-teal primary accent, a deep bush-green neutral character, and a
  // terracotta support accent. Reads as generic New Zealand alpine, not any
  // specific club (any fork's own brand colour lives only in that deployment's
  // ClubTheme DB row, never in this shipping default).
  // These three seed the vendored Radix generator, which derives the full
  // 12-step substrate whose contrast is guaranteed by construction (see the
  // guarantee sweep in `@/lib/theme/guarantees`). The former charcoal/mist/snow/
  // ridge surfaces are derived from the neutral ramp (see `deriveBrandShims`).
  brandGold: "#57b3ab",
  brandDeep: "#17231c",
  brandSafety: "#b04d28",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoUrl: null,
  logoDataUrl: null,
  rawCss: "",
};

const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const LOGO_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
/**
 * The ONLY logo URL form accepted, anywhere (#2322). Anchored, same-origin, and
 * limited to the id charset `extractImageIds` recognises, so the two stay
 * consistent and a config-transfer bundle cannot smuggle in a form the export
 * scanner would miss. No scheme, no `//host`, no traversal — the value is
 * interpolated straight into an `<img src>`.
 *
 * Unlike `logoDataUrl` this is enforced on the READ path as well as the write
 * path: the column is new, so no legacy row can be nulled by strictness.
 *
 * A hand-edited row or a crafted bundle bypasses the zod write schema, so every
 * read path sanitises independently. There are three, and they are the complete
 * set of ways a stored logo reaches a browser:
 *   1. `normaliseThemeValues` — every website/admin render of the theme.
 *   2. `buildDisplayState` (`lodge-display-state.ts`) — the kiosk, which reads
 *      the columns directly rather than through `normaliseThemeValues`, and so
 *      calls `sanitiseLogoUrl`/`sanitiseLogoDataUrl` itself.
 *   3. `applySiteContent` (config-transfer import) — normalises before writing,
 *      so a hostile bundle cannot seed a value the render paths would trust.
 */
const LOGO_URL_PATTERN = /^\/api\/images\/[A-Za-z0-9_-]+$/;

/**
 * A user-entered theme seed is valid iff it is a 6-digit hex colour (#2187 D6:
 * hex-only). The oklch paste-in path is gone — the generator seeds are hex, and
 * the wizard's native colour picker only emits hex. Internal derivation maths
 * (the curated `*-muted` surfaces, the app muted-tone clamp) still measures
 * oklch literals; this validator gates only the user-INPUT path.
 */
export function isValidThemeColour(value: string): boolean {
  return HEX_COLOUR_PATTERN.test(value.trim());
}

/** Map the three stored seed columns onto the generator's seed shape. */
export function themeSeedsFromValues(theme: ClubThemeValues): ThemeSeeds {
  return {
    accent: theme.brandGold,
    neutralSource: theme.brandDeep,
    support: theme.brandSafety,
  };
}

export interface BrandShims {
  gold: string;
  charcoal: string;
  deep: string;
  ridge: string;
  mist: string;
  snow: string;
  safety: string;
}

/**
 * The seven legacy `--brand-*` values, derived from the 3 seeds via the light
 * substrate neutral ramp (#2187). Old shims (`bg-brand-mist`, the website-theme
 * `color-mix()` recipes, the email palette) keep functioning through P1 by
 * consuming these; P2/P3 delete the shims. The four former-column surfaces map
 * to neutral steps chosen to preserve their structural role:
 *   snow → neutral-1 (lightest page/card), mist → neutral-3 (quiet surface),
 *   ridge → neutral-8 (hairline/mid), charcoal → neutral-12 (darkest ink/nav).
 * The three real seeds pass through verbatim. Property names are unprefixed
 * ROLES, not column names — the four former columns are dead to code.
 */
export function deriveBrandShims(theme: ClubThemeValues): BrandShims {
  const n = buildNeutralRamp(themeSeedsFromValues(theme), "light");
  return {
    gold: theme.brandGold,
    deep: theme.brandDeep,
    safety: theme.brandSafety,
    snow: must(n[0], "deriveBrandShims: light neutral ramp has no step 1"),
    mist: must(n[2], "deriveBrandShims: light neutral ramp has no step 3"),
    ridge: must(n[7], "deriveBrandShims: light neutral ramp has no step 8"),
    charcoal: must(n[11], "deriveBrandShims: light neutral ramp has no step 12"),
  };
}

export function isValidLogoUrl(value: string): boolean {
  return LOGO_URL_PATTERN.test(value.trim());
}

/**
 * The logo exclusivity rule (#2322): a served-image URL wins, and when one is
 * set the inlined data URI is dropped. Storing both would leave megabytes of
 * base64 on the row that nothing renders, and lets a stale client resurrect the
 * inlined copy.
 *
 * Shared by the admin save path (`saveClubTheme`) and the config-transfer import
 * so the two cannot drift.
 */
export function resolveLogoFields(input: {
  logoUrl: string | null;
  logoDataUrl: string | null;
}): { logoUrl: string | null; logoDataUrl: string | null } {
  return {
    logoUrl: input.logoUrl,
    logoDataUrl: input.logoUrl ? null : input.logoDataUrl,
  };
}

/** The MediaImage id a logo URL points at, or null when it is not a logo URL. */
export function logoImageIdFromUrl(value: string | null): string | null {
  if (!value || !isValidLogoUrl(value)) return null;
  return value.trim().slice("/api/images/".length);
}

/**
 * Decoded byte length of a logo data URI, or null when the value is not a
 * well-formed one. Exported so the write path can enforce its own (much
 * smaller) budget without redefining what "decoded size" means — see
 * `MAX_LOGO_DATA_URL_WRITE_BYTES`.
 */
export function logoDataUrlByteLength(value: string): number | null {
  const match = value.trim().match(LOGO_DATA_URL_PATTERN);
  if (!match) {
    return null;
  }

  // The pattern's 2nd group is mandatory (no trailing `?`), so a successful
  // match always captures it.
  const base64 = must(match[2], "logoDataUrlByteLength: matched data URI has no base64 capture group");
  if (base64.length % 4 !== 0) {
    return null;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function isValidLogoDataUrl(value: string): boolean {
  const byteLength = logoDataUrlByteLength(value);
  return byteLength !== null && byteLength <= MAX_LOGO_DATA_URL_BYTES;
}

function fontOption(fontKey: ClubThemeFontKey) {
  return CLUB_THEME_FONT_OPTIONS.find((font) => font.key === fontKey);
}

export function fontLabel(fontKey: ClubThemeFontKey): string {
  return fontOption(fontKey)?.label ?? fontKey;
}

export function fontCssVariable(fontKey: ClubThemeFontKey): string {
  return (
    fontOption(fontKey)?.cssVariable ??
    fontOption(DEFAULT_CLUB_THEME_VALUES.bodyFontKey)?.cssVariable ??
    "--font-theme-inter"
  );
}

// test seam
// Strip any </style...> closing-tag sequence (case-insensitive). This is
// the only HTML breakout vector from inside a <style> element — browsers use
// rawtext mode and close the element on </style regardless of nesting. No
// valid CSS ever contains that sequence, so silent removal is safe and lossless.
export function sanitiseRawCss(value: string): string {
  // Repeated to a FIXPOINT, and this is the whole security property (#2420
  // review). `String.replace` makes ONE pass over the ORIGINAL string: it never
  // re-scans text that its own deletions bring together. A single pass was
  // therefore a reassembly bypass, verified by execution before this fix:
  //
  //   "</sty</style>le><script>alert(1)</script>"
  //     one pass  -> "</style><script>alert(1)</script>"   ← live breakout
  //     fixpoint  -> "<script>alert(1)</script>"           ← inert inside <style>
  //
  // The surviving `<script>` text is harmless: nothing but `</style` leaves
  // rawtext mode, so with every one of them gone the remainder is CSS text the
  // browser never parses as markup.
  //
  // The `>` is OPTIONAL so the postcondition is checkable rather than
  // approximate: the output contains no `</style` in any case, full stop. A
  // trailing `</style` with no `>` of its own could otherwise borrow the `>`
  // from the closing tag the consumer writes right after it.
  let sanitised = value;

  for (let previous = ""; sanitised !== previous; ) {
    previous = sanitised;
    sanitised = sanitised.replace(/<\/style[^>]*>?/gi, "");
  }

  return sanitised;
}

function sanitiseThemeColour(
  value: unknown,
  field: ClubThemeColourKey,
): string {
  return typeof value === "string" && isValidThemeColour(value)
    ? value.trim()
    : DEFAULT_CLUB_THEME_VALUES[field];
}

function sanitiseThemeFont(value: unknown, fallback: ClubThemeFontKey) {
  return CLUB_THEME_FONT_KEYS.includes(value as ClubThemeFontKey)
    ? (value as ClubThemeFontKey)
    : fallback;
}

export function sanitiseLogoDataUrl(value: unknown): string | null {
  return typeof value === "string" && isValidLogoDataUrl(value)
    ? value.trim()
    : null;
}

export function sanitiseLogoUrl(value: unknown): string | null {
  return typeof value === "string" && isValidLogoUrl(value)
    ? value.trim()
    : null;
}

export function normaliseThemeValues(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): ClubThemeValues {
  return {
    brandGold: sanitiseThemeColour(value?.brandGold, "brandGold"),
    brandDeep: sanitiseThemeColour(value?.brandDeep, "brandDeep"),
    brandSafety: sanitiseThemeColour(value?.brandSafety, "brandSafety"),
    headingFontKey: sanitiseThemeFont(
      value?.headingFontKey,
      DEFAULT_CLUB_THEME_VALUES.headingFontKey,
    ),
    bodyFontKey: sanitiseThemeFont(
      value?.bodyFontKey,
      DEFAULT_CLUB_THEME_VALUES.bodyFontKey,
    ),
    logoUrl: sanitiseLogoUrl(value?.logoUrl),
    logoDataUrl: sanitiseLogoDataUrl(value?.logoDataUrl),
    rawCss:
      typeof value?.rawCss === "string" ? sanitiseRawCss(value.rawCss) : "",
  };
}

export function buildClubThemeCss(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): string {
  const theme = normaliseThemeValues(value);
  const seeds = themeSeedsFromValues(theme);
  const base = `:root,.website-theme{${buildClubThemeDeclarations(theme)}}`;
  // #2188 P2 — the website scope (`.website-theme`, light-only) consumes the
  // semantic + categorical STEP utilities too (form callouts etc.), but sits
  // outside `.app-theme-scope`, so it needs its own generated step vars. Emitted
  // as a `.website-theme` block with the same generated club values as the app
  // scope; globals.css's @theme step tokens carry a static default fallback so a
  // no-sheet page never falls through to transparent.
  //
  // #2217 (theme burndown) — the website SEMANTIC ROLE tokens
  // (`--background`/`--primary`/`--sidebar`/…) are now also injected here, as
  // RESOLVED substrate-step hexes (`serializeWebsiteRoleTokens`), migrating the
  // `.website-theme` block OFF the `--brand-*` shims + `color-mix()` recipes it
  // used to carry. Same selector as the globals.css `.website-theme` static
  // fallbacks, so these per-club values override them by source order while
  // preserving the branded look (gold primary/ring, dark charcoal nav).
  const websiteTokens = `.website-theme{${serializeWebsiteStepTokens(
    seeds,
  )}${serializeWebsiteRoleTokens(seeds)}}`;
  const core = `${base}${websiteTokens}`;
  return theme.rawCss ? `${core}\n${theme.rawCss}` : core;
}

/** Brand/font variables for app shells. Deliberately excludes rawCss so an
 * administrator's public-site CSS cannot override app or semantic tokens.
 *
 * Also emits the two DERIVED app muted-text tones (#2145). They are computed
 * here rather than expressed as a CSS `color-mix()` for one reason: a mix is
 * unmeasurable from TypeScript, and this repository's app-scope rule is that
 * every TEXT token resolves to a solid endpoint whose contrast the gate can
 * actually measure (see `getContrastWarnings` and the endpoint-crossing case in
 * `club-theme-schema.test.ts`). Emitting a resolved colour keeps that true. */
export function buildClubThemeAppCss(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): string {
  const theme = normaliseThemeValues(value);
  const muted = deriveAppMutedForeground(theme);
  // #2187 P1 — emit the full GENERATED substrate (`--gen-*` / `--gen-*-dark`)
  // that the static `.app-theme-scope` blocks in globals.css consume. The legacy
  // `--brand-*` shims stay (buildClubThemeDeclarations) so website/app brand
  // utilities keep working through P1 (deleted in P2/P3).
  const generated = serializeAppThemeTokens(themeSeedsFromValues(theme));
  return `.app-theme-scope{${buildClubThemeDeclarations(theme)}${generated}--app-muted-foreground:${muted.light};--app-muted-foreground-dark:${muted.dark};}`;
}

function buildClubThemeDeclarations(theme: ClubThemeValues): string {
  const s = deriveBrandShims(theme);
  return `--brand-gold:${s.gold};--brand-charcoal:${s.charcoal};--brand-deep:${s.deep};--brand-ridge:${s.ridge};--brand-mist:${s.mist};--brand-snow:${s.snow};--brand-safety:${s.safety};--font-website-heading:var(${fontCssVariable(theme.headingFontKey)});--font-website-body:var(${fontCssVariable(theme.bodyFontKey)});`;
}

export type ContrastWarning = {
  id: string;
  label: string;
  ratio: number | null;
  message: string;
};

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (!HEX_COLOUR_PATTERN.test(trimmed)) {
    return null;
  }

  return {
    r: Number.parseInt(trimmed.slice(1, 3), 16),
    g: Number.parseInt(trimmed.slice(3, 5), 16),
    b: Number.parseInt(trimmed.slice(5, 7), 16),
  };
}

function channelToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// Linear sRGB for an oklch() colour. User INPUT is hex-only (#2187 D6:
// `isValidThemeColour` is a hex regex; the oklch paste-in path is gone), so this
// path never runs on an admin-entered value. It stays because the internal
// derivation still MEASURES oklch literals — the curated dark `*-muted` surfaces
// are authored in oklch (SEMANTIC_MUTED_SURFACES_DARK), and the muted-tone clamp
// mixes/measures against them. oklch -> oklab -> linear sRGB uses Björn Ottosson's
// matrices; the linear RGB it yields is exactly what the luminance sum needs (no
// extra gamma step), clamped for out-of-gamut hues.
function oklchToLinearRgb(
  colour: string,
): { r: number; g: number; b: number } | null {
  const match = colour
    .trim()
    .match(/^oklch\(\s*([^\s]+)\s+([^\s]+)\s+([^\s)]+)\s*\)$/i);
  if (!match) {
    return null;
  }

  // All three groups are mandatory (no trailing `?`), so a successful match
  // always captures them.
  const lightnessToken = must(match[1], "oklchToLinearRgb: matched oklch() has no lightness capture group");
  const L = lightnessToken.endsWith("%")
    ? Number.parseFloat(lightnessToken) / 100
    : Number.parseFloat(lightnessToken);
  const C = Number.parseFloat(must(match[2], "oklchToLinearRgb: matched oklch() has no chroma capture group"));
  const hueDegrees = Number.parseFloat(must(match[3], "oklchToLinearRgb: matched oklch() has no hue capture group"));
  if (
    !Number.isFinite(L) ||
    !Number.isFinite(C) ||
    !Number.isFinite(hueDegrees)
  ) {
    return null;
  }

  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = C * Math.cos(hueRadians);
  const b = C * Math.sin(hueRadians);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Inverse of `channelToLinear`: linear sRGB (0..1) back to an 0..255 channel. */
function linearToChannel(value: number): number {
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp01(encoded) * 255;
}

/**
 * A schema-valid colour (hex or oklch) as gamma-encoded sRGB channels.
 *
 * The oklch path round-trips through `oklchToLinearRgb`, which CLAMPS
 * out-of-gamut hues — so an oklch colour outside sRGB resolves to its clamped
 * sRGB neighbour here. That is only used for MIXING; every contrast figure this
 * module reports is measured on the resulting colour itself, so a clamp changes
 * which tone is derived but never makes a reported ratio untrue.
 */
function colourToRgb(colour: string): { r: number; g: number; b: number } | null {
  const rgb = hexToRgb(colour);
  if (rgb) {
    return rgb;
  }

  const linear = oklchToLinearRgb(colour);
  if (!linear) {
    return null;
  }

  return {
    r: linearToChannel(linear.r),
    g: linearToChannel(linear.g),
    b: linearToChannel(linear.b),
  };
}

/**
 * `foreground` mixed toward `towards` in gamma-encoded sRGB, matching CSS
 * `color-mix(in srgb, <foreground> <weight>%, <towards>)`, as a `#rrggbb` hex.
 */
function mixSrgb(
  foreground: string,
  towards: string,
  foregroundWeight: number,
): string | null {
  const from = colourToRgb(foreground);
  const to = colourToRgb(towards);
  if (!from || !to) {
    return null;
  }

  const channel = (a: number, b: number) =>
    Math.round(a * foregroundWeight + b * (1 - foregroundWeight))
      .toString(16)
      .padStart(2, "0");

  return `#${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`;
}

function relativeLuminance(colour: string): number | null {
  const rgb = hexToRgb(colour);
  if (!rgb) {
    const linear = oklchToLinearRgb(colour);
    return linear
      ? clamp01(0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b)
      : null;
  }

  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

// test seam
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    return null;
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The WCAG AA minimum for normal-size body text. */
export const AA_TEXT_CONTRAST_RATIO = 4.5;

/**
 * Where the derived muted tone AIMS to land: 70% foreground, 30% surface. This
 * mirrors the mix `.website-theme` already uses for its own `--muted-foreground`
 * (`color-mix(in srgb, var(--brand-deep) 70%, var(--brand-snow))` in
 * `globals.css`), so the app scope follows the existing house derivation instead
 * of inventing a second one.
 */
const MUTED_FOREGROUND_TARGET_WEIGHT = 0.7;

/** How far each clamp step walks the tone back toward `--foreground`. */
const MUTED_FOREGROUND_WEIGHT_STEP = 0.02;

/**
 * The curated semantic `*-muted` surfaces, light mode, exactly as declared on
 * `:root` in `src/app/globals.css`.
 *
 * These are in the clamp set because they are REAL muted-text backgrounds
 * (`bg-warning-muted`/`bg-info-muted`/`bg-danger-muted`/`bg-success-muted`
 * panels carry `text-muted-foreground` footnotes in ~35 places across
 * bed-allocation, waitlist, committee, and family-suggestions) AND because
 * #1808 deliberately does NOT override them inside `app-theme-scope`. They are
 * therefore FIXED while the derived tone moves with the brand palette — the one
 * combination that can drift apart silently. Every other surface muted text
 * lands on is either a brand token the clamp already covers, or is remapped to
 * one in dark mode (`bg-card`/`bg-*-50` -> `--card`, `bg-*-100` -> `--muted`,
 * `hover:bg-*-50` -> `--accent`).
 *
 * Pinned against `globals.css` by `app-theme-layout-contract.test.ts` so the two
 * cannot drift.
 */
const SEMANTIC_MUTED_SURFACES_LIGHT = [
  "#fef9c3", // --warning-muted
  "#dbeafe", // --info-muted
  "#dcfce7", // --success-muted
  "#fee2e2", // --danger-muted
] as const;

/** The `.dark` half of {@link SEMANTIC_MUTED_SURFACES_LIGHT}. */
const SEMANTIC_MUTED_SURFACES_DARK = [
  "oklch(0.33 0.05 75)", // --warning-muted
  "oklch(0.33 0.05 250)", // --info-muted
  "oklch(0.33 0.05 150)", // --success-muted
  "oklch(0.33 0.05 27)", // --danger-muted
] as const;

/**
 * The tokens whose VALUES the light clamp checks, named as they appear in
 * `globals.css`. `--brand-snow` backs `--background`/`--card`/`--popover`;
 * `--brand-mist` backs `--muted`/`--secondary`. `--accent` is the #2144 hover
 * surface — neutral-4, one band DARKER than `--brand-mist` (neutral-3), so it is
 * the harder light surface and must be checked in its own right: dropdown/command
 * shortcuts render `text-muted-foreground` inside `focus:bg-accent` items, and
 * clamping against `--brand-mist` alone under-clamped the tone to 4.37:1 on
 * step-4 for the Tokoroa palette. Its value is read from the mode's own substrate
 * neutral ramp (see `deriveAppMutedForeground`).
 *
 * This list is the CONTRACT, not a convenience: `docs/ARCHITECTURE.md` publishes
 * it as "the surfaces the derived muted tone is guaranteed against", and
 * `app-theme-layout-contract.test.ts` fails if the prose and this list disagree.
 * Prose that claims a broader guarantee than the code delivers is the specific
 * failure mode this pin exists to prevent.
 */
export const APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS = [
  "--brand-snow",
  "--brand-mist",
  "--accent",
  "--warning-muted",
  "--info-muted",
  "--success-muted",
  "--danger-muted",
] as const;

/** The dark-mode counterpart of {@link APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS}. */
export const APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS = [
  "--brand-deep",
  "--brand-charcoal",
  "--accent",
  "--warning-muted",
  "--info-muted",
  "--success-muted",
  "--danger-muted",
] as const;

/**
 * Surfaces DELIBERATELY excluded from the clamp set.
 *
 * `--border`/`--input` are hairline tokens. Dark mode remaps `bg-*-200` onto
 * `--border`, so a `bg-accent` badge WOULD be a muted-text surface — but the
 * only such badge (`page-content-panel.tsx`) was moved to
 * `bg-muted text-muted-foreground` instead, because a mid-luminance rule colour
 * is the wrong background for body text at any weight. A mid-luminance surface
 * also leaves the derived tone almost no headroom, so clamping against it would
 * force the tone to walk back onto `--foreground` for a materially larger share
 * of palettes than the derivation collapses on today, defeating #2145 for a
 * surface no text should sit on.
 *
 * The AA guarantee that IS enforced is the neutral-ramp sweep in
 * `club-theme-schema.test.ts`; it covers only the surfaces in the clamp set
 * (`APP_MUTED_FOREGROUND_{LIGHT,DARK}_SURFACE_TOKENS`), and `--border`/`--input`
 * are deliberately outside it.
 *
 * Kept as a value rather than a comment so the docs pin can assert the
 * exclusion is STATED, not silently assumed.
 */
export const APP_MUTED_FOREGROUND_EXCLUDED_SURFACES = ["--border", "--input"] as const;

/**
 * A muted tone for `foreground`, mixed toward `towards` and then clamped back
 * toward `foreground` until it clears WCAG AA against EVERY surface it can land
 * on.
 *
 * What this guarantees is TWO-BRANCH, and only over the LISTED surfaces: where
 * `foreground` itself clears 4.5:1 on a listed surface, the returned tone clears
 * 4.5:1 there too; where `foreground` itself FAILS AA on a listed surface (an
 * inherited failure — a curated `*-muted` fill is fixed while the brand ramp
 * moves), the returned tone is no worse than `foreground` there.
 *
 * What it does NOT guarantee is parity with `foreground`. The returned tone is
 * deliberately LESS readable than the token it softens — that is the entire
 * point of the role, and `club-theme-schema.test.ts` fails if the ratio it
 * carries ever climbs back above 0.75 of `foreground`'s on a palette with
 * headroom.
 *
 * What it does NOT guarantee: that the tone is DISTINCT from `foreground`. A
 * palette with no contrast headroom (one whose own body text only just clears
 * AA, or fails it) walks all the way back and returns `foreground` unchanged —
 * accessibility wins over the semantic distinction, and the result is exactly
 * today's behaviour rather than a regression. `getBlockingContrastWarnings`
 * is what stops such a palette being saved in the first place.
 */
function deriveMutedTone(
  foreground: string,
  towards: string,
  surfaces: readonly string[],
): string {
  for (
    let weight = MUTED_FOREGROUND_TARGET_WEIGHT;
    weight < 1;
    weight += MUTED_FOREGROUND_WEIGHT_STEP
  ) {
    const candidate = mixSrgb(foreground, towards, weight);
    if (!candidate) {
      // Neither accepted colour format parsed; fall back to the un-muted role
      // rather than emitting an unmeasured colour.
      return foreground;
    }
    const clearsAa = surfaces.every(
      (surface) =>
        (contrastRatio(candidate, surface) ?? 0) >= AA_TEXT_CONTRAST_RATIO,
    );
    if (clearsAa) {
      return candidate;
    }
  }

  return foreground;
}

export type AppMutedForegroundTones = {
  /** Value for `--muted-foreground` in the light `.app-theme-scope` block. */
  light: string;
  /** Value for `--muted-foreground` in the `.dark .app-theme-scope` block. */
  dark: string;
};

/**
 * The derived `--muted-foreground` tones for the app scope (#2145).
 *
 * Before this, `.app-theme-scope` set `--muted-foreground` to the same brand
 * colour as `--foreground`, so `text-muted-foreground` — used all over the admin
 * and finance surfaces for secondary labels and footnotes — rendered
 * identically to primary text and the `muted` semantic role was inert.
 *
 * Each mode mixes its foreground 30% toward its own base surface and then
 * clamps for AA against the SEVEN surfaces that mode can put muted text on —
 * `APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS` /
 * `APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS`:
 *
 * - light: `--brand-deep` toward `--brand-snow`, checked against `--brand-snow`
 *   (`--background`/`--card`/`--popover`), `--brand-mist`
 *   (`--muted`/`--secondary`), `--accent` (neutral-4, the #2144 hover surface),
 *   and the four curated light `*-muted` panel fills;
 * - dark: `--brand-snow` toward `--brand-deep`, checked against `--brand-deep`
 *   (`--background`), `--brand-charcoal`
 *   (`--card`/`--popover`/`--muted`/`--secondary`), `--accent` (neutral-4), and
 *   the four curated dark `*-muted` panel fills.
 *
 * `--accent` is neutral-4, a DISTINCT (darker light / lighter dark) band from the
 * `--brand-mist`/`--brand-charcoal` step-3 surfaces since #2144, so it is read
 * from each mode's own substrate ramp and checked separately — brand-mist alone
 * left the tone at 4.37:1 on step-4 for the Tokoroa palette (a real
 * `text-muted-foreground` on `focus:bg-accent` dropdown/command composition).
 *
 * Checking both BRAND surfaces per mode rather than only the base one is what
 * makes the guard hold for an ENDPOINT-CROSSING palette — one whose
 * `--brand-deep` sits BETWEEN `--brand-snow` and `--brand-mist`. Mixing toward
 * one surface moves the tone AWAY from the other, so a single-surface check
 * would ship a sub-AA muted tone for a palette that passes the save gate today
 * (the `#767676`/`#000000`/`#ffffff` case pinned in
 * `club-theme-schema.test.ts`).
 *
 * Checking the curated `*-muted` fills as well is what makes it hold for a
 * palette that MOVES while they stay put: they are excluded from the app scope
 * by #1808, so a brand ramp can slide the derived tone toward them without any
 * brand-only check noticing. See `SEMANTIC_MUTED_SURFACES_LIGHT`.
 *
 * `APP_MUTED_FOREGROUND_EXCLUDED_SURFACES` records what is deliberately NOT in
 * the set, and why.
 */
export function deriveAppMutedForeground(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): AppMutedForegroundTones {
  const theme = normaliseThemeValues(value);
  const s = deriveBrandShims(theme);
  // The `--accent` surface (#2144) is neutral-4 in BOTH modes: a distinct band
  // from `--muted`/`--secondary` (neutral-3 = `--brand-mist`). Read the true
  // step-4 from each mode's own substrate ramp so the clamp measures the surface
  // muted text actually lands on (`focus:bg-accent` items), not the step-3 shim.
  const seeds = themeSeedsFromValues(theme);
  const accentIndex = ACCENT_NEUTRAL_STEP - 1;
  const lightAccent = must(
    buildNeutralRamp(seeds, "light")[accentIndex],
    `deriveAppMutedForeground: light neutral ramp has no step ${ACCENT_NEUTRAL_STEP}`,
  );
  const darkAccent = must(
    buildNeutralRamp(seeds, "dark")[accentIndex],
    `deriveAppMutedForeground: dark neutral ramp has no step ${ACCENT_NEUTRAL_STEP}`,
  );

  return {
    light: deriveMutedTone(s.deep, s.snow, [
      s.snow,
      s.mist,
      lightAccent,
      ...SEMANTIC_MUTED_SURFACES_LIGHT,
    ]),
    dark: deriveMutedTone(s.snow, s.deep, [
      s.deep,
      s.charcoal,
      darkAccent,
      ...SEMANTIC_MUTED_SURFACES_DARK,
    ]),
  };
}

export function getContrastWarnings(
  value: Partial<Record<keyof ClubThemeValues, unknown>>,
): ContrastWarning[] {
  const s = deriveBrandShims(normaliseThemeValues(value));
  const checks: Array<{
    id: string;
    label: string;
    foreground: string;
    background: string;
  }> = [
    {
      id: "body-on-snow",
      label: "Body text on page background",
      foreground: s.deep,
      background: s.snow,
    },
    {
      id: "header-on-charcoal",
      label: "Header text on navigation background",
      foreground: s.snow,
      background: s.charcoal,
    },
    {
      id: "button-on-gold",
      label: "Button text on primary action",
      foreground: s.charcoal,
      background: s.gold,
    },
    {
      id: "app-accent-on-deep",
      label: "App accent on dark app chrome",
      foreground: s.gold,
      background: s.deep,
    },
    {
      id: "app-accent-on-snow",
      label: "App accent foreground on light app background",
      foreground: s.charcoal,
      background: s.snow,
    },
    {
      id: "app-muted-on-snow",
      label: "App muted text on light app background",
      foreground: s.deep,
      background: s.snow,
    },
    {
      id: "app-secondary-on-mist",
      label: "App text on secondary surface",
      foreground: s.deep,
      background: s.mist,
    },
  ];

  const warnings: ContrastWarning[] = [];

  for (const check of checks) {
    const ratio = contrastRatio(check.foreground, check.background);
    if (ratio === null) {
      warnings.push({
        id: check.id,
        label: check.label,
        ratio,
        message: `${check.label}: check WCAG AA contrast manually for OKLCH colours.`,
      });
      continue;
    }
    if (ratio >= 4.5) {
      continue;
    }
    warnings.push({
      id: check.id,
      label: check.label,
      ratio,
      message: `${check.label}: ${ratio.toFixed(2)}:1 is below the WCAG AA 4.5:1 text target.`,
    });
  }

  return warnings;
}

/**
 * The subset of contrast warnings whose ratio is measurable and below the WCAG
 * AA 4.5:1 text minimum. #2187 removed the blocking save gate — the generated
 * substrate guarantees contrast by construction, so a low-contrast seed is
 * ADJUSTED and disclosed (before → after in the wizard), never rejected. This
 * helper therefore gates NO save; it is retained as an advisory signal (the
 * wizard's adjusted-colour disclosure) and pinned by club-theme-schema.test.ts as
 * empty for the shipped palettes. Input is hex-only, so `contrastRatio` measures
 * every value an admin can enter; the ratio === null guard is a defensive
 * fallback for a value that parses to neither format.
 */
export function getBlockingContrastWarnings(
  value: Partial<Record<keyof ClubThemeValues, unknown>>,
): ContrastWarning[] {
  return getContrastWarnings(value).filter(
    (warning) => warning.ratio !== null && warning.ratio < 4.5,
  );
}
