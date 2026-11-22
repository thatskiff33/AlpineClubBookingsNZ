import type { DisplayState } from "../lodge-display-state";
import {
  DISPLAY_CONDITION_NAMES,
  evaluateDisplayCondition,
  isDisplayConditionName,
  type DisplayConditionName,
} from "./conditions";

// NOTE: this module is CLIENT-SAFE by design — pure data, validation, and
// eligibility logic only, no prisma/database imports. The display page's
// client bundle imports it; DB-backed template resolution lives in
// template-resolution.ts (server-only).

// Lobby display template registry (fork issue hoppers99/AlpineClubBookingsNZ#29, ADR-002): data-only
// template definitions validated against closed module/condition name
// registries. During the v2 rebuild (LTV-024) only these code built-ins are
// resolved — the DB override/custom rows were retired with the old
// DisplayTemplate model. An invalid definition is rejected with the offending
// detail, never rendered partially broken.

/**
 * The closed set of module names a template may place in a region. The
 * renderers attach in LTV-005/LTV-006/LTV-011; keeping the NAME registry
 * here lets the validator reject unknown modules before any renderer exists.
 */
export const DISPLAY_MODULE_NAMES = [
  "lodge-header",
  "arrivals-board",
  "occupancy-grid",
  "welcome",
  "singles-board",
  "room-cards",
  "night-columns",
  "status-board",
  "chores-board",
  "lodge-rules",
  "notice-board",
  "info-footer",
] as const;

export type DisplayModuleName = (typeof DISPLAY_MODULE_NAMES)[number];

export type DisplayPanelOptionValue = string | number | boolean;

export interface DisplayPanelDefinition {
  module: DisplayModuleName;
  /** Rotation eligibility; defaults to "always". */
  condition?: DisplayConditionName;
  options?: Record<string, DisplayPanelOptionValue>;
}

export interface DisplayRegionDefinition {
  key: string;
  panels: DisplayPanelDefinition[];
  /** Seconds per panel when the region rotates (>1 eligible panel). */
  rotateSeconds?: number;
  /**
   * How a region with several eligible panels presents them (issue hoppers99/AlpineClubBookingsNZ#56):
   * "rotate" (default) cycles them; "stack" renders them all at once —
   * the sidebar-card treatment from the approved mockups.
   */
  layout?: "rotate" | "stack";
}

export interface DisplayTemplateDefinition {
  key: string;
  name: string;
  regions: DisplayRegionDefinition[];
}

export const DEFAULT_ROTATE_SECONDS = 8;

/** Thrown when a definition (code or DB) fails validation (ADR-002 §1). */
export class InvalidDisplayTemplateError extends Error {
  constructor(templateKey: string, detail: string) {
    super(`Display template "${templateKey}" is invalid: ${detail}`);
    this.name = "InvalidDisplayTemplateError";
  }
}

function isModuleName(name: string): name is DisplayModuleName {
  return (DISPLAY_MODULE_NAMES as readonly string[]).includes(name);
}

/**
 * Validates a definition (data-only — ADR-002 §1). Throws
 * InvalidDisplayTemplateError with the offending detail; a template is never
 * accepted partially broken (issue hoppers99/AlpineClubBookingsNZ#29 AC6) and no code path exists in a
 * definition (AC7 — options are scalars only).
 */
