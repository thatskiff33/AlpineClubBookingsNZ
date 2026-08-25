/**
 * Membership financial-year configuration.
 *
 * The club's financial year-end month drives how a calendar date maps to a
 * membership "season year" and how the Xero subscription-invoice window is
 * built. The effective value is resolved on the server (override, else the
 * connected Xero organisation, else the March default) and cached here as a
 * plain module-level number.
 *
 * This module deliberately has NO server imports (no Prisma, no Xero). It is
 * imported transitively by `utils.ts`, which is also pulled into client
 * bundles, so the synchronous getter below must stay dependency-free. The
 * async resolution lives in `financial-year-server.ts`. `@/lib/club-time` is
 * the one import added to it (CT-4 group F1, #2870): that barrel is deliberately
 * isomorphic - no `server-only`, no Prisma, no environment read of the zone - and
 * it is what lets the season derivation below be zone-aware without this module
 * gaining a server edge.
 *
 * ## THE SEASON YEAR HAS TWO CALLERS, AND THEY ARE NOT THE SAME QUESTION
 *
 * This is why the retired `getSeasonYearForYearEndMonth(date, m)` could not be
 * repaired in place, and why no call site could repair itself. It read its `Date`
 * argument with `date.getMonth()` and `date.getFullYear()` - the HOST's calendar
 * components - so `getSeasonYear(new Date())` answered from the server's month
 * rather than the club's, and `getSeasonYear(booking.checkIn)` read a
 * UTC-midnight `@db.Date` encoding a day early for every club west of Greenwich.
 *
 * The two callers want opposite treatment, so there are two functions:
 *
 * | The caller holds                        | The function                             |
 * | --------------------------------------- | ---------------------------------------- |
 * | "what season is it NOW, for the club"    | {@link clubSeasonYear} - zone + clock    |
 * | a stored `@db.Date` night / DOB / edge   | {@link seasonYearOfStoredDate} - NO zone |
 * | a `CalendarDate` already                 | {@link seasonYearOfCalendarDate}         |
 *
 * ## AND HANDING THE OLD FUNCTION A CLUB-DERIVED DATE MADE THINGS WORSE
 *
 * Measured across a host x club matrix (#2870, group A): passing
 * `dateOnlyInstantOf(clubToday(zone))` into a host-local reader gives zero wrong
 * days for a host at or ahead of UTC and ONE ENTIRE WRONG DAY for any host behind
 * it - so a self-consistent `America/Denver` deployment went from zero wrong
 * hours to the whole of 1 April answering with the previous season year. On that
 * boundary a season year is a whole YEAR out, not a day, and it selects immutable
 * subscription charges and the Xero work queued from them. Do not reintroduce a
 * season helper that reads a `Date`'s host-local components, and do not "fix" one
 * by improving the `Date` handed to it.
 */

import {
  calendarDateOfDateOnlyInstant,
  calendarDateParts,
  clubToday,
  requireStoredCalendarDay,
  type CalendarDate,
  type ClubClock,
  type ClubTimeZone,
} from "@/lib/club-time";

/** Default financial year-end month: March (NZ convention, 31 March year-end). */
export const DEFAULT_FINANCIAL_YEAR_END_MONTH = 3;

// 1-12. Seeded from the DB / Xero by refreshFinancialYearConfig() on the server.
let cachedYearEndMonth = DEFAULT_FINANCIAL_YEAR_END_MONTH;

// test seam
/** Clamp an arbitrary value to a valid month (1-12), falling back to March. */
export function normalizeYearEndMonth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FINANCIAL_YEAR_END_MONTH;
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 12) return DEFAULT_FINANCIAL_YEAR_END_MONTH;
  return rounded;
}

// test seam
/**
 * Synchronous read of the effective financial year-end month (1-12). Returns
 * the March default until the server seeds the cache. Used by the
 * (synchronous) season helpers so their signatures and ~40 call sites are
 * unchanged.
 */
export function getFinancialYearEndMonth(): number {
  return cachedYearEndMonth;
}

/** Update the module cache. Called by the server resolver only. */
export function setFinancialYearEndMonth(month: number): void {
  cachedYearEndMonth = normalizeYearEndMonth(month);
}

/**
 * The 1-based calendar month a membership season starts in, for an EXPLICIT
 * year-end month - the month after it. For a March year-end that is April (4);
 * for a December year-end it is January (1), which is why a December club's
 * season is one calendar year rather than two.
 *
 * THE ONE HOME FOR THAT ROLLOVER. It was written out twice - here and inside
 * {@link seasonYearOfCalendarDate} - and the season LABEL
 * (`@/lib/season-label`) needs it a third time, for a year-end its caller holds
 * rather than the cached one. Three copies of a one-line modular step is the
 * drift class this epic exists to remove, so it is a function.
 */
