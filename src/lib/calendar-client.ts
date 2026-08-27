import {
  addCalendarDays,
  calendarDayOfWeek,
  calendarMonthOf,
  clubCalendarDateOf,
  clubWallTimeOf,
  countClubNights,
  endOfClubDayExclusive,
  formatClubInstantTime,
  formatClubLongWeekdayDate,
  instantForClubWallTime,
  parseCalendarDate,
  parseInstant,
  startOfCalendarMonth,
  startOfClubDay,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";
import type { CalendarEventDTO } from "@/lib/calendar-events";

/**
 * Pure, client-safe date helpers for the month calendar (CT-4, #2870).
 *
 * ## The two kinds, kept apart
 *
 * A month grid is made of CALENDAR DATES — 42 cells, each a day of the club's
 * calendar, with no time of day and no timezone. A `CalendarEvent`'s `startsAt`
 * is an INSTANT. So every function here either takes a {@link CalendarDate} and
 * NO zone, or takes an instant and REQUIRES the club's zone; there is nothing in
 * between, and that asymmetry is the domain rather than a style (see
 * `club-time/types.ts`).
 *
 * ## What this replaces, and why the whole module had to move at once
 *
 * Until CT-4 the grid arithmetic (`startOfMonth`, `addMonths`, `dateKey`,
 * `buildMonthGrid`, `monthGridRange`, `isToday`) ran on host-local `Date`
 * component APIs, justified by "for a single-club NZ deployment the browser IS
 * the lodge's timezone". It is not: a member reading the calendar from London saw
 * a different grid, a different "today" and different day buckets from a member
 * in Ohakune,
 * and the display formatters beside it pinned `APP_TIME_ZONE` — the ENVIRONMENT's
 * zone — rather than the club's persisted one (`INV-CONFIG-002`).
 *
 * The fix could not be applied one call site at a time. Handing a club-derived
 * UTC-midnight `Date` to `getMonth()` makes a self-consistent behind-UTC
 * deployment WORSE, not better — measured on this epic as a whole wrong day
 * against zero wrong hours — so the helper contract and its four component
 * callers changed together.
 *
 * ## `formatMonthTitle` was a live defect, not just an authority question
 *
 * It built `new Date(Date.UTC(year, month, 1))` and read it through an
 * `APP_TIME_ZONE`-pinned formatter. That is the identity only for a club EAST of
 * Greenwich: for `America/Denver` the encoding of 1 April 2026 reads back as
 * 31 March, so the heading over an April grid said "March 2026". It is now
 * `formatClubMonthYear` over the month's calendar date, which is the identity for
 * every club.
 *
 * No server-only imports may be added to this module (it is bundled to the
 * client). The club's zone reaches a component through `ClubTimeProvider`, never
 * from the browser's own clock.
 */

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayLabels(): string[] {
  return WEEKDAY_LABELS;
}

/** Whether a grid cell belongs to the month being displayed. */
export function isSameCalendarMonth(
  day: CalendarDate,
  monthStart: CalendarDate,
): boolean {
  return calendarMonthOf(day) === calendarMonthOf(monthStart);
}

/**
 * The 6x7 grid of days covering `monthStart`'s month, weeks starting Monday. The
 * leading/trailing days spill into the previous/next month so every week is
 * full — the standard month-calendar layout.
 */
export function buildMonthGrid(monthStart: CalendarDate): CalendarDate[] {
  const first = startOfCalendarMonth(monthStart);
  // calendarDayOfWeek(): 0=Sun..6=Sat. Convert to Monday-first offset (Mon=0..Sun=6).
  const mondayOffset = (calendarDayOfWeek(first) + 6) % 7;
  const gridStart = addCalendarDays(first, -mondayOffset);
  return Array.from({ length: 42 }, (_, i) => addCalendarDays(gridStart, i));
}

/**
 * The inclusive `[from, to]` instants covering a month's full grid, for the
 * events API's overlap query.
 *
 * Both ends are CLUB day boundaries. The pair this replaces was
 * `setHours(0, 0, 0, 0)` / `setHours(23, 59, 59, 999)` on a host-local `Date`,
 * so the window a member's browser asked for was their own day's, not the
 * club's — up to a day of events missing from one edge of the grid and a day of
 * extra events on the other.
 *
 * `to` is INCLUSIVE because that is what the route's `startsAt: { lte: to }`
 * compares against. It is derived from the kernel's half-open
 * `endOfClubDayExclusive` and stepped back one millisecond, which is the
 * `getTime() - 1` idiom group A asked for as `endOfClubDayInclusive(date, zone)`
 * and did not add; this is a fifth caller for it (#2870).
 */
export function monthGridRange(
  monthStart: CalendarDate,
  zone: ClubTimeZone,
): { from: Instant; to: Instant } {
  const grid = buildMonthGrid(monthStart);
  const from = startOfClubDay(grid[0], zone);
  const to = new Date(
    endOfClubDayExclusive(grid[grid.length - 1], zone).getTime() - 1,
  );
  return { from, to };
}

/**
 * Cap on how many day-cells a single event may expand across. A well-formed
 * event never spans a year; this guards against a malformed `endsAt` (e.g. a
 * bad import putting the end centuries in the future) blowing up the loop and
 * the grid. 370 comfortably covers any legitimate multi-day event.
 */
const MAX_EVENT_SPAN_DAYS = 370;

/**
 * Group events by the CLUB calendar day they fall on. A multi-day /
 * midnight-spanning event — one whose `endsAt` falls on a later club calendar
 * day than its `startsAt` — is added to EVERY day it covers, from its start day
 * through its end day inclusive, so it renders on each of those cells. Events
 * with no `endsAt`, an invalid/earlier `endsAt`, or an `endsAt` on the same club
 * day stay in a single bucket.
 *
 * The day an instant "is" depends entirely on the zone it is read in, which is
 * why `zone` is required here and why it must be the club's persisted one: a
 * 22:00 event read in a browser twelve hours away lands on the wrong cell, and
 * used to.
 *
 * An event whose `startsAt` is not a parseable instant is DROPPED rather than
 * bucketed. The host-local version keyed it under the literal string
 * `"NaN-NaN-NaN"`, which no grid cell ever reads, so this changes nothing a
 * screen can see and removes a garbage key from the map.
 */
export function groupEventsByDay(
  events: CalendarEventDTO[],
  zone: ClubTimeZone,
): Map<CalendarDate, CalendarEventDTO[]> {
  const byDay = new Map<CalendarDate, CalendarEventDTO[]>();

  const addToDay = (key: CalendarDate, event: CalendarEventDTO) => {
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      byDay.set(key, [event]);
    }
  };

  for (const event of events) {
    const start = parseInstant(event.startsAt);
    if (start === null) continue;
    const startKey = clubCalendarDateOf(start, zone);

    // Single-bucket fast paths: no end, an unparseable end, or an end that does
    // not reach a later club day than the start.
    const end = event.endsAt ? parseInstant(event.endsAt) : null;
    if (end === null) {
      addToDay(startKey, event);
      continue;
    }
    const endKey = clubCalendarDateOf(end, zone);
    if (endKey <= startKey) {
      // `endKey <= startKey` (plain comparison on a four-digit-year `YYYY-MM-DD`
      // IS chronological order) covers same-day and any end-before-start data.
      addToDay(startKey, event);
      continue;
    }

    // Multi-day: walk club calendar days from the start day through the end day
    // inclusive, capped so a pathological span can't run away.
    const span = Math.min(
      countClubNights(startKey, endKey),
      MAX_EVENT_SPAN_DAYS,
    );
    for (let i = 0; i <= span; i++) {
      addToDay(addCalendarDays(startKey, i), event);
    }
  }

  // All-day events first, then chronological.
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (
        (parseInstant(a.startsAt)?.getTime() ?? 0) -
        (parseInstant(b.startsAt)?.getTime() ?? 0)
      );
    });
  }
  return byDay;
}

