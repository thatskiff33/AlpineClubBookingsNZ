/**
 * Calendar-day identity and arithmetic (CT-2, #2990; epic #2988).
 *
 * A club calendar day is `YYYY-MM-DD` and nothing else. It has no time of day,
 * no timezone and no instant, so NOTHING IN THIS MODULE CONSTRUCTS A `Date`,
 * READS `Intl`, OR LOOKS AT `process.env` — and `club-time-kernel-census.test.ts`
 * asserts exactly that, because the property is the whole point rather than a
 * stylistic preference.
 *
 * WHY THAT MATTERS, in one measured sentence. The representation this replaces
 * is a `Date` pinned to UTC midnight, which is only readable as the club's day
 * while the club sits east of Greenwich: for `America/Denver`,
 * `2026-04-05T00:00:00Z` reads back as **2026-04-04**, so every label derived
 * that way is a day early. `INV-DATE-010` already forbids deriving a rule from
 * one of these values read as a **moment**; holding the day as text removes the
 * instant there was to misread. (It is not the citation for a UTC decode — that
 * is `INV-DATE-019`'s first exact boundary with `INV-DATE-026`, and the rule
 * says so itself; #3080.)
 *
 * THE ARITHMETIC IS INTEGER CIVIL-CALENDAR ARITHMETIC, not `Date` arithmetic.
 * Howard Hinnant's `days_from_civil`/`civil_from_days` pair converts a
 * proleptic-Gregorian (year, month, day) to and from a day number, exactly, with
 * no epoch object in the middle. `__tests__/calendar-date.test.ts` pins every
 * day of a multi-century span against `Date.UTC` so the two can never disagree; the reason not to simply USE `Date.UTC` is that a module holding a
 * `Date` is a module somebody eventually formats, and the census above is what
 * stops that.
 *
 * FOUR-DIGIT YEARS ONLY, AND THE ARITHMETIC IS HELD TO IT. `parseCalendarDate`
 * requires exactly four digits, which is what makes plain string comparison a
 * correct chronological comparison and what keeps every value round-trippable
 * through JSON, a URL and a `date` column. A club with a booking in the year
 * 10000 has a different problem.
 *
 * That is only true if NOTHING can mint a brand outside the range, and the first
 * version of this module could: `compose` padded with `padStart(4, "0")`, which
 * lengthens and never truncates, so `addCalendarDays("9999-12-31", 1)` returned
 * a branded `"10000-01-01"`, `addCalendarDays(date, NaN)` a branded
 * `"0NaN-NaN-NaN"`, and `compareCalendarDates("10000-01-01", "2026-01-01")` the
 * WRONG ORDER — the one property the brand exists to promise. It was reachable
 * from a screen: `/admin/audit-log?to=9999-12-31` runs that value through
 * `endOfDateOnlyForTimeZone`, whose upper bound became an instant in the year
 * 999, so the log came back EMPTY while the filter still said "to 9999-12-31".
 *
 * So the range is a guard rather than a convention. Every value this module
 * produces is between `0001-01-01` and `9999-12-31`, every step is a whole
 * number of days or months, and anything else throws a `RangeError` naming what
 * it was asked for. `calendar-date.test.ts` mutates `compose`'s pad width to
 * prove the guard is the thing catching it.
 *
 * WHY THE FLOOR IS YEAR 1 AND NOT YEAR 0. `0000` is a legal ISO 8601 year (1 BC
 * in the proleptic Gregorian calendar), and the integer arithmetic below handles
 * it perfectly well — but `Intl` cannot describe it without an era, so a
 * year-zero value round-tripped through a projection came back as `0001-...`,
 * silently one year out. Refusing year 0 outright costs nothing and gives the
 * projections in `intl.ts` one range to refuse rather than an era to interpret.
 */

import type { CalendarDate } from "./types";

/** Exactly `YYYY-MM-DD`. Anything else — `2026-4-6`, `20260406`, a suffix. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The first and last years a `CalendarDate` can name. See the module doc.
 *
 * Module-private on purpose: the range is a property of the type, enforced here,
 * not a number other modules should be branching on.
 */
const MIN_CALENDAR_YEAR = 1;
const MAX_CALENDAR_YEAR = 9999;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1-12) of `year`. */
export function daysInCalendarMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (MONTH_LENGTHS[month - 1] ?? 0);
}

/**
 * Days since 1970-01-01 for a proleptic-Gregorian civil date (Hinnant).
 * `Math.floor` rather than truncation, so the negative-year branch floors the
 * era the way the algorithm requires.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The inverse of {@link daysFromCivil}. */
