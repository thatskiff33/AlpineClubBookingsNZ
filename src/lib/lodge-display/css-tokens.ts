import { sanitiseRawCss, type BrandShims } from "@/lib/club-theme-schema";

// Authored-CSS handling for the lobby display (ADR-003 §4, LTV-029, hoppers99/AlpineClubBookingsNZ#75).
//
// A Layout carries a default CSS block and a Template layers CSS overrides on
// top. Both are ADMIN-authored (full-admin only, CMS trust model) but reach an
// UNATTENDED lobby wall, so this module hardens that surface with two pure,
// lexical passes applied server-side in `layout-render.ts`:
//
//  1. `sanitiseDisplayCss` — neutralise the exfiltration/injection vectors
//     ADR-003 names (external `url()`, `@import`/`@charset`, `</style`, `<`,
//     `expression(`/`-moz-binding`) and cap the length.
//  2. `scopeDisplayCss` — prefix every authored selector with the display's
//     authored-root scope so a template can only style the editable body/footer,
//     never the fixed header/clock chrome.
//
// Deliberately NOT a full CSS parser: targeted lexical neutralisation with a
// test matrix is the right size for the trust model (no admin-authored JS ever
// runs; script is stripped by the html sanitiser, not here). This module is
// CLIENT-SAFE by design — pure string work, no prisma/`server-only`/DOM — so the
// authoring UI (hoppers99/AlpineClubBookingsNZ#79) and the reference screen (hoppers99/AlpineClubBookingsNZ#80) can reuse the sanitiser,
// scoper, and `listDisplayCssTokens()` without pulling in the server assembler.

/** The DOM class the display page wraps the editable body/footer in. Authored
 * CSS is server-prefixed with this scope so it cannot reach the page chrome. */
export const DISPLAY_AUTHORED_ROOT_CLASS = "display-authored-root";

/** The selector form of {@link DISPLAY_AUTHORED_ROOT_CLASS}. */
export const DISPLAY_AUTHORED_ROOT_SELECTOR = `.${DISPLAY_AUTHORED_ROOT_CLASS}`;

/** Per-field cap on authored CSS. Over-cap input is truncated with a trailing
 * `/* truncated *\/` marker so an author sees why the tail vanished. */
