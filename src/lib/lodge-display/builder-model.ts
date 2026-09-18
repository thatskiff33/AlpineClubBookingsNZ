import {
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
  type SlotContent,
} from "./layout-registry";
import {
  DEFAULT_ROTATE_SECONDS,
  type DisplayModuleName,
  type DisplayPanelOptionValue,
} from "./template-registry";

// Guided-zone builder model + deterministic generators/parser (ADR-004 §2/§4).
//
// The visual builder is a THIN GENERATOR over the ADR-003 data model: a
// `BuilderModel` (a skeleton + ordered zones) is turned into ordinary
// `bodyHtml` / `defaultCss` / `areas[]` (the Layout) and `slotContent` (the
// Template) by pure functions here, then saved through the EXISTING save
// contract — no new persistence, no schema change. Every shape this module
// emits is one `validateDisplayLayoutDefinition` / `validateDisplaySlotContent`
// already accept, so a builder-produced layout can never fail `buildLayoutRender`.
//
// The builder OWNS the `dlb-` (display-layout-builder) class namespace. The
// reserved `dlb-root` wrapper class is the round-trip SIGNATURE (§4): a stored
// layout opens in the builder ONLY IF the signature is present AND re-generating
// from the parsed model reproduces the stored `bodyHtml` byte-for-byte and the
// stored `areas[]` / `slotContent` deep-equal (else it degrades to Advanced-only,
// never silently reinterpreted). The signature alone is never trusted without the
// exact round-trip, so a hand-forged `dlb-root` on non-conforming HTML simply
// falls to Advanced-only — it cannot trick the builder into mis-editing.
//
// CLIENT-SAFE by design: pure data + the client-safe layout/condition registries
// only. No prisma/sanitiser import (sanitisation stays at serve time).

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The fixed set of grid skeletons (§2). `columns`/`rows` are parameterised by
 * zone count (1–3); `side-rail` is a fixed main cell + 1–3 rail zones. A rotator
 * is a per-zone KIND, not a skeleton (any zone can cycle child slots). */
export type BuilderSkeleton = "columns" | "rows" | "side-rail";

export const BUILDER_SKELETONS: readonly BuilderSkeleton[] = [
  "columns",
  "rows",
  "side-rail",
];

/** Max zones for the count-parameterised skeletons, so a 16:9 wall stays legible. */
export const BUILDER_MAX_ZONES = 3;
/** Max rail zones for the side-rail skeleton (plus the fixed main cell). */
export const BUILDER_MAX_RAIL_ZONES = 3;
/** Max rotator children per zone. */
export const BUILDER_MAX_ROTATOR_CHILDREN = 6;

/** What fills one zone / rotator child. `empty` renders nothing (the slot is
 * omitted from `slotContent`), matching the "leave it blank" authoring path. */
export type BuilderContent =
  | { type: "empty" }
  | { type: "module"; module: DisplayModuleName; options: Record<string, DisplayPanelOptionValue> }
  | { type: "html"; html: string };

export interface BuilderChild {
  key: string;
  description: string;
  /** null → always eligible; else a closed-registry condition name. */
  condition: string | null;
  content: BuilderContent;
}

export type BuilderZone =
  | { key: string; description: string; kind: "static"; content: BuilderContent }
  | {
      key: string;
      description: string;
      kind: "conditional";
      condition: string;
      content: BuilderContent;
    }
  | {
      key: string;
      description: string;
      kind: "rotator";
      rotateSeconds: number;
      children: BuilderChild[];
    };

export interface BuilderModel {
  skeleton: BuilderSkeleton;
  /** Ordered zones. For `side-rail`, `zones[0]` is the main cell and the rest are
   * the stacked rail; for `columns`/`rows` every zone is a column/row in order. */
  zones: BuilderZone[];
}

// ---------------------------------------------------------------------------
// Signature + slug helpers
// ---------------------------------------------------------------------------

// The reserved root-class signature. Matches the first element's class list
// carrying `dlb-root` (class is allowlisted by the sanitiser, so it survives
// storage + serve). Detection is only a HINT — the parser still requires an exact
// round-trip before opening a body (§4).
const SIGNATURE_REGEX = /^<div class="dlb-root dlb-(cols|rows|rail)\b[^"]*">/;

/** True when `bodyHtml` carries the builder's reserved `dlb-root` signature. */
export function hasBuilderSignature(bodyHtml: string): boolean {
  return SIGNATURE_REGEX.test(bodyHtml);
}

