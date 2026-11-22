import { MODULE_DEFINITIONS, type ModuleKey } from "@/config/modules";
import type { DisplayState } from "../lodge-display-state";

// Rotation / area-eligibility conditions for the lobby display (ADR-003 §3):
// a closed, code-defined registry, each entry a PURE function of the
// DisplayState payload — no queries, no side effects — so a wall never rotates
// into (or shows) an area that is wrong for the current data. A general
// expression language was deliberately deferred; admins pick from this set in a
// dropdown and discover them in the Conditions reference screen (LTV-034).
//
// NOTE: this module is CLIENT-SAFE by design — it imports only the module
// definitions (pure data) and the DisplayState type. No prisma/database import
// may enter here; capability flags reach the evaluator through
// `DisplayState.capabilities`, never through a live query.
//
// Names are namespaced `namespace:name` (matching the `{{config:key}}` token
// grammar), giving clash-free contribution: `occupancy:*` / `content:*` are
// core built-ins, `<module>:*` are contributed by an optional module, and the
// bare `always` is the default.

export type DisplayConditionFamily =
  | "core"
  | "occupancy"
  | "content"
  | "capability";

export interface DisplayConditionDefinition {
  /** Namespaced `namespace:name` key (or the bare `always`). */
  name: string;
  family: DisplayConditionFamily;
  /** Human-readable one-liner — feeds the LTV-034 Conditions reference. */
  description: string;
  evaluate: (state: DisplayState) => boolean;
}

// Module key → condition-namespace slug. This single map both (a) generates the
// `<module>:enabled` capability conditions below and (b) bounds which module
// flags `buildDisplayState` copies onto the public payload
// (`DisplayState.capabilities`). Adding a module to the display's condition
// vocabulary is ONE line here — the ADR's principle that the vocabulary grows
// by shipping a module, not by admins writing expressions. A slug differs from
// its camelCase module key (e.g. `bedAllocation` → `bed-allocation`), so this
// is a map, not a bare key list.
export const DISPLAY_RELEVANT_MODULE_KEYS = {
  bedAllocation: "bed-allocation",
  chores: "chores",
} as const satisfies Partial<Record<ModuleKey, string>>;

/**
 * Does this row hold a bed on the lodge night `date`?
 *
 * Asked of the row's own night set (#2735). It used to be
 * `stayStart <= date < stayEnd`, which is the same nights for a contiguous row
 * and fills the gaps of one that is not: a row whose guests are here Friday and
 * Monday but not Saturday claimed the lodge on the Saturday. A departure
 * morning is not a night either way.
 *
 * `nights` is REQUIRED on the payload, so the envelope branch is unreachable
 * from a live serialiser. It is kept because this is the one consumer that
 * would otherwise THROW on a row without it — a lobby TV polling an instance
 * still serving the previous deploy's shape would go blank rather than fall
 * back, and the condition engine takes the whole screen down with it. The two
 * other `nights` consumers (`computeBarSegments`, `staySegmentOn`) already
 * degrade this way.
 */
function holdsNight(
  booking: { stayStart: string; stayEnd: string; nights?: readonly string[] },
  date: string
): boolean {
  return booking.nights
    ? booking.nights.includes(date)
    : booking.stayStart <= date && date < booking.stayEnd;
}

/** The window.start ("today") occupancy entry, or null when none is present. */
function todayOccupancy(state: DisplayState): DisplayState["occupancy"][number] | null {
  return (
    state.occupancy.find((day) => day.date === state.window.start) ??
    state.occupancy[0] ??
    null
  );
}

