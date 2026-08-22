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
 * the UTC reading of a date-only value; holding the day as text removes the
 * reading to derive a rule from.
 *
 * THE ARITHMETIC IS INTEGER CIVIL-CALENDAR ARITHMETIC, not `Date` arithmetic.
 * Howard Hinnant's `days_from_civil`/`civil_from_days` pair converts a
 * proleptic-Gregorian (year, month, day) to and from a day number, exactly, with
 * no epoch object in the middle. `calendar-date-agrees-with-utc.test.ts` pins
 * every day of a multi-century span against `Date.UTC` so the two can never
 * disagree; the reason not to simply USE `Date.UTC` is that a module holding a
 * `Date` is a module somebody eventually formats, and the census above is what
 * stops that.
 *
 * FOUR-DIGIT YEARS ONLY. `parseCalendarDate` requires exactly four digits, which
 * is what makes plain string comparison a correct chronological comparison and
 * what keeps every value round-trippable through JSON, a URL and a `date`
 * column. A club with a booking in the year 10000 has a different problem.
 */

import type { CalendarDate } from "./types";

/** Exactly `YYYY-MM-DD`. Anything else — `2026-4-6`, `20260406`, a suffix. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function compose(year: number, month: number, day: number): CalendarDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as CalendarDate;
}

/** True when `value` is a well-formed calendar day that really exists. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInCalendarMonth(year, month);
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
    year < 0 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInCalendarMonth(year, month)
  ) {
    throw new Error(
      `Not a club calendar date: year=${year} month=${month} day=${day}. Months are 1-12 and the day must exist in that month.`,
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

/** Whole calendar days later (or earlier, for a negative `days`). */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
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
 */
export function addCalendarMonths(
  date: CalendarDate,
  months: number,
): CalendarDate {
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