function readSkeleton(bodyHtml: string): BuilderSkeleton | null {
  const match = SIGNATURE_REGEX.exec(bodyHtml);
  if (!match) return null;
  switch (match[1]) {
    case "cols":
      return "columns";
    case "rows":
      return "rows";
    case "rail":
      return "side-rail";
    default:
      return null;
  }
}

/** A default slug for the Nth zone of a skeleton (positional, deterministic). */
export function defaultZoneKey(skeleton: BuilderSkeleton, index: number): string {
  if (skeleton === "side-rail") return index === 0 ? "main" : `rail-${index}`;
  return `zone-${index + 1}`;
}

/** A default slug for the Nth rotator child of a zone. */
export function defaultChildKey(index: number): string {
  return `slot-${index + 1}`;
}

/** The board-key slug pattern (mirrors the layouts/templates route `keyField`): a
 * lower-case slug of letters, digits and hyphens, not leading with a hyphen, and
 * capped at the server's `.max(80)` (the `{0,79}` allows 1 lead char + 79 more =
 * 80 total). The builder validates the key against this client-side so an invalid
 * or over-long key is caught inline rather than round-tripping to a bare server
 * "Invalid request" — a long auto-derived slug would otherwise come back as a
 * misattributed charset error (§U2/U3, #2048 L1). */
export const BUILDER_KEY_REGEX = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The server-enforced max key length (`keyField.max(80)`), mirrored for the
 * inline hint copy so the two never drift. */
export const BUILDER_KEY_MAX_LENGTH = 80;

/** True when `key` is a valid board slug the save routes accept. */
export function isValidBuilderKey(key: string): boolean {
  return BUILDER_KEY_REGEX.test(key);
}

/** Derive a board-key slug from a free-text name: lower-case, runs of any
 * non-alphanumeric character collapse to a single hyphen, and leading/trailing
 * hyphens are trimmed. May return "" for an all-symbol name — the UI keeps the
 * field editable and blocks Save until it holds a valid slug. */
export function slugifyKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Generation (model → stored shapes) — pure, deterministic, byte-stable
// ---------------------------------------------------------------------------

function areaPlaceholder(key: string): string {
  return `{{area:${key}}}`;
}

function zoneCell(key: string): string {
  return `<div class="dlb-zone">${areaPlaceholder(key)}</div>`;
}

/** The Layout `bodyHtml` for a model (§2). Compact, no inter-tag whitespace, so
 * byte-equality on round-trip is trivial. */
export function builderBodyHtml(model: BuilderModel): string {
  const { skeleton, zones } = model;
  if (skeleton === "side-rail") {
    const [main, ...rail] = zones;
    // "side-rail needs at least a main cell" is the model's own invariant
    // (see BuilderModel.zones and the builder above); a missing one here
    // would be that invariant broken, not a shape this renderer can guess.
    if (!main) {
      throw new Error("side-rail model has no main zone");
    }
    const railCells = rail.map((zone) => zoneCell(zone.key)).join("");
    return (
      `<div class="dlb-root dlb-rail">` +
      `<div class="dlb-main">${areaPlaceholder(main.key)}</div>` +
      `<div class="dlb-side">${railCells}</div>` +
      `</div>`
    );
  }
  const short = skeleton === "columns" ? "cols" : "rows";
  const cells = zones.map((zone) => zoneCell(zone.key)).join("");
  return `<div class="dlb-root dlb-${short} dlb-${short}-${zones.length}">${cells}</div>`;
}

/** The Layout `defaultCss` for a model (§2). The builder OWNS this skeleton CSS;
 * admins customise styling via the Template's CSS overrides (which the builder
 * preserves), not by hand-editing the default CSS. Deterministic + byte-stable;
 * contains no url()/@import/expression, so the save-time CSS sanitiser leaves it
 * untouched (no warning). */