function civilFromDays(dayNumber: number): {
  year: number;
  month: number;
  day: number;
} {
  const shifted = dayNumber + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * THE ONLY PLACE A `CalendarDate` BRAND IS MINTED FROM PARTS, and therefore the
 * one place the four-digit range can be enforced once for every caller.
 *
 * `pad` lengthens and cannot truncate, so without this check a year of 10000, a
 * negative year or a `NaN` produced a string that carried the brand and failed
 * `isCalendarDate`. Throwing is deliberate: returning `null` instead would make
 * `addCalendarDays` and every one of its callers nullable in order to describe
 * an input no correct caller passes, and this module already throws for exactly
 * that class in {@link calendarDateFromParts}.
 */
function compose(year: number, month: number, day: number): CalendarDate {
  if (
    !Number.isInteger(year) ||
    year < MIN_CALENDAR_YEAR ||
    year > MAX_CALENDAR_YEAR
  ) {
    throw new RangeError(
      `A club calendar date runs from ${pad(MIN_CALENDAR_YEAR, 4)}-01-01 to ` +
        `${pad(MAX_CALENDAR_YEAR, 4)}-12-31; this step landed on year ${String(year)}. ` +
        "Four-digit years are what make plain string comparison chronological, so a value " +
        "outside that range cannot be a club calendar date at all.",
    );
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as CalendarDate;
}

/**
 * A calendar step is a WHOLE number of days or months.
 *
 * `NaN`, `Infinity` and `0.5` all used to flow through the civil arithmetic and
 * out the other side as a branded string — `"0NaN-NaN-NaN"`, `"2026-01-1.5"`.
 * They are programmer errors rather than data, so they are named where they
 * arrive instead of being discovered three modules later.
 */
function requireWholeStep(steps: number, unit: "days" | "months"): void {
  if (!Number.isInteger(steps)) {
    throw new RangeError(
      `A calendar step must be a whole number of ${unit}: got ${String(steps)}.`,
    );
  }
}

/** True when `value` is a well-formed calendar day that really exists. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return (
    year >= MIN_CALENDAR_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInCalendarMonth(year, month)
  );
}

/**
 * `value` as a calendar day, or `null`.
 *
 * NEVER ROLLS. `2026-02-30` is `null`, not 2 March — silently normalising an
 * impossible date is how a typo becomes a booking on the wrong night.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  return isCalendarDate(value) ? value : null;
}

/** {@link parseCalendarDate}, throwing with the offending value named. */
export function requireCalendarDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (parsed === null) {
    throw new Error(
      `Not a club calendar date: ${JSON.stringify(value)}. Expected YYYY-MM-DD naming a real day.`,
    );
  }
  return parsed;
}

/**
 * A calendar day from its parts. `month` is 1-12 — NOT the 0-based
 * `Date.getMonth()` convention, because there is no `Date` here to be consistent
 * with and an off-by-one month is the mistake this deliberately makes loud.
 * Throws rather than rolling, for the reason {@link parseCalendarDate} gives.
 */
export function calendarDateFromParts(
  year: number,
  month: number,
  day: number,
): CalendarDate {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < MIN_CALENDAR_YEAR ||
    year > MAX_CALENDAR_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInCalendarMonth(year, month)
  ) {
    throw new Error(
      `Not a club calendar date: year=${year} month=${month} day=${day}. Years are ` +
        `${MIN_CALENDAR_YEAR}-${MAX_CALENDAR_YEAR}, months are 1-12, and the day must exist in that month.`,
    );
  }
  return compose(year, month, day);
}

