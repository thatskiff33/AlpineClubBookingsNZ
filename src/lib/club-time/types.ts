/**
 * The three temporal concepts, made distinct in the TYPE system (CT-2, #2990;
 * epic #2988).
 *
 * The epic's domain contract names three things and says they are different:
 *
 * 1. a **calendar date** — a lodge night, a birthday, a season edge. `YYYY-MM-DD`
 *    and nothing else. It has no time of day and no timezone, so it is never
 *    converted;
 * 2. an **instant** — a real moment (`createdAt`, `paidAt`, an audit stamp).
 *    Stored and transported as a moment, projected into club civil time only
 *    when a person has to read it;
 * 3. a **club-local scheduled time** — a wall-clock reading plus the club's
 *    named zone (08:00 club time; noon on the day a party arrives). Its instant
 *    is DERIVED using the zone's DST rules.
 *
 * WHY THE DISTINCTION IS A TYPE AND NOT A COMMENT. Prose has been tried here and
 * lost: `date-only.ts` carries several paragraphs explaining that its encoder is
 * correct for a `@db.Date` column and wrong for a `DateTime`, and #2697 still
 * shipped a Xero due date and a finance export a day early because the two are
 * identical in syntax. A branded string on one side and a `Date` on the other
 * makes the confusion a compile error instead of a code review:
 *
 * | Mistake                                        | Result                        |
 * | ---------------------------------------------- | ----------------------------- |
 * | `formatClubDate(booking.createdAt)`             | `Date` is not a `CalendarDate` |
 * | `formatClubInstantDateTime("2026-04-16")`       | `string` is not a `Date`       |
 * | `formatClubDate("2026-4-16")`                   | unbranded `string` is refused  |
 *
 * WHAT IT DOES NOT CATCH, said plainly so nobody claims more than was built.
 * `formatClubDate(requireCalendarDate(someInstant.toISOString().slice(0, 10)))`
 * — an instant truncated into a string and then branded — is still a defect and
 * still compiles. That stays the job of `INV-DATE-019`, the `no-restricted-syntax`
 * arms in `eslint.config.mjs`, and `date-only-encoding-guard.test.ts`. The type
 * closes the accidental confusion, not the deliberate cast.
 *
 * WHY `Instant` IS A BARE `Date`. Prisma hands every timestamp back as a `Date`
 * and takes one on the way in, so a wrapper would force an unwrap at hundreds of
 * boundaries and buy nothing: the safety comes from the OTHER side of the pair
 * being a branded STRING, and TypeScript already refuses a `string` where a
 * `Date` is wanted and the reverse. A wrapper would also become the new
 * ambiguity carrier the issue's review focus warns about — one more shape people
 * unwrap to get at "the real date".
 */

declare const calendarDateBrand: unique symbol;
declare const clubTimeZoneBrand: unique symbol;

/**
 * A club calendar day: `YYYY-MM-DD`, four-digit year, zero-padded, and a date
 * that really exists. Never timezone-converted, JSON-safe, and orderable by
 * plain string comparison.
 *
 * This is the canonical wire identity the epic's domain contract settles on.
 * The year runs from 0001 to 9999, and the arithmetic is held to it: every
 * operation that would leave the range throws rather than minting a brand that
 * fails its own validator. Build one with {@link parseCalendarDate} or
 * {@link requireCalendarDate}; there is no other legal way to obtain the brand.
 */
export type CalendarDate = string & { readonly [calendarDateBrand]: true };

/**
 * A validated named IANA club timezone — CT-1's judgement (#2989), branded at
 * that boundary so a raw `process.env` string cannot be passed where the club's
 * civil-time authority is wanted.
 */
export type ClubTimeZone = string & { readonly [clubTimeZoneBrand]: true };

/**
 * An exact moment. See the module doc for why this is deliberately a bare
 * `Date` rather than a wrapper.
 */
export type Instant = Date;