/** "2:30 pm" in CLUB time for a serialised instant; the raw value if malformed. */
export function formatInstantTime(iso: string, zone: ClubTimeZone): string {
  const instant = parseInstant(iso);
  // The kernel's formatters throw a RangeError on an unusable value, and an
  // unhandled throw in a client render blanks the screen behind an error
  // boundary. Falling back to the raw text is the same judgement
  // `describeRecurrence` makes for a malformed `until`.
  return instant === null ? iso : formatClubInstantTime(instant, zone);
}

/** Short chip/list label for an event's time ("All day", "7:00 pm"). */
export function formatEventTime(
  event: CalendarEventDTO,
  zone: ClubTimeZone,
): string {
  if (event.allDay) return "All day";
  return formatInstantTime(event.startsAt, zone);
}

/**
 * "Thursday, 16 April 2026" for the club calendar day an event starts on.
 *
 * The instant is projected into the club's calendar ONCE, and the resulting
 * calendar date is then formatted with no zone at all — rather than handing the
 * instant to a zone-pinned display formatter, which is the same operation only
 * while the pinned zone happens to be the club's.
 */
export function formatEventDateLong(
  event: CalendarEventDTO,
  zone: ClubTimeZone,
): string {
  const instant = parseInstant(event.startsAt);
  if (instant === null) return event.startsAt;
  return formatCalendarDateLong(clubCalendarDateOf(instant, zone));
}

