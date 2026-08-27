import { formatDateOnly } from "@/lib/date-only";
import type { CalendarDate } from "@/lib/club-time";

/**
 * THE shared member-age helper (#2568).
 *
 * Every surface that needs a member's age — the member-detail summary strip and
 * the identity-sensitive Family Group admin workflows — resolves it here.
 * Nothing recomputes age in a component, a route, or a Prisma mapper, and no
 * calculated age is ever stored: it changes on its own every day.
 *
 * Semantics, all deliberate:
 *
 * - **Date-only, and a date of birth carries no time zone at all.** Every column
 *   this reads — `Member.dateOfBirth`, `FamilyGroupJoinRequest.childDateOfBirth`
 *   and `requestedDateOfBirth` — is `DateTime @db.Date` since #2872: a calendar
 *   day, encoded as UTC midnight and never a moment (INV-DATE-010). A `Date` or
 *   an ISO string is therefore read by TRUNCATION (`formatDateOnly`,
 *   INV-DATE-019's first exact boundary with INV-DATE-026 — the citation for a
 *   decode, which INV-DATE-010 is not; #3080), which returns the
 *   stored day from any zone on earth. "Today" is a different question with a
 *   different answer, and it is the CLUB's calendar day — never the server's or
 *   the browser's UTC date. Reading `new Date()` in UTC puts "today" a day
 *   behind a club at UTC+12/+13 for the first 12-13 hours of every club day,
 *   which is exactly the off-by-one that would show an admin "18 years" on the
 *   morning of a member's 19th birthday. Which zone answers it, and how the
 *   answer reaches this module, is the next bullet.
 * - **The reference day is a REQUIRED `CalendarDate` and there is no default**
 *   (#3123). It used to default to `todayDateOnlyForTimeZone()`, which reads
 *   `APP_TIME_ZONE` — the CONTAINER's zone on a server and the BUILD's zone in
 *   the browser, never the club's persisted one (`INV-CONFIG-002`). This module
 *   is on the client graph (`member-summary-strip.tsx` is `"use client"`), so it
 *   can never read that setting itself: the answer has to arrive as data. The
 *   default was deleted rather than repaired, so the typechecker enumerates
 *   every call site instead of leaving the wrong ones silently green — the same
 *   remedy `getSeasonYear` got, and for the same reason.
 *   A server caller supplies `(await clubTime()).today()` or
 *   `clubToday(await readClubTimeZoneOutsideRequest())`; a client caller
 *   supplies `useClubTime().today()`. Both are the club's persisted zone, and
 *   both hand over a `CalendarDate` — so an INSTANT cannot reach the "today"
 *   operand by mistake, which is the other half of the #3082 confusion.
 * - **29 February birthdays clamp to 28 February in a non-leap year.** The
 *   anniversary day is `min(dobDay, daysInTargetMonth)`, so a leap-day member
 *   counts the new year on 28 February rather than on 1 March. This is the
 *   behaviour the member-detail strip has always had, and for an identity check
 *   a one-day convention difference cannot change which person a name matches.
 * - **A date of birth in the future has no age**, so it resolves to `null` /
 *   "Age unavailable" rather than "0 years" — a mistyped year must read as
 *   unusable, not as a newborn.
 */

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const EXACT_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A bare date-only value that carries a time as well — what a `Date` becomes on
// the way through JSON. Nothing else is accepted as a string: `new Date()` still
// falls back to a locale-dependent legacy parser, and "01/02/2003" silently
// resolving to 2 January (US reading) rather than 1 February is exactly the kind
// of ambiguity an identity check must refuse instead of guess at.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of `month`.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

function partsFromDateOnlyString(value: string): DateParts | null {
  // The reference day reaching here is a `CalendarDate`, whose brand can only be
  // minted by a validator — but a brand is castable, and this module is on the
  // client graph where an unhandled throw blanks the screen through the nearest
  // error boundary. "Age unavailable" is the right answer for a value that is
  // not a day at all; a white page is not (#3123).
  if (typeof value !== "string") return null;
  const match = value.match(EXACT_DATE_ONLY);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

/**
 * The calendar day a date-of-birth value denotes.
 *
 * A bare `yyyy-MM-dd` string is already a calendar day and is taken as written.
 * Anything else — a Prisma `Date` from a `@db.Date` column, or the ISO timestamp
 * that same value becomes once it is JSON-serialised — is UTC midnight on that
 * day, so the day is read straight off the UTC clock face.
 *
 * IT USED TO PROJECT THE VALUE INTO THE CLUB ZONE FIRST, and the comment here
 * defended that as making "the two representations of one stored value always
 * agree". They do agree — both ARE UTC midnight — so truncation makes them agree
 * AND agree with what is stored, which the projection does not. Projecting UTC
 * midnight into a zone BEHIND Greenwich lands on the previous evening, so a
 * member born on 1 January read a year short on their own birthday for any club
 * west of UTC. It agreed in New Zealand, which sits ahead of UTC, and that is
 * why it survived (#2872, INV-DATE-026).
 *
 * The receiver contract is `formatDateOnly`'s: what is handed in must be a
 * calendar day, not a real moment. Nothing here can tell the difference, and a
 * caller passing an instant as `referenceDate` would get its UTC day.
 */
function parseDateOnlyParts(value: Date | string | null | undefined): DateParts | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string") {
    const exact = partsFromDateOnlyString(value);
    if (exact) return exact;
    if (!ISO_DATE_TIME.test(value)) return null;
  }

  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;

  return partsFromDateOnlyString(formatDateOnly(instant));
}

