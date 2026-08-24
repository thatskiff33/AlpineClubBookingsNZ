import {
  formatClubLongWeekdayDayMonth,
  parseCalendarDate,
} from "@/lib/club-time";
import type { DisplayState } from "../lodge-display-state";

// Token resolution for display-authored copy (fork issue #31; value-token
// resolution inside authored HTML added in LTV-028, ADR-003 §4).
//
// The grammar is the display's OWN token set — deliberately NOT the site-wide
// token catalogue (src/lib/token-catalogue.ts), which resolves on the public
// website outside the display auth boundary. A wall must never surface a site
// token that reveals data beyond the privacy-reduced DisplayState payload, so
// PLACEHOLDER_PATTERN matches ONLY these value tokens:
//   {{config:<key>}}  {{lodge-name}}  {{display-date}}
// Any other `{{…}}` (a site token like {{club-name}}, or a `{{module:<name>}}`
// embed handled by the layout splitter) is not matched here and is therefore
// left VERBATIM — the token-scope security line lives in this closed regex.
//
// Two resolvers share that one grammar:
//   • resolveDisplayText — returns plain TEXT for React text nodes. Consumers
//     render it as children (never dangerouslySetInnerHTML), so HTML escaping
//     is React's job and a config value can never inject markup.
//   • resolveDisplayHtml — returns HTML for an authored html surface, with each
//     injected value HTML-escaped (and its braces neutralised) on injection, so
//     a config value renders as inert TEXT even inside html and can never inject
//     markup nor form a second `{{…}}` token.
//
// EXTENSION POINT (ADR-003 §4, deferred): module-contributed VALUE tokens would
// slot in here as a second alternative in PLACEHOLDER_PATTERN plus a branch in
// resolveToken — one grammar, still closed to the display's own token set. Not
// built in v1 (see #74 "Do NOT build").

const PLACEHOLDER_PATTERN = /\{\{\s*(config:([a-z0-9][a-z0-9-]{0,63})|lodge-name|display-date)\s*\}\}/gi;

/**
 * The `{{display-date}}` line: "Thursday, 16 April" — the wall shows the day to
 * people standing in the lodge, so the year is noise.
 *
 * A DECLARED `src/lib` FIX INSIDE CT-4 GROUP E, and this is why (#2870).
 * `src/lib/**` is group F by the epic's published partition, so group E does not
 * normally touch it. It has to here, because group E migrated the OTHER half of
 * this same value and leaving one half behind is worse than leaving both:
 * `display-header-clock.tsx` now resolves the header's date line to a
 * `CalendarDate` and formats it with no zone, while this token still pushed
 * `window.start` — the SAME date-only lodge night — through `APP_TIME_ZONE`.
 * One lobby wall, two days, one line apart: for a club in `America/Denver` with
 * a window starting `2026-04-16` the header read "Thu, 16 Apr" and a template
 * carrying this token read "Wednesday, 15 April".
 *
 * `window.start` IS A CALENDAR DATE, so this takes no zone at all.
 * `formatClubLongWeekdayDayMonth` pins `UTC` over the UTC-midnight encoding,
 * which is provably the identity for EVERY club rather than a projection that
 * happens to cancel east of Greenwich — `club-time/__tests__/house-shapes.test.ts`
 * pins it byte-for-byte against the exact `Intl` options this file used to hold,
 * over a 400-day sweep, which is why the rendered string does not move for the
 * club this codebase was written for.
 *
 * GROUP F STILL OWNS THE CONVERGENCE: `window.start` is typed as a `string` on
 * the payload rather than a `CalendarDate`, which is why this parses it here
 * instead of receiving one. The raw-value fallback is for the same reason — an
 * unattended wall must render something rather than throw.
 */
function displayDateToken(state: DisplayState): string {
  const day = parseCalendarDate(state.window.start);
  return day === null ? state.window.start : formatClubLongWeekdayDayMonth(day);
}

/** Resolve one matched value token to its raw (unescaped) replacement string. */
function resolveToken(
  token: string,
  configKey: string | undefined,
  state: DisplayState
): string {
  const lower = token.toLowerCase();
  if (lower === "lodge-name") return state.lodge.name;
  if (lower === "display-date") return displayDateToken(state);
  // configKey is always set for the remaining `config:<key>` alternative.
  const value = state.config[configKey!.toLowerCase()];
  // An unset key renders a VISIBLE placeholder so misconfiguration is obvious
  // on the screen during setup, never silently blank (brief §3).
  return value ?? `⟨config:${configKey!.toLowerCase()}?⟩`;
}

