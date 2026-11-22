import type { Prisma } from "@prisma/client";
import {
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
} from "./layout-registry";

// Built-in lobby-display designs, re-expressed as v2 Layout + Template rows
// (LTV-038, ADR-003 §1 Consequences "Redone"). The MVP shipped three code
// built-ins (everyday-board / whole-lodge / singles-house) as region/panel
// definitions resolved by their registry key (template-registry.ts). This module
// re-expresses the SAME three designs in the v2 shapes — an HTML Layout with
// named areas + a Template that fills those areas with library modules — and
// SEEDS them create-if-missing so they become ordinary, admin-editable rows.
//
// Visual parity (the acceptance criterion): the module components render
// identically (their CSS in display.css is untouched); each Layout's `defaultCss`
// re-creates the PAGE-GRID treatments the legacy `.display-screen` region grid
// carried (the two-column board+rail treatment from `.display-screen:has(
// .display-region-side)`, the stacked side-rail from `.display-region-stack`,
// and the compact notice-card treatment) so the rendered boards match the
// LTV-015/016 approved mocks. The v2 area model has rotator areas but NOT the
// legacy "stack" layout, so the everyday-board side rail becomes three ADJACENT
// areas inside a rail container div in the layout body (nesting works since
// LTV-041/#96); whole-lodge and singles keep their rotation as rotator areas.
//
// SEED CONTRACT (code-managed scaffolding — owner decision A, issue hoppers99/AlpineClubBookingsNZ#111):
// `ensureBuiltInDisplays` upserts each Layout/Template by its unique `key` and
// REFRESHES its definition from code on every re-seed, so improvements to the
// shipped designs reach existing installs. Built-ins are not edited in place —
// an admin who wants a variant DUPLICATES a built-in into a new (non-`builtin-`)
// row and customises that. Only the reserved `builtin-*` keys are touched here.
// Devices bind to these seeded rows by `templateId`; the legacy device
// `templateKey` column and its one-shot migration were removed in hoppers99/AlpineClubBookingsNZ#86 (LTV-040)
// before the feature shipped. Every step is idempotent: a second run creates
// nothing.
//
// This module is import-safe for a jsdom/client test (it only TYPE-imports
// Prisma — erased at build — and its data + validation come from the client-safe
// layout-registry). The seed itself (`ensureBuiltInDisplays`) is server/seed-only
// by virtue of taking a live PrismaClient.

/** A built-in Layout definition in the v2 DisplayLayout shape. */
export interface BuiltInLayoutSeed {
  key: string;
  name: string;
  description: string;
  bodyHtml: string;
  defaultCss: string;
  areas: DisplayAreaDefinition[];
}

/** A built-in Template definition in the v2 DisplayTemplate shape. `layoutKey`
 * names the Layout it is built on; the seed resolves it to the seeded row's id. */
export interface BuiltInTemplateSeed {
  key: string;
  name: string;
  layoutKey: string;
  slotContent: DisplaySlotContentMap;
  cssOverrides: string;
  footerHtml: string;
}

/** Deterministic ids for the seeded rows so a first-run create is stable and the
 * device migration is unambiguous. Only used on CREATE (upsert create branch); a
 * pre-existing admin row keyed the same keeps ITS id (the upsert matches on key).
 */
const BUILT_IN_LAYOUT_ID = (key: string) => `builtin-layout-${key}`;
const BUILT_IN_TEMPLATE_ID = (key: string) => `builtin-template-${key}`;

// ---------------------------------------------------------------------------
// everyday-board — board + stacked side rail (chores, rules, gated notice).
// Legacy: header[lodge-header] · main[arrivals-board days:3] · side(stack)
// [chores-board, lodge-rules, notice-board(content:notice)] · footer[info-footer].
// The header/footer are page furniture (fixed LodgeHeader + built-in InfoFooter
// when footerHtml is empty), so only the board + rail live in the body.
// ---------------------------------------------------------------------------

const EVERYDAY_BODY =
  '<div class="eb-grid">' +
  '<div class="eb-board">{{area:board}}</div>' +
  '<div class="eb-rail">{{area:chores}}{{area:rules}}{{area:notice}}</div>' +
  "</div>";