/**
 * "Thursday, 16 April 2026" for a calendar day. No zone: a day has none.
 *
 * Deliberately wordier than `formatClubWeekdayDate` ("Thu, 16 Apr 2026") because
 * these are single-day/single-event headings rather than scannable list rows.
 * F3 (#3079) declared this bag as the kernel's `longWeekdayDate` shape — the
 * fourth caller was what earned it — so the local formatter this file carried is
 * gone rather than composed from `longWeekdayDayMonth` plus the year, which is
 * byte-identical for `en-NZ` and not safe for a configurable `APP_LOCALE`.
 */
function formatCalendarDateLong(date: CalendarDate): string {
  return formatClubLongWeekdayDate(date);
}

/**
 * Long date label for a `YYYY-MM-DD` day key, used as the day-detail dialog
 * heading and the per-cell screen-reader label. Falls back to the raw key if it
 * is malformed — the key reaches here through React state typed `string | null`,
 * and showing the stored text beats blanking the dialog.
 */
export function formatDayKeyLong(dayKey: string): string {
  const date = parseCalendarDate(dayKey);
  return date === null ? dayKey : formatCalendarDateLong(date);
}

/**
 * `<input type="date">` value for a serialised instant: the CLUB calendar day it
 * falls on, never the viewer's.
 */
export function toDateInputValue(iso: string, zone: ClubTimeZone): string {
  const instant = parseInstant(iso);
  return instant === null ? "" : clubCalendarDateOf(instant, zone);
}

/**
 * `<input type="time">` value (`HH:MM`) for a serialised instant: the CLUB
 * wall-clock reading, so an admin in London editing a 7pm club meeting is shown
 * 19:00 and does not silently move it by saving.
 */
