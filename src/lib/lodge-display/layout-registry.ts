import { isDisplayConditionName } from "./conditions";
import {
  DEFAULT_ROTATE_SECONDS,
  DISPLAY_MODULE_NAMES,
  type DisplayModuleName,
  type DisplayPanelOptionValue,
} from "./template-registry";

// Lobby display LAYOUT registry (ADR-003 §1/§2, LTV-027). A Layout is the
// admin-authored structural template: an HTML body carrying `{{area:<key>}}`
// placeholders, a default CSS block, and an ordered list of area/slot
// descriptors. A Template fills each declared slot with content (authored HTML)
// or an embedded module. This module validates both halves against the closed
// module/condition registries.
//
// NOTE: this module is CLIENT-SAFE by design — pure data, validation, and body
// parsing only, no prisma/database/sanitiser imports. The display page's client
// bundle imports it (to split the body and evaluate areas); server-side
// assembly + HTML sanitisation lives in layout-render.ts (server-only).

/** Content filling one slot: either authored HTML or an embedded module. */
export type SlotContent =
  | { html: string }
  | { module: DisplayModuleName; options?: Record<string, DisplayPanelOptionValue> };

/** A rotator child: one rotating slot, optionally gated by a condition. */
export interface DisplayAreaChild {
  key: string;
  description: string;
  /** Rotation eligibility; defaults to "always" when omitted. */
  condition?: string;
}

export type DisplayAreaKind = "static" | "conditional" | "rotator";

/** One named area in a Layout body (validates the LTV-024 `areas` Json). */
export interface DisplayAreaDefinition {
  /** Lower-case slug, unique across the layout. */
  key: string;
  description: string;
  kind: DisplayAreaKind;
  /** Required when kind === "conditional"; validated against the registry. */
  condition?: string;
  /** Rotator only: seconds per child (3–300, default DEFAULT_ROTATE_SECONDS). */
  rotateSeconds?: number;
  /** Rotator only: ≥1 child slots. */
  children?: DisplayAreaChild[];
  /** static/conditional only: fallback content when the Template omits the slot. */
  defaultContent?: SlotContent;
}

/**
 * Template slot fills, keyed by slot key. A static/conditional area's slot key
 * is its area key; a rotator child's slot key is `"<areaKey>/<childKey>"`.
 */
export type DisplaySlotContentMap = Record<string, SlotContent>;

/**
 * The fully-assembled render payload attached to the display-state response
 * when a device is bound to a v2 Template (its HTML fields already sanitised
 * server-side, its CSS already sanitised + scoped — see layout-render.ts and
 * css-tokens.ts, LTV-029). Declared here (a type, erased at build) so the client
 * lifecycle can consume it without importing the server-only assembler.
 */
export interface LayoutRenderPayload {
  bodyHtml: string;
  /** Club-theme CSS variables (`--brand-*`, font families) injected read-only
   * and UNscoped before the authored CSS, so a Template can `var(--brand-gold)`
   * to match the website by default (ADR-003 §4, LTV-029). Non-authored: the
   * site's own theme CSS, reused verbatim. */
  themeCss: string;
  /** Layout default CSS — sanitised + scoped to the display's authored root. */
  defaultCss: string;
  areas: DisplayAreaDefinition[];
  slotContent: DisplaySlotContentMap;
  /** Template CSS overrides — sanitised + scoped, layered after defaultCss. */
  cssOverrides: string;
  footerHtml: string;
}

/** Thrown when a Layout/Template definition fails validation (fail-fast, mirrors
 * InvalidDisplayTemplateError — a broken layout is never rendered partially). */
export class InvalidDisplayLayoutError extends Error {
  constructor(detail: string) {
    super(`Display layout is invalid: ${detail}`);
    this.name = "InvalidDisplayLayoutError";
  }
}

