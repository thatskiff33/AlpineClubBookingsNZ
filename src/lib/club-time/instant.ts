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

import {
  isCalendarDate,
  parseCalendarDate,
  requireCalendarDate,
} from "./calendar-date";
import {
  clubZoneDateString,
  clubZoneParts,
  composeDateString,
  utcDateOnlyString,
} from "./intl";
import type { CalendarDate, ClubTimeZone, ClubWallTime, Instant } from "./types";

const MS_PER_SECOND = 1000;

/** A whole UTC day in milliseconds - the stride a `@db.Date` encoding lands on. */
const MS_PER_DAY = 86_400_000;

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
 * This is an ENCODING and nothing else. `INV-DATE-010` is the rule it
 * implements, and only for what that rule says: the UTC-midnight pinning is an
 * INTERNAL ENCODING of the calendar day and nothing more — not the midday
 * boundary instant, and not a moment any rule may be read out of.
 * `INV-DATE-026`'s corollary is why the encoding has to be exactly this one: the
 * Prisma adapter narrows whatever instant you hand a `@db.Date` bound to its UTC
 * calendar date, so a bound built as midnight in the club's zone — or, worse, on
 * the host — silently becomes the PREVIOUS day.
 *
 * DO NOT CITE `INV-DATE-010` FOR THE DECODE — the rule now says so in as many
 * words. What it forbids deriving a rule from is one of these values read as a
 * **moment**, an instant carrying a time of day. Its earlier wording ("no rule
 * may be derived from the UTC reading of these values") is what a docblock in
 * this file paraphrased as that sentence's own inverse ("no rule may be derived
 * from reading the result in any zone but UTC"), and four call sites plus two
 * test files copied the inverse from here before it was caught (#3080). The
 * authority for reading a
 * `@db.Date` back in UTC is `INV-DATE-019`'s first exact boundary — truncating an
 * existing `@db.Date` value is fine because it already encodes a calendar day —
 * together with `INV-DATE-026`, which is what guarantees the column really is
 * one. See {@link calendarDateOfDateOnlyInstant}.
 *
 * It exists because Prisma's `date` mapping takes and returns a `Date`; the
 * moment the value is back in application code it should become a
 * `CalendarDate` again.
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
 * THE RULE THIS IMPLEMENTS IS `INV-DATE-019`'s FIRST EXACT BOUNDARY — "truncating
 * an existing `@db.Date` value the same way is fine; those are already pinned to
 * UTC midnight and encode a calendar day, not an instant" — together with
 * `INV-DATE-026`, which is what makes the column a `@db.Date` in the first place
 * rather than a bare `DateTime` its writers merely agree to keep at midnight.
 * **Do not cite `INV-DATE-010` for this direction**: what that rule forbids is
 * deriving a rule from one of these values read as a MOMENT, and it names these
 * two ids rather than itself as the authority for a decode.
 * {@link dateOnlyInstantOf} records where the inverse paraphrase came from and
 * how far it spread.
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

/**
 * The same inverse for a `@db.Date` that has already crossed a JSON boundary:
 * the calendar day a SERIALISED date-only column carries.
 *
 * Once a `date` column reaches a client component or an API payload it is a
 * string — `"2026-07-01T00:00:00.000Z"`, or already `"2026-07-01"` — and two
 * spellings of this one operation grew up side by side across CT-4 (#2870):
 * `requireCalendarDate(dateOnlyFromIsoString(v))` in nine files and
 * `calendarDateOfDateOnlyInstant(new Date(v))` in six. Both are correct for both
 * of those shapes; this is the one call that replaces them.
 *
 * The rule is the one {@link calendarDateOfDateOnlyInstant} implements —
 * `INV-DATE-019`'s first exact boundary plus `INV-DATE-026`, and **not**
 * `INV-DATE-010`, which is about the other direction.
 *
 * IT READS THE PREFIX RATHER THAN REPARSING, and the difference is worth one
 * sentence because it is the only input on which the two spellings disagree. The
 * UTC-midnight encoding puts the day in the first ten characters, so the prefix
 * IS the decoding — no `Date`, no projection, nothing a zone could move. Reparse
 * instead and an OFFSET-BEARING string would be projected into UTC:
 * `"2026-07-01T12:00:00+13:00"` decodes as 30 June that way and as 1 July here.
 * No serialisation of a `@db.Date` produces such a string, so this is a
 * contract-boundary difference rather than a live one — but "the day this column
 * holds" must not depend on a zone at all, and the prefix read is the spelling
 * that cannot.
 *
 * WHAT IT DOES NOT DO is tell you whether the value was a `@db.Date` in the
 * first place. Hand it a serialised `createdAt` and you get that instant's UTC
 * day, which is the `INV-DATE-019` defect — the same warning
 * {@link calendarDateOfDateOnlyInstant} carries, for the same reason. Use
 * {@link clubCalendarDateOf} for a moment.
 *
 * Throws for a value whose first ten characters are not a real calendar day.
 */
export function calendarDateOfSerialisedDbDate(value: string): CalendarDate {
  return requireCalendarDate(value.slice(0, 10));
}

/**
 * {@link calendarDateOfSerialisedDbDate}, answering `null` instead of throwing —
 * and also `null` for an absent value, so a nullable column needs no guard.
 *
 * A REAL DIFFERENCE IN FAILURE MODE, not a style preference. Two public token
 * landing pages carried a local formatter wrapped in `try`/`catch` for exactly
 * this: a throw out of a client render blanks the whole screen, where the code
 * they replaced showed at worst "Invalid Date" beside a page that still worked.
 * A member holding a link to a page whose stored date is malformed must still be
 * able to read the rest of it.
 *
 * So the choice between the two is about what the caller can do with a refusal,
 * and the parser half of the kernel already draws that line the same way —
 * {@link parseInstant} and `parseCalendarDate` answer `null` where their
 * `require*` siblings throw.
 */
export function calendarDateOfSerialisedDbDateOrNull(
  value: string | null | undefined,
): CalendarDate | null {
  return value == null ? null : parseCalendarDate(value.slice(0, 10));
}

/**
 * `value`, PROVED not to be a moment carrying a time of day — which is as much as
 * anything can prove about a bare `Date`.
 *
 * BE PRECISE ABOUT WHAT THE CHECK ESTABLISHES, because the stronger reading is
 * the tempting one and it is wrong. The test is that the value sits on a whole
 * number of UTC days since the epoch, so it is NECESSARY for a `@db.Date`
 * encoding and not SUFFICIENT: a real `createdAt` that happens to fall on exactly
 * UTC midnight passes it. That residue is why the census in
 * `date-only-encoding-guard.test.ts` still classifies a field read through this
 * guard — the guard reports a shape, and only the field name says whether the
 * value was ever a calendar day.
 *
 * The precondition {@link calendarDateOfDateOnlyInstant} cannot check for
 * itself. That decoder takes an `Instant`, which is a bare `Date`, so it cannot
 * tell a stored calendar day from a real timestamp — and it says so: hand it a
 * `createdAt` and you get that instant's UTC day, which for a club east of
 * Greenwich is the right answer for most of the day and the wrong one for the
 * rest. That is the hardest kind of wrong to notice, so a caller whose whole
 * contract is "this argument is a stored calendar day" states the precondition
 * here and declines to answer when it does not hold. F2 (#3076) established the
 * shape on `normalizeBookingDate`; `seasonYearOfStoredDate` and `computeAge` are
 * the two derivations that now share it.
 *
 * IT RETURNS THE INSTANT RATHER THAN THE CALENDAR DAY, deliberately, and that is
 * the same decision {@link requireInstant} makes. Wrapping the decode would put
 * a second name in front of it, and `date-only-encoding-guard.test.ts` bans that
 * for a measured reason: `xero-invoice-helpers` once exported `formatDate`, and
 * the thirty-three Xero document dates behind that one-line rename were
 * invisible to the spelling census that was supposed to audit them. Composing
 * instead — `calendarDateOfDateOnlyInstant(requireStoredCalendarDay(v, ...))` —
 * keeps the encoder's own name at every call site, where the census can see what
 * is being encoded.
 *
 * `refusal.instead` is the sentence naming what the caller should have been
 * asked for, supplied by the caller because only the caller knows it. There is
 * no repair to offer: a moment handed to a calendar-day rule needs somebody to
 * decide whose calendar the day comes from, and that is not a decision a guard
 * can make.
 *
 * On today's schema the throw is unreachable from the database — PostgreSQL will
 * not keep a time in a `date` column — so it fires for a value some code path
 * built wrong, which is exactly when a loud failure is worth more than an
 * answer. It has already found fourteen such values across two of this
 * repository's own test files — thirteen date-of-birth literals describing an
 * age-tier price boundary, and the shared helper the age-up cron's suite built
 * every one of its members from.
 */
export function requireStoredCalendarDay(
  value: Date,
  refusal: { subject: string; instead: string },
): Instant {
  if (!isInstant(value)) {
    throw new RangeError(
      `${refusal.subject} needs a valid Date holding a @db.Date calendar-day ` +
        `encoding; got ${String(value)}.`,
    );
  }
  if (value.getTime() % MS_PER_DAY !== 0) {
    throw new RangeError(
      `${refusal.subject} takes a stored calendar day, not a moment: ${value.toISOString()} ` +
        "carries a UTC time of day. A @db.Date column round-trips as UTC midnight, so a value with " +
        "a time of day is a real timestamp - flooring it to its UTC day is the INV-DATE-019 defect " +
        `and would be silently right for a club east of Greenwich. ${refusal.instead}`,
    );
  }
  return value;
}