function comparableDay(parts: DateParts): number {
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}

function anniversaryDay(dateOfBirth: DateParts, year: number, month: number) {
  return Math.min(dateOfBirth.day, daysInMonth(year, month));
}

function isBeforeBirthdayInYear(dateOfBirth: DateParts, asOfDate: DateParts) {
  const birthdayDay = anniversaryDay(dateOfBirth, asOfDate.year, dateOfBirth.month);
  return (
    asOfDate.month < dateOfBirth.month ||
    (asOfDate.month === dateOfBirth.month && asOfDate.day < birthdayDay)
  );
}

/** Completed years, and completed months since the last birthday. */
export interface MemberAgeParts {
  years: number;
  months: number;
}

/**
 * Completed years and months between a date of birth and a reference day, or
 * `null` when the date of birth is missing, unparseable, or in the future.
 *
 * `asOf` is REQUIRED and is a `CalendarDate` — the club's own day, resolved by
 * the caller from the persisted timezone. See the module docblock for why there
 * is no default and why this module cannot resolve it itself.
 */
export function calculateMemberAgeParts(
  dateOfBirth: Date | string | null | undefined,
  asOf: CalendarDate
): MemberAgeParts | null {
  const dob = parseDateOnlyParts(dateOfBirth);
  // A `CalendarDate` is a real `yyyy-MM-dd` day by construction, so this cannot
  // fail from a legitimately-obtained value. It is still checked: the brand is
  // castable, and an age label that quietly reported the wrong year would be
  // worse on this surface than one that reports "Age unavailable".
  const asOfParts = partsFromDateOnlyString(asOf);
  if (!dob || !asOfParts) return null;

  // No age exists before a person is born; a future value is bad data.
  if (comparableDay(dob) > comparableDay(asOfParts)) return null;

  let years = asOfParts.year - dob.year;
  if (isBeforeBirthdayInYear(dob, asOfParts)) {
    years -= 1;
  }

  let months = asOfParts.month - dob.month;
  if (months < 0) months += 12;

  // Only whole months count: the monthly anniversary has to have passed.
  const monthlyAnniversaryDay = anniversaryDay(
    dob,
    asOfParts.year,
    asOfParts.month
  );
  if (asOfParts.day < monthlyAnniversaryDay) {
    months -= 1;
  }
  if (months < 0) months += 12;

  return { years, months };
}

function pluralise(value: number, noun: "year" | "month") {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatYearsMonths(parts: MemberAgeParts) {
  return `${pluralise(parts.years, "year")} ${pluralise(parts.months, "month")}`;
}

/**
 * Completed years and months, always both, or `null` when no age can be
 * derived. Used by the member-detail summary strip, which shows the exact age
 * beside the stored date of birth.
 */
export function formatAgeYearsMonths(
  dateOfBirth: Date | string | null | undefined,
  asOfDate: CalendarDate
): string | null {
  const parts = calculateMemberAgeParts(dateOfBirth, asOfDate);
  return parts ? formatYearsMonths(parts) : null;
}

/** Rendered whenever a member's age cannot be derived (#2568). */
export const AGE_UNAVAILABLE_LABEL = "Age unavailable";

/**
 * Below this age the months component is shown too: for an infant or toddler
 * "3 years" is not enough to tell two siblings apart, and a bare "0 years"
 * says almost nothing.
 */
export const AGE_MONTHS_SHOWN_BELOW_YEARS = 5;

/**
 * The age label an authorised administrator sees while confirming WHICH member
 * record an identity-sensitive Family Group action applies to (#2568).
 *
 * "47 years" from 5 years old up, "3 years 8 months" below that, and
 * "Age unavailable" when there is no usable date of birth. Always computed
 * server-side and sent as this finished string, so the date of birth itself
 * does not have to reach the browser.
 */
export function formatMemberIdentityAge(
  dateOfBirth: Date | string | null | undefined,
  referenceDate: CalendarDate
): string {
  const parts = calculateMemberAgeParts(dateOfBirth, referenceDate);
  if (!parts) return AGE_UNAVAILABLE_LABEL;
  if (parts.years >= AGE_MONTHS_SHOWN_BELOW_YEARS) {
    return pluralise(parts.years, "year");
  }
  return formatYearsMonths(parts);
}
