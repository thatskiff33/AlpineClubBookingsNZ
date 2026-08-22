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
 * The six named after `nzst-date`'s exports reproduce those helpers exactly; the
 * last three are the lobby-display forms, which drop the year because a wall
 * screen only ever names days inside the current stay window.
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
  /** "Thu" */
  weekday: { weekday: "short" },
  /** "Thu 16 Apr" */
  weekdayDayMonth: { weekday: "short", day: "numeric", month: "short" },
  /** "Thursday 16 April" */
  longWeekdayDayMonth: { weekday: "long", day: "numeric", month: "long" },
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

/** The calendar-day shape used to decode a `@db.Date`, never for display. */
const DATE_PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

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

/** The `YYYY-MM-DD` a `@db.Date` value encodes, read in UTC. */
export function utcDateOnlyString(value: Date): string {
  const parts = formatterFor(
    "utc-date-only",
    "en-US",
    "UTC",
    DATE_PARTS_OPTIONS,
  ).formatToParts(value);
  return composeDateString(
    readNumber(parts, "year"),
    readNumber(parts, "month"),
    readNumber(parts, "day"),
  );
}

/** `YYYY-MM-DD` from numeric parts. The kernel's only date-string assembly. */
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