// Slug shape shared with the template registry (lower-case, ≤64 chars).
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Matches an `{{area:key}}` placeholder loosely so the validator can see (and
// reject) a malformed key rather than silently treating it as text. The same
// regex drives client-side body splitting, so what validation checked is
// exactly what the renderer splits on.
const AREA_PLACEHOLDER_REGEX = /\{\{area:([^{}]*?)\}\}/g;

// Marker attributes (LTV-041, issue #96). After sanitisation, the server swaps
// each `{{area:key}}` / `{{module:name}}` token for an inert `<div>` carrying one
// of these attributes; the client locates the divs and portals its Area/module
// component into them. Declared here (client-safe) so both the server assembler
// (layout-render.ts) and the client renderer (display-screen.tsx) share one
// source of truth — the client cannot import the server-only assembler.
export const DISPLAY_AREA_MARKER_ATTR = "data-display-area";
export const DISPLAY_MODULE_MARKER_ATTR = "data-display-module";

/** A parsed body segment: literal HTML, or a reference to an area by key. */
export type LayoutBodySegment =
  | { type: "html"; html: string }
  | { type: "area"; key: string };

/**
 * Split a Layout body into ordered HTML/area segments on the `{{area:key}}`
 * placeholders. Client-safe and pure; the HTML segments are rendered verbatim
 * (already sanitised server-side) and each area segment renders its slot.
 */
export function splitLayoutBody(bodyHtml: string): LayoutBodySegment[] {
  const segments: LayoutBodySegment[] = [];
  let lastIndex = 0;
  // Fresh regex per call — a shared /g regex carries lastIndex between calls.
  const regex = new RegExp(AREA_PLACEHOLDER_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(bodyHtml)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "html", html: bodyHtml.slice(lastIndex, match.index) });
    }
    const areaKey = match[1];
    // Unreachable: the pattern's one capture group has no `?` quantifier.
    if (areaKey === undefined) {
      throw new InvalidDisplayLayoutError(
        "area placeholder matched with no captured key",
      );
    }
    segments.push({ type: "area", key: areaKey });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < bodyHtml.length) {
    segments.push({ type: "html", html: bodyHtml.slice(lastIndex) });
  }
  return segments;
}

function isModuleName(name: string): name is DisplayModuleName {
  return (DISPLAY_MODULE_NAMES as readonly string[]).includes(name);
}

// `{{module:<name>}}` embed tokens inside authored html (LTV-028, ADR-003 §4).
// The STRICT form is the only shape the client splitter mounts, so validation
// must accept exactly it — no leading/inner whitespace, no arguments — and the
// splitter matches exactly it, keeping "what was validated is what is split".
// Options are NOT supported inside an embed token in v1: module options belong
// to `{module, options}` slot content, not to `{{module:name(...)}}`.
const MODULE_EMBED_STRICT_REGEX = /\{\{module:([a-z0-9][a-z0-9-]{0,63})\}\}/g;
// A loose DETECTOR that also catches malformed embeds (spaces, arguments, bad
// names) so the validator can reject them rather than silently rendering them
// as literal text.
const MODULE_EMBED_DETECT_REGEX = /\{\{\s*module\s*:[^{}]*\}\}/gi;

// NOTE (LTV-041, issue #96): there is no `{{module:…}}` splitter here any more.
// Both area and module tokens are swapped for inert marker elements server-side
// (layout-render.ts) after sanitisation, and the client portals its Area/module
// components into those markers — so a token nested inside an authored container
// stays put instead of being auto-closed into a sibling. The STRICT regex below
// is still the single source of truth for what a valid embed looks like, used by
// the validator (and mirrored by the server's marker replacement).

/**
 * Reject any malformed or unknown `{{module:…}}` embed in an authored html
 * surface (slot html, defaultContent html, footer html) so authoring fails fast
 * rather than the wall rendering a placeholder for a typo. A well-formed embed
 * of a KNOWN module name passes; a spaced/argument form or an unknown name
 * throws. Exported so layout-render can guard the footer html (which has no
 * slot-content validator of its own).
 */
export function validateHtmlModuleEmbeds(html: string, where: string): void {
  const detector = new RegExp(MODULE_EMBED_DETECT_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = detector.exec(html)) !== null) {
    const token = match[0];
    const strict = new RegExp(`^${MODULE_EMBED_STRICT_REGEX.source}$`).exec(token);
    if (!strict) {
      throw new InvalidDisplayLayoutError(
        `${where} has a malformed module embed "${token}" — use the bare form ` +
          `{{module:<name>}} with no spaces or arguments (module options belong ` +
          `to {module, options} slot content, not embed tokens)`
      );
    }
    // The strict pattern's one capture group has no `?` quantifier, so a
    // successful match always carries it.
    const moduleName = strict[1];
    if (moduleName === undefined || !isModuleName(moduleName)) {
      throw new InvalidDisplayLayoutError(
        `${where} embeds unknown module "${moduleName ?? token}" ` +
          `(known: ${DISPLAY_MODULE_NAMES.join(", ")})`
      );
    }
  }
}

/**
 * Validate one slot content value (authored HTML or a module embed). `module`
 * wins when both keys appear; options must be a flat scalar object (no code
 * path reaches a slot — ADR-003's "no admin-authored JavaScript" boundary).
 */