/** A wall-clock reading in the club's zone, with the calendar day it falls on. */
export interface ClubWallTime {
  readonly date: CalendarDate;
  /** 0-23. */
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * A wall-clock time of day, with no date and no zone attached.
 *
 * Every field is a whole number in range and every derivation VALIDATES that
 * (`boundaries.ts`), because `setUTCHours` rolls: `{ hour: 24 }` — the natural
 * spelling of "the end of the day" — used to come back as midnight on the
 * following day, or to throw an error saying the clocks had jumped over it. For
 * the end of a day use `endOfClubDayExclusive`.
 */
export interface ClubTimeOfDay {
  /** 0-23. */
  readonly hour: number;
  /** 0-59. */
  readonly minute?: number;
  /** 0-59. */
  readonly second?: number;
  /** 0-999. */
  readonly millisecond?: number;
}

/**
 * What to do with a wall-clock time that DOES NOT EXIST because the clocks
 * jumped forward over it.
 *
 * - `reject` (the default) throws {@link SkippedClubWallTimeError}, naming the
 *   date, the time and the zone. Nothing asked for a moment that never happened
 *   on purpose, so saying so is how the author finds out.
 * - `nextExistingInstant` returns THE MOMENT THE CLOCK JUMPED TO — the
 *   transition instant itself, not the request slid forward by the size of the
 *   gap, which is what a `Temporal`-style "compatible" disambiguation would give
 *   and which is later than the transition for any reading inside the gap rather
 *   than at its start. That is the right answer for a day boundary — "the first
 *   instant of this club day" — and it is what {@link startOfClubDay} asks for.
 *   `boundaries.ts` explains how it is found and names the two historical dates
 *   on which the two answers have ever differed for a day boundary.
 *
 * Measured across all 418 zones this runtime knows, 2015-2036: local midnight is
 * skipped in 19 of them (Havana, Santiago, Sao Paulo, Cairo, Beirut, Tehran,
 * Gaza, the Azores and others), and local NOON is skipped in NONE. See
 * `boundaries.ts` for what follows from that.
 */
export type SkippedWallTimePolicy = "reject" | "nextExistingInstant";

/**
 * Which occurrence to take when a wall-clock time happens TWICE because the
 * clocks went back over it. `earliest` is the default: a job scheduled for 01:30
 * on a fall-back day should run at the first 01:30, not the second.
 *
 * Measured across all 418 zones, 2015-2036: local midnight is ambiguous in 8 of
 * them, and local noon in none.
 */
export type AmbiguousWallTimePolicy = "earliest" | "latest";

/** How {@link instantForClubWallTime} resolves the two DST edge cases. */
export interface WallTimePolicy {
  readonly skipped?: SkippedWallTimePolicy;
  readonly ambiguous?: AmbiguousWallTimePolicy;
}

/**
 * A lodge stay's two date-only identities plus the instants they imply.
 *
 * `checkIn`/`checkOut` stay date-only and `nights` stays a CALENDAR count, both
 * unchanged by anything in this kernel — `INV-DATE-002` and `INV-DATE-003` keep
 * capacity on the half-open `[checkIn, checkOut)` night range and nothing here
 * may be substituted for that. `arrival`/`departure` are new capability: the
 * midday-club-time boundary as an actual moment, for the surfaces that need one.
 */
export interface StayWindow {
  readonly checkIn: CalendarDate;
  readonly checkOut: CalendarDate;
  /** 12:00 club time on `checkIn`. */
  readonly arrival: Instant;
  /** 12:00 club time on `checkOut`. */
  readonly departure: Instant;
  /** Calendar nights — never elapsed milliseconds divided by 24 hours. */
  readonly nights: number;
}

/**
 * The one seam through which this kernel learns what time it is.
 *
 * Every unit test in this repository already runs with "today" frozen at
 * `2026-07-01T00:00:00.000Z` (`vitest.clock-setup.ts`), so the seam is not
 * primarily a test device — it is the single named place a `new Date()` is
 * allowed to live, which is what makes "no business-day decision reads the host
 * clock directly" a property a census can check rather than a habit.
 */
export interface ClubClock {
  nowInstant(): Instant;
}

/**
 * Thrown when a wall-clock time that never happened is asked for under the
 * `reject` policy. Carries the parts rather than only a message so a caller can
 * decide what to do without parsing prose.
 */
export class SkippedClubWallTimeError extends Error {
  readonly date: CalendarDate;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;

  constructor(
    date: CalendarDate,
    hour: number,
    minute: number,
    timeZone: string,
  ) {
    const wall = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    super(
      `${date} ${wall} does not exist in ${timeZone}: the clocks jump forward over it. ` +
        "Pass { skipped: \"nextExistingInstant\" } if the next moment that does exist is the answer you want.",
    );
    this.name = "SkippedClubWallTimeError";
    this.date = date;
    this.hour = hour;
    this.minute = minute;
    this.timeZone = timeZone;
  }
}
