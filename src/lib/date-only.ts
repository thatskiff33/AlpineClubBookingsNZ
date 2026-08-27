/**
 * Date-only values, and the club-day boundaries derived from them.
 *
 * PARTLY A COMPATIBILITY ADAPTER over `@/lib/club-time` since CT-2 (#2990).
 * Every function here that takes or implies a TIMEZONE now delegates to the
 * kernel; the pure UTC-encoding helpers below (`formatDateOnly` and friends)
 * still live here, because this module is the sanctioned home for the date-only
 * encoding (#2684, `INV-DATE-019`) and the kernel deliberately holds a calendar
 * day as text rather than as a `Date`. Retired by CT-6 (#2991).
 *
 * ONE BEHAVIOUR CHANGE, and it is a bug fix. `startOfDateOnlyForTimeZone`
 * resolved a wall time by applying the zone offset twice, which lands BEFORE the
 * transition when the requested midnight does not exist — so for a club whose
 * clocks spring forward at midnight it returned an instant on the PREVIOUS
 * calendar day. Swept across all 418 zones this runtime knows for 2015-2036, the
 * old algorithm named the wrong day in eleven of them (Havana, Santiago, Sao
 * Paulo, Asuncion, Cuiaba, Campo Grande, Coyhaique, Punta Arenas, Scoresbysund,
 * Palmer, the Azores) and differed from the kernel's answer in sixteen. For
 * `Pacific/Auckland`, `Pacific/Chatham`, `UTC` and `America/Denver` the two
 * agree on **every day** of that twenty-one-year span, so this deployment sees
 * no change at all — see `club-day-boundaries.test.ts`.
 *
 * `endOfDateOnlyForTimeZone` keeps its INCLUSIVE "one millisecond before the
 * next day" shape, unchanged, because its call sites depend on it. The kernel's
 * own boundary is half-open (`endOfClubDayExclusive`) and new code should use
 * that.
 *
 * THAT SENTENCE USED TO READ "fifty-eight call sites", AND HALF OF IT WAS WRONG.
 * The claim was about the PAIR — `startOfDateOnlyForTimeZone` together with
 * `endOfDateOnlyForTimeZone` — so the pair is what has to be measured, under a
 * stated predicate. This one is: calls in `src/`, excluding this file's own
 * definitions, excluding `__tests__`, and excluding comment lines.
 *
 *     git grep -nE "(startOf|endOf)DateOnlyForTimeZone\(" -- src/ \
 *       ':!src/lib/date-only.ts' ':!*__tests__*' \
 *       | grep -vE ':[0-9]+: *(\*|//)'
 *
 * At `613cc552e`, the commit that wrote the sentence, that yields **31 call
 * sites in 16 files**. So "sixteen files" was exactly right and "fifty-eight"
 * was not, and no predicate reproduces 58 — the most generous reading available,
 * every non-comment reference including the import lines, is 55. At this head it
 * is **8 call sites in 5 files**, of which 3 are `endOfDateOnlyForTimeZone`,
 * after #2870 moved the nine payment-link expiry sites onto
 * `paymentLinkExpiryForCheckIn`.
 *
 * The method is the point, not the arithmetic. A count without the predicate it
 * was counted under cannot be checked, so it gets copied instead — which is how
 * one wrong figure reached six places. State the predicate, publish a command
 * that yields exactly the stated number, and the next reader can re-run it
 * instead of trusting it.
 */

import {
  clubCalendarDateOf,
  clubToday,
  dateOnlyInstantOf,
  endOfClubDayExclusive,
  isCalendarDate,
  parseCalendarDate,
  startOfClubDay,
  unvalidatedLegacyClubTimeZone,
} from "@/lib/club-time";

/** See `unvalidatedLegacyClubTimeZone` for why the legacy zone is not validated. */
const legacyZone = (timeZone: string) => unvalidatedLegacyClubTimeZone(timeZone);

export function isDateOnlyString(dateStr: string): boolean {
  return isCalendarDate(dateStr);
}

