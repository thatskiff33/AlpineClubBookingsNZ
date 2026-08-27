/**
 * Recurring-event rule + occurrence generation (#calendar-recurring).
 *
 * Pure and client-safe (no prisma, no zod, no server-only imports): the same
 * module powers server-side occurrence materialisation and the client-side
 * "Repeat" picker labels.
 *
 * ## The two temporal kinds this module holds, and why they are now separate
 *
 * A `CalendarEvent`'s `startsAt` is a bare `DateTime` — a real INSTANT. The
 * pattern it repeats on ("the 3rd Tuesday", "every second Friday") is a
 * statement about CALENDAR DAYS. Those are different kinds (`club-time/types.ts`),
 * and until CT-4 this module conflated them: every step was taken with host-local
 * `Date` component APIs (`getFullYear`/`getMonth`/`getDate` +
 * `new Date(y, m, d, …)`), so the calendar the series walked was the SERVER
 * CONTAINER's, justified by the docker `TZ=Pacific/Auckland` pin.
 *
 * That is the second authority `INV-CONFIG-002` forbids. The club's civil time is
 * the persisted `ClubTimeSettings.timeZone`; an operator who changes it must not
 * have to redeploy the container for the calendar to follow, and the browser
 * half of this module was reading the VIEWER's calendar rather than either.
 *
 * So the arithmetic now runs on {@link CalendarDate} — exact integer civil-calendar
 * steps with no `Date` in the middle — and each occurrence's instant is derived
 * ONCE, at the end, from the club calendar day plus the anchor's club wall time
 * (`instantForClubWallTime`). A 7pm meeting stays a 7pm meeting across a DST
 * transition because the wall time is what is preserved, not a fixed number of
 * milliseconds.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: pass a club-derived value into a host-local
 * getter. Handing `new Date(Date.UTC(y, m, d))` to `getMonth()` reads a club day
 * in the host's zone, which for a self-consistent behind-UTC deployment turns
 * "correct by accident" into a whole wrong day (#2870, measured across a
 * host x club matrix). The contract and its callers move together or not at all.
 *
 * The human-readable labels at the bottom of the file take a `CalendarDate` and
 * therefore need no zone at all — 16 April 2026 is a Thursday everywhere.
 */

import {
  addCalendarDays,
  addCalendarMonths,
  calendarDateFromParts,
  calendarDateParts,
  calendarDayOfWeek,
  clubCalendarDateOf,
  clubWallTimeOf,
  daysInCalendarMonth,
  endOfClubDayExclusive,
  formatClubDate,
  formatClubLongWeekday,
  instantForClubWallTime,
  parseInstant,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
  type WallTimePolicy,
} from "@/lib/club-time";

export const CALENDAR_RECURRENCE_FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY_DAY_OF_MONTH",
  "MONTHLY_NTH_WEEKDAY",
] as const;

export type CalendarRecurrenceFrequency =
  (typeof CALENDAR_RECURRENCE_FREQUENCIES)[number];

export type RecurrenceEndMode = "never" | "until" | "count";

export interface RecurrenceRule {
  frequency: CalendarRecurrenceFrequency;
  /** Every N units (weeks/months/days). >= 1. */
  interval: number;
  endMode: RecurrenceEndMode;
  /** Inclusive last date (ISO) when endMode === "until". */
  until?: string | null;
  /** Number of occurrences when endMode === "count". */
  count?: number | null;
}

/** Hard ceiling on generated rows, so an open-ended rule can never run away. */
export const MAX_OCCURRENCES = 366;
/** Horizon for an open-ended ("never") rule, from the anchor. */
const NEVER_HORIZON_MONTHS = 24;
/** Loop guard: months/weeks/days we are willing to probe before giving up. */
const MAX_ITERATIONS = 4000;

/**
 * How a generated occurrence resolves the two DST edges.
 *
 * `nextExistingInstant` rather than the kernel's `reject` default: a weekly 2:30
 * am event crosses a spring-forward Sunday on which 2:30 never happens, and a
 * save that threw there would refuse a perfectly ordinary series. The answer is
 * the transition instant — the first moment that does exist — which is the
 * closest thing to 2:30 that day has. `earliest` for the fall-back duplicate, so
 * a series occurrence behaves like a scheduled job and runs at the first
 * 2:30 rather than the second.
 */
