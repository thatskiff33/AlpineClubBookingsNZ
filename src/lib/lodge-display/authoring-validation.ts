import "server-only";

import {
  InvalidDisplayLayoutError,
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  validateHtmlModuleEmbeds,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
} from "./layout-registry";
import { MAX_AUTHORED_CSS_CHARS, sanitiseDisplayCss } from "./css-tokens";

// Save-path validation contract for the lobby-display authoring UIs (LTV-030,
// ADR-003 "Unattended surface"). A lobby wall has nobody watching, so a Layout
// or Template must be proven safe BEFORE it is persisted, not at render time.
// This module is the single shared contract the authoring UIs (#78/#79) call
// from their save routes; it owns NO HTTP surface of its own (the UIs bring
// their routes) and performs NO persistence — it only judges an incoming
// definition and reports back structurally.
//
// The judgement wraps the pieces the render pipeline already trusts at serve
// time (layout-render.ts): the layout-registry structural validators, the
// module-embed / token checks inside authored html, the authored-CSS
// sanitiser, and (issue #161) the display's img-src restriction on authored
// html. It splits its findings two ways (ADR-003 §5 — required, not optional):
//
//   • ERROR   — structural invalidity. The definition cannot render safely, so
//               the save MUST be refused (`ok: false`). Mirrors the fail-fast
//               stance buildLayoutRender takes at serve time.
//   • WARNING — content the CSS sanitiser neutralised (an external url(),
//               `@import`, an `expression(` vector, an over-length block, …)
//               or an absolute `http(s)` `<img>` src the display's img-src
//               restriction blocks (see {@link isDisplayBlockedImgSrc} — a
//               protocol-relative src is excluded because the CMS default
//               already silently strips it, so it is not a display-specific
//               surprise). The save is ALLOWED — serve time re-sanitises
//               identically, so the wall is safe regardless — but the author
//               is told exactly what was stripped so a surprise is surfaced at
//               authoring time, not discovered on the wall.
//
// Marked `server-only`: this is the server-side save contract. It imports only
// client-safe helpers (the validators and the CSS sanitiser are pure), but the
// boundary keeps it out of the client bundle so the authoring UIs call it from
// their server routes/actions, never the browser.

/** One structured finding: which field, and a human-readable reason. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * The save verdict. `ok: false` REFUSES the save and lists the structural
 * errors; `ok: true` ACCEPTS it. Both carry `warnings` so auto-sanitisation
 * notices (blocked-but-allowed content) surface on an accepted save too — the
 * authoring UI shows them without blocking the author.
 */
