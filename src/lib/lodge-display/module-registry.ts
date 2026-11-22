import { DISPLAY_RELEVANT_MODULE_KEYS } from "./conditions";
import {
  DISPLAY_MODULE_NAMES,
  type DisplayModuleName,
} from "./template-registry";

// Module metadata registry for the lobby display (LTV-026, ADR-003 §1). One
// entry per display module — the seven content modules plus the two pieces of
// page furniture (lodge-header / info-footer). Each entry is the ADR's module
// contract: label + description (admin-facing), the club-module flags it
// depends on, how it behaves when a dependency is unmet, the stable CSS-hook
// class names admins may target, the conditions it contributes, and the embed
// token an authored Layout/Template references it by.
//
// NOTE: this module is CLIENT-SAFE by design — it imports only the condition
// key map (pure data) and the module-name registry (pure data). No
// prisma/database import may enter here; it feeds the admin reference screen
// (LTV-034), the render-boundary dependency guard, and the CSS-hook contract
// test, all of which run in or alongside the client bundle.
//
// This registry records metadata only. Token RESOLUTION of `embedToken` is
// LTV-028's job and the layout render engine is LTV-027 — neither lives here.

/** The club-module flags a display module may depend on (the keys of the
 * condition-namespace map, so a dependency always lines up with a generated
 * `<module>:enabled` capability condition and with `DisplayState.capabilities`). */
export type DisplayModuleDependencyKey =
  keyof typeof DISPLAY_RELEVANT_MODULE_KEYS;

/**
 * How a module behaves when one of its `dependencies` is unmet:
 * - `"degrades"` — the module still renders, in a documented reduced form
 *   (e.g. per-booking rows instead of per-room rows). The component handles
 *   this itself; the render-boundary guard lets it through.
 * - `"hides"` — the module renders nothing (the guard substitutes an empty
 *   `data-module-disabled` placeholder) rather than an empty card on the wall.
 *
 * Modules with no dependencies are `"degrades"` — they always render.
 */
export type DisplayModuleDependencyMode = "degrades" | "hides";

/**
 * A declarative, machine-readable descriptor for one module option (ADR-004 §3).
 * The visual builder's per-module settings drawer is generated from these — a
 * new module without descriptors offers no options in the drawer, and a
 * descriptor can never present an option the module's real parser
 * (`intOption`/`boolOption`/`enumOption`, `module-options.ts`) would reject or
 * silently default: a drift-guard test binds each descriptor's
 * default/bounds/allowed set to the parser's behaviour and to the source
 * constants (issue hoppers99/AlpineClubBookingsNZ#30 AC6 keeps the parser the runtime authority; these are the
 * UI mirror). Scalars only (int/bool/enum) — the same constraint the save
 * contract enforces in `validateSlotContent`. No descriptor may widen a privacy
 * field (ADR-004 §5): widening is structurally impossible (modules only see the
 * already-reduced DisplayState) and a privacy test asserts none is offered.
 */
export type DisplayModuleOptionDescriptor =
  | {
      key: string;
      label: string;
      description?: string;
      type: "int";
      default: number;
      min: number;
      max: number;
    }
  | { key: string; label: string; description?: string; type: "bool"; default: boolean }
  | {
      key: string;
      label: string;
      description?: string;
      type: "enum";
      default: string;
      allowed: readonly string[];
    };

export interface DisplayModuleMetadata {
  /** Registry key — one of DISPLAY_MODULE_NAMES. */
  name: DisplayModuleName;
  /** Admin-facing short name. */
  label: string;
  /** Admin-facing one-liner; documents the reduced form for `"degrades"`. */
  description: string;
  /** Club-module flags this module needs (empty for most). */
  dependencies: readonly DisplayModuleDependencyKey[];
  /** What an unmet dependency does (see DisplayModuleDependencyMode). */
  dependencyMode: DisplayModuleDependencyMode;
  /** Stable class-name contract admins may target from Template CSS. */
  cssHooks: readonly string[];
  /** Condition names this module contributes to the vocabulary (§3). */
  contributes: readonly string[];
  /** The token an authored Layout/Template references this module by. */
  embedToken: string;
  /**
   * Declarative option descriptors driving the visual builder's settings drawer
   * (ADR-004 §3). Empty for a module that takes no options. Every descriptor is
   * bound to the module's real parser by the drift-guard test, so the drawer can
   * never present an option the renderer would reject.
   */
  options: readonly DisplayModuleOptionDescriptor[];
}

