// Lobby-display terminology — ONE source of truth for the operator-facing
// definitions of the three words the admin uses for two database rows (#2247).
//
// The admin surfaces used "Layout", "Template" and "board" interchangeably and
// defined none of them, so nobody could tell a Template from a Layout. Layout
// and Template are ADR-003 §1
// (`docs/lobby-display/decisions/ADR-003-layout-template-authoring-model.md`)
// restated in operator language. "Board" is NOT in that ADR — it is the word
// the admin and the built-in names grew afterwards, and defining it is this
// module's own contribution (see the decision note below). What the module
// exists for is that the hub cards, the Layouts/Templates pages, the Reference
// page and `docs/guides/display.md` cannot drift apart again.
//
// Decision recorded for "board" (#2247): the word is KEPT, not removed. It is
// the operator-facing word for *what a TV shows* — the thing the Visual builder
// composes and the thing the built-ins are named after ("Everyday board") — and
// it maps onto no single row: a board is a Template rendered on its Layout for
// the lodge its screen is paired to. Defining it once beats renaming ~20 builder
// strings to "template pair", which would read worse and say less.
//
// `oneLiner` is quoted VERBATIM in `docs/guides/display.md` and asserted by
// `display-terminology.test.ts`, so edit the definition here and the guide
// together.

export interface DisplayTerm {
  /** The operator-facing word, capitalised as it is used in the admin. */
  term: string;
  /** A single sentence-pair definition, short enough to sit on a hub card. */
  oneLiner: string;
}

export const DISPLAY_TERM_LAYOUT: DisplayTerm = {
  term: "Layout",
  oneLiner:
    "A Layout is the structural skeleton of a board: an HTML body with named areas and a default CSS block. It sets the shape, not the words.",
};

export const DISPLAY_TERM_TEMPLATE: DisplayTerm = {
  term: "Template",
  oneLiner:
    "A Template is a Layout filled in: content or an embedded module in each area, CSS layered over the layout default, and the footer. A Template is what you bind to a screen.",
};

export const DISPLAY_TERM_BOARD: DisplayTerm = {
  term: "Board",
  oneLiner:
    "A board is what a lobby screen actually shows: a Template rendered on its Layout for the lodge that screen is paired to.",
};

/** Layout → Template → board, in the order an operator meets them. */
export const DISPLAY_GLOSSARY: readonly DisplayTerm[] = [
  DISPLAY_TERM_LAYOUT,
  DISPLAY_TERM_TEMPLATE,
  DISPLAY_TERM_BOARD,
];

/**
 * The Lobby Display hub's lead-in line.
 *
 * Deliberately NAMES the three words without defining any of them: each hub
 * card opens with the definition of the one it is about, and the Reference page
 * gathers all three. A fourth paraphrase in the header — which is what this
 * replaced — is exactly the drift this module exists to prevent, so the lead-in
 * is held here rather than typed into the page.
 */
export const DISPLAY_GLOSSARY_LEAD =
  "Three words, two of them stored: a Layout, a Template built on it, and " +
  "the board a screen shows. The Display Builder, Display Layouts and Display " +
  "Templates cards each open with the one they are about, and the Display " +
  "Reference card gathers all three.";
