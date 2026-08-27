/**
 * The one place in the kernel that constructs an `Intl.DateTimeFormat`
 * (CT-2, #2990).
 *
 * WHY THE FORMATTER CANNOT BE A MODULE CONSTANT ANY MORE. Before this epic there
 * were 41 frozen module-level `Intl.DateTimeFormat` constants in `src/`, each
 * pinned at import time to `APP_TIME_ZONE` — a synchronous, environment-derived
 * value. After CT-1 the club's zone is an asynchronous, `server-only` database
 * read, and 112 of the 400 files on the temporal surfaces are `"use client"`. A
 * module-level `const` cannot await, and a browser cannot reach the database, so
 * the zone has to arrive as an ARGUMENT and the formatter has to be looked up
 * rather than frozen.
 *
 * WHAT THAT COSTS, measured on Node 24.15.0 over 20 000 iterations with
 * `process.hrtime.bigint()`:
 *
 * | strategy                         | per call  |
 * | -------------------------------- | --------- |
 * | construct a formatter per call   | 42.25 us  |
 * | memoised by zone (this module)   |  0.76 us  |
 * | frozen module constant (before)  |  0.75 us  |
 *
 * Nine nanoseconds, 1.2%, against the one strategy that is genuinely expensive.
 * The pattern is not invented here: `dateOnlyFormatterCache` in
 * `src/lib/date-only.ts` is the same map, added for the same measured reason.
 *
 * THAT TABLE IS ABOUT THE MEMO AND NOTHING ELSE. It says what a lookup costs
 * against a frozen constant; it says nothing about how many FIELDS the formatter
 * behind the lookup is asked for, which turned out to matter more. Deriving a
 * club calendar day through the six-field parts formatter and discarding five of
 * them measured 6.34 us against the 3.34 us of the `date-only.ts` helper it
 * replaces — 1.90x, at 45 non-test call sites in the capacity, pricing and
 * finance loops. A three-field formatter of its own, reading the part VALUES as
 * strings instead of round-tripping them through `Number`, brings it to 3.35 us:
 * 1.18x, and the 18% buys the range validation the old helper never did.
 * Interleaved A/B/A, 300 000 iterations, `process.hrtime.bigint()`, Node
 * 24.15.0. {@link clubZoneDateString} is that path.
 *
 * NO EVICTION, DELIBERATELY. One installation is one club and one zone, so the
 * map holds one entry per shape (a dozen) plus whatever a test pins. Adding an
 * LRU here would be complexity guarding against nothing.
 *
 * THE LOCALE STILL COMES FROM CONFIGURATION, THE ZONE NEVER DOES. `APP_LOCALE`
 * is imported; `APP_TIME_ZONE` is not, and `club-time-kernel-census.test.ts`
 * asserts no module under `src/lib/club-time/**` mentions it. Locale is a
 * separate axis this epic does not touch.
 */

import { APP_LOCALE } from "@/config/operational";

/**
 * Every display shape the house uses, declared once.
 *
 * The six named after the exports of the retired `nzst-date` adapter (deleted by
 * #3123) reproduce those helpers exactly, which `house-shapes.test.ts` pins
 * against their transcribed `Intl.DateTimeFormat` options over 400 instants.
 * `weekday`, `weekdayDayMonth` and `longWeekdayDayMonth` are the lobby-display
 * forms, which drop the year because a wall screen only ever names days inside
 * the current stay window.
 *
 * The last five arrived with CT-4's `src/lib` group (#2870), each because a call
 * site was keeping a local `Intl.DateTimeFormat` for want of them and saying so
 * in a comment: `longWeekdayDate` for the booking calendar's day-button label,
 * the booking editor's stay dates and the kiosk and chore-sheet headings;
 * `dayMonth` for the guest-night grid's night column and the dashboard's tight
 * slots; `shortMonthYear` for the finance chart axes; `longWeekday` for a bare
 * spelled-out weekday, which nothing had asked for until the calendar
 * subsystem's recurrence labels needed one; and `shortMonth` for the membership
 * season label, which names the months a season runs between and had no month
 * name to reach for at all.
 *
 * NONE OF THE FIVE IS COMPOSED FROM AN EXISTING SHAPE, and that is deliberate.
 * `longWeekdayDayMonth` plus `" 2026"` is byte-identical for `en-NZ` and is NOT
 * safe in general: `APP_LOCALE` is configurable, and a locale that ordered or
 * punctuated the pair differently would silently change every day button in the
 * product. `shortMonth` is the same rule read the other way round - it is the
 * one shape that could plausibly be SLICED out of a longer one, and stripping
 * the year off `shortMonthYear` is a guess about where that locale puts the year
 * and how it punctuates the join. Declaring the whole shape asks `Intl` the
 * question rather than assuming its answer — the same reasoning `formatClubWeekdayDay`'s docblock
 * records for the one shape that IS assembled, where the assembled half is a
 * bare integer taken from the calendar-date string and so has no locale form at
 * all.
 */