function embedToken(name: DisplayModuleName): string {
  return `{{module:${name}}}`;
}

// Metadata is authored per module. Ordered to match DISPLAY_MODULE_NAMES so the
// registry reads as the page does, header first.
const DISPLAY_MODULE_METADATA: DisplayModuleMetadata[] = [
  {
    name: "lodge-header",
    label: "Lodge header",
    description:
      "Fixed page furniture: club logo, lodge name, club name, and the live " +
      "clock (with the admin-preview simulated-date affordance). Present on " +
      "every template.",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-lodge-header",
      "display-header-brand",
      "display-header-logo",
      "display-lodge-name",
      "display-club-name",
      "display-header-clock",
      "display-clock-time",
      "display-clock-date",
    ],
    contributes: [],
    embedToken: embedToken("lodge-header"),
    options: [],
  },
  {
    name: "arrivals-board",
    label: "Arrivals board",
    description:
      "The everyday bar board: one bar per booking across the nights it " +
      "covers, with guest names, expected arrival time and check-out day. " +
      "With bed allocation on it " +
      "groups bars into room rows; with it off it degrades to per-booking rows " +
      "(no room lanes).",
    dependencies: ["bedAllocation"],
    dependencyMode: "degrades",
    cssHooks: [
      "display-arrivals-board",
      "display-board-head",
      "display-board-corner",
      "display-board-day",
      "display-board-row",
      "display-board-room",
      "display-board-room-tag",
      "display-board-lanes",
      "display-bar",
      "display-bar-names",
      "display-bar-overflow",
      // #2621: the expected arrival time on a bar that starts inside the
      // window. Themable like every other bar hook so a club can tone it down.
      "display-bar-arrival",
      "display-bar-out",
    ],
    contributes: [],
    embedToken: embedToken("arrivals-board"),
    // Mirrors arrivals-board.tsx: `days` (intOption 1–7), `max-names` (intOption
    // 1–10), `name-style` (enumOption over ARRIVALS_BOARD_NAME_STYLES). "lead-count"
    // shows the lead name + a count — a privacy RESTRICTION, never a widening.
    options: [
      { key: "days", label: "Nights to show", type: "int", default: 3, min: 1, max: 7 },
      {
        key: "max-names",
        label: "Names per bar",
        description: "How many of the already-privacy-reduced names to list before a +N overflow.",
        type: "int",
        default: 5,
        min: 1,
        max: 10,
      },
      {
        key: "name-style",
        label: "Name style",
        description: "Show the reduced names, or just the lead name and a count (more private).",
        type: "enum",
        default: "names",
        allowed: ["names", "lead-count"],
      },
    ],
  },
  {
    name: "occupancy-grid",
    label: "Occupancy grid",
    description:
      "The whole-lodge blockout view. With rooms configured it renders the " +
      "board variant (room grid with a spanning block); with bed allocation " +
      "off it degrades to the statement variant — a full-width block statement " +
      "plus a week occupancy strip.",
    dependencies: ["bedAllocation"],
    dependencyMode: "degrades",
    cssHooks: [
      "display-occupancy-grid",
      "display-blockout-statement",
      "display-blockout-kicker",
      "display-blockout-label",
      "display-blockout-sub",
      "display-blockout-dates",
      "display-week-strip",
      "display-week-day",
      "display-week-name",
      "display-week-bar",
      "display-week-count",
    ],
    contributes: [],
    embedToken: embedToken("occupancy-grid"),
    // Mirrors occupancy-grid.tsx: `days` (intOption 1–7), `max-names` (intOption
    // 1–10), `variant` (enumOption over OCCUPANCY_GRID_VARIANTS).
    options: [
      { key: "days", label: "Nights in the strip", type: "int", default: 3, min: 1, max: 7 },
      {
        key: "max-names",
        label: "Names per bar",
        type: "int",
        default: 5,
        min: 1,
        max: 10,
      },
      {
        key: "variant",
        label: "Variant",
        description: "Auto picks board when rooms exist, else the statement view; or force one.",
        type: "enum",
        default: "auto",
        allowed: ["auto", "board", "statement"],
      },
    ],
  },
  {
    name: "welcome",
    label: "Welcome panel",
    description:
      "A warm counterpart to the operational boards: greets the current " +
      "whole-lodge group (privacy-reduced label) with size, stay dates, nights " +
      "and an optional bunks note, or greets the lodge generally when no group " +
      "holds it.",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-welcome",
      "display-welcome-kicker",
      "display-welcome-group",
      "display-welcome-note",
      "display-welcome-tiles",
      "display-welcome-tile",
      "display-tile-key",
      "display-tile-value",
    ],
    contributes: [],
    embedToken: embedToken("welcome"),
    options: [],
  },
  {
    name: "singles-board",
    label: "Singles board",
    description:
      "By-booking Room | Guest | night rows, one row per guest with their own " +
      "check-out. With bed allocation on the room label spans its guests' rows; " +
      "with it off it degrades to a single guest column with no room grouping.",
    dependencies: ["bedAllocation"],
    dependencyMode: "degrades",
    cssHooks: [
      "display-singles-board",
      "display-singles-head",
      "display-singles-room",
      "display-board-room-tag",
      "display-singles-guest",
      "display-singles-track",
      "display-singles-bar",
    ],
    contributes: [],
    embedToken: embedToken("singles-board"),
    // Mirrors singles-board.tsx: `days` (intOption 1–7, default ARRIVALS_BOARD_DEFAULT_DAYS).
    options: [
      { key: "days", label: "Nights to show", type: "int", default: 3, min: 1, max: 7 },
    ],
  },
  {
    name: "room-cards",
    label: "Room cards",
    description:
      "Tonight's rooms: a card per room showing who sleeps there tonight with " +
      "their stay span and an arrive/stay/depart dot; unoccupied rooms show a " +
      "dashed free card. Needs bed allocation — with it off it degrades to a " +
      "short note (the arrivals / status boards cover the roomless view).",
    dependencies: ["bedAllocation"],
    dependencyMode: "degrades",
    cssHooks: [
      "display-room-cards",
      "display-room-card",
      "display-room-card-empty",
      "display-room-card-head",
      "display-room-name",
      "display-room-card-count",
      "display-room-people",
      "display-room-person",
      "display-room-dot",
      "display-room-person-name",
      "display-room-span",
    ],
    contributes: [],
    embedToken: embedToken("room-cards"),
    options: [],
  },
  {
    name: "night-columns",
    label: "Next nights",
    description:
      "Next-N-nights look-ahead: a column per upcoming night listing the " +
      "bookings active that night, marked arriving/staying/departing with their " +
      "check-out. With bed allocation on (and the show-rooms option) each row is " +
      "annotated with its room; with it off it degrades to the plain look-ahead.",
    dependencies: ["bedAllocation"],
    dependencyMode: "degrades",
    cssHooks: [
      "display-night-columns",
      "display-night-col",
      "display-night-col-today",
      "display-night-col-head",
      "display-night-col-date",
      "display-night-col-count",
      "display-night-list",
      "display-night-row",
      "display-night-dot",
      "display-night-name",
      "display-night-room",
      "display-night-span",
      "display-night-empty",
    ],
    contributes: [],
    embedToken: embedToken("night-columns"),
    // Mirrors night-columns.tsx: `days` (intOption 1–NIGHT_COLUMNS_MAX_DAYS,
    // default NIGHT_COLUMNS_DEFAULT_DAYS), `show-rooms` (boolOption default true).
    options: [
      // max mirrors NIGHT_COLUMNS_MAX_DAYS = 3 (#2056 Option C: the board is a
      // permanent 3-night board matching the fixed device data window); the
      // descriptor drift-guard test fails if these ever diverge.
      { key: "days", label: "Nights ahead", type: "int", default: 3, min: 1, max: 3 },
      {
        key: "show-rooms",
        label: "Annotate with rooms",
        description: "Show each guest's room when bed allocation is on.",
        type: "bool",
        default: true,
      },
    ],
  },
  {
    name: "status-board",
    label: "Status board",
    description:
      "Allocation-off status board: three columns for tonight — Arriving, " +
      "Staying, Leaving today — with no room boxes. Room-agnostic; renders the " +
      "same whether or not bed allocation is on, and is the natural rotation " +
      "target when rooms are off (condition affinity bed-allocation:enabled = false).",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-status-board",
      "display-status-group",
      "display-status-group-head",
      "display-status-dot",
      "display-status-title",
      "display-status-list",
      "display-status-row",
      "display-status-name",
      "display-status-span",
      "display-status-empty",
    ],
    contributes: [],
    embedToken: embedToken("status-board"),
    options: [],
  },
  {
    name: "chores-board",
    label: "Chores board",
    description:
      "The day's chore assignments. Hard-depends on the Chores and roster " +
      "module: with the Chores flag off it hides entirely (renders nothing) " +
      "rather than showing an empty rail card.",
    dependencies: ["chores"],
    dependencyMode: "hides",
    cssHooks: [
      "display-chores-board",
      "display-card-title",
      "display-chores-day",
      "display-chores-date",
      "display-card-list",
      "display-chore",
      "display-chore-title",
      "display-chore-assignees",
    ],
    contributes: ["chores:enabled", "chores:today"],
    embedToken: embedToken("chores-board"),
    options: [],
  },
  {
    name: "lodge-rules",
    label: "Lodge rules",
    description:
      "Lodge rules / arrival information: renders the sanitised " +
      "lodge-instruction documents; only documents with content earn a card.",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-lodge-rules",
      "display-rules-doc",
      "display-card-title",
      "display-rules-body",
    ],
    contributes: [],
    embedToken: embedToken("lodge-rules"),
    options: [],
  },
  {
    name: "notice-board",
    label: "Notice board",
    description:
      "The committee notice: free text posted by permitted admins, rendered " +
      "as plain text nodes (never HTML). An empty notice renders nothing.",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-notice-board",
      "display-notice-kicker",
      "display-notice-text",
    ],
    contributes: [],
    embedToken: embedToken("notice-board"),
    options: [],
  },
  {
    name: "info-footer",
    label: "Info footer",
    description:
      "Editable page furniture: Wi-Fi, contact email, and a footer note. Each " +
      "item is shown only when its config value is set.",
    dependencies: [],
    dependencyMode: "degrades",
    cssHooks: [
      "display-info-footer",
      "display-footer-item",
      "display-footer-icon",
      "display-footer-note",
    ],
    contributes: [],
    embedToken: embedToken("info-footer"),
    options: [],
  },
];