export function seasonStartMonthOf(yearEndMonth: number): number {
  return (normalizeYearEndMonth(yearEndMonth) % 12) + 1;
}

/**
 * The 1-based calendar month in which the membership season starts, for the
 * club's CONFIGURED year-end. A cache accessor, so it takes no override; every
 * DERIVATION in this module takes one.
 */
export function getSeasonStartMonth(): number {
  return seasonStartMonthOf(getFinancialYearEndMonth());
}

/**
 * THE ONE SEASON DERIVATION. A club calendar day in, a season year out.
 *
 * It takes a {@link CalendarDate} and therefore takes NO TIMEZONE, which is
 * `INV-DATE-019`: a calendar day has no zone, so nothing here can read one
 * wrong. `calendarDateParts` is integer civil-calendar arithmetic over the
 * `YYYY-MM-DD` text - no `Date` is constructed and no host component is read, so
 * this returns the same answer on every host on earth.
 *
 * `yearEndMonth` defaults to the process cache so the call sites this replaced
 * keep reading the club's configured year-end without each passing it.
 */
export function seasonYearOfCalendarDate(
  date: CalendarDate,
  yearEndMonth: number = getFinancialYearEndMonth(),
): number {
  const startMonth = seasonStartMonthOf(yearEndMonth);
  const { year, month } = calendarDateParts(date);
  return month >= startMonth ? year : year - 1;
}

/**
 * The season year of a value read out of a Prisma `@db.Date` column - a lodge
 * night, a date of birth, a season edge, an explicit decision date.
 *
 * IT TAKES NO ZONE, AND THAT IS THE FIX. The column stores an encoding whose
 * definition is UTC midnight (`INV-DATE-019`'s first exact boundary, and
 * `INV-DATE-026`); the day it names is the same day in every zone, so projecting
 * it through one - the club's or the host's - is the defect rather than the
 * remedy. Do NOT cite `INV-DATE-010` for the decode: it names the two ids above
 * as that authority rather than itself, and what it forbids is deriving a rule
 * from such a value read as a MOMENT (#3076 corrected four such citations;
 * #3080 the rest).
 *
 * IT REFUSES A VALUE CARRYING A UTC TIME OF DAY, for the reason F2 recorded on
 * `normalizeBookingDate` (#3076). `calendarDateOfDateOnlyInstant` silently FLOORS
 * a real timestamp to its UTC day, so `seasonYearOfStoredDate(new Date())` would
 * answer from the UTC day rather than the club's and nothing would say so - and
 * for a club east of Greenwich it would be right for most of the day, which is
 * worse than being wrong for all of it. Refusing is not guessing which kind it
 * was handed: the function still never decides, it declines to answer. A caller
 * that means "now" wants {@link clubSeasonYear}.
 */
export function seasonYearOfStoredDate(
  value: Date,
  yearEndMonth?: number,
): number {
  return seasonYearOfCalendarDate(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(value, {
        subject: "seasonYearOfStoredDate",
        instead: `If you meant "the club's season year now", call clubSeasonYear(zone) instead.`,
      }),
    ),
    yearEndMonth,
  );
}

/**
 * THE CLUB'S CURRENT SEASON YEAR. Needs the club's PERSISTED zone
 * (`INV-CONFIG-002`), because "what season is it now" is a club business decision
 * and the container's month is not the club's.
 *
 * The zone arrives as data - `await clubTimeZone()` inside a React request,
 * `await readClubTimeZoneOutsideRequest()` from a cron or a CLI-reachable module,
 * a prop or a payload field on the client. It is never read from the host and
 * never from `APP_TIME_ZONE`.
 *
 * `clock` exists so a caller that must hold time still - a batch that cannot be
 * allowed to straddle midnight mid-run - passes `fixedClubClock(instant)` rather
 * than letting each call re-read the clock.
 */
export function clubSeasonYear(
  zone: ClubTimeZone,
  clock?: ClubClock,
  yearEndMonth?: number,
): number {
  return seasonYearOfCalendarDate(clubToday(zone, clock), yearEndMonth);
}

// test seam
/** Test-only override. Pair with a reset to DEFAULT in a beforeEach. */
export function __setFinancialYearEndMonthForTesting(month: number): void {
  cachedYearEndMonth = normalizeYearEndMonth(month);
}
