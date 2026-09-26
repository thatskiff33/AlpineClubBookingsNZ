import "server-only";

import type { DisplayState } from "@/lib/lodge-display-state";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveDisplayHtml } from "./display-text";
import { sanitiseDisplayCss, scopeDisplayCss } from "./css-tokens";
import {
  DISPLAY_AREA_MARKER_ATTR,
  DISPLAY_MODULE_MARKER_ATTR,
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  validateHtmlModuleEmbeds,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
  type LayoutRenderPayload,
  type SlotContent,
} from "./layout-registry";
import type { ClubDateFormat } from "@/lib/club-time";

// Server-side assembly of a v2 Layout + Template into the display-state
// `layoutRender` payload (ADR-003 §4, LTV-027/LTV-028). This is where the CMS
// trust model AND display token resolution are applied at SERVE time:
//
//  1. Every admin-authored HTML field (the layout body, each authored slot's
//     html, the footer) passes through the website content sanitiser with its
//     display img-src restriction (issue #161, ADR-003 residual: an <img> src
//     is constrained to relative/self paths or data: URIs, matching the
//     display CSP's img-src 'self' data: — src/lib/csp.ts), and the
//     CSS blocks (defaultCss + cssOverrides) are hardened by sanitiseDisplayCss
//     (external url()/@import/@charset/</style/</expression/-moz-binding
//     neutralised, length-capped — ADR-003 §4, LTV-029) then scopeDisplayCss
//     (every selector prefixed with the display's authored-root scope so a
//     template can only style the editable body/footer, never the fixed header
//     clock/brand chrome). The club-theme CSS variables ship separately as the
//     non-authored, unscoped `themeCss` so `var(--brand-*)` matches the website.
//  2. AFTER sanitisation, the display's own VALUE tokens ({{config:…}},
//     {{lodge-name}}, {{display-date}}) are resolved against the bound lodge's
//     DisplayState, with each injected value HTML-escaped (see resolveDisplayHtml)
//     so a config value renders as inert text even inside html.
//
// TOKEN-SCOPE BOUNDARY (ADR-003 §4 — the security line): resolution runs over
// the display's OWN token set only, never the site-wide token catalogue
// (src/lib/token-catalogue.ts). resolveDisplayHtml's closed grammar leaves any
// other `{{…}}` verbatim — a site token like {{club-name}} is rendered as
// literal text, so a wall can never surface data beyond the privacy-reduced
// payload. `{{module:<name>}}` embed tokens are also outside the value grammar:
// they pass through sanitisation and value resolution untouched (they are plain
// text to both), and the client splitter mounts them.
//
// A validation or sanitise failure throws — the caller drops back to the legacy
// built-in template (LTV-030 formalises the full safe-fallback board; this is
// the simple safe version). Kept server-only: it imports the sanitiser, which
// is server-only.

/**
 * Harden one authored CSS field for the unattended wall (LTV-029, #75):
 * lexically neutralise the exfiltration/injection vectors, THEN scope every
 * selector to the display's authored root so it can only style the editable
 * body/footer. Order matters — scoping runs over the already-sanitised text so
 * the blocked-marker comments it inserts are never treated as selectors.
 */
function prepareAuthoredCss(css: string): string {
  return scopeDisplayCss(sanitiseDisplayCss(css));
}

// Marker replacement (LTV-041, issue #96): once an authored surface has been
// sanitised AND value-resolved, each `{{area:key}}` / `{{module:name}}` token is
// swapped for an INERT marker element the client portals its Area/module into.
// The token syntax never reaches the client, so a placeholder nested inside an
// authored container (`<div class="cols"><div>{{area:main}}</div>…`) stays put —
// the previous split-into-siblings renderer broke out of the container and
// mounted areas outside it. Keys/names are validated slugs by the time we get
// here (validateDisplayLayoutDefinition / validateHtmlModuleEmbeds ran first), so
// the strict slug shape below can never inject markup.
//
// SPOOF DEFENCE: an author cannot hand-type a marker div to fake an area/module.
// `sanitizePageContentHtml` allowlists only `class`/`aria-hidden` globally, so a
// literal `<div data-display-area="…">` in authored html loses its data attribute
// during sanitisation (which runs BEFORE this replacement) — only the markers we
// generate here survive to be portalled into.
const AREA_MARKER_REGEX = /\{\{area:([a-z0-9][a-z0-9-]{0,63})\}\}/g;
const MODULE_MARKER_REGEX = /\{\{module:([a-z0-9][a-z0-9-]{0,63})\}\}/g;

function replaceAreaPlaceholders(html: string): string {
  return html.replace(
    AREA_MARKER_REGEX,
    (_match, key: string) => `<div ${DISPLAY_AREA_MARKER_ATTR}="${key}"></div>`
  );
}

function replaceModuleEmbeds(html: string): string {
  return html.replace(
    MODULE_MARKER_REGEX,
    (_match, name: string) => `<div ${DISPLAY_MODULE_MARKER_ATTR}="${name}"></div>`
  );
}