const MODULE_REGISTRY = new Map(
  DISPLAY_MODULE_METADATA.map((metadata) => [metadata.name, metadata])
);

/** Every module's metadata (for the LTV-034 reference screen). */
export function listDisplayModules(): DisplayModuleMetadata[] {
  return DISPLAY_MODULE_METADATA.map((metadata) => ({ ...metadata }));
}

/** Metadata for one module, or undefined for an unknown name. */
export function getDisplayModule(
  name: DisplayModuleName
): DisplayModuleMetadata | undefined {
  return MODULE_REGISTRY.get(name);
}

/**
 * Modules that are PAGE FURNITURE, not content the builder palette offers
 * (ADR-004 §3): `lodge-header` and `info-footer` are rendered by the display
 * shell (the footer is authored via the footer editor), so neither is a
 * draggable palette item. Kept as an explicit set so a test can assert the
 * palette never surfaces them.
 */
export const DISPLAY_PALETTE_EXCLUDED_MODULES: readonly DisplayModuleName[] = [
  "lodge-header",
  "info-footer",
];

/** The content modules the visual builder's palette offers (ADR-004 §3) — every
 * module except the page furniture the shell renders. */
export function listPaletteDisplayModules(): DisplayModuleMetadata[] {
  return DISPLAY_MODULE_METADATA.filter(
    (metadata) => !DISPLAY_PALETTE_EXCLUDED_MODULES.includes(metadata.name)
  ).map((metadata) => ({ ...metadata }));
}

// Guard against a name drifting out of the metadata registry: fail fast at
// module load (in tests/build) rather than rendering a wall with a module the
// admin reference screen cannot describe.
for (const name of DISPLAY_MODULE_NAMES) {
  if (!MODULE_REGISTRY.has(name)) {
    throw new Error(`Display module "${name}" has no metadata entry`);
  }
}
