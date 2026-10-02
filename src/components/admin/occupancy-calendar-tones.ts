/**
 * Calendar overlay TONES: the tone/emphasis vocabulary callers speak, and the
 * static class table it maps to.
 *
 * Split out of `occupancy-calendar.tsx` (#2887) because it is presentational
 * data with no React in it, and that file crossed its size budget. The types
 * are re-exported from the component so no caller import changes.
 */

export type CalendarTone = "red" | "amber" | "orange" | "green" | "violet";

// How prominently an overlay paints its cell. "fill" (default) is the original
// solid tint; "ring" draws a low-emphasis outline over a white cell so a covered
// night with no guests reads as quiet history rather than an active state.
export type CalendarOverlayEmphasis = "fill" | "ring";

export type CalendarOverlayValue = {
  tone: CalendarTone;
  /** The cell's text, and what a screen reader hears after the date. */
  label: string;
  emphasis?: CalendarOverlayEmphasis;
  /**
   * Optional: paint the badge as these separate lines instead of `label`
   * (#3818 — a hut-leader changeover day shows its morning and afternoon
   * leaders one above the other). `label` stays the accessible text, so a
   * caller sets it to the same lines joined.
   */
  lines?: readonly string[];
};

// Static class table so Tailwind sees every class literally (no dynamic class
// construction, which its JIT would prune). Consumers pass a tone; the calendar
// never builds these strings at runtime. `ringCell` is the low-emphasis variant
// used when an overlay sets emphasis: "ring".
//
// "Restrained Alpine" (epic #1800, #1815): each tone now renders on the shared
// dark-adapting semantic tokens (#1801/#1804 success/warning/info/danger + the
// neutral muted pair) instead of hardcoded Tailwind hues, so overlays adapt in
// dark mode. The keys stay the original COLOUR NAMES to preserve the tone-string
// API that callers (roster + hut-leaders) already pass — so a key's name no
// longer implies its rendered hue (e.g. `orange` renders `info`, `violet`
// renders neutral). Meaning is always carried by the overlay's text label too,
// never colour alone. Roster severity order (needs-roster > suggested >
// needs-attention > confirmed) maps onto danger > warning > info > success.
export const CALENDAR_TONE_CLASSES: Record<
  CalendarTone,
  { cell: string; ringCell: string; badge: string }
> = {
  red: {
    cell: "border-danger/40 bg-danger-muted text-foreground hover:shadow-sm",
    ringCell: "ring-1 ring-inset ring-danger/50 bg-card text-foreground hover:shadow-sm",
    badge: "bg-danger-muted text-danger",
  },
  amber: {
    cell: "border-warning/40 bg-warning-muted text-foreground hover:shadow-sm",
    ringCell: "ring-1 ring-inset ring-warning/50 bg-card text-foreground hover:shadow-sm",
    badge: "bg-warning-muted text-warning",
  },
  orange: {
    cell: "border-info/40 bg-info-muted text-foreground hover:shadow-sm",
    ringCell: "ring-1 ring-inset ring-info/50 bg-card text-foreground hover:shadow-sm",
    badge: "bg-info-muted text-info",
  },
  green: {
    cell: "border-success/40 bg-success-muted text-foreground hover:shadow-sm",
    ringCell: "ring-1 ring-inset ring-success/50 bg-card text-foreground hover:shadow-sm",
    badge: "bg-success-muted text-success",
  },
  violet: {
    cell: "border-border bg-muted text-foreground hover:shadow-sm",
    ringCell: "ring-1 ring-inset ring-border bg-card text-foreground hover:bg-muted",
    badge: "bg-muted text-foreground",
  },
};
