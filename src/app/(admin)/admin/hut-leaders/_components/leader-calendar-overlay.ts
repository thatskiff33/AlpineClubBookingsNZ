import type {
  CalendarOverlayLine,
  CalendarOverlayValue,
} from "@/components/admin/occupancy-calendar-tones";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  isCalendarDate,
} from "@/lib/club-time";
import {
  deriveHutLeaderDayHalves,
  hutLeaderAfternoonLine,
  hutLeaderLineText,
  hutLeaderMorningLine,
  joinHutLeaderNames,
  noHutLeaderTonightLabel,
  type HutLeaderOnNight,
} from "@/lib/hut-leader-handover";

/**
 * Short calendar-badge label for a leader: the surname, or initials when the
 * surname is long, so a custodian's multi-month block reads as a band.
 */
export function shortLeaderLabel(memberName: string) {
  const parts = memberName.trim().split(/\s+/).filter(Boolean);
  // The last part IS the "there are no parts" check: a blank name has no
  // surname to abbreviate, which is the same condition the length test
  // expressed (#2801).
  const surname = parts[parts.length - 1];
  if (surname === undefined) return memberName;
  if (surname.length > 10) {
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  }
  return surname;
}

/**
 * The hut-leaders calendar overlay for one visible month (#3818).
 *
 * Every input already went through the one coverage helper on the server:
 * `coveredNights` names who validly covers each night (assigned AND staying)
 * and `redDates` are the nights with guests and no valid shift. This only paints
 * them, with each day read as two halves (`deriveHutLeaderDayHalves`):
 *
 *  - a night with guests and no valid shift: "No <label> tonight" in the
 *    club's own word for the role, preceded by "AM · <leader of the night
 *    before> until midday" when someone is finishing that morning;
 *  - a day whose leaders change: "AM · <who finishes> until midday" and/or
 *    "PM · <who starts> from midday", with anyone on duty in both halves
 *    named plainly first (a one-night overlap never reads as a departure);
 *  - otherwise, a covered night shows its leader as before.
 *
 * A covered night with no guests is painted as a quiet ring, as before. Each
 * value's `label` is its lines in full, for screen readers; a phone-width cell
 * drops the " until midday" / " from midday" suffix, never the name.
 */
export function buildLeaderCalendarOverlay(input: {
  monthStart: Date;
  monthEnd: Date;
  /** Covered nights from the day before `monthStart`, by `yyyy-MM-dd`. */
  coveredNights: ReadonlyMap<string, readonly HutLeaderOnNight[]>;
  redDates: readonly string[];
  guestNights?: ReadonlySet<string>;
  /** The club's configured hut-leader label (`useClubIdentity`). */
  hutLeaderLabel: string;
}): Record<string, CalendarOverlayValue> {
  const overlay: Record<string, CalendarOverlayValue> = {};
  const red = new Set(input.redDates);
  const names = (leaders: readonly HutLeaderOnNight[]) =>
    joinHutLeaderNames(leaders, shortLeaderLabel);
  const labelOf = (lines: readonly CalendarOverlayLine[]) =>
    lines.map(hutLeaderLineText).join(", ");

  const last = calendarDateOfDateOnlyInstant(input.monthEnd);
  for (
    let date = calendarDateOfDateOnlyInstant(input.monthStart);
    date <= last;
    date = addCalendarDays(date, 1)
  ) {
    const previous = addCalendarDays(date, -1);
    const halves = deriveHutLeaderDayHalves(
      input.coveredNights.get(previous) ?? [],
      input.coveredNights.get(date) ?? [],
    );
    const emphasis = input.guestNights?.has(date) ? "fill" : "ring";

    if (red.has(date)) {
      const lines: CalendarOverlayLine[] = [
        ...(halves.leaving.length > 0
          ? [hutLeaderMorningLine(names(halves.leaving))]
          : []),
        noHutLeaderTonightLabel(input.hutLeaderLabel),
      ];
      overlay[date] = { tone: "red", label: labelOf(lines), lines };
      continue;
    }

    if (halves.changes) {
      const lines: CalendarOverlayLine[] = [
        ...(halves.continuing.length > 0 ? [names(halves.continuing)] : []),
        ...(halves.leaving.length > 0
          ? [hutLeaderMorningLine(names(halves.leaving))]
          : []),
        ...(halves.arriving.length > 0
          ? [hutLeaderAfternoonLine(names(halves.arriving))]
          : []),
      ];
      overlay[date] = {
        tone: "violet",
        label: labelOf(lines),
        lines,
        emphasis,
      };
      continue;
    }

    if (halves.afternoon.length > 0) {
      overlay[date] = {
        tone: "violet",
        label: names(halves.afternoon),
        emphasis,
      };
    }
  }

  return overlay;
}

/** Group the route's `coveredNights` rows by night key. */
export function coveredNightsByDate(
  rows: ReadonlyArray<{ date: string; leaders: readonly HutLeaderOnNight[] }>,
): Map<string, readonly HutLeaderOnNight[]> {
  const byDate = new Map<string, readonly HutLeaderOnNight[]>();
  for (const row of rows) {
    // A malformed row is dropped rather than thrown on: the overlay is
    // non-essential and must never take the page down (#2286 review).
    if (
      typeof row?.date !== "string" ||
      !isCalendarDate(row.date) ||
      !Array.isArray(row.leaders)
    ) {
      continue;
    }
    byDate.set(row.date, row.leaders);
  }
  return byDate;
}