// Re-creates, in the authored-CSS scoped world (every selector is server-prefixed
// with `.display-authored-root`), the legacy `.display-screen:has(
// .display-region-side)` two-column grid, the `.display-region-stack` side rail,
// and the `.display-region-stack .display-notice-board` compact notice card.
// The `[data-display-area]` markers (LTV-041) are the inert wrappers the client
// portals each area into, so the height chain must pass through them.
const EVERYDAY_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.eb-grid {
  display: grid;
  grid-template-columns: 1fr 27vw;
  grid-template-rows: 1fr;
  column-gap: 2.6vmin;
  height: 100%;
  min-height: 0;
}
.eb-board { overflow: hidden; min-width: 0; }
.eb-board > [data-display-area] { display: block; height: 100%; }
.eb-rail {
  display: flex;
  flex-direction: column;
  gap: 1.8vmin;
  overflow: hidden;
}
.eb-rail .display-notice-board {
  height: auto;
  padding: 1.7vmin;
  text-align: left;
  gap: 1.1vmin;
  background: color-mix(in srgb, var(--display-departing) 10%, var(--display-panel));
  border: 1px solid color-mix(in srgb, var(--display-departing) 40%, transparent);
  border-radius: 1.4vmin;
}
.eb-rail .display-notice-kicker { font-size: 1.7vmin; letter-spacing: 0.18em; }
.eb-rail .display-notice-text { font-size: 2vmin; }
`;

const EVERYDAY_LAYOUT: BuiltInLayoutSeed = {
  key: "everyday-board",
  name: "Everyday board",
  description:
    "The daily arrivals board with a stacked side rail (chores, house rules, and a committee notice when one is set).",
  bodyHtml: EVERYDAY_BODY,
  defaultCss: EVERYDAY_CSS,
  // Each static/conditional area declares the module it is built to show as its
  // `defaultContent` (issue hoppers99/AlpineClubBookingsNZ#111): the Template authoring editor seeds a NEW
  // template's slots from these, so an author starts from the REAL default rather
  // than an empty box. These mirror EVERYDAY_TEMPLATE.slotContent exactly.
  // Rotator-child defaults (whole-lodge / singles-house) are a FOLLOW-UP —
  // DisplayAreaChild has no defaultContent field yet, so those child slots still
  // seed empty until the child type gains one.
  areas: [
    {
      key: "board",
      description: "The arrivals / bar board.",
      kind: "static",
      defaultContent: { module: "arrivals-board", options: { days: 3 } },
    },
    {
      key: "chores",
      description: "Today's chores card.",
      kind: "static",
      defaultContent: { module: "chores-board" },
    },
    {
      key: "rules",
      description: "House rules card.",
      kind: "static",
      defaultContent: { module: "lodge-rules" },
    },
    {
      key: "notice",
      description: "Committee notice — shown only when a notice is set.",
      kind: "conditional",
      condition: "content:notice",
      defaultContent: { module: "notice-board" },
    },
  ],
};

const EVERYDAY_TEMPLATE: BuiltInTemplateSeed = {
  key: "everyday-board",
  name: "Everyday board",
  layoutKey: "everyday-board",
  slotContent: {
    board: { module: "arrivals-board", options: { days: 3 } },
    chores: { module: "chores-board" },
    rules: { module: "lodge-rules" },
    notice: { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>Have a nice day 👋</p>",
};

// ---------------------------------------------------------------------------
// whole-lodge — a rotator that cycles blockout ⇄ welcome ⇄ gated notice.
// Legacy: main(rotate 8s)[occupancy-grid(occupancy:whole-lodge-in-window),
// welcome, notice-board(content:notice)].
// ---------------------------------------------------------------------------

const WHOLE_LODGE_BODY = '<div class="wl-main">{{area:main}}</div>';

const WHOLE_LODGE_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.wl-main { height: 100%; min-height: 0; overflow: hidden; }
.wl-main > [data-display-area] { display: block; height: 100%; }
`;