/**
 * Resolve the display's value tokens to plain TEXT (for React text nodes).
 * Non-display tokens (site catalogue tokens, module embeds) are left verbatim.
 */
export function resolveDisplayText(template: string, state: DisplayState): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_whole, token: string, configKey?: string) =>
      resolveToken(token, configKey, state)
  );
}

/**
 * HTML-escape a resolved value for injection into an authored html surface.
 * Escapes the five HTML-significant characters so the value renders as literal
 * text, AND neutralises `{`/`}` so an injected value can never form a second
 * `{{…}}` token (config/area/module) that a later splitter would act on — the
 * value is inert text, full stop.
 */
function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

// URL-scheme guard for resolved values (issue #176, ADR-003 §4). Value-token
// resolution runs AFTER the CMS sanitiser (see layout-render.ts), so the
// sanitiser's scheme allowlist never sees a resolved value: a config value like
// `javascript:alert(1)` or `data:text/html,…` resolved at the START of an
// authored `href`/`src` brings its OWN scheme past that gate. The escaping above
// stops a value BREAKING OUT of the attribute (quotes/brackets), but a scheme
// sits happily INSIDE the quotes, so escaping alone does not close this.
//
// DESIGN CHOICE — enforce in TWO phases, both scoped to token-bearing URL
// attributes, never a full post-resolution HTML re-parse: the fix stays on the
// display token path and touches only attributes whose AUTHORED value carried a
// token. Literal authored URLs keep the sanitiser's own verdict (a blanket
// re-parse would re-decide them and wrongly strip the display's legitimately-
// allowed `data:` <img> srcs — issue #161); CMS/page-content behaviour is
// untouched.
//
//   • Phase 1 (token-level, fast path): while resolving, when a token OPENS a
//     URL attribute value its resolved value runs through neutraliseUrlScheme,
//     so a single token bringing its own `javascript:`/`data:` scheme is killed
//     at injection. This covers the common single-token case cheaply.
//   • Phase 2 (attribute-level, composition-closing — issue #186): phase 1 only
//     inspects the OPENING token, so a scheme split across adjacent tokens
//     (`href="{{a}}{{b}}"`, a=`javascript`, b=`:alert(1)`) reconstitutes
//     `javascript:` from two individually-innocent halves and slips past it.
//     After full resolution, re-check the COMPLETE final value of every
//     token-bearing href/src attribute (only those — literal attributes are left
//     alone, preserving #161) and collapse the whole value to `#` when its
//     scheme is disallowed.

/** True when the html up to `offset` ends with a URL-bearing attribute opener
 * (`href="`/`src="`), so the token that follows is the START of that URL and its
 * resolved value determines the scheme. A token AFTER a literal scheme prefix
 * (`href="https://{{config:path}}"`) does not match — the scheme is already the
 * vetted literal and the value is only a path segment. */
const URL_ATTR_OPENER = /\b(?:href|src)\s*=\s*["']?\s*$/i;
function opensUrlAttributeValue(html: string, offset: number): boolean {
  // Only the short run of text immediately before the token can hold the
  // attribute opener, so inspect a bounded tail rather than the whole prefix.
  const tail = html.slice(Math.max(0, offset - 64), offset);
  return URL_ATTR_OPENER.test(tail);
}

/** Neutralise a resolved value whose scheme is not one of the vetted URL
 * schemes. Allows http/https/mailto/tel and any relative/anchor/query reference
 * (no scheme); everything else — javascript:, data:, vbscript:, protocol-
 * relative `//host`, … — collapses to an inert `#` so the attribute stays valid
 * but dead. */
const ALLOWED_URL_SCHEME = /^(?:https?|mailto|tel)$/i;
function neutraliseUrlScheme(value: string): string {
  // Browsers ignore leading whitespace and C0 control chars when resolving a
  // URL, so trim them before inspecting the scheme (a value cannot smuggle
  // `\tjavascript:` past the check).
  const trimmed = value.replace(/^[\u0000-\u0020]+/, "");
  // Protocol-relative (`//host`) inherits the page scheme — treat it as unsafe.
  if (trimmed.startsWith("//")) return "#";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  // No scheme → a relative path or `#anchor`/`?query`: always safe.
  if (!scheme) return value;
  return ALLOWED_URL_SCHEME.test(scheme[1]) ? value : "#";
}

// Phase 2 — composition-closing attribute scheme pass (issue #186). Matches a
// URL-bearing attribute and captures its value in double-quoted, single-quoted,
// or unquoted form. Used twice: once over the AUTHORED template (to record which
// href/src attributes were token-bearing) and once over the RESOLVED output (to
// re-check those same attributes' complete values). A fresh RegExp is created
// per pass so the shared /g `lastIndex` can never leak between the two walks.
const URL_ATTR_VALUE_SOURCE =
  "(\\b(?:href|src)\\s*=\\s*)(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))";
const CONTAINS_TOKEN = /\{\{[^}]*\}\}/;