export const HOUSE_SHAPES = {
  /** "16 Apr 2026" */
  date: { dateStyle: "medium" },
  /** "16 Apr 2026, 2:30 pm" */
  dateTime: { dateStyle: "medium", timeStyle: "short" },
  /** "16 April 2026" — INV-DATE-016 reserves this for four member-facing surfaces. */
  longDate: { dateStyle: "long" },
  /** "2:30 pm" */
  time: { timeStyle: "short" },
  /** "April 2026" */
  monthYear: { month: "long", year: "numeric" },
  /** "Thu, 16 Apr 2026" */
  weekdayDate: {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  },
  /** "Apr 2026" — a chart axis tick, where the long month will not fit. */
  shortMonthYear: { month: "short", year: "numeric" },
  /** "Apr" — the month alone, for a label naming the months a season spans. */
  shortMonth: { month: "short" },
  /** "Thu" */
  weekday: { weekday: "short" },
  /** "Thursday" */
  longWeekday: { weekday: "long" },
  /** "16 Apr" — a grid column head, where the year is already stated above it. */
  dayMonth: { day: "numeric", month: "short" },
  /** "Thu, 16 Apr" */
  weekdayDayMonth: { weekday: "short", day: "numeric", month: "short" },
  /** "Thursday, 16 April" */
  longWeekdayDayMonth: { weekday: "long", day: "numeric", month: "long" },
  /** "Thursday, 16 April 2026" — the spelled-out form WITH the year. */
  longWeekdayDate: {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type HouseShape = keyof typeof HOUSE_SHAPES;

/** The numeric-parts shape used for projection, never for display. */
const PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/**
 * The DAY-ONLY projection shape, never for display.
 *
 * Three fields rather than {@link PARTS_OPTIONS}' six, because "which club day
 * is this moment on?" is the hottest question the kernel is asked and the other
 * five parts were built and thrown away. See the module doc for the measurement.
 */
const DATE_PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl` DESCRIBES A YEAR THROUGH A CALENDAR, and without an `era` part it
 * renders the proleptic year 0 as "1" and year -1 as "2" — so an instant before
 * the common era projects into a plausible, wrong, CE-looking date rather than
 * an error. The kernel's `CalendarDate` starts at year 1 for the same reason, so
 * an instant outside 0001-9999 has no answer here and says so.
 *
 * One millisecond of honesty about the edges: this checks the UTC year, and a
 * zone offset can move the reading by up to sixteen hours, so on the very first
 * and very last UTC day of the range the projected day can still fall outside
 * it. In the late direction that composes a five-digit year, which
 * `requireCalendarDate` refuses; in the early direction — the first UTC day of
 * year 1, read in a zone west of Greenwich — it reads as year 1 rather than
 * year 0. No club has data there, and the guard is one integer comparison.
 */
function requireDescribableInstant(instant: Date, timeZone: string): void {
  const year = instant.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1 || year > 9999) {
    throw new RangeError(
      `Cannot project ${instant.toISOString()} into ${timeZone}: the club-time kernel describes ` +
        "the years 0001 to 9999, and outside them Intl reports a year through an era this " +
        "kernel does not read — silently naming a common-era day for a moment that is not on one.",
    );
  }
}

/**
 * The ONE `new Intl.DateTimeFormat` in the kernel.
 *
 * `timeZone` is a separate REQUIRED parameter rather than part of `options`, so
 * that the construction below literally carries the property. That satisfies
 * `INV-DATE-015`'s lint arm — which cannot see inside a spread options object —
 * by construction rather than by exemption, and it makes a zone-less formatter
 * impossible to write here at all.
 */
function formatterFor(
  key: string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const existing = formatters.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(locale, { timeZone, ...options });
  formatters.set(key, created);
  return created;
}

/**
 * A display formatter for one shape in one zone.
 *
 * KEYED ON BOTH, and that is the single most likely implementation slip in this
 * module: a memo keyed on the shape alone returns the first zone's formatter
 * for every later zone, which looks perfect on a one-club installation and is
 * wrong the moment a test or a second club asks for another.
 */
function displayFormatter(
  shape: HouseShape,
  timeZone: string,
): Intl.DateTimeFormat {
  return formatterFor(
    `display|${timeZone}|${shape}`,
    APP_LOCALE,
    timeZone,
    HOUSE_SHAPES[shape],
  );
}

/** Render `instant` in `timeZone` using one of the declared house shapes. */
export function formatHouseShape(
  shape: HouseShape,
  instant: Date,
  timeZone: string,
): string {
  return displayFormatter(shape, timeZone).format(instant);
}

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function readNumber(parts: Intl.DateTimeFormatPart[], type: string): number {
  const raw = parts.find((part) => part.type === type)?.value;
  if (raw === undefined) {
    throw new Error(
      `Intl.DateTimeFormat produced no ${type} part; the runtime cannot describe this instant.`,
    );
  }
  return Number(raw);
}

/** The wall-clock parts an instant has in `timeZone`, as numbers. */
export function clubZoneParts(instant: Date, timeZone: string): ZoneParts {
  requireDescribableInstant(instant, timeZone);
  const parts = formatterFor(
    `parts|${timeZone}`,
    "en-US",
    timeZone,
    PARTS_OPTIONS,
  ).formatToParts(instant);
  return {
    year: readNumber(parts, "year"),
    month: readNumber(parts, "month"),
    day: readNumber(parts, "day"),
    hour: readNumber(parts, "hour"),
    minute: readNumber(parts, "minute"),
    second: readNumber(parts, "second"),
  };
}

/**
 * The `YYYY-MM-DD` a `@db.Date` value encodes, read in UTC.
 *
 * NO FORMATTER, DELIBERATELY, even though this module owns the only one. `Intl`
 * describes a year through a CALENDAR, and without an `era` part it renders the
 * proleptic year 0 as "1" (1 BC) — so a value at `0000-05-01T00:00:00Z` came
 * back as `"0001-05-01"`, one year out and silent about it. `getUTC*` reads the
 * field itself: UTC has no calendar to interpret, no eras and no transitions, so
 * this is the decoding rather than a projection of it, and a year the
 * `CalendarDate` range cannot hold now composes an out-of-range string that
 * `requireCalendarDate` refuses out loud.
 */
export function utcDateOnlyString(value: Date): string {
  return composeDateString(
    value.getUTCFullYear(),
    value.getUTCMonth() + 1,
    value.getUTCDate(),
  );
}

/**
 * The `YYYY-MM-DD` an instant reads as in `timeZone` — the kernel's hot path.
 *
 * Reads the part VALUES as the strings `Intl` already produced rather than
 * parsing each to a number and printing it again, and pads only the year, which
 * `year: "numeric"` leaves unpadded below 1000. The result is validated by the
 * caller ({@link clubCalendarDateOf}), so an unpadded or over-long year is a
 * refusal rather than a malformed brand.
 */
export function clubZoneDateString(instant: Date, timeZone: string): string {
  requireDescribableInstant(instant, timeZone);
  const parts = formatterFor(
    `date-parts|${timeZone}`,
    "en-US",
    timeZone,
    DATE_PARTS_OPTIONS,
  ).formatToParts(instant);
  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  if (!year || !month || !day) {
    throw new Error(
      `Intl.DateTimeFormat produced no year/month/day for ${timeZone}; the runtime cannot describe this instant.`,
    );
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

/** `YYYY-MM-DD` from numeric parts. Pads, and therefore never truncates: an
 * out-of-range year composes an out-of-range string, which the callers hand to
 * `requireCalendarDate`. */
export function composeDateString(
  year: number,
  month: number,
  day: number,
): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A calendar date rendered WITHOUT any zone conversion.
 *
 * The mechanism, because it is the load-bearing trick of this whole module: the
 * day is encoded at UTC midnight and the formatter is pinned to `UTC`, so the
 * projection is the identity function. UTC has no DST and no transitions ever,
 * so there is no offset that could move the day — the club's zone is not
 * consulted and could not change the answer. That is what makes
 * "date-only values never route through an instant projection" true rather than
 * aspirational: an encoding that provably cancels is not a projection.
 *
 * It is also byte-identical to what the tree renders today, where the same
 * UTC-midnight value is fed to a `Pacific/Auckland` formatter — which works only
 * because New Zealand is east of Greenwich, and is a day early for any club that
 * is not.
 */
export function formatCalendarDateShape(
  shape: HouseShape,
  date: string,
): string {
  return formatHouseShape(shape, new Date(`${date}T00:00:00.000Z`), "UTC");
}