export function validateDisplayTemplateDefinition(
  value: unknown
): DisplayTemplateDefinition {
  const keyForError =
    value && typeof value === "object" && "key" in value
      ? String((value as { key: unknown }).key)
      : "(unknown)";

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidDisplayTemplateError(keyForError, "definition must be an object");
  }
  const def = value as Partial<DisplayTemplateDefinition>;
  if (typeof def.key !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.key)) {
    throw new InvalidDisplayTemplateError(keyForError, "key must be a lower-case slug");
  }
  if (typeof def.name !== "string" || def.name.trim().length === 0) {
    throw new InvalidDisplayTemplateError(def.key, "name is required");
  }
  if (!Array.isArray(def.regions) || def.regions.length === 0) {
    throw new InvalidDisplayTemplateError(def.key, "at least one region is required");
  }

  const seenRegionKeys = new Set<string>();
  for (const region of def.regions) {
    if (!region || typeof region !== "object" || Array.isArray(region)) {
      throw new InvalidDisplayTemplateError(def.key, "each region must be an object");
    }
    if (typeof region.key !== "string" || region.key.trim().length === 0) {
      throw new InvalidDisplayTemplateError(def.key, "each region needs a key");
    }
    if (seenRegionKeys.has(region.key)) {
      throw new InvalidDisplayTemplateError(def.key, `duplicate region key "${region.key}"`);
    }
    seenRegionKeys.add(region.key);
    if (
      region.rotateSeconds !== undefined &&
      (typeof region.rotateSeconds !== "number" ||
        region.rotateSeconds < 3 ||
        region.rotateSeconds > 300)
    ) {
      throw new InvalidDisplayTemplateError(
        def.key,
        `region "${region.key}" rotateSeconds must be 3-300`
      );
    }
    if (
      region.layout !== undefined &&
      region.layout !== "rotate" &&
      region.layout !== "stack"
    ) {
      throw new InvalidDisplayTemplateError(
        def.key,
        `region "${region.key}" layout must be "rotate" or "stack"`
      );
    }
    if (!Array.isArray(region.panels) || region.panels.length === 0) {
      throw new InvalidDisplayTemplateError(
        def.key,
        `region "${region.key}" needs at least one panel`
      );
    }
    for (const panel of region.panels) {
      if (!panel || typeof panel !== "object" || Array.isArray(panel)) {
        throw new InvalidDisplayTemplateError(def.key, "each panel must be an object");
      }
      if (typeof panel.module !== "string" || !isModuleName(panel.module)) {
        throw new InvalidDisplayTemplateError(
          def.key,
          `unknown module "${String(panel.module)}" in region "${region.key}" ` +
            `(known: ${DISPLAY_MODULE_NAMES.join(", ")})`
        );
      }
      if (
        panel.condition !== undefined &&
        (typeof panel.condition !== "string" || !isDisplayConditionName(panel.condition))
      ) {
        throw new InvalidDisplayTemplateError(
          def.key,
          `unknown condition "${String(panel.condition)}" in region "${region.key}" ` +
            `(known: ${DISPLAY_CONDITION_NAMES.join(", ")})`
        );
      }
      if (panel.options !== undefined) {
        if (
          !panel.options ||
          typeof panel.options !== "object" ||
          Array.isArray(panel.options)
        ) {
          throw new InvalidDisplayTemplateError(
            def.key,
            `options in region "${region.key}" must be a flat object`
          );
        }
        for (const [optionKey, optionValue] of Object.entries(panel.options)) {
          const valueType = typeof optionValue;
          if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
            throw new InvalidDisplayTemplateError(
              def.key,
              `option "${optionKey}" in region "${region.key}" must be a scalar`
            );
          }
        }
      }
    }
  }

  return def as DisplayTemplateDefinition;
}

// ---------------------------------------------------------------------------
// Built-in starter templates — the approved design-exploration mockups
// (docs/lobby-display/mockups/). Region skeletons only; the module renderers
// attach in LTV-005/LTV-006.
// ---------------------------------------------------------------------------

const BUILT_IN_DEFINITIONS: DisplayTemplateDefinition[] = [
  {
    key: "everyday-board",
    name: "Everyday board",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      { key: "main", panels: [{ module: "arrivals-board", options: { days: 3 } }] },
      {
        key: "side",
        layout: "stack",
        panels: [
          { module: "chores-board" },
          { module: "lodge-rules" },
          { module: "notice-board", condition: "content:notice" },
        ],
      },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
  {
    key: "whole-lodge",
    name: "Whole lodge",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      {
        key: "main",
        rotateSeconds: DEFAULT_ROTATE_SECONDS,
        panels: [
          { module: "occupancy-grid", condition: "occupancy:whole-lodge-in-window" },
          { module: "welcome" },
          { module: "notice-board", condition: "content:notice" },
        ],
      },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
  {
    key: "singles-house",
    name: "Singles house",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      {
        key: "main",
        panels: [
          { module: "singles-board" },
          { module: "notice-board", condition: "content:notice" },
        ],
      },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
];

// Validate built-ins at module load: a broken starter template is a
// programming error and should fail fast in tests/build, not at render.
for (const definition of BUILT_IN_DEFINITIONS) {
  validateDisplayTemplateDefinition(definition);
}

export function listBuiltInDisplayTemplates(): DisplayTemplateDefinition[] {
  return BUILT_IN_DEFINITIONS.map((definition) => ({ ...definition }));
}

export interface ResolvedDisplayTemplate {
  definition: DisplayTemplateDefinition;
}

/** The club-wide default template for a device with no explicit binding. */
export const DEFAULT_DISPLAY_TEMPLATE_KEY = "everyday-board";

/**
 * Filter a region's panels to those whose condition holds for the current
 * payload (ADR-002 §3; issue hoppers99/AlpineClubBookingsNZ#29 AC5). The renderer shows the survivors in
 * order and rotates when more than one remains.
 */
export function eligibleDisplayPanels(
  region: DisplayRegionDefinition,
  state: DisplayState
): DisplayPanelDefinition[] {
  return region.panels.filter((panel) =>
    evaluateDisplayCondition(panel.condition ?? "always", state)
  );
}