export function parseDateOnly(dateStr: string): Date {
  const date = parseCalendarDate(dateStr);
  return date === null ? new Date(NaN) : dateOnlyInstantOf(date);
}

/**
 * The first instant of a club calendar day. Delegates to `startOfClubDay`, which
 * is defined as "the first instant that exists on that day" rather than
 * "midnight" — see the module doc for the nineteen zones where those differ.
 */
export function startOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone: string
): Date {
  const date = parseCalendarDate(dateStr);
  if (date === null) return new Date(NaN);
  return startOfClubDay(date, legacyZone(timeZone));
}

/**
 * The last instant of a club calendar day, INCLUSIVE — the millisecond before
 * the next day begins. New code wants the kernel's half-open
 * `endOfClubDayExclusive` instead.
 *
 * `new Date(NaN)` FOR A DAY THE KERNEL CANNOT ANSWER, which is this adapter's
 * long-standing contract for an input it cannot interpret and is what every one
 * of its call sites already behaves correctly against. There is
 * exactly one such day: `9999-12-31`, whose exclusive end lies in the year
 * 10000 and so has no `CalendarDate`, where the kernel throws a `RangeError`
 * (see the four-digit-year guard in `club-time/calendar-date.ts`). Before CT-2
 * that input produced an Invalid Date too, so this restores the old behaviour rather than
 * inventing one: the value reaches Prisma, which refuses to serialise it, and
 * the operator gets a failed query instead of a filter that silently matched
 * nothing.
 */
export function endOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone: string
): Date {
  const date = parseCalendarDate(dateStr);
  if (date === null) return new Date(NaN);
  try {
    return new Date(
      endOfClubDayExclusive(date, legacyZone(timeZone)).getTime() - 1
    );
  } catch (error) {
    if (error instanceof RangeError) return new Date(NaN);
    throw error;
  }
}