// --- Core + occupancy + content built-ins ---------------------------------
const CORE_CONDITIONS: DisplayConditionDefinition[] = [
  {
    name: "always",
    family: "core",
    description: "Always true — the default when no condition is set.",
    evaluate: () => true,
  },
  {
    name: "occupancy:whole-lodge-today",
    family: "occupancy",
    description: "A whole-lodge booking occupies the lodge tonight.",
    // Today's NIGHT, from the row's own night set — see `holdsNight` (#2735).
    evaluate: (state) =>
      state.bookings.some(
        (booking) => booking.wholeLodge && holdsNight(booking, state.window.start)
      ),
  },
  {
    name: "occupancy:whole-lodge-in-window",
    family: "occupancy",
    description:
      "A whole-lodge booking appears anywhere in the display window (drives the rotating blockout).",
    evaluate: (state) => state.bookings.some((booking) => booking.wholeLodge),
  },
  {
    name: "occupancy:empty-today",
    family: "occupancy",
    description: "No guests are staying tonight.",
    evaluate: (state) => (todayOccupancy(state)?.staying ?? 0) === 0,
  },
  {
    name: "occupancy:arrivals-today",
    family: "occupancy",
    description: "One or more guests arrive today.",
    evaluate: (state) => (todayOccupancy(state)?.arriving ?? 0) > 0,
  },
  {
    name: "occupancy:departures-today",
    family: "occupancy",
    description: "One or more guests depart today.",
    evaluate: (state) => (todayOccupancy(state)?.departing ?? 0) > 0,
  },
  {
    name: "content:notice",
    family: "content",
    description: "A committee notice is set for the lodge.",
    evaluate: (state) => state.notice !== null,
  },
  {
    name: "content:instructions",
    family: "content",
    description: "At least one lodge instruction document has content.",
    evaluate: (state) =>
      (state.rules ?? []).some((doc) => doc.html.trim().length > 0),
  },
];

// --- Capability `<module>:enabled` conditions (generated) ------------------
// Generated from DISPLAY_RELEVANT_MODULE_KEYS + MODULE_DEFINITIONS so each
// inherits its module's label and stays in sync automatically — no
// hand-maintained list (issue hoppers99/AlpineClubBookingsNZ#71 AC2). Evaluated against the flags the
// serialiser copied onto DisplayState.capabilities.
const CAPABILITY_CONDITIONS: DisplayConditionDefinition[] = (
  Object.entries(DISPLAY_RELEVANT_MODULE_KEYS) as Array<[ModuleKey, string]>
).map(([moduleKey, slug]) => ({
  name: `${slug}:enabled`,
  family: "capability",
  description: `The ${MODULE_DEFINITIONS[moduleKey].label} module is enabled.`,
  evaluate: (state) => state.capabilities[moduleKey] === true,
}));

// --- Module-contributed data conditions -----------------------------------
// `chores:today` is the worked example of a module contributing a DATA
// condition (not just a capability flag): it implies the module is enabled and
// that assignments exist for today. `skifield:available` is reserved for the
// later weather work (ADR-003 §3) and is intentionally not shipped here.
const MODULE_DATA_CONDITIONS: DisplayConditionDefinition[] = [
  {
    name: "chores:today",
    family: "capability",
    description:
      "Chores are assigned for today (requires the Chores and roster module).",
    evaluate: (state) =>
      state.capabilities.chores === true &&
      state.chores.some((chore) => chore.date === state.window.start),
  },
];

const DISPLAY_CONDITION_DEFINITIONS: DisplayConditionDefinition[] = [
  ...CORE_CONDITIONS,
  ...CAPABILITY_CONDITIONS,
  ...MODULE_DATA_CONDITIONS,
];

const CONDITION_REGISTRY = new Map(
  DISPLAY_CONDITION_DEFINITIONS.map((definition) => [definition.name, definition])
);

/** Every registered condition name (derived — never hand-maintained). */
export const DISPLAY_CONDITION_NAMES: readonly string[] =
  DISPLAY_CONDITION_DEFINITIONS.map((definition) => definition.name);

// The closed registry is enforced at runtime by `isDisplayConditionName`; the
// generated capability names make a compile-time literal union impractical, so
// this stays a plain string and the validator rejects unknown names.
export type DisplayConditionName = (typeof DISPLAY_CONDITION_NAMES)[number];

export function isDisplayConditionName(
  name: string
): name is DisplayConditionName {
  return CONDITION_REGISTRY.has(name);
}

export function evaluateDisplayCondition(
  name: DisplayConditionName,
  state: DisplayState
): boolean {
  const definition = CONDITION_REGISTRY.get(name);
  if (!definition) {
    // Callers validate names first (template validation / eligibility); an
    // unknown name here is a programming error, surfaced rather than silently
    // treated as false.
    throw new Error(`Unknown display condition "${name}"`);
  }
  return definition.evaluate(state);
}

/** The full registry (name + family + description) for the reference screen. */
export function listDisplayConditions(): DisplayConditionDefinition[] {
  return DISPLAY_CONDITION_DEFINITIONS.map((definition) => ({ ...definition }));
}