/**
 * Sanitise then token-resolve one authored html surface. Order matters:
 * sanitise the AUTHORED template first (CMS trust model — strips script/handlers),
 * THEN resolve the display's value tokens escaping each injected value, so an
 * injected config value can only ever be inert text. Area/module tokens survive
 * both steps; the caller swaps them for inert markers as the final step.
 */
function renderAuthoredHtml(html: string, state: DisplayState, format: ClubDateFormat): string {
  // restrictImgSrc: true (issue #161, ADR-003 residual) — the display's own
  // img-src CSP is 'self' data:, so an <img src="https://…"> an author saved
  // before this change (or hand-edited around the save-time warning) has its
  // src stripped here too rather than being served to fail silently against
  // the tighter CSP. The CMS's own sanitizePageContentHtml() default (used for
  // public-site page content) is untouched — see page-content-html.ts.
  return resolveDisplayHtml(
    sanitizePageContentHtml(html, { restrictImgSrc: true }),
    state,
    format
  );
}

/**
 * As renderAuthoredHtml, then swap `{{module:name}}` embed tokens for inert
 * markers (LTV-041). Used for every authored surface that can carry an embedded
 * module — slot html, defaultContent html, footer html.
 */
function renderAuthoredHtmlWithModuleMarkers(html: string, state: DisplayState, format: ClubDateFormat): string {
  return replaceModuleEmbeds(renderAuthoredHtml(html, state, format));
}

/** Sanitise + token-resolve the HTML fields inside one slot's content, then
 * swap module embed tokens for markers (module slot content carries no HTML —
 * only its scalar options, already validated — so it passes through). */
function renderSlotContent(content: SlotContent, state: DisplayState, format: ClubDateFormat): SlotContent {
  if ("module" in content) return content;
  return { html: renderAuthoredHtmlWithModuleMarkers(content.html, state, format) };
}

function renderAreas(
  areas: DisplayAreaDefinition[],
  state: DisplayState, format: ClubDateFormat
): DisplayAreaDefinition[] {
  return areas.map((area) =>
    area.defaultContent
      ? { ...area, defaultContent: renderSlotContent(area.defaultContent, state, format) }
      : area
  );
}

function renderSlotContentMap(
  slotContent: DisplaySlotContentMap,
  state: DisplayState, format: ClubDateFormat
): DisplaySlotContentMap {
  const out: DisplaySlotContentMap = {};
  for (const [key, value] of Object.entries(slotContent)) {
    out[key] = renderSlotContent(value, state, format);
  }
  return out;
}

export interface LayoutRenderInput {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
  /** The club-theme CSS variable block (`buildClubThemeCss` output) to ship as
   * the non-authored, unscoped `themeCss`. Optional so unit tests need not
   * thread a theme; the state route always supplies the live value. */
  themeCss?: string;
}

/**
 * Validate + sanitise + token-resolve a stored Layout/Template pair into the
 * render payload, against the bound lodge's DisplayState (LTV-028: value tokens
 * resolve against `state` at serve time). Throws on any structural/validation
 * failure so the caller can fall back to a known-good legacy template rather
 * than ever serving a broken payload.
 */
export function buildLayoutRender(
  input: LayoutRenderInput,
  state: DisplayState, format: ClubDateFormat
): LayoutRenderPayload {
  const areas = validateDisplayLayoutDefinition(input.bodyHtml, input.areas);
  const slotContent = validateDisplaySlotContent(areas, input.slotContent);
  // The footer html has no slot-content validator of its own; reject typo'd or
  // unknown module embeds in it here (fail-fast, mirrors the slot path).
  validateHtmlModuleEmbeds(input.footerHtml, "footerHtml");

  return {
    // Sanitise + value-resolve the body AFTER validation (placeholders survive
    // both — they carry no angle brackets), THEN swap each `{{area:key}}` for an
    // inert `<div data-display-area="key">` marker the client portals its Area
    // into. Shipping the body WHOLE (not split into sibling fragments) keeps an
    // area nested inside an authored container in place (LTV-041, issue #96).
    bodyHtml: replaceAreaPlaceholders(renderAuthoredHtml(input.bodyHtml, state, format)),
    // Non-authored club-theme variables, unscoped so `:root { --brand-* }`
    // cascades to the whole page; injected BEFORE the authored CSS.
    themeCss: input.themeCss ?? "",
    defaultCss: prepareAuthoredCss(input.defaultCss),
    areas: renderAreas(areas, state, format),
    slotContent: renderSlotContentMap(slotContent, state, format),
    cssOverrides: prepareAuthoredCss(input.cssOverrides),
    // The footer html can embed `{{module:name}}` tokens — swap them for markers
    // too, the same mechanism the client mounts everywhere (LTV-041).
    footerHtml: renderAuthoredHtmlWithModuleMarkers(input.footerHtml, state, format),
  };
}