/** Record, in document order, whether each href/src attribute value in the
 * AUTHORED template contains at least one `{{…}}` token. Resolution only
 * substitutes tokens for escaped text (it can neither create nor destroy an
 * attribute), so this sequence maps 1:1 and in order onto the resolved output's
 * href/src attributes — letting phase 2 re-check the right attributes
 * positionally without tracking shifting offsets. */
function tokenBearingUrlAttributeFlags(template: string): boolean[] {
  const pattern = new RegExp(URL_ATTR_VALUE_SOURCE, "gi");
  const flags: boolean[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    flags.push(CONTAINS_TOKEN.test(value));
  }
  return flags;
}

/** Walk the RESOLVED output's href/src attributes in order and, for each one
 * whose authored counterpart was token-bearing, run the COMPLETE final value
 * through neutraliseUrlScheme — collapsing the whole value to `#` when its
 * scheme is disallowed. Literal (no-token) attributes are returned untouched so
 * the display's allowed `data:` <img> srcs survive (issue #161). */
function neutraliseTokenBearingUrlAttributes(
  resolved: string,
  tokenBearing: boolean[]
): string {
  const pattern = new RegExp(URL_ATTR_VALUE_SOURCE, "gi");
  let attrIndex = 0;
  return resolved.replace(
    pattern,
    (whole, prefix: string, dq?: string, sq?: string, uq?: string) => {
      const isTokenBearing = tokenBearing[attrIndex++] ?? false;
      if (!isTokenBearing) return whole;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      const value = dq ?? sq ?? uq ?? "";
      return `${prefix}${quote}${neutraliseUrlScheme(value)}${quote}`;
    }
  );
}

/**
 * Resolve the display's value tokens inside an authored html surface, with each
 * injected value HTML-escaped. The template's own markup and any non-display
 * `{{…}}` token (site catalogue tokens, `{{module:<name>}}` embeds) are left
 * untouched — only the closed value-token set is substituted, and only the
 * substituted value is escaped. Run this AFTER the CMS sanitiser (see
 * layout-render.ts): the sanitiser trusts the authored template, and escaping
 * the injected value is what keeps a config value from being markup.
 *
 * URL schemes are guarded in two phases (issue #176, #186): phase 1 neutralises
 * a resolved value that OPENS a URL attribute (`href="{{config:link}}"`) at
 * injection time; phase 2 then re-checks the COMPLETE value of every
 * token-bearing href/src attribute after resolution, closing a scheme split
 * across adjacent tokens (`href="{{a}}{{b}}"`) that phase 1's opener-only check
 * would miss. Either way a config value can never smuggle a `javascript:`/`data:`
 * scheme past the sanitiser that ran before it.
 */
export function resolveDisplayHtml(template: string, state: DisplayState): string {
  // Snapshot which href/src attributes were token-bearing BEFORE resolution, so
  // phase 2 can positionally re-check exactly those (and leave literal `data:`
  // srcs — issue #161 — untouched).
  const tokenBearing = tokenBearingUrlAttributeFlags(template);

  // Phase 1 — token-level guard (fast path): neutralise the scheme of a value
  // that opens a URL attribute as it is injected and escaped.
  const resolved = template.replace(
    PLACEHOLDER_PATTERN,
    (_whole: string, token: string, configKey: string | undefined, offset: number, full: string) => {
      const value = resolveToken(token, configKey, state);
      const guarded = opensUrlAttributeValue(full, offset)
        ? neutraliseUrlScheme(value)
        : value;
      return escapeHtmlValue(guarded);
    }
  );

  // Phase 2 — composition-closing pass: re-check the complete final value of the
  // token-bearing href/src attributes, killing a scheme reconstituted across
  // tokens.
  return neutraliseTokenBearingUrlAttributes(resolved, tokenBearing);
}