const OCCURRENCE_WALL_TIME_POLICY: WallTimePolicy = {
  skipped: "nextExistingInstant",
  ambiguous: "earliest",
};

/** The 1-based ordinal of a date's weekday within its month (1st..5th). */
export function weekdayOrdinalInMonth(date: CalendarDate): number {
  return ordinalFromDayOfMonth(calendarDateParts(date).day);
}

/**
 * The day-of-month for the nth occurrence of `weekday` in the given month, or
 * null when that month has no such nth weekday (e.g. a 5th Tuesday).
 */
function nthWeekdayDayOfMonth(
  year: number,
  month: number,
  weekday: number,
  nth: number,
): number | null {
  const firstWeekday = calendarDayOfWeek(calendarDateFromParts(year, month, 1));
  const firstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  const day = firstOccurrence + (nth - 1) * 7;
  return day <= daysInCalendarMonth(year, month) ? day : null;
}

/**
 * The kth candidate CALENDAR DAY for a rule anchored on `anchorDate`.
 *
 * Returns null when that cycle has no occurrence (only possible for
 * MONTHLY_NTH_WEEKDAY when the nth weekday does not exist that month). Throws a
 * `RangeError` — from the kernel's own arithmetic — for a step that would leave
 * the four-digit year range; {@link generateOccurrenceStarts} stops the series
 * there rather than minting days no reader can hold.
 */
function occurrenceDateForCycle(
  anchorDate: CalendarDate,
  frequency: CalendarRecurrenceFrequency,
  interval: number,
  k: number,
): CalendarDate | null {
  switch (frequency) {
    case "DAILY":
      return addCalendarDays(anchorDate, k * interval);
    case "WEEKLY":
      return addCalendarDays(anchorDate, k * 7 * interval);
    case "MONTHLY_DAY_OF_MONTH":
      // `addCalendarMonths` clamps the day into the target month (the 31st
      // becomes the 30th / 28th) rather than rolling into the following one,
      // which is the behaviour this rule has always had.
      return addCalendarMonths(anchorDate, k * interval);
    case "MONTHLY_NTH_WEEKDAY": {
      const weekday = calendarDayOfWeek(anchorDate);
      const nth = weekdayOrdinalInMonth(anchorDate);
      // Only the target MONTH is taken from the step; the day comes from the
      // nth-weekday rule. Clamping cannot move the month, so stepping the anchor
      // itself is safe here.
      const { year, month } = calendarDateParts(
        addCalendarMonths(anchorDate, k * interval),
      );
      const day = nthWeekdayDayOfMonth(year, month, weekday, nth);
      return day === null ? null : calendarDateFromParts(year, month, day);
    }
  }
}

/**
 * All occurrence start instants for a rule, in ascending order, INCLUDING the
 * anchor itself as the first. Bounded by the rule's end condition and the
 * MAX_OCCURRENCES safety cap.
 *
 * `zone` is the club's PERSISTED timezone (`INV-CONFIG-002`) — the server
 * resolves it with `clubTime()`, and it is a required argument rather than an
 * ambient read so that a caller cannot accidentally materialise a series against
 * the container's `TZ`.
 *
 * THE ANCHOR IS RETURNED VERBATIM. Every frequency's k=0 step lands on the
 * anchor's own calendar day by construction, so re-deriving its instant would
 * only risk moving it: an anchor that fell in the SECOND half of a fall-back
 * hour would come back an hour earlier under the `earliest` policy. Returning
 * the value it was handed makes "the first occurrence IS the anchor" exact.
 */