const WHOLE_LODGE_LAYOUT: BuiltInLayoutSeed = {
  key: "whole-lodge",
  name: "Whole lodge",
  description:
    "A rotating statement board: the whole-lodge blockout when the lodge is booked out, a welcome panel, and a committee notice when one is set.",
  bodyHtml: WHOLE_LODGE_BODY,
  defaultCss: WHOLE_LODGE_CSS,
  areas: [
    {
      key: "main",
      description: "Rotating whole-lodge statement.",
      kind: "rotator",
      rotateSeconds: 8,
      children: [
        {
          key: "occupancy",
          description: "Whole-lodge blockout — shown while a whole-lodge booking is in the window.",
          condition: "occupancy:whole-lodge-in-window",
        },
        { key: "welcome", description: "Welcome panel." },
        {
          key: "notice",
          description: "Committee notice — shown only when a notice is set.",
          condition: "content:notice",
        },
      ],
    },
  ],
};

const WHOLE_LODGE_TEMPLATE: BuiltInTemplateSeed = {
  key: "whole-lodge",
  name: "Whole lodge",
  layoutKey: "whole-lodge",
  slotContent: {
    "main/occupancy": { module: "occupancy-grid" },
    "main/welcome": { module: "welcome" },
    "main/notice": { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>Have a nice day 👋</p>",
};

// ---------------------------------------------------------------------------
// singles-house — the by-booking singles board, rotating with a gated notice.
// Legacy: main(rotate 8s)[singles-board, notice-board(content:notice)] — the
// singles board shows on its own until a notice is set, then the two rotate.
// ---------------------------------------------------------------------------

const SINGLES_BODY = '<div class="sh-main">{{area:main}}</div>';

const SINGLES_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.sh-main { height: 100%; min-height: 0; overflow: hidden; }
.sh-main > [data-display-area] { display: block; height: 100%; }
`;

const SINGLES_LAYOUT: BuiltInLayoutSeed = {
  key: "singles-house",
  name: "Singles house",
  description:
    "The by-booking singles board, rotating with a committee notice when one is set.",
  bodyHtml: SINGLES_BODY,
  defaultCss: SINGLES_CSS,
  areas: [
    {
      key: "main",
      description: "Singles board, rotating with any committee notice.",
      kind: "rotator",
      rotateSeconds: 8,
      children: [
        { key: "singles", description: "The by-booking singles board." },
        {
          key: "notice",
          description: "Committee notice — shown only when a notice is set.",
          condition: "content:notice",
        },
      ],
    },
  ],
};

const SINGLES_TEMPLATE: BuiltInTemplateSeed = {
  key: "singles-house",
  name: "Singles house",
  layoutKey: "singles-house",
  slotContent: {
    "main/singles": { module: "singles-board" },
    "main/notice": { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>Have a nice day 👋</p>",
};

// ===========================================================================
// Template pack (issue #2047) — pre-built layouts exercising the full module
// catalogue. Owner-ticked delivery split (see docs/lobby-display/README.md
// "Template gallery"): the four BROADLY-USEFUL boards below ship as built-in
// seeds (every install gets them, refreshed on re-seed like the originals); the
// two situational boards (busy-weekend rotator, minimal arrivals strip) travel
// in the importable extras bundle (docs/lobby-display/seeds/) instead, so the
// built-in set stays focused on the boards any lodge wants day to day.
//
// Between them these four ALSO complete built-in coverage of the module
// catalogue: they are the first built-in use of room-cards, night-columns, and
// status-board (the originals covered the other content modules), so after this
// pack every content module is exercised by a built-in — asserted in
// lodge-display-built-in-seeds.test.ts. New keys are permanent (re-seed matches
// on key), so they are chosen carefully and never reused.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// room-by-room — tonight's room cards (first built-in use of room-cards) with a
// live arrivals side rail. Two-column board+rail, like everyday-board.
// ---------------------------------------------------------------------------

const ROOM_BY_ROOM_BODY =
  '<div class="rbr-grid">' +
  '<div class="rbr-main">{{area:rooms}}</div>' +
  '<div class="rbr-rail">{{area:arrivals}}</div>' +
  "</div>";

const ROOM_BY_ROOM_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.rbr-grid {
  display: grid;
  grid-template-columns: 1fr 34vw;
  grid-template-rows: 1fr;
  column-gap: 2.6vmin;
  height: 100%;
  min-height: 0;
}
.rbr-main { overflow: hidden; min-width: 0; }
.rbr-main > [data-display-area] { display: block; height: 100%; }
.rbr-rail { overflow: hidden; min-width: 0; }
.rbr-rail > [data-display-area] { display: block; height: 100%; }
`;

const ROOM_BY_ROOM_LAYOUT: BuiltInLayoutSeed = {
  key: "room-by-room",
  name: "Room by room",
  description:
    "Tonight's rooms as cards (who sleeps where) with a live arrivals side rail. Needs bed allocation — the room cards degrade to a short note without it.",
  bodyHtml: ROOM_BY_ROOM_BODY,
  defaultCss: ROOM_BY_ROOM_CSS,
  areas: [
    {
      key: "rooms",
      description: "Tonight's room cards.",
      kind: "static",
      defaultContent: { module: "room-cards" },
    },
    {
      key: "arrivals",
      description: "Arrivals side rail.",
      kind: "static",
      defaultContent: { module: "arrivals-board", options: { days: 3 } },
    },
  ],
};

const ROOM_BY_ROOM_TEMPLATE: BuiltInTemplateSeed = {
  key: "room-by-room",
  name: "Room by room",
  layoutKey: "room-by-room",
  slotContent: {
    rooms: { module: "room-cards" },
    arrivals: { module: "arrivals-board", options: { days: 3 } },
  },
  cssOverrides: "",
  footerHtml: "<p>Welcome to the lodge 🏔️</p>",
};

// ---------------------------------------------------------------------------
// nights-ahead — the coming nights at a glance (first built-in use of
// night-columns): room-level night columns over a notice band that only appears
// when a committee notice is set. Named "Nights ahead" (not "Week ahead")
// because it honestly renders a handful of nights, not a full week — see the
// `days` note below.
// ---------------------------------------------------------------------------

const NIGHTS_AHEAD_BODY =
  '<div class="na-grid">' +
  '<div class="na-main">{{area:planner}}</div>' +
  '<div class="na-band">{{area:notice}}</div>' +
  "</div>";

const NIGHTS_AHEAD_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.na-grid {
  display: grid;
  grid-template-rows: 1fr auto;
  row-gap: 1.8vmin;
  height: 100%;
  min-height: 0;
}
.na-main { overflow: hidden; min-height: 0; }
.na-main > [data-display-area] { display: block; height: 100%; }
.na-band { overflow: hidden; }
.na-band .display-notice-board {
  height: auto;
  padding: 1.6vmin 2vmin;
  text-align: left;
  gap: 1vmin;
  background: color-mix(in srgb, var(--display-accent) 10%, var(--display-panel));
  border: 1px solid color-mix(in srgb, var(--display-accent) 40%, transparent);
  border-radius: 1.4vmin;
}
`;

const NIGHTS_AHEAD_LAYOUT: BuiltInLayoutSeed = {
  key: "nights-ahead",
  name: "Nights ahead",
  description:
    "The next three nights at a glance — room-level night columns (rooms shown when bed allocation is on) over a committee-notice band that appears only when a notice is set.",
  bodyHtml: NIGHTS_AHEAD_BODY,
  defaultCss: NIGHTS_AHEAD_CSS,
  areas: [
    {
      key: "planner",
      description: "The coming nights, one column each.",
      kind: "static",
      // A permanent 3-night board: `days` matches NIGHT_COLUMNS_MAX_DAYS = 3,
      // which in turn matches the fixed 3-day display-device data window
      // (issue #2056 Option C). Bookings beyond three nights are never fetched,
      // so asking for more would render fewer columns than promised — hence the
      // name "Nights ahead" over the next three nights, never "Week ahead".
      defaultContent: {
        module: "night-columns",
        options: { days: 3, "show-rooms": true },
      },
    },
    {
      key: "notice",
      description: "Committee notice band — shown only when a notice is set.",
      kind: "conditional",
      condition: "content:notice",
      defaultContent: { module: "notice-board" },
    },
  ],
};

const NIGHTS_AHEAD_TEMPLATE: BuiltInTemplateSeed = {
  key: "nights-ahead",
  name: "Nights ahead",
  layoutKey: "nights-ahead",
  slotContent: {
    planner: { module: "night-columns", options: { days: 3, "show-rooms": true } },
    notice: { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>See you on the hill ⛷️</p>",
};

// ---------------------------------------------------------------------------
// operations-board — the roomless status board (first built-in use of
// status-board) with a chores + notice rail. chores-board is a `hides` module,
// so with the Chores flag off it drops to an empty placeholder and the rail
// keeps its shape (status + notice) — the required graceful auto-degrade.
// ---------------------------------------------------------------------------

const OPERATIONS_BODY =
  '<div class="ops-grid">' +
  '<div class="ops-main">{{area:status}}</div>' +
  '<div class="ops-rail">{{area:chores}}{{area:notice}}</div>' +
  "</div>";

const OPERATIONS_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.ops-grid {
  display: grid;
  grid-template-columns: 1fr 30vw;
  grid-template-rows: 1fr;
  column-gap: 2.6vmin;
  height: 100%;
  min-height: 0;
}
.ops-main { overflow: hidden; min-width: 0; }
.ops-main > [data-display-area] { display: block; height: 100%; }
.ops-rail {
  display: flex;
  flex-direction: column;
  gap: 1.8vmin;
  overflow: hidden;
}
.ops-rail .display-notice-board {
  height: auto;
  padding: 1.7vmin;
  text-align: left;
  gap: 1.1vmin;
  background: color-mix(in srgb, var(--display-departing) 10%, var(--display-panel));
  border: 1px solid color-mix(in srgb, var(--display-departing) 40%, transparent);
  border-radius: 1.4vmin;
}
`;

const OPERATIONS_LAYOUT: BuiltInLayoutSeed = {
  key: "operations-board",
  name: "Lodge operations",
  description:
    "The roomless tonight status board (arriving / staying / leaving) with a chores and committee-notice rail. The chores card hides itself when the Chores module is off, so the rail keeps its shape.",
  bodyHtml: OPERATIONS_BODY,
  defaultCss: OPERATIONS_CSS,
  areas: [
    {
      key: "status",
      description: "Tonight status board.",
      kind: "static",
      defaultContent: { module: "status-board" },
    },
    {
      key: "chores",
      description: "Today's chores — hides when the Chores module is off.",
      kind: "static",
      defaultContent: { module: "chores-board" },
    },
    {
      key: "notice",
      description: "Committee notice — shown only when a notice is set.",
      kind: "conditional",
      condition: "content:notice",
      defaultContent: { module: "notice-board" },
    },
  ],
};

const OPERATIONS_TEMPLATE: BuiltInTemplateSeed = {
  key: "operations-board",
  name: "Lodge operations",
  layoutKey: "operations-board",
  slotContent: {
    status: { module: "status-board" },
    chores: { module: "chores-board" },
    notice: { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>Thanks for pitching in 🧹</p>",
};

// ---------------------------------------------------------------------------
// welcome-kiosk — the maximum-privacy board: a welcome hero over a rotator that
// cycles house rules and (when set) the committee notice. It embeds ONLY
// welcome / lodge-rules / notice-board — none of the guest-roster / arrivals
// modules — so no guest ROSTER or arrivals name ever appears on it. The one name
// it can show is the whole-lodge GROUP label (WelcomePanel renders
// `wholeLodgeRow.label`), which is `bookingLabel` already reduced to the lodge's
// privacy granularity and never exceeds it — for an exclusive whole-lodge hold
// booked by a single named member (no minors, not an organisation) that label
// CAN be that member's own name at the lodge's setting, so this is the
// lowest-name-surface board, not a zero-name board. Enforced by tests that
// render it against named bookings and assert nothing MORE than the lodge
// granularity's whole-lodge label ever shows (no roster/arrivals names).
// ---------------------------------------------------------------------------

const WELCOME_KIOSK_BODY =
  '<div class="wk-grid">' +
  '<div class="wk-hero">{{area:welcome}}</div>' +
  '<div class="wk-info">{{area:info}}</div>' +
  "</div>";

const WELCOME_KIOSK_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.wk-grid {
  display: grid;
  grid-template-rows: minmax(0, 1.1fr) minmax(0, 1fr);
  row-gap: 2.2vmin;
  height: 100%;
  min-height: 0;
}
.wk-hero { overflow: hidden; min-height: 0; }
.wk-hero > [data-display-area] { display: block; height: 100%; }
.wk-info { overflow: hidden; min-height: 0; }
.wk-info > [data-display-area] { display: block; height: 100%; }
`;

const WELCOME_KIOSK_LAYOUT: BuiltInLayoutSeed = {
  key: "welcome-kiosk",
  name: "Welcome kiosk",
  description:
    "Maximum-privacy greeter: a welcome hero over a rotator cycling the house rules and, when one is set, the committee notice. Shows no guest roster or arrivals names — only the whole-lodge group label, reduced to the lodge's privacy setting — so it is safe for the most public spot in the lodge.",
  bodyHtml: WELCOME_KIOSK_BODY,
  defaultCss: WELCOME_KIOSK_CSS,
  areas: [
    {
      key: "welcome",
      description: "Welcome hero.",
      kind: "static",
      defaultContent: { module: "welcome" },
    },
    {
      key: "info",
      description: "House rules, rotating with any committee notice.",
      kind: "rotator",
      rotateSeconds: 10,
      children: [
        {
          key: "rules",
          description: "House rules / arrival information.",
          // Gated so the rotator never flashes an empty rules card when the
          // lodge has no instruction docs (F3): with no docs, LodgeRules renders
          // an empty div, which would otherwise rotate 10s-blank / 10s-notice.
          // With docs absent AND no notice, the rotator has no eligible child and
          // degrades to nothing (no crash), exactly as any all-gated rotator does.
          condition: "content:instructions",
        },
        {
          key: "notice",
          description: "Committee notice — shown only when a notice is set.",
          condition: "content:notice",
        },
      ],
    },
  ],
};

const WELCOME_KIOSK_TEMPLATE: BuiltInTemplateSeed = {
  key: "welcome-kiosk",
  name: "Welcome kiosk",
  layoutKey: "welcome-kiosk",
  slotContent: {
    welcome: { module: "welcome" },
    "info/rules": { module: "lodge-rules" },
    "info/notice": { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "<p>Make yourself at home 👋</p>",
};

/** The built-in Layouts, in seed order (a Template's Layout must exist first).
 * The three originals (LTV-038) plus the issue-#2047 template-pack built-ins. */
export const BUILT_IN_DISPLAY_LAYOUTS: BuiltInLayoutSeed[] = [
  EVERYDAY_LAYOUT,
  WHOLE_LODGE_LAYOUT,
  SINGLES_LAYOUT,
  ROOM_BY_ROOM_LAYOUT,
  NIGHTS_AHEAD_LAYOUT,
  OPERATIONS_LAYOUT,
  WELCOME_KIOSK_LAYOUT,
];

/** The built-in Templates, one per Layout. The first three are keyed identically
 * to the legacy code built-ins (the registry keys `resolveDisplayTemplate` still
 * resolves); the rest are the issue-#2047 template pack. */
export const BUILT_IN_DISPLAY_TEMPLATES: BuiltInTemplateSeed[] = [
  EVERYDAY_TEMPLATE,
  WHOLE_LODGE_TEMPLATE,
  SINGLES_TEMPLATE,
  ROOM_BY_ROOM_TEMPLATE,
  NIGHTS_AHEAD_TEMPLATE,
  OPERATIONS_TEMPLATE,
  WELCOME_KIOSK_TEMPLATE,
];

// The reserved built-in keys. `ensureBuiltInDisplays` upserts the Layout/Template
// rows keyed here and REFRESHES their definitions from code on every re-seed
// (owner decision A, issue hoppers99/AlpineClubBookingsNZ#111), so an in-place admin edit to a row with one of
// these keys is overwritten on the next re-seed/upgrade. The authoring editors
// use these to warn before an in-place built-in edit and to offer "duplicate to
// customise" (fork issue hoppers99/AlpineClubBookingsNZ#156). Detection is by KEY because the seed matches on
// key — the deterministic `builtin-*` id is only assigned on a fresh create, so a
// row pre-created under a different id but the reserved key is still a built-in.
export const BUILT_IN_DISPLAY_LAYOUT_KEYS: readonly string[] =
  BUILT_IN_DISPLAY_LAYOUTS.map((layout) => layout.key);
export const BUILT_IN_DISPLAY_TEMPLATE_KEYS: readonly string[] =
  BUILT_IN_DISPLAY_TEMPLATES.map((template) => template.key);

/** True when `key` names a built-in Layout (re-seed refreshes it from code, so
 * in-place edits are not upgrade-safe). */
export function isBuiltInDisplayLayoutKey(key: string): boolean {
  return BUILT_IN_DISPLAY_LAYOUT_KEYS.includes(key);
}

/** True when `key` names a built-in Template (re-seed refreshes it from code, so
 * in-place edits are not upgrade-safe). */
export function isBuiltInDisplayTemplateKey(key: string): boolean {
  return BUILT_IN_DISPLAY_TEMPLATE_KEYS.includes(key);
}

// Validate every built-in at module load: a broken seed is a programming error
// and must fail fast in tests/build, never at serve time on a lobby wall. This
// runs the SAME structural contract the authoring routes and the state route's
// assembler apply (validateDisplayLayoutDefinition / validateDisplaySlotContent).
for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
  const areas = validateDisplayLayoutDefinition(layout.bodyHtml, layout.areas);
  const template = BUILT_IN_DISPLAY_TEMPLATES.find(
    (candidate) => candidate.layoutKey === layout.key
  );
  if (!template) {
    throw new Error(`Built-in layout "${layout.key}" has no matching template`);
  }
  validateDisplaySlotContent(areas, template.slotContent);
}

/**
 * The subset of the Prisma client `ensureBuiltInDisplays` touches. Typed against
 * the generated Prisma arg types so the real client satisfies it and a test can
 * pass a narrow mock (cast via `as unknown as EnsureBuiltInDisplaysClient`).
 */
export interface EnsureBuiltInDisplaysClient {
  displayLayout: {
    upsert: (args: Prisma.DisplayLayoutUpsertArgs) => Promise<{ id: string }>;
  };
  displayTemplate: {
    upsert: (args: Prisma.DisplayTemplateUpsertArgs) => Promise<{ id: string }>;
  };
}

/**
 * Seed the built-in Layouts + Templates, refreshing them from code (LTV-038;
 * refresh policy = owner decision A, issue hoppers99/AlpineClubBookingsNZ#111). Idempotent: re-running upserts
 * each by `key` and rewrites its definition to match code, so a re-seed (or the
 * prisma seed on deploy) propagates design improvements — e.g. the per-area
 * `defaultContent` new templates seed from (hoppers99/AlpineClubBookingsNZ#111) — to installs that seeded the
 * built-ins earlier. Built-ins are code-managed scaffolding: to customise, an
 * admin DUPLICATES a built-in into a new (non-`builtin-`) row and edits that;
 * editing a built-in in place is overwritten on the next re-seed. Devices bind
 * to these rows by `templateId`.
 */
export async function ensureBuiltInDisplays(
  prisma: EnsureBuiltInDisplaysClient
): Promise<void> {
  // Built-ins are code-managed scaffolding (owner decision A, issue hoppers99/AlpineClubBookingsNZ#111): each
  // re-seed REFRESHES the built-in's definition from code so improvements to the
  // shipped designs (e.g. new per-area defaults) reach existing installs. An
  // admin who wants a variant DUPLICATES a built-in into a new row rather than
  // editing it in place. Only the reserved `builtin-*` keys are refreshed here.
  const layoutIdByKey = new Map<string, string>();
  for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
    const row = await prisma.displayLayout.upsert({
      where: { key: layout.key },
      update: {
        name: layout.name,
        description: layout.description,
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas as unknown as Prisma.InputJsonValue,
      },
      create: {
        id: BUILT_IN_LAYOUT_ID(layout.key),
        key: layout.key,
        name: layout.name,
        description: layout.description,
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    layoutIdByKey.set(layout.key, row.id);
  }

  for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
    // Bind to the Layout's REAL id from the upsert above (robust to an admin who
    // pre-created a layout with this key under a different id), falling back to
    // the deterministic id for a fresh seed.
    const layoutId =
      layoutIdByKey.get(template.layoutKey) ??
      BUILT_IN_LAYOUT_ID(template.layoutKey);
    await prisma.displayTemplate.upsert({
      where: { key: template.key },
      update: {
        name: template.name,
        layoutId,
        slotContent: template.slotContent as unknown as Prisma.InputJsonValue,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      create: {
        id: BUILT_IN_TEMPLATE_ID(template.key),
        key: template.key,
        name: template.name,
        layoutId,
        slotContent: template.slotContent as unknown as Prisma.InputJsonValue,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      select: { id: true },
    });
  }
}