/** The parts of a calendar day. `month` is 1-12. */
export function calendarDateParts(date: CalendarDate): {
  year: number;
  month: number;
  day: number;
} {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/** The `YYYY-MM` month a calendar day falls in — the finance period identity. */
export function calendarMonthOf(date: CalendarDate): string {
  return date.slice(0, 7);
}

/**
 * The first day of the calendar month `date` falls in.
 *
 * "The first of this month" is a calendar-day question, so it is answered here
 * rather than by whichever module happens to be drawing a grid. The two
 * spellings this replaces both went through a `Date`:
 * `parseDateOnly(`${formatMonthOnly(d)}-01`)` and
 * `new Date(d.getFullYear(), d.getMonth(), 1)`. The second is host-local
 * midnight, so on a behind-UTC host it is the previous month's last day for the
 * first of a month — which is the whole class this kernel exists to remove.
 *
 * Cannot throw: the year is the one `date` already carries, and day 1 exists in
 * every month.
 */
export function startOfCalendarMonth(date: CalendarDate): CalendarDate {
  const { year, month } = calendarDateParts(date);
  return compose(year, month, 1);
}

/**
 * The day of the week a calendar day falls on: `0` for Sunday through `6` for
 * Saturday, which is `Date.prototype.getUTCDay`'s numbering.
 *
 * NO `Date` IS CONSTRUCTED, which is the point rather than a detail. The
 * spellings this replaces are `dateOnlyInstantOf(date).getUTCDay()` — correct,
 * but it mints an instant to ask a question a calendar day already answers — and
 * `new Date(y, m, 1).getDay()`, which is host-local midnight and therefore
 * reports the PREVIOUS day's weekday for any host far enough west. A month grid
 * built on the second shifts by a whole column, invisibly, on exactly the hosts
 * this epic exists to stop mattering.
 *
 * The offset is 4 because 1970-01-01 — day number 0 — was a Thursday. The double
 * modulo is for a pre-epoch date, whose day number is negative and whose
 * remainder in JavaScript therefore is too.
 *
 * `getUTCDay`'s numbering rather than ISO's 1-7 because every call site in this
 * tree already reads that convention, and a helper that silently renumbered
 * would be a defect wearing a green suite.
 */
export function calendarDayOfWeek(date: CalendarDate): number {
  const { year, month, day } = calendarDateParts(date);
  return (((daysFromCivil(year, month, day) + 4) % 7) + 7) % 7;
}

/**
 * Whole calendar days later (or earlier, for a negative `days`).
 *
 * Throws a `RangeError` for a fractional or non-finite step, and for a step that
 * would leave the four-digit year range — `addCalendarDays("9999-12-31", 1)` has
 * no answer this type can hold. See the module doc for why that is a throw.
 */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  requireWholeStep(days, "days");
  const { year, month, day } = calendarDateParts(date);
  const moved = civilFromDays(daysFromCivil(year, month, day) + days);
  return compose(moved.year, moved.month, moved.day);
}

/**
 * Whole calendar months later, with the day CLAMPED to the target month's
 * length: 31 January plus one month is 28 February (29 in a leap year), never an
 * overflow into March. Clamping makes the operation non-reversible for such
 * days (31 Jan -> 28 Feb -> 28 Jan), which matches `addMonthsDateOnly`'s
 * long-standing behaviour; a caller stepping back and forth keeps its own
 * anchor.
 *
 * Throws a `RangeError` for a fractional or non-finite step, and for one that
 * would leave the four-digit year range, exactly as {@link addCalendarDays} does.
 */
export function addCalendarMonths(
  date: CalendarDate,
  months: number,
): CalendarDate {
  requireWholeStep(months, "months");
  const { year, month, day } = calendarDateParts(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return compose(
    targetYear,
    targetMonth,
    Math.min(day, daysInCalendarMonth(targetYear, targetMonth)),
  );
}

/**
 * Chronological order. Plain string comparison IS chronological order for
 * zero-padded four-digit-year ISO days, which is why the parser insists on that
 * shape.
 */
export function compareCalendarDates(
  left: CalendarDate,
  right: CalendarDate,
): -1 | 0 | 1 {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * How many lodge nights the half-open range `[checkIn, checkOutExclusive)`
 * covers. Exact integer calendar arithmetic, so a DST transition inside the
 * range cannot make it 0.958 or 1.042 of a night.
 */
export function countClubNights(
  checkIn: CalendarDate,
  checkOutExclusive: CalendarDate,
): number {
  const start = calendarDateParts(checkIn);
  const end = calendarDateParts(checkOutExclusive);
  return (
    daysFromCivil(end.year, end.month, end.day) -
    daysFromCivil(start.year, start.month, start.day)
  );
}

/**
 * Every calendar day in `[startInclusive, endExclusive)`, in order. Empty when
 * the range is empty or inverted.
 */
export function eachCalendarDate(
  startInclusive: CalendarDate,
  endExclusive: CalendarDate,
): CalendarDate[] {
  const nights = countClubNights(startInclusive, endExclusive);
  if (nights <= 0) return [];
  const days: CalendarDate[] = [];
  for (let offset = 0; offset < nights; offset += 1) {
    days.push(addCalendarDays(startInclusive, offset));
  }
  return days;
}