function validateSlotContent(value: unknown, where: string): SlotContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidDisplayLayoutError(`${where} content must be an object`);
  }
  const record = value as Record<string, unknown>;
  if ("module" in record) {
    if (typeof record.module !== "string" || !isModuleName(record.module)) {
      throw new InvalidDisplayLayoutError(
        `${where} references unknown module "${String(record.module)}" ` +
          `(known: ${DISPLAY_MODULE_NAMES.join(", ")})`
      );
    }
    if (record.options !== undefined) {
      if (
        !record.options ||
        typeof record.options !== "object" ||
        Array.isArray(record.options)
      ) {
        throw new InvalidDisplayLayoutError(`${where} options must be a flat object`);
      }
      for (const [optionKey, optionValue] of Object.entries(record.options)) {
        const valueType = typeof optionValue;
        if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
          throw new InvalidDisplayLayoutError(
            `${where} option "${optionKey}" must be a scalar`
          );
        }
      }
    }
    return {
      module: record.module,
      ...(record.options !== undefined
        ? { options: record.options as Record<string, DisplayPanelOptionValue> }
        : {}),
    };
  }
  if (typeof record.html === "string") {
    // Reject typo'd/unknown module embeds inside authored html so authoring
    // fails fast (LTV-028); the client splitter mounts the rest.
    validateHtmlModuleEmbeds(record.html, where);
    return { html: record.html };
  }
  throw new InvalidDisplayLayoutError(
    `${where} content needs either "html" or "module"`
  );
}

function validateCondition(value: unknown, where: string): string {
  if (typeof value !== "string" || !isDisplayConditionName(value)) {
    throw new InvalidDisplayLayoutError(
      `${where} has unknown condition "${String(value)}"`
    );
  }
  return value;
}

/**
 * Validate a Layout: its `bodyHtml` placeholders and its `areas` descriptor
 * list must agree exactly (every `{{area:key}}` has an entry and vice versa),
 * and every area obeys the slug/kind/condition/rotateSeconds/children rules.
 * Returns the typed areas on success; throws InvalidDisplayLayoutError with the
 * offending detail otherwise (never accepts a partially-broken layout).
 */