export function toTimeInputValue(iso: string, zone: ClubTimeZone): string {
  const instant = parseInstant(iso);
  if (instant === null) return "";
  const wall = clubWallTimeOf(instant, zone);
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/**
 * Build an ISO instant from the date + optional time inputs, read as CLUB wall
 * time.
 *
 * This is the inverse of {@link toDateInputValue} / {@link toTimeInputValue} and
 * the write half of the same defect: `new Date("2026-04-16T19:00")` is resolved
 * by JavaScript in the HOST's zone, so an overseas admin creating a 7pm club
 * event stored 7pm THEIR time. The club's zone and its DST rules decide the
 * moment now, and a wall time the clocks jumped over resolves to the first
 * instant that does exist rather than throwing inside a form submit.
 *
 * AN OMITTED **OR EMPTY** `timeValue` MEANS MIDNIGHT, which is stated because it
 * was briefly not true. `""` is what an `<input type="time">` holds when it has
 * been cleared, and "no time given" and "time cleared" are the same request; the
 * version this replaced used `??`, so an empty string reached `split(":")` and
 * the function returned `null`. The sole caller in this repository passes
 * `startTime || "00:00"` and so never saw it, but this is exported and the guard
 * was in a different file.
 */
export function isoFromDateTimeInputs(
  dateValue: string,
  zone: ClubTimeZone,
  timeValue?: string,
): string | null {
  const date = parseCalendarDate(dateValue);
  if (date === null) return null;
  const parsed = parseWallTime(timeValue);
  if (parsed === null) return null;
  return instantForClubWallTime(date, parsed, zone, GAP_TOLERANT).toISOString();
}

/** `HH:MM` as whole hours and minutes in range, or null. Empty means midnight. */
function parseWallTime(
  timeValue: string | undefined,
): { hour: number; minute: number } | null {
  const [hour, minute] = (timeValue || "00:00").split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * The DST policy both ends of an event share: a wall time the clocks jumped over
 * resolves to the first instant that does exist, and the earlier of a repeated
 * pair wins.
 */
const GAP_TOLERANT = {
  skipped: "nextExistingInstant",
  ambiguous: "earliest",
} as const;

/**
 * The END instant of a timed event, given the date and the two wall times the
 * officer typed.
 *
 * ## Why this is not just `isoFromDateTimeInputs` twice
 *
 * Because on one morning a year that produces a ZERO-LENGTH event, and it is a
 * regression this subsystem's migration introduced rather than a limit it
 * inherited. Every wall-clock reading inside a spring-forward gap resolves to
 * the same instant — the moment the clocks jumped to — so `02:00`-`02:30` on
 * 27 September 2026 in `Pacific/Auckland` resolves to `03:00` at BOTH ends.
 * `resolveCalendarEventDates` refuses only an end BEFORE the start, so the row
 * persists and the panel reads "3:00 am – 3:00 am". The host-local version this
 * replaced stored thirty minutes, because JavaScript slid each end
 * independently.
 *
 * ## What it does instead, and what it deliberately does NOT do
 *
 * The exact wall time is kept wherever it survives the transition. Only when the
 * typed end is LATER than the typed start and the resolved end is not later than
 * the resolved start — which is precisely the both-ends-in-one-gap case — is the
 * end re-derived as the start plus the typed wall duration, restoring the
 * thirty minutes the officer asked for.
 *
 * Deriving the end from the duration ALWAYS was the obvious fix and is worse.
 * A `01:30`-`03:30` event on that same morning spans two hours of wall clock and
 * one hour of real time; duration-first would store it ending at `04:30`, an
 * hour after the officer typed `03:30`. Exact-first keeps `03:30` and gives up
 * only the elapsed length, which is the right trade for a form whose two fields
 * are wall times. So the repair is scoped to the degenerate case and nothing
 * else moves.
 *
 * A deliberately zero-length event — the same time typed twice — is left alone,
 * so this refuses nothing the officer asked for.
 */
export function isoEndFromDateTimeInputs(
  dateValue: string,
  zone: ClubTimeZone,
  startTime: string | undefined,
  endTime: string,
): string | null {
  const date = parseCalendarDate(dateValue);
  if (date === null) return null;
  const start = parseWallTime(startTime);
  const end = parseWallTime(endTime);
  if (start === null || end === null) return null;

  const startInstant = instantForClubWallTime(date, start, zone, GAP_TOLERANT);
  const endInstant = instantForClubWallTime(date, end, zone, GAP_TOLERANT);

  const typedMinutes = (t: { hour: number; minute: number }) =>
    t.hour * 60 + t.minute;
  const typedEndIsLater = typedMinutes(end) > typedMinutes(start);
  const resolvedEndIsLater = endInstant.getTime() > startInstant.getTime();
  if (typedEndIsLater && !resolvedEndIsLater) {
    const durationMs =
      (typedMinutes(end) - typedMinutes(start)) * 60 * 1000;
    return new Date(startInstant.getTime() + durationMs).toISOString();
  }
  return endInstant.toISOString();
}

/**
 * Whether a save request should carry the recurrence rule.
 *
 * The rule is sent on create, when converting a standalone event to recurring,
 * and on a whole-series edit. It is dropped ONLY when editing a single
 * occurrence of an existing series (that path changes just this occurrence,
 * never the pattern). Extracted from the dialog so the exact decision that once
 * silently swallowed recurrence on create (#calendar-recurring) is unit-tested.
 */
export function shouldIncludeRecurrence(opts: {
  /** Selected repeat value ("NONE" or a frequency). */
  repeat: string;
  /** Editing an existing event (vs creating). */
  isEdit: boolean;
  /** The event being edited already belongs to a series. */
  isSeriesEvent: boolean;
  /** The chosen edit scope. */
  scope: "single" | "series";
}): boolean {
  if (opts.repeat === "NONE") return false;
  return !(opts.isEdit && opts.isSeriesEvent && opts.scope === "single");
}