export type SaveValidationResult =
  | { ok: true; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

/** Assemble the verdict: any error refuses the save; warnings ride along. */
function verdict(
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): SaveValidationResult {
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// CSS sanitisation-diff reporting (warnings)
// ---------------------------------------------------------------------------

/** A `url()` target that reaches an external host — the exfiltration vector the
 * sanitiser strips. Mirrors css-tokens' private isAllowedCssUrl exactly: only a
 * relative/root-absolute path or a self-contained `data:` URI is allowed. */
function isExternalCssUrl(target: string): boolean {
  const t = target.trim();
  if (t === "") return false;
  if (/^data:/i.test(t)) return false;
  if (/^\/\//.test(t)) return true; // protocol-relative → external host
  return /^[a-z][a-z0-9+.-]*:/i.test(t); // any explicit scheme
}

/**
 * Report, category by category, what `sanitiseDisplayCss` would neutralise in
 * one authored CSS field — so an accepted save can still warn the author about
 * auto-sanitised content. Returns nothing when the field survives sanitisation
 * byte-for-byte (the common case). Scans the ORIGINAL for the vectors the
 * sanitiser rewrites; the categories mirror css-tokens.sanitiseDisplayCss.
 */
function cssSanitisationWarnings(css: string, path: string): ValidationIssue[] {
  if (typeof css !== "string" || css === "") return [];
  // Fast path: unchanged input has nothing to warn about.
  if (sanitiseDisplayCss(css) === css) return [];

  const warnings: ValidationIssue[] = [];
  const add = (message: string) => warnings.push({ path, message });

  if (css.length > MAX_AUTHORED_CSS_CHARS) {
    add(
      `truncated to ${MAX_AUTHORED_CSS_CHARS} characters — the tail was dropped ` +
        `before save`
    );
  }
  let hasExternalUrl = false;
  const urlRegex = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(css)) !== null) {
    // Group 2 has no `?` quantifier, so it is always present (possibly empty).
    const urlTarget = urlMatch[2];
    if (urlTarget !== undefined && isExternalCssUrl(urlTarget)) {
      hasExternalUrl = true;
      break;
    }
  }
  if (hasExternalUrl) {
    add("external url() blocked — only relative paths and data: URIs are kept");
  }
  if (/@(?:import|charset)\b/i.test(css)) {
    add("@import / @charset removed — remote fetch and encoding tricks are blocked");
  }
  if (/\bexpression\s*\(/i.test(css)) {
    add("legacy expression() vector neutralised");
  }
  if (/-moz-binding\b/i.test(css)) {
    add("legacy -moz-binding vector neutralised");
  }
  if (/<\/style/i.test(css)) {
    add("</style breakout removed");
  } else if (css.includes("<")) {
    add("stray '<' removed — CSS needs none");
  }

  // The scan above is exhaustive for the sanitiser's categories, but never let a
  // detected diff pass silently if a future vector is added to the sanitiser.
  if (warnings.length === 0) {
    add("content was auto-sanitised before save");
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// HTML img-src warning (issue #161, ADR-003 residual)
// ---------------------------------------------------------------------------

/** An `<img>` src the CMS default sanitiser allows (an absolute `http`/`https`
 * URL — page-content-html.ts's `allowedSchemesByTag.img`) but the display's
 * `restrictImgSrc` variant blocks. Deliberately narrower than
 * {@link isExternalCssUrl}: a protocol-relative `//host` src is already
 * stripped by the CMS default (nothing display-specific to warn about there),
 * and `data:` is exactly what the display variant newly ALLOWS relative to the
 * CMS default (the opposite direction — never a warning). */
function isDisplayBlockedImgSrc(target: string): boolean {
  return /^https?:/i.test(target.trim());
}

/**
 * Report when the display's img-src restriction would strip an `<img>` src
 * from one authored HTML field — so an accepted save still warns the author
 * (serve time applies the identical restriction, so the wall is safe either
 * way; without this the author would only discover it as a missing image on
 * an unattended screen). Scans the ORIGINAL for the vector the restriction
 * blocks, mirroring {@link cssSanitisationWarnings}'s approach.
 */
function htmlImgSanitisationWarnings(html: string, path: string): ValidationIssue[] {
  if (typeof html !== "string" || html === "") return [];

  const imgSrcRegex = /<img\b[^>]*\ssrc\s*=\s*(['"])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = imgSrcRegex.exec(html)) !== null) {
    // Group 2 has no `?` quantifier, so it is always present (possibly empty).
    const imgSrc = match[2];
    if (imgSrc !== undefined && isDisplayBlockedImgSrc(imgSrc)) {
      return [
        {
          path,
          message:
            "external <img> src blocked — only relative paths and data: URIs " +
            "render on the wall (display img-src is 'self' data:)",
        },
      ];
    }
  }
  return [];
}

/** As {@link htmlImgSanitisationWarnings}, over every `defaultContent.html`
 * carried by a validated Layout's areas — the Layout-level fallback content
 * renders through the same restricted path as everything else (layout-render's
 * `renderAreas`). */
function areaDefaultContentImgWarnings(
  areas: DisplayAreaDefinition[]
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  for (const area of areas) {
    if (area.defaultContent && "html" in area.defaultContent) {
      warnings.push(
        ...htmlImgSanitisationWarnings(
          area.defaultContent.html,
          `areas.${area.key}.defaultContent`
        )
      );
    }
  }
  return warnings;
}

/** As {@link htmlImgSanitisationWarnings}, over every html slot in a validated
 * Template's slotContent (module slots carry no html, so are skipped). */
function slotContentImgWarnings(
  slotContent: DisplaySlotContentMap
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  for (const [key, content] of Object.entries(slotContent)) {
    if ("html" in content) {
      warnings.push(...htmlImgSanitisationWarnings(content.html, `slotContent.${key}`));
    }
  }
  return warnings;
}

/** Map a thrown validator error to a structured issue. Only the layout/registry
 * validators throw InvalidDisplayLayoutError; anything else is unexpected and
 * still reported (fail closed) rather than leaking as a 500 in the caller. */
function issueFromError(error: unknown, path: string): ValidationIssue {
  if (error instanceof InvalidDisplayLayoutError) {
    return { path, message: error.message };
  }
  return {
    path,
    message: error instanceof Error ? error.message : "invalid definition",
  };
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface LayoutForSave {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
}

/**
 * Judge a Layout before it is saved (#79). Structural failure (bodyHtml/areas
 * disagree, a bad slug, an unknown module embed in a default slot, …) is an
 * ERROR that refuses the save; anything the CSS sanitiser would strip from
 * `defaultCss`, or the display img-src restriction would strip from `bodyHtml`
 * / an area's default content, is a WARNING (serve time re-sanitises, so the
 * wall is safe either way — issue #161).
 */
export function validateLayoutForSave(input: LayoutForSave): SaveValidationResult {
  const errors: ValidationIssue[] = [];
  let imgWarnings = htmlImgSanitisationWarnings(input.bodyHtml, "bodyHtml");
  try {
    const areas = validateDisplayLayoutDefinition(input.bodyHtml, input.areas);
    imgWarnings = [...imgWarnings, ...areaDefaultContentImgWarnings(areas)];
  } catch (error) {
    errors.push(issueFromError(error, "layout"));
  }
  const warnings = [
    ...cssSanitisationWarnings(input.defaultCss, "defaultCss"),
    ...imgWarnings,
  ];
  return verdict(errors, warnings);
}

export interface TemplateForSave {
  /** The Layout the Template fills — its areas gate which slot keys are valid,
   * so it must be validated first (an invalid layout is a layout-side error). */
  layout: { bodyHtml: string; areas: unknown };
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

/**
 * Judge a Template before it is saved (#78). The Template's slotContent is
 * validated against its Layout's areas (an unknown slot key, a bad module, a
 * malformed embed in authored html is an ERROR); the footer html is checked for
 * malformed/unknown module embeds; anything the CSS sanitiser would strip from
 * `cssOverrides`, or the display img-src restriction would strip from a slot's
 * html / the footer html, is a WARNING (issue #161). When the bound Layout
 * itself is structurally invalid the slot check cannot run, so that surfaces
 * as a `layout` error.
 */
export function validateTemplateForSave(input: TemplateForSave): SaveValidationResult {
  const errors: ValidationIssue[] = [];
  let slotImgWarnings: ValidationIssue[] = [];
  try {
    const areas = validateDisplayLayoutDefinition(
      input.layout.bodyHtml,
      input.layout.areas
    );
    try {
      const slotContent = validateDisplaySlotContent(areas, input.slotContent);
      slotImgWarnings = slotContentImgWarnings(slotContent);
    } catch (error) {
      errors.push(issueFromError(error, "slotContent"));
    }
  } catch (error) {
    // The bound layout is itself broken — the template cannot be validated
    // against it. Report it against the layout so the UI points at the cause.
    errors.push(issueFromError(error, "layout"));
  }
  try {
    validateHtmlModuleEmbeds(input.footerHtml, "footerHtml");
  } catch (error) {
    errors.push(issueFromError(error, "footerHtml"));
  }
  const warnings = [
    ...cssSanitisationWarnings(input.cssOverrides, "cssOverrides"),
    ...slotImgWarnings,
    ...htmlImgSanitisationWarnings(input.footerHtml, "footerHtml"),
  ];
  return verdict(errors, warnings);
}
