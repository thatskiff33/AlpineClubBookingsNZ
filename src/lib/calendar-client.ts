import { APP_LOCALE } from "@/config/operational";
import {
  addCalendarDays,
  calendarDateFromParts,
  calendarDateParts,
  calendarMonthOf,
  clubCalendarDateOf,
  clubWallTimeOf,
  countClubNights,
  dateOnlyInstantOf,
  endOfClubDayExclusive,
  formatClubInstantTime,
  instantForClubWallTime,
  parseCalendarDate,
  parseInstant,
  startOfClubDay,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";
import { calendarDayOfWeek } from "@/lib/calendar-recurrence";
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
 * the lodge's timezone". It is not: a member booking from London saw a different
 * grid, a different "today" and different day buckets from a member in Ohakune,
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

/**
 * Long weekday-bearing calendar date, e.g. "Thursday, 16 April 2026".
 * Deliberately wordier than the kernel's `formatClubWeekdayDate`
 * ("Thu, 16 Apr 2026") because these are single-day/single-event headings, not
 * scannable list rows.
 *
 * PINNED TO `UTC`, WHICH IS AN IDENTITY AND NOT A PROJECTION — the calendar day
 * is encoded at UTC midnight and read back in UTC, which has no transitions, so
 * the club's zone is not consulted and could not change the answer. The
 * mechanism is documented in full on `formatCalendarDateShape`
 * (`club-time/intl.ts`).
 *
 * STILL A LOCAL `Intl.DateTimeFormat` BECAUSE THE KERNEL HAS NO SUCH SHAPE.
 * `HOUSE_SHAPES` declares `longWeekdayDayMonth` ("Thursday, 16 April") but
 * nothing carrying the YEAR as well, and composing one on is byte-identical for
 * `en-NZ` and NOT safe in general, because `APP_LOCALE` is configurable. Adding a
 * shape means editing `src/lib/club-time/**`, which is another lane's surface in
 * this migration (#2870, group F3); `booking-calendar.tsx`, `booking-editor.tsx`
 * and `guest-night-grid.tsx` carry the identical note, and this is the fourth
 * caller of the same missing shape.
 */
const CALENDAR_LONG_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayLabels(): string[] {
  return WEEKDAY_LABELS;
}

/**
 * The first day of the calendar month `date` falls in — the month anchor the
 * grid, the heading and the fetch window are all derived from.
 *
 * Another helper the kernel could reasonably own; reported to group F3 rather
 * than added to `src/lib/club-time/**` from this lane.
 */
export function startOfCalendarMonth(date: CalendarDate): CalendarDate {
  const { year, month } = calendarDateParts(date);
  return calendarDateFromParts(year, month, 1);
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

/** "Thursday, 16 April 2026" for a calendar day. No zone: a day has none. */
function formatCalendarDateLong(date: CalendarDate): string {
  return CALENDAR_LONG_DATE.format(dateOnlyInstantOf(date));
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
 */
export function isoFromDateTimeInputs(
  dateValue: string,
  zone: ClubTimeZone,
  timeValue?: string,
): string | null {
  const date = parseCalendarDate(dateValue);
  if (date === null) return null;
  const [hour, minute] = (timeValue ?? "00:00").split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return instantForClubWallTime(
    date,
    { hour, minute },
    zone,
    { skipped: "nextExistingInstant", ambiguous: "earliest" },
  ).toISOString();
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