export const MAX_AUTHORED_CSS_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Theme tokens (the owner's "match the website by default")
// ---------------------------------------------------------------------------

/** A named CSS custom property an author may reference as `var(--…)`. */
export interface DisplayCssToken {
  name: string;
  description: string;
  /** `display` — the board's own dark palette; `brand` — the club theme. */
  family: "display" | "brand";
}

// The display's own palette — the stable subset of the `--display-*` custom
// properties `display.css` cascades from `.display-shell`. These are the tokens
// authors should reach for first; they are theme-independent and always defined.
const DISPLAY_PALETTE_TOKENS: DisplayCssToken[] = [
  { name: "--display-ink", description: "Primary display text / ink colour.", family: "display" },
  { name: "--display-accent", description: "Accent colour — links, highlights, the active day.", family: "display" },
  { name: "--display-muted", description: "Muted / secondary text colour.", family: "display" },
  { name: "--display-panel", description: "Panel and card background fill.", family: "display" },
  { name: "--display-line", description: "Hairline / border colour.", family: "display" },
  { name: "--display-arriving", description: "Arrivals accent colour.", family: "display" },
  { name: "--display-departing", description: "Departures accent colour.", family: "display" },
  { name: "--display-group", description: "Group / whole-lodge accent colour.", family: "display" },
];

const FONT_TOKENS: DisplayCssToken[] = [
  { name: "--font-website-heading", description: "Club theme heading font family.", family: "brand" },
  { name: "--font-website-body", description: "Club theme body font family.", family: "brand" },
];

/**
 * The seven legacy `--brand-*` custom properties the display page injects
 * unscoped via `themeCss` (`buildClubThemeCss` → `deriveBrandShims`). Since
 * #2187 P1 only three brand seeds are STORED (gold/deep/safety); the other four
 * surfaces (charcoal/ridge/mist/snow) are derived from the substrate neutral
 * ramp — but all seven are still emitted through the shims and remain valid
 * `var(--brand-*)` references authored display CSS may use (kiosk/display is P3
 * scope, untouched in P1). Keyed by `BrandShims` ROLE so this advertised set
 * stays in lockstep with the derivation: adding a role forces an entry here. */
const BRAND_SHIM_TOKEN_DESCRIPTIONS: Record<keyof BrandShims, string> = {
  gold: "Primary accent — the club's main brand colour.",
  charcoal: "Darkest neutral — ink / nav surface (derived from the ramp).",
  deep: "Neutral-character seed colour.",
  ridge: "Mid neutral — hairline / border (derived from the ramp).",
  mist: "Quiet neutral surface fill (derived from the ramp).",
  snow: "Lightest neutral — page / card surface (derived from the ramp).",
  safety: "Support accent for highlights.",
};

/**
 * The stable set of theme tokens an author may use in display CSS: the board's
 * own `--display-*` palette plus the club theme's `--brand-*` colours and font
 * families (injected read-only into the display page — see `themeCss`). Name +
 * description + family; surfaced by the authoring UI (hoppers99/AlpineClubBookingsNZ#79) and reference screen
 * (hoppers99/AlpineClubBookingsNZ#80), and the data source the LTV-034 reference expects.
 */
export function listDisplayCssTokens(): DisplayCssToken[] {
  const brandColours: DisplayCssToken[] = (
    Object.keys(BRAND_SHIM_TOKEN_DESCRIPTIONS) as (keyof BrandShims)[]
  ).map((role) => ({
    name: `--brand-${role}`,
    description: BRAND_SHIM_TOKEN_DESCRIPTIONS[role],
    family: "brand" as const,
  }));
  return [...DISPLAY_PALETTE_TOKENS, ...brandColours, ...FONT_TOKENS];
}

// ---------------------------------------------------------------------------
// 1. Sanitisation
// ---------------------------------------------------------------------------

/** A `url()` target is allowed only when it stays on this origin (a relative or
 * root-absolute path), or is a self-contained `data:` URI. An external http(s)
 * URL, a protocol-relative `//host` URL, or any other explicit scheme
 * (`javascript:`, `file:`, …) is the exfiltration vector ADR-003 names. */
function isAllowedCssUrl(target: string): boolean {
  const t = target.trim();
  if (t === "") return true; // an empty url() fetches nothing
  if (/^data:/i.test(t)) return true; // self-contained, no network
  if (/^\/\//.test(t)) return false; // protocol-relative → external host
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false; // any explicit scheme
  return true; // relative path, /root-absolute, ./, ../, #fragment
}

/**
 * Neutralise the exfiltration/injection vectors ADR-003 names in one authored
 * CSS field, lexically. Ordinary rules pass through byte-identical; only a
 * matched vector is rewritten. Order matters (cap → `</style` → at-rules →
 * legacy vectors → url() → stray `<`).
 */
export function sanitiseDisplayCss(css: string): string {
  if (typeof css !== "string") return "";

  let out = css;
  let truncated = false;
  if (out.length > MAX_AUTHORED_CSS_CHARS) {
    out = out.slice(0, MAX_AUTHORED_CSS_CHARS);
    truncated = true;
  }

  // </style — the only HTML breakout from inside a <style>. Remove the whole
  // closing-tag token (shared with the site theme sanitiser).
  out = sanitiseRawCss(out);

  // @import / @charset — remote fetch + encoding tricks. Strip the statement.
  out = out.replace(/@(?:import|charset)\b[^;{}]*;?/gi, "");

  // Legacy script-in-CSS vectors: rename the token so it becomes an inert
  // unknown function / property (parens stay balanced, declaration is dropped).
  out = out.replace(/\bexpression\s*\(/gi, "/*blocked*/(");
  out = out.replace(/-moz-binding\b/gi, "/*blocked*/");

  // External url() — the exfiltration vector. Keep relative + data:; replace an
  // external target with a marker so the author sees why it went.
  out = out.replace(
    /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi,
    (match, _quote: string, target: string) =>
      isAllowedCssUrl(target) ? match : "/* blocked: external url */"
  );

  // Any remaining '<' — CSS needs none, and it kills nested-markup tricks.
  out = out.replace(/</g, "");

  if (truncated) out += "\n/* truncated */";
  return out;
}

// ---------------------------------------------------------------------------
// 2. Scoping
// ---------------------------------------------------------------------------

/** Split on a top-level separator, ignoring separators nested inside `()` or
 * `[]` (so `:is(a, b)` and `[data-x=","]` are not split). */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === separator && depthParen === 0 && depthBracket === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

/** Index of the `}` matching the `{` at `openIndex` (brace-aware). Returns the
 * last index on an unbalanced block so the remainder is treated as one body. */
function matchBrace(css: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

function scopeSelectorList(prelude: string, scope: string): string {
  return splitTopLevel(prelude, ",")
    .map((sel) => sel.trim())
    .filter((sel) => sel.length > 0)
    .map((sel) => `${scope} ${sel}`)
    .join(", ");
}

function scopeRules(css: string, scope: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const braceIndex = css.indexOf("{", i);
    if (braceIndex === -1) {
      out += css.slice(i); // trailing comments / whitespace
      break;
    }
    const prelude = css.slice(i, braceIndex);
    const closeIndex = matchBrace(css, braceIndex);
    const body = css.slice(braceIndex + 1, closeIndex);
    const trimmed = prelude.trim();

    if (trimmed.startsWith("@")) {
      const atName = (/^@(?:-[a-z]+-)?[a-z]+/i.exec(trimmed)?.[0] ?? "").toLowerCase();
      if (atName.endsWith("keyframes")) {
        // Allow @keyframes through unmodified — its `from`/`to`/`%` steps are
        // not selectors. Names are GLOBAL (documented; namespacing them is
        // over-engineering for this pass).
        out += css.slice(i, closeIndex + 1);
      } else if (
        atName === "@media" ||
        atName === "@supports" ||
        atName === "@container" ||
        atName === "@document"
      ) {
        // Conditional group rule: prefix its INNER selectors, keep the prelude.
        out += `${prelude}{${scopeRules(body, scope)}}`;
      } else {
        // Any other at-rule (@font-face, @page, …) has no body selectors to
        // scope and is stripped per §1's stance on non-style at-rules.
        out += "/* blocked at-rule */";
      }
    } else if (trimmed.length === 0) {
      out += "/* blocked */"; // a block with no selector — drop it
    } else {
      out += `${scopeSelectorList(prelude, scope)} {${body}}`;
    }
    i = closeIndex + 1;
  }
  return out;
}

/**
 * Prefix every top-level selector of already-sanitised authored CSS with the
 * display's authored-root scope so it applies inside the editable body/footer
 * only. `@media`/`@supports` (and `@container`/`@document`) have their inner
 * selectors prefixed; `@keyframes` passes through unchanged (global names);
 * other at-rules are stripped.
 *
 * Known limitations (pragmatic, per ADR-003 §4 — targeted lexical, not a full
 * parser): a raw `html`/`body`/`:root` selector is prefixed to a descendant
 * combinator (`.display-authored-root body`) that matches nothing, which is the
 * intended chrome-protection; `@keyframes` animation names are global; deeply
 * malformed CSS may scope imperfectly but can never escape the wrapper.
 */
export function scopeDisplayCss(
  css: string,
  scope: string = DISPLAY_AUTHORED_ROOT_SELECTOR
): string {
  if (typeof css !== "string" || css.trim() === "") return "";
  return scopeRules(css, scope);
}