/**
 * The NZ calendar day a date-only value encodes, as `yyyy-MM-dd`.
 *
 * THE CANONICAL ENCODER, and the only place in `src/` allowed to write the
 * truncation by hand (#2684). The receiver must be a date-only value — a
 * `@db.Date` column, or a `Date` this module produced — whose instant is UTC
 * midnight, because that is what makes the UTC reading and the day the value
 * encodes the same day, for EVERY club rather than only for one east of
 * Greenwich. That truncation is `INV-DATE-019`'s first exact boundary, over the
 * columns `INV-DATE-026` establishes as calendar days. `INV-DATE-010` is why the
 * value is an encoding rather than a moment, and is not the citation for the
 * decode — it says so itself (#3080).
 *
 * It is NOT the encoder for a real instant. `createdAt`, `updatedAt` and every
 * other bare `DateTime` column is a moment, and its UTC calendar day is the
 * PREVIOUS NZ day for roughly the first half of every New Zealand day — the
 * defect #2697 fixed on a Xero due date and a finance export. Deriving a club
 * calendar day from an instant is `formatDateOnlyForTimeZone`'s job
 * (INV-DATE-019).
 */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar MONTH a date-only value falls in, as `yyyy-MM`.
 *
 * Same receiver contract as `formatDateOnly`: a date-only value, never an
 * instant. Month keys are the finance subsystem's period identity (the
 * `@db.Date` `FinanceMonthlyFact.month`, a reconciliation window's start), and
 * they were the one hand-written ISO truncation left over once the day-level
 * ones were single-sourced — a neighbouring hole in a rule that claims to close
 * the class, so it lives here too (#2684).
 */
export function formatMonthOnly(date: Date): string {
  return formatDateOnly(date).slice(0, 7);
}

/**
 * The `yyyy-MM-dd` day a SERIALISED date-only value carries.
 *
 * The same value as `formatDateOnly`, one hop later: once a `@db.Date` has
 * crossed a JSON boundary into a client component or an API payload it is a
 * string (`"2026-07-01T00:00:00.000Z"`, or already `"2026-07-01"`), and the
 * caller wants the day back out of it. Both shapes return their leading day,
 * which is why this is a plain fixed-width prefix rather than a parse: the
 * date-only prefix of an ISO value is exactly ten characters, so this and the
 * `.split("T")[0]` spelling it replaces agree on every input either can be
 * handed.
 *
 * It carries the SAME receiver contract as `formatDateOnly` and provides no
 * more safety than it: a serialised instant truncated here is the identical
 * off-by-one-day defect. If what you hold is a serialised `DateTime`, parse it
 * and go through `formatDateOnlyForTimeZone` instead.
 */
export function dateOnlyFromIsoString(value: string): string {
  return value.slice(0, 10);
}

/**
 * The NZ date-only key (`yyyy-MM-dd`) for a calendar day given as parts;
 * `monthIndex` is 0-based, matching `Date.getMonth()`.
 *
 * This is the CANONICAL client-side encoding of a lodge night (#2474). A lodge
 * night is an abstract calendar day, not an instant, so it is built straight
 * from its parts and never routed through `new Date(year, month, day)` — that
 * construction is midnight in the BROWSER's zone, and the moment such a value
 * reaches an instant-based API (a club-pinned `Intl` formatter, a UTC
 * serialiser, or day arithmetic across a DST boundary) it is off by a day for a
 * viewer whose zone sits far enough from New Zealand. This replaced the #2264
 * `localCalendarDayToDateOnly` bridge, which patched the display half of that
 * hazard while the fragile local-midnight encoding still existed; carrying the
 * string end-to-end removes the encoding itself. A consumer that genuinely needs
 * a `Date` calls `parseDateOnly` at the boundary, which pins the day to UTC
 * midnight — rendered as club midday, so the same calendar day in every zone.
 */
export function formatCalendarDayOnly(
  year: number,
  monthIndex: number,
  day: number,
): string {
  const month = String(monthIndex + 1).padStart(2, "0");
  const dayOfMonth = String(day).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}

/**
 * The club calendar day a real instant falls on. Delegates to the kernel's
 * `clubCalendarDateOf`, whose formatter memo is the same zone-keyed map this
 * function used to own — kept for the same measured reason: `Intl` construction
 * costs about 42 microseconds against 0.76 memoised, and the capacity, pricing
 * and finance loops call this once per (booking, night) pair.
 */
export function formatDateOnlyForTimeZone(
  date: Date,
  timeZone: string
): string {
  return clubCalendarDateOf(date, legacyZone(timeZone));
}

/**
 * "Now" as a `yyyy-MM-dd` string in the given zone.
 *
 * THIS AND TWO OTHERS BELOW HAVE NO PRODUCTION CALLER LEFT, and the decision to
 * keep them is written here rather than left for the next reader to re-derive.
 * `normalizeDateOnlyForTimeZone` and `getTodayDateOnly` are the other two;
 * #3123 moved the last production site of each onto the kernel. Measured with
 * the same predicate this module's header uses — calls in `src/`, excluding
 * this file, excluding `__tests__`, excluding comment lines — all three are at
 * zero, and what remains outside tests is docblocks explaining what moved.
 *
 * THE TEST SUITE IS THE CALLER, and `npm run knip` — this repository's arbiter
 * for a dead export — does not flag any of the three, because a test import is
 * a real import. Each is the compact spelling of a fixture the suites build
 * constantly: the club's today as a day string, or as the UTC-midnight
 * `Date` a `@db.Date` column round-trips. Deleting them rewrites every one of
 * those fixtures into `dateOnlyInstantOf(clubToday(requireClubTimeZone(zone)))`,
 * which is the same value spelled longer, in dozens of files, for no change in
 * what ships.
 *
 * PRODUCTION IS HELD OFF THEM BY A GUARD RATHER THAN BY ABSENCE, which is the
 * part that makes keeping them safe. All three are named — with the replacement
 * to use — in the `ENVIRONMENT_ZONE_HELPERS` import bans of
 * `member-public-club-time-convergence.test.ts` and
 * `api-club-time-convergence.test.ts`, so a member page, a public page or an
 * API route that reaches for one again fails a suite instead of quietly taking
 * a civil-time answer from whatever string it was holding. Those bans cover
 * those route groups and not all of `src/lib`; a shared library module wanting
 * the club's today composes it from the kernel, per
 * `docs/CLUB_TIME_KERNEL.md`.
 *
 * WHAT WOULD MAKE THEM DELETABLE: those fixtures moving to a shared test helper
 * over the kernel. That is a change to the test suite rather than to this
 * module, so it is recorded here instead of started.
 */
export function todayDateOnlyForTimeZone(timeZone: string): string {
  return clubToday(legacyZone(timeZone));
}

/**
 * The club calendar day of an instant, re-encoded as a date-only `Date`.
 *
 * NO PRODUCTION CALLER — see `todayDateOnlyForTimeZone` above for why the three
 * such exports stay. A `@db.Date` value is ALREADY the normalised calendar day,
 * so round-tripping one through a zone here is the defect the convergence
 * suites' ban entry for this name warns about; what this is for is a real
 * instant a test wants pinned to its club day.
 */
export function normalizeDateOnlyForTimeZone(
  date: Date,
  timeZone: string
): Date {
  const normalized = parseDateOnly(formatDateOnlyForTimeZone(date, timeZone));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid date-only value: ${date.toISOString()}`);
  }

  return normalized;
}

export function addDaysDateOnly(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Build a UTC date-only value from calendar parts, WITHOUT `Date.UTC`.
 *
 * `Date.UTC` applies the legacy two-digit-year rule: years 0-99 are mapped onto
 * 1900-1999, so `Date.UTC(47, 0, 1)` is 1947, not 0047. `setUTCFullYear` has no
 * such rule, so every date-only value derived from parts is built this way.
 * `monthIndex` and `day` may be out of range and roll over as usual (month 12 is
 * January of the next year; day 0 is the last day of the previous month).
 */
export function dateOnlyFromParts(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, monthIndex, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

// Steps a date-only value by whole calendar months (#2251, the bed-allocation
// board's month stepper). Pure UTC date-only arithmetic — no time zone
// conversion, matching addDaysDateOnly. The day-of-month is clamped to the
// target month's length so the result is always a real date: 31 Jan + 1 month
// is 28 Feb (29 in a leap year), never an overflow into March. Clamping means
// the operation is NOT reversible for such days (31 Jan → 28 Feb → 28 Jan);
// callers that need to step back and forth should keep their own anchor.
export function addMonthsDateOnly(date: Date, months: number): Date {
  if (Number.isNaN(date.getTime())) return new Date(NaN);

  const day = date.getUTCDate();
  const target = dateOnlyFromParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
  );
  // Day 0 of the following month is the last day of the target month.
  const daysInTargetMonth = dateOnlyFromParts(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

/**
 * How many nights a date-only range covers, WITHOUT materialising them.
 *
 * Both ends are UTC midnight, so the span is an exact whole number of days and
 * no time-zone or DST correction applies. Every cap on a range length checks
 * this first (#2251): `eachDateOnlyInRange` on a mistyped year-3000 date-out
 * would build a million `Date` objects before anyone could refuse it.
 * Returns `NaN` for an invalid endpoint, which fails every comparison.
 */
export function countNightsDateOnly(
  startInclusive: Date,
  endExclusive: Date,
): number {
  const spanMs = endExclusive.getTime() - startInclusive.getTime();
  return Number.isFinite(spanMs) ? Math.round(spanMs / 86_400_000) : NaN;
}

export function eachDateOnlyInRange(startInclusive: Date, endExclusive: Date): Date[] {
  const dates: Date[] = [];

  for (
    let current = new Date(startInclusive);
    current < endExclusive;
    current = addDaysDateOnly(current, 1)
  ) {
    dates.push(current);
  }

  return dates;
}

/**
 * Today's club calendar day as a date-only `Date`. INV-DATE-019.
 *
 * NO PRODUCTION CALLER — see `todayDateOnlyForTimeZone` above for why the three
 * such exports stay. This is the most-used of them in tests by a wide margin.
 */
export function getTodayDateOnly(timeZone: string): Date {
  return dateOnlyInstantOf(clubToday(legacyZone(timeZone)));
}
