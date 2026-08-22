/**
 * The house display shapes (CT-2, #2990).
 *
 * ## The API says what it is FORMATTING, and the type system enforces it
 *
 * The calendar-date functions take a {@link CalendarDate} and **no zone**,
 * because a calendar day does not have one: 16 April 2026 is a Thursday
 * everywhere on earth, and asking which zone to render it in is asking a
 * question with no answer. The instant functions take a {@link Instant} and
 * **require** a zone, because a moment has no civil date until one is chosen.
 *
 * That asymmetry is the domain made visible, and it is why there is no generic
 * `formatDate` here — the issue forbids one, and a catch-all is precisely what
 * lets a `createdAt` be rendered as if it were a lodge night.
 *
 * ## The output is byte-identical to what shipped before
 *
 * `__tests__/house-shapes.test.ts` pins every shape against the frozen
 * `Intl.DateTimeFormat` constants `nzst-date` used to hold — written out by hand
 * there, because delegation means importing `nzst-date` would compare the kernel
 * with itself — and against the lodge-display constants these replace, over a
 * 400-day sweep. The calendar-date half reaches the same strings by a different route
 * — see `formatCalendarDateShape` in `./intl` for why a UTC-pinned formatter
 * over a UTC-midnight encoding is an identity rather than a projection.
 *
 * ## INV-DATE-016 still stands
 *
 * `formatClubLongDate` / `formatClubInstantLongDate` are the long spelled-out
 * form and remain reserved for the four member-facing surfaces named in that
 * invariant. Everything admin-side or internal uses the medium shape.
 */

import { calendarDateParts } from "./calendar-date";
import { formatCalendarDateShape, formatHouseShape } from "./intl";
import type { CalendarDate, ClubTimeZone, Instant } from "./types";

// ---------------------------------------------------------------------------
// Calendar dates — no zone, because a calendar day has none
// ---------------------------------------------------------------------------

/** "16 Apr 2026" — the house medium form. */
export function formatClubDate(date: CalendarDate): string {
  return formatCalendarDateShape("date", date);
}

/** "16 April 2026" — reserved by INV-DATE-016 for four member-facing surfaces. */
export function formatClubLongDate(date: CalendarDate): string {
  return formatCalendarDateShape("longDate", date);
}

/** "April 2026" — a month heading. */
export function formatClubMonthYear(date: CalendarDate): string {
  return formatCalendarDateShape("monthYear", date);
}

/** "Thu, 16 Apr 2026" — for lists scanned by day of the week. */
export function formatClubWeekdayDate(date: CalendarDate): string {
  return formatCalendarDateShape("weekdayDate", date);
}

/** "Thu" — the weekday alone. */
export function formatClubWeekday(date: CalendarDate): string {
  return formatCalendarDateShape("weekday", date);
}

/**
 * "Thu 16" — weekday plus bare day of month, the lobby wall's column head.
 *
 * ASSEMBLED rather than asked of `Intl` as one shape, and the difference is not
 * cosmetic: the day number comes from the calendar-date STRING, so it is the day
 * that was asked for in every locale. `{ weekday: "short", day: "numeric" }`
 * happens to render "Thu 16" for `en-NZ`, but `APP_LOCALE` is configurable and a
 * locale that ordered or punctuated the pair differently would silently change
 * six lobby screens.
 */
export function formatClubWeekdayDay(date: CalendarDate): string {
  return `${formatClubWeekday(date)} ${calendarDateParts(date).day}`;
}

/** "Thu, 16 Apr" — the lobby wall's short date, deliberately without a year. */
export function formatClubWeekdayDayMonth(date: CalendarDate): string {
  return formatCalendarDateShape("weekdayDayMonth", date);
}

/** "Thursday, 16 April" — the lobby wall's long date, deliberately without a year. */
export function formatClubLongWeekdayDayMonth(date: CalendarDate): string {
  return formatCalendarDateShape("longWeekdayDayMonth", date);
}

// ---------------------------------------------------------------------------
// Instants — the zone is required, because a moment has no civil date without one
// ---------------------------------------------------------------------------

/** "16 Apr 2026" — the club calendar date a moment falls on. */
export function formatClubInstantDate(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("date", instant, zone);
}

/** "16 Apr 2026, 2:30 pm" */
export function formatClubInstantDateTime(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("dateTime", instant, zone);
}

/** "16 April 2026" — INV-DATE-016 applies. */
export function formatClubInstantLongDate(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("longDate", instant, zone);
}

/** "2:30 pm" — time of day only, no date, no seconds. */
export function formatClubInstantTime(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("time", instant, zone);
}

/** "April 2026" */
export function formatClubInstantMonthYear(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("monthYear", instant, zone);
}

/** "Thu, 16 Apr 2026" */
export function formatClubInstantWeekdayDate(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("weekdayDate", instant, zone);
}