export function validateDisplayLayoutDefinition(
  bodyHtml: string,
  areas: unknown
): DisplayAreaDefinition[] {
  if (typeof bodyHtml !== "string") {
    throw new InvalidDisplayLayoutError("bodyHtml must be a string");
  }
  if (!Array.isArray(areas)) {
    throw new InvalidDisplayLayoutError("areas must be an array");
  }

  const validated: DisplayAreaDefinition[] = [];
  const seenKeys = new Set<string>();

  for (const raw of areas) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidDisplayLayoutError("each area must be an object");
    }
    const area = raw as Record<string, unknown>;
    if (typeof area.key !== "string" || !SLUG_REGEX.test(area.key)) {
      throw new InvalidDisplayLayoutError(
        `area key "${String(area.key)}" must be a lower-case slug`
      );
    }
    if (seenKeys.has(area.key)) {
      throw new InvalidDisplayLayoutError(`duplicate area key "${area.key}"`);
    }
    seenKeys.add(area.key);
    const at = `area "${area.key}"`;
    if (typeof area.description !== "string") {
      throw new InvalidDisplayLayoutError(`${at} needs a string description`);
    }
    if (area.kind !== "static" && area.kind !== "conditional" && area.kind !== "rotator") {
      throw new InvalidDisplayLayoutError(
        `${at} kind must be "static", "conditional", or "rotator"`
      );
    }
    const kind = area.kind;
    const next: DisplayAreaDefinition = {
      key: area.key,
      description: area.description,
      kind,
    };

    // condition — required for conditional, forbidden elsewhere.
    if (kind === "conditional") {
      next.condition = validateCondition(area.condition, at);
    } else if (area.condition !== undefined) {
      throw new InvalidDisplayLayoutError(
        `${at} may only set a condition when kind is "conditional"`
      );
    }

    if (kind === "rotator") {
      // rotateSeconds — rotator only, 3–300.
      if (area.rotateSeconds !== undefined) {
        if (
          typeof area.rotateSeconds !== "number" ||
          area.rotateSeconds < 3 ||
          area.rotateSeconds > 300
        ) {
          throw new InvalidDisplayLayoutError(`${at} rotateSeconds must be 3-300`);
        }
        next.rotateSeconds = area.rotateSeconds;
      } else {
        next.rotateSeconds = DEFAULT_ROTATE_SECONDS;
      }
      // children — rotator only, ≥1, unique child keys.
      if (!Array.isArray(area.children) || area.children.length === 0) {
        throw new InvalidDisplayLayoutError(`${at} rotator needs at least one child`);
      }
      const seenChildKeys = new Set<string>();
      const children: DisplayAreaChild[] = [];
      for (const rawChild of area.children) {
        if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) {
          throw new InvalidDisplayLayoutError(`${at} each child must be an object`);
        }
        const child = rawChild as Record<string, unknown>;
        if (typeof child.key !== "string" || !SLUG_REGEX.test(child.key)) {
          throw new InvalidDisplayLayoutError(
            `${at} child key "${String(child.key)}" must be a lower-case slug`
          );
        }
        if (seenChildKeys.has(child.key)) {
          throw new InvalidDisplayLayoutError(
            `${at} has duplicate child key "${child.key}"`
          );
        }
        seenChildKeys.add(child.key);
        if (typeof child.description !== "string") {
          throw new InvalidDisplayLayoutError(
            `${at} child "${child.key}" needs a string description`
          );
        }
        const childOut: DisplayAreaChild = {
          key: child.key,
          description: child.description,
        };
        if (child.condition !== undefined) {
          childOut.condition = validateCondition(
            child.condition,
            `${at} child "${child.key}"`
          );
        }
        children.push(childOut);
      }
      next.children = children;
      // A rotator carries no defaultContent — its children hold the content.
      if (area.defaultContent !== undefined) {
        throw new InvalidDisplayLayoutError(
          `${at} rotator may not set defaultContent (use child slots)`
        );
      }
    } else {
      // static/conditional — no children/rotateSeconds; optional defaultContent.
      if (area.children !== undefined) {
        throw new InvalidDisplayLayoutError(`${at} only a rotator may have children`);
      }
      if (area.rotateSeconds !== undefined) {
        throw new InvalidDisplayLayoutError(
          `${at} only a rotator may set rotateSeconds`
        );
      }
      if (area.defaultContent !== undefined) {
        next.defaultContent = validateSlotContent(
          area.defaultContent,
          `${at} defaultContent`
        );
      }
    }

    validated.push(next);
  }

  // Placeholders and areas must agree exactly, both directions.
  const placeholderKeys = splitLayoutBody(bodyHtml)
    .filter((segment): segment is { type: "area"; key: string } => segment.type === "area")
    .map((segment) => segment.key);
  const seenPlaceholders = new Set<string>();
  for (const key of placeholderKeys) {
    if (!SLUG_REGEX.test(key)) {
      throw new InvalidDisplayLayoutError(
        `bodyHtml placeholder key "${key}" must be a lower-case slug`
      );
    }
    if (seenPlaceholders.has(key)) {
      throw new InvalidDisplayLayoutError(
        `bodyHtml uses area "${key}" more than once`
      );
    }
    seenPlaceholders.add(key);
    if (!seenKeys.has(key)) {
      throw new InvalidDisplayLayoutError(
        `bodyHtml references area "${key}" with no matching areas entry`
      );
    }
  }
  for (const key of seenKeys) {
    if (!seenPlaceholders.has(key)) {
      throw new InvalidDisplayLayoutError(
        `area "${key}" has no {{area:${key}}} placeholder in bodyHtml`
      );
    }
  }

  return validated;
}

/** Every slot key a Template may fill for the given (validated) areas. */
function slotKeysForAreas(areas: DisplayAreaDefinition[]): Set<string> {
  const keys = new Set<string>();
  for (const area of areas) {
    if (area.kind === "rotator") {
      for (const child of area.children ?? []) {
        keys.add(`${area.key}/${child.key}`);
      }
    } else {
      keys.add(area.key);
    }
  }
  return keys;
}

/**
 * Validate a Template's slotContent against its Layout's (validated) areas:
 * every key must name a real slot (`areaKey`, or `areaKey/childKey` for a
 * rotator child) and every value must be valid SlotContent. Missing slots are
 * allowed (they fall back to defaultContent or render nothing); unknown keys
 * are rejected. Returns the typed map on success.
 */
export function validateDisplaySlotContent(
  areas: DisplayAreaDefinition[],
  slotContent: unknown
): DisplaySlotContentMap {
  if (!slotContent || typeof slotContent !== "object" || Array.isArray(slotContent)) {
    throw new InvalidDisplayLayoutError("slotContent must be an object");
  }
  const validSlotKeys = slotKeysForAreas(areas);
  const out: DisplaySlotContentMap = {};
  for (const [slotKey, value] of Object.entries(slotContent as Record<string, unknown>)) {
    if (!validSlotKeys.has(slotKey)) {
      throw new InvalidDisplayLayoutError(
        `slotContent has unknown slot key "${slotKey}"`
      );
    }
    out[slotKey] = validateSlotContent(value, `slot "${slotKey}"`);
  }
  return out;
}