export function builderDefaultCss(model: BuilderModel): string {
  const { skeleton, zones } = model;
  const head =
    `.display-layout-body { height: 100%; min-height: 0; }\n` +
    `.dlb-root { height: 100%; min-height: 0; box-sizing: border-box; }`;
  const zoneBase =
    `.dlb-zone { overflow: hidden; min-width: 0; min-height: 0; }\n` +
    `.dlb-zone > [data-display-area] { display: block; height: 100%; }`;
  if (skeleton === "columns") {
    return [
      head,
      `.dlb-cols {`,
      `  display: grid;`,
      `  grid-template-columns: repeat(${zones.length}, minmax(0, 1fr));`,
      `  grid-template-rows: 1fr;`,
      `  gap: 2.6vmin;`,
      `}`,
      zoneBase,
      ``,
    ].join("\n");
  }
  if (skeleton === "rows") {
    return [
      head,
      `.dlb-rows {`,
      `  display: grid;`,
      `  grid-template-rows: repeat(${zones.length}, minmax(0, 1fr));`,
      `  grid-template-columns: 1fr;`,
      `  gap: 2vmin;`,
      `}`,
      zoneBase,
      ``,
    ].join("\n");
  }
  // side-rail
  return [
    head,
    `.dlb-rail {`,
    `  display: grid;`,
    `  grid-template-columns: 1fr 30vw;`,
    `  grid-template-rows: 1fr;`,
    `  column-gap: 2.6vmin;`,
    `}`,
    `.dlb-main { overflow: hidden; min-width: 0; min-height: 0; }`,
    `.dlb-main > [data-display-area] { display: block; height: 100%; }`,
    `.dlb-side {`,
    `  display: flex;`,
    `  flex-direction: column;`,
    `  gap: 1.8vmin;`,
    `  overflow: hidden;`,
    `  min-height: 0;`,
    `}`,
    zoneBase,
    ``,
  ].join("\n");
}

/** The Layout `areas[]` JSON for a model. One area per zone, in order; a rotator
 * emits explicit `rotateSeconds` + `children[]` (never `defaultContent`); a
 * static/conditional emits neither `children`/`rotateSeconds` (§2). This is BOTH
 * the save payload and the round-trip comparison target. */
export function builderAreas(model: BuilderModel): unknown[] {
  return model.zones.map((zone) => {
    if (zone.kind === "rotator") {
      return {
        key: zone.key,
        description: zone.description,
        kind: "rotator",
        rotateSeconds: zone.rotateSeconds,
        children: zone.children.map((child) => ({
          key: child.key,
          description: child.description,
          ...(child.condition ? { condition: child.condition } : {}),
        })),
      };
    }
    if (zone.kind === "conditional") {
      return {
        key: zone.key,
        description: zone.description,
        kind: "conditional",
        condition: zone.condition,
      };
    }
    return { key: zone.key, description: zone.description, kind: "static" };
  });
}

function contentToSlot(content: BuilderContent): SlotContent | null {
  if (content.type === "empty") return null;
  if (content.type === "html") {
    const html = content.html.trim();
    return html === "" ? null : { html };
  }
  const keys = Object.keys(content.options);
  return keys.length > 0
    ? { module: content.module, options: content.options }
    : { module: content.module };
}

/** The Template `slotContent` JSON for a model. Empty zones/children are omitted
 * (they fall back to nothing). BOTH the save payload and round-trip target. */
export function builderSlotContent(model: BuilderModel): DisplaySlotContentMap {
  const out: DisplaySlotContentMap = {};
  for (const zone of model.zones) {
    if (zone.kind === "rotator") {
      for (const child of zone.children) {
        const slot = contentToSlot(child.content);
        if (slot) out[`${zone.key}/${child.key}`] = slot;
      }
    } else {
      const slot = contentToSlot(zone.content);
      if (slot) out[zone.key] = slot;
    }
  }
  return out;
}

/** The full generated Layout half of a model (`bodyHtml` + `defaultCss` +
 * `areas`), ready for the existing save contract. */
export function builderLayout(model: BuilderModel): {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown[];
} {
  return {
    bodyHtml: builderBodyHtml(model),
    defaultCss: builderDefaultCss(model),
    areas: builderAreas(model),
  };
}

// ---------------------------------------------------------------------------
// Parse (stored shapes → model | Advanced-only) — the inverse of §2, gated by
// an exact round-trip (§4)
// ---------------------------------------------------------------------------

export type ParseBuilderResult =
  | { ok: true; model: BuilderModel; defaultCssCustomised: boolean }
  | { ok: false; reason: "no-signature" | "not-round-trip" };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }
  return false;
}

function slotToContent(slot: SlotContent | undefined): BuilderContent {
  if (!slot) return { type: "empty" };
  if ("module" in slot) {
    return { type: "module", module: slot.module, options: slot.options ?? {} };
  }
  return { type: "html", html: slot.html };
}