export function generateOccurrenceStarts(
  anchor: Instant,
  rule: RecurrenceRule,
  zone: ClubTimeZone,
): Instant[] {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const results: Instant[] = [];

  // The anchor's club calendar day and club wall time: the ONE projection of a
  // real instant in this function, taken at the boundary.
  const wall = clubWallTimeOf(anchor, zone);
  const anchorDate = wall.date;
  const timeOfDay = {
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
    millisecond: wall.millisecond,
  };

  // Both bounds are half-open club-day boundaries — the first instant of the day
  // AFTER the last day the series may reach. `endOfClubDayExclusive` is the
  // kernel's own bound, so a DST transition inside the final day cannot make an
  // occurrence fall a millisecond either side of it.
  let untilEndExclusive: number | null = null;
  if (rule.endMode === "until" && rule.until) {
    const untilInstant = parseInstant(rule.until);
    if (untilInstant) {
      untilEndExclusive = endOfClubDayExclusive(
        clubCalendarDateOf(untilInstant, zone),
        zone,
      ).getTime();
    }
  }

  const horizonEndExclusive =
    rule.endMode === "never"
      ? endOfClubDayExclusive(
          addCalendarMonths(anchorDate, NEVER_HORIZON_MONTHS),
          zone,
        ).getTime()
      : null;

  const targetCount =
    rule.endMode === "count" && rule.count
      ? Math.max(1, Math.min(MAX_OCCURRENCES, Math.floor(rule.count)))
      : MAX_OCCURRENCES;

  for (let k = 0; k < MAX_ITERATIONS && results.length < targetCount; k++) {
    let date: CalendarDate | null;
    try {
      date = occurrenceDateForCycle(anchorDate, rule.frequency, interval, k);
    } catch (error) {
      // The kernel throws rather than minting a year outside 0001-9999. A series
      // that walks off the end of the calendar stops there. The route's schema
      // caps `interval` at 52, so this is unreachable from a request; it exists
      // because this function is exported and the alternative — what the
      // host-local version did — was to push Invalid Dates into the rows.
      if (error instanceof RangeError) break;
      throw error;
    }
    if (!date) continue; // skipped cycle (missing nth weekday)

    const occurrence =
      k === 0
        ? anchor
        : instantForClubWallTime(
            date,
            timeOfDay,
            zone,
            OCCURRENCE_WALL_TIME_POLICY,
          );

    const t = occurrence.getTime();
    if (untilEndExclusive !== null && t >= untilEndExclusive) break;
    if (horizonEndExclusive !== null && t >= horizonEndExclusive) break;

    results.push(occurrence);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Labels for the "Repeat" picker (client-safe)
// ---------------------------------------------------------------------------

const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th"];

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}

/**
 * Bare long weekday ("Tuesday") over a CALENDAR DATE.
 *
 * PINNED TO `UTC`, WHICH IS AN IDENTITY AND NOT A PROJECTION: the day is encoded
 * at UTC midnight and read back in UTC, which has no transitions, so the club's
 * zone is not consulted and could not change the answer. That is the mechanism
 * `formatCalendarDateShape` in `club-time/intl.ts` documents in full. The
 * constant this replaces pinned `APP_TIME_ZONE` — the identity only for a club
 * east of Greenwich, and a day early for any club west of it.
 *
 * IT IS ONE CALL NOW: the kernel's `longWeekday` shape is a long weekday on its
 * own, so the local `Intl.DateTimeFormat` this file kept while
 * `src/lib/club-time/**` belonged to another lane (#2870, group F3) is gone.
 * `booking-calendar.tsx` carried the same note and lost its copy the same way.
 */
function longWeekdayOf(date: CalendarDate): string {
  return formatClubLongWeekday(date);
}

/** The 1-based ordinal of a weekday within its month, from a day number. */
function ordinalFromDayOfMonth(day: number): number {
  return Math.floor((day - 1) / 7) + 1;
}

/**
 * "Repeat" options for a given selected CALENDAR DAY, labelled from that day.
 *
 * A calendar day needs no zone, and that is the whole fix here: this used to take
 * a `Date` that the dialog built at BROWSER-local midnight and then read through
 * a club-pinned formatter, so the weekday and day number an overseas admin was
 * offered could both belong to the wrong day. The selected value comes from an
 * `<input type="date">`, which is a calendar day and nothing else, so it is now
 * carried as one end to end.
 */
export function recurrenceOptionsForDate(
  date: CalendarDate,
): Array<{ value: CalendarRecurrenceFrequency | "NONE"; label: string }> {
  const weekday = longWeekdayOf(date);
  const day = calendarDateParts(date).day;
  const nth = ordinalFromDayOfMonth(day);
  return [
    { value: "NONE", label: "Does not repeat" },
    { value: "DAILY", label: "Daily" },
    { value: "WEEKLY", label: `Weekly on ${weekday}` },
    { value: "MONTHLY_DAY_OF_MONTH", label: `Monthly on day ${day}` },
    {
      value: "MONTHLY_NTH_WEEKDAY",
      label: `Monthly on the ${ordinal(nth)} ${weekday}`,
    },
  ];
}

/** The unit noun for an interval input ("week", "month", "day"). */
export function recurrenceUnitLabel(
  frequency: CalendarRecurrenceFrequency,
): string {
  switch (frequency) {
    case "DAILY":
      return "day";
    case "WEEKLY":
      return "week";
    default:
      return "month";
  }
}

/**
 * Human summary of a rule anchored at an instant, e.g. "Every 2 weeks on
 * Tuesday".
 *
 * The anchor is a real instant (a stored `startsAt`), so it is projected into the
 * club's calendar ONCE here and every label below is derived from that calendar
 * day.
 *
 * WHAT WAS WRONG BEFORE, stated precisely, because the obvious guess is wrong.
 * The label was never internally inconsistent: the version this replaces took the
 * weekday AND the day number from a single `formatToParts` call, deliberately, and
 * its own docblock explains that a split reading "would let a label contradict
 * itself". That hazard was described hypothetically and avoided.
 *
 * The defect was cruder — the label could name the wrong day ENTIRELY, and be
 * self-consistent about it. `recurrenceOptionsForDate` was handed a `Date` the
 * dialog built at BROWSER-local midnight and then read it in the club's zone, so
 * an overseas admin selecting a Tuesday could be offered "Weekly on Monday" with
 * "Monthly on day 20" agreeing beside it. Deriving everything from the
 * `CalendarDate` the officer actually picked removes the projection rather than
 * making the two halves agree, since they already did.
 */
export function describeRecurrence(
  rule: RecurrenceRule,
  anchor: Instant,
  zone: ClubTimeZone,
): string {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const every = interval === 1 ? "" : `Every ${interval} `;
  const anchorDate = clubCalendarDateOf(anchor, zone);
  const anchorWeekday = longWeekdayOf(anchorDate);
  const anchorDay = calendarDateParts(anchorDate).day;
  const anchorNth = ordinalFromDayOfMonth(anchorDay);
  let base: string;
  switch (rule.frequency) {
    case "DAILY":
      base = interval === 1 ? "Daily" : `${every}days`;
      break;
    case "WEEKLY":
      base =
        interval === 1
          ? `Weekly on ${anchorWeekday}`
          : `${every}weeks on ${anchorWeekday}`;
      break;
    case "MONTHLY_DAY_OF_MONTH":
      base =
        interval === 1
          ? `Monthly on day ${anchorDay}`
          : `${every}months on day ${anchorDay}`;
      break;
    case "MONTHLY_NTH_WEEKDAY":
      base =
        interval === 1
          ? `Monthly on the ${ordinal(anchorNth)} ${anchorWeekday}`
          : `${every}months on the ${ordinal(anchorNth)} ${anchorWeekday}`;
      break;
  }

  if (rule.endMode === "until" && rule.until) {
    // #2264: `Intl.format` THROWS a RangeError on an invalid Date, where the
    // `toLocaleDateString` call this replaced quietly returned the string
    // "Invalid Date". A malformed `until` must not take the whole "Repeat"
    // picker down with it, so fall back to the raw value — the same defensive
    // shape the occurrence generator above already applies to this field.
    const untilInstant = parseInstant(rule.until);
    const untilLabel =
      untilInstant === null
        ? rule.until
        : formatClubDate(clubCalendarDateOf(untilInstant, zone));
    return `${base}, until ${untilLabel}`;
  }
  if (rule.endMode === "count" && rule.count) {
    return `${base}, ${rule.count} times`;
  }
  return base;
}
