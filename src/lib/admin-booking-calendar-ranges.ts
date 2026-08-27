/**
 * Which days of one calendar-grid month a booking occupies (CT-6, #2991).
 *
 * ## Why this stopped using `Date`
 *
 * This module used to turn each `YYYY-MM-DD` stay day into a HOST-LOCAL
 * midnight — `new Date(year, month - 1, day)` — and then read the day back out
 * with `.getDate()`. The round trip recovers what it was given in almost every
 * zone, which is exactly why it survived so long: the two errors cancel.
 *
 * They stop cancelling on a day whose LOCAL midnight does not exist. Where a
 * zone springs forward AT midnight, `new Date(y, m, d)` lands on the previous
 * day at 23:00 and `.getDate()` answers `d - 1` — so a booking checking in that
 * day is drawn one cell early on the admin calendar, in that zone only, on one
 * day a year. `INV-DATE-025` is the rule; the kernel's own
 * `SkippedClubWallTimeError` exists because the same hazard bites harder
 * elsewhere.
 *
 * A calendar grid needs no zone at all. Every value here is a calendar day, and
 * the arithmetic below is the kernel's zone-free calendar arithmetic — so there
 * is no clock face to read, no host to depend on, and nothing left to cancel.
 */
import {
  addCalendarMonths,
  calendarDateFromParts,
  calendarDateParts,
  compareCalendarDates,
  daysInCalendarMonth,
  parseCalendarDate,
} from "@/lib/club-time";

interface CalendarBookingRangeInput {
  checkIn: string;
  checkOut: string;
}

/**
 * The `[start, end]` day-of-month span, or `null` when the booking does not
 * touch this grid month.
 *
 * `month` is ZERO-indexed, the convention the calling grid already uses, and
 * out-of-range values normalise the way `new Date(year, month, 1)` did — month
 * `12` is January of the next year. `end` is the last OCCUPIED night, so a
 * check-out day contributes nothing: a stay is `[checkIn, checkOut)`.
 *
 * A malformed date returns `null` rather than throwing. This renders an admin
 * calendar; a row with a bad day should go missing from the grid, not take the
 * page down with it.
 */
export function getAdminCalendarBookingDayRange(
  booking: CalendarBookingRangeInput,
  year: number,
  month: number
): { start: number; end: number } | null {
  const checkIn = parseCalendarDate(booking.checkIn);
  const checkOut = parseCalendarDate(booking.checkOut);
  if (checkIn === null || checkOut === null) return null;

  // January of `year`, stepped forward `month` months, so an out-of-range month
  // rolls into the next year exactly as the Date constructor used to.
  const monthStart = addCalendarMonths(
    calendarDateFromParts(year, 1, 1),
    month
  );
  const monthEndExclusive = addCalendarMonths(monthStart, 1);

  if (
    compareCalendarDates(checkOut, monthStart) <= 0 ||
    compareCalendarDates(checkIn, monthEndExclusive) >= 0
  ) {
    return null;
  }

  const monthParts = calendarDateParts(monthStart);
  const daysInMonth = daysInCalendarMonth(monthParts.year, monthParts.month);
  const start = Math.max(
    1,
    compareCalendarDates(checkIn, monthStart) < 0
      ? 1
      : calendarDateParts(checkIn).day
  );
  const end = Math.min(
    daysInMonth,
    compareCalendarDates(checkOut, monthEndExclusive) >= 0
      ? daysInMonth
      : calendarDateParts(checkOut).day - 1
  );

  return end >= start ? { start, end } : null;
}