/** Reconstruct a zone from a validated area + the Template's slotContent. */
function zoneFromArea(
  area: DisplayAreaDefinition,
  slotContent: DisplaySlotContentMap
): BuilderZone {
  if (area.kind === "rotator") {
    return {
      key: area.key,
      description: area.description,
      kind: "rotator",
      rotateSeconds: area.rotateSeconds ?? DEFAULT_ROTATE_SECONDS,
      children: (area.children ?? []).map((child) => ({
        key: child.key,
        description: child.description,
        condition: child.condition ?? null,
        content: slotToContent(slotContent[`${area.key}/${child.key}`]),
      })),
    };
  }
  if (area.kind === "conditional") {
    return {
      key: area.key,
      description: area.description,
      kind: "conditional",
      condition: area.condition ?? "",
      content: slotToContent(slotContent[area.key]),
    };
  }
  return {
    key: area.key,
    description: area.description,
    kind: "static",
    content: slotToContent(slotContent[area.key]),
  };
}

/**
 * Attempt to open a stored Layout+Template in the builder (§4). Returns the
 * reconstructed model ONLY when the `dlb-root` signature is present AND
 * re-generating from the reconstructed model reproduces the stored `bodyHtml`
 * byte-for-byte and the stored `areas` / `slotContent` deep-equal. Any mismatch
 * (a hand-authored body, a signature-less body, an advanced edit that broke the
 * shape) returns `{ ok: false }` — the caller shows Advanced-only and NEVER
 * mutates the stored body. The stored input is never altered here.
 *
 * `defaultCssCustomised` is true when the stored `defaultCss` differs from what
 * the builder would regenerate — the builder still opens (the default CSS is
 * builder-owned, §2), but the caller can warn that saving resets it.
 */
export function parseBuilderModel(input: {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
  slotContent: unknown;
}): ParseBuilderResult {
  if (!hasBuilderSignature(input.bodyHtml)) {
    return { ok: false, reason: "no-signature" };
  }
  const skeleton = readSkeleton(input.bodyHtml);
  if (!skeleton) return { ok: false, reason: "no-signature" };

  let areas: DisplayAreaDefinition[];
  let slotContent: DisplaySlotContentMap;
  try {
    // Canonical validators: an invalid/hand-broken definition throws → Advanced.
    areas = validateDisplayLayoutDefinition(input.bodyHtml, input.areas);
    slotContent = validateDisplaySlotContent(areas, input.slotContent);
  } catch {
    return { ok: false, reason: "not-round-trip" };
  }

  // side-rail needs at least a main cell; count skeletons need ≥1 zone.
  if (areas.length === 0) return { ok: false, reason: "not-round-trip" };

  const model: BuilderModel = {
    skeleton,
    zones: areas.map((area) => zoneFromArea(area, slotContent)),
  };

  // Exact round-trip gate — the single mechanism that keeps the two edit
  // surfaces from diverging. Regenerate and require byte-equal body + deep-equal
  // areas + deep-equal slotContent against the STORED values.
  if (builderBodyHtml(model) !== input.bodyHtml) {
    return { ok: false, reason: "not-round-trip" };
  }
  if (!deepEqual(builderAreas(model), input.areas)) {
    return { ok: false, reason: "not-round-trip" };
  }
  if (!deepEqual(builderSlotContent(model), input.slotContent ?? {})) {
    return { ok: false, reason: "not-round-trip" };
  }

  return {
    ok: true,
    model,
    defaultCssCustomised: builderDefaultCss(model) !== input.defaultCss,
  };
}

// ---------------------------------------------------------------------------
// Fresh-model construction (the "Rebuild in builder" / new-layout path)
// ---------------------------------------------------------------------------

function freshZone(skeleton: BuilderSkeleton, index: number): BuilderZone {
  return {
    key: defaultZoneKey(skeleton, index),
    description: "",
    kind: "static",
    content: { type: "empty" },
  };
}

/**
 * A blank starter model for a skeleton. `columns`/`rows` get `zoneCount` zones
 * (clamped 1–BUILDER_MAX_ZONES); `side-rail` gets a main cell + `zoneCount` rail
 * zones (clamped 1–BUILDER_MAX_RAIL_ZONES).
 */
export function emptyBuilderModel(
  skeleton: BuilderSkeleton,
  zoneCount = skeleton === "side-rail" ? 1 : 2
): BuilderModel {
  if (skeleton === "side-rail") {
    const rail = Math.min(BUILDER_MAX_RAIL_ZONES, Math.max(1, zoneCount));
    const zones: BuilderZone[] = [freshZone(skeleton, 0)];
    for (let i = 1; i <= rail; i++) zones.push(freshZone(skeleton, i));
    return { skeleton, zones };
  }
  const count = Math.min(BUILDER_MAX_ZONES, Math.max(1, zoneCount));
  const zones: BuilderZone[] = [];
  for (let i = 0; i < count; i++) zones.push(freshZone(skeleton, i));
  return { skeleton, zones };
}
