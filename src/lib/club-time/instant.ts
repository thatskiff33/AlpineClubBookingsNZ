/**
 * Instants, and their projection into the club's civil time (CT-2, #2990).
 *
 * An instant is one exact moment. It has no calendar day of its own: the day it
 * "is" depends entirely on which zone you read it in, which is why every
 * function here that produces a civil answer takes the club zone as an argument
 * and none of them consults the host.
 *
 * THE PROJECTION IS `formatToParts`, NOT ARITHMETIC. There is no way to compute
 * a named zone's offset from first principles — the offsets and the transition
 * dates are IANA data — so the runtime is asked, and the answer is parsed. The
 * formatter instances are memoised by zone (see `format.ts`) because
 * constructing one costs about 42 microseconds against 0.76 for a memoised call,
 * measured on Node 24.15.0 over 20 000 iterations, and the capacity, pricing and
 * finance loops call this once per (booking, night) pair.
 *
 * ONE SUBTLETY THAT HAS ALREADY BITTEN THIS CODE, so it is written down rather
 * than rediscovered. `Intl` reports whole seconds. Reading the parts of an
 * instant that carries a millisecond remainder and subtracting gives an offset
 * short by that remainder — a silently wrong number, not an error. Every offset
 * probe here therefore floors its instant to the second first. The bug is easy
 * to reproduce: a binary search over transition instants written without the
 * flooring converges to a boundary seven and a half minutes away from the real
 * one.
 */

import { isCalendarDate, requireCalendarDate } from "./calendar-date";
import {
  clubZoneDateString,
  clubZoneParts,
  composeDateString,
  utcDateOnlyString,
} from "./intl";
import type { CalendarDate, ClubTimeZone, ClubWallTime, Instant } from "./types";

const MS_PER_SECOND = 1000;

/** An ISO 8601 value that actually pins a moment: it carries `Z` or an offset. */
const OFFSET_BEARING_ISO =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** True when `value` is a `Date` holding a real moment. */
export function isInstant(value: unknown): value is Instant {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * `value` as an instant, or `null`.
 *
 * AN OFFSET-LESS ISO STRING IS REFUSED, and that refusal is the point.
 * `"2026-04-16T00:00:00"` names a wall-clock reading, not a moment; JavaScript
 * resolves it in the HOST's zone, so the same payload means different moments on
 * a developer's laptop, on a UTC container and on the club's server. That is the
 * provider-boundary hazard the epic asks each integration to classify — an
 * external system sending a local time must say which zone it meant, and the
 * kernel refuses to guess. A caller that genuinely holds a club wall-clock time
 * uses `instantForClubWallTime` instead, which says so.
 *
 * IT DOES NOT ROLL AN IMPOSSIBLE DATE EITHER, for the same reason
 * `parseCalendarDate` does not: JavaScript reads `"2026-02-30T00:00:00Z"` as
 * 2 March, so a provider's typo or off-by-one becomes a real, plausible,
 * WRONG moment two days later with nothing to notice. The calendar half of the
 * string is checked before the value is accepted, so the two parsers agree about
 * what a date is.
 */
export function parseInstant(value: string | number | Date): Instant | null {
  if (value instanceof Date) return isInstant(value) ? value : null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  const trimmed = value.trim();
  if (!OFFSET_BEARING_ISO.test(trimmed)) return null;
  if (!isCalendarDate(trimmed.slice(0, 10))) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** {@link parseInstant}, throwing with the offending value named. */
export function requireInstant(value: string | number | Date): Instant {
  const instant = parseInstant(value);
  if (instant === null) {
    throw new Error(
      `Not an instant: ${JSON.stringify(value)}. An ISO string must carry Z or a UTC offset — ` +
        "without one it names a wall-clock reading in whichever zone happens to be reading it — " +
        "and its calendar date must be a day that exists, never one this parser rolls forward.",
    );
  }
  return instant;
}

/**
 * The club zone's UTC offset in milliseconds AT `instant` — positive east of
 * Greenwich. Floored to the second before probing; see the module doc.
 */
export function clubZoneOffsetMs(instant: Instant, zone: ClubTimeZone): number {
  const flooredMs = Math.floor(instant.getTime() / MS_PER_SECOND) * MS_PER_SECOND;
  const parts = clubZoneParts(new Date(flooredMs), zone);
  // NOT `Date.UTC`: it maps years 0-99 onto 1900-1999, which would make the
  // offset nonsense for a year the club will never book but a test may reach.
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  asUtc.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return asUtc.getTime() - flooredMs;
}

/** The wall-clock reading, and the calendar day, an instant has in the club's zone. */
export function clubWallTimeOf(
  instant: Instant,
  zone: ClubTimeZone,
): ClubWallTime {
  const parts = clubZoneParts(instant, zone);
  return {
    date: requireCalendarDate(
      composeDateString(parts.year, parts.month, parts.day),
    ),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond:
      ((instant.getTime() % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND,
  };
}

/**
 * The club calendar day an instant falls on.
 *
 * THIS IS THE ONE CORRECT WAY to get a day out of a real timestamp, and the
 * defect it replaces is `INV-DATE-019`'s: truncating an instant's ISO string
 * gives the UTC day, which for a club at UTC+12/+13 is YESTERDAY for roughly the
 * first half of every club day — a Xero due date and a finance export both
 * landed a day early that way (#2697).
 */
export function clubCalendarDateOf(
  instant: Instant,
  zone: ClubTimeZone,
): CalendarDate {
  // Its own three-field projection rather than `clubWallTimeOf`, which builds
  // the hour, minute and second this discards. 45 non-test call sites sit in the
  // capacity, pricing and finance loops; `intl.ts` carries the measurement.
  return requireCalendarDate(clubZoneDateString(instant, zone));
}

/**
 * THE PRISMA `@db.Date` ENCODER: a calendar day as the UTC-midnight `Date` a
 * `date` column round-trips through.
 *
 * This is an ENCODING and nothing else — `INV-DATE-010`'s rule that "UTC
 * midnight is encoding, not meaning" is exactly what it implements, and no rule
 * may be derived from reading the result in any zone but UTC. It exists because
 * Prisma's `date` mapping takes and returns a `Date`; the moment the value is
 * back in application code it should become a `CalendarDate` again.
 */
export function dateOnlyInstantOf(date: CalendarDate): Instant {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * The inverse: the calendar day a `@db.Date` value encodes.
 *
 * Deliberately reads the value in **UTC**, not in the club's zone — the column
 * stores an encoding, not a moment, and the encoding is defined in UTC. Reading
 * it in club time is the same defect from the other direction: for
 * `America/Denver`, `2026-04-05T00:00:00Z` reads back as 4 April.
 *
 * Hand it a real `DateTime` and you get that column's UTC day, which is the
 * `INV-DATE-019` defect. Use {@link clubCalendarDateOf} for a moment.
 *
 * Throws for a value whose UTC year is outside the `CalendarDate` range, which
 * is what a `@db.Date` holding something other than a club calendar day looks
 * like from here.
 */
export function calendarDateOfDateOnlyInstant(value: Instant): CalendarDate {
  return requireCalendarDate(utcDateOnlyString(value));
}
