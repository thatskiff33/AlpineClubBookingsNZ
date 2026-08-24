/**
 * The month arithmetic behind the occupancy calendar's grid (CT-4, #2870).
 *
 * ## Why this is its own module
 *
 * The seam is PURE versus COMPONENT, the same one `occupancy-calendar-tones.ts`
 * already uses beside it: nothing here touches React, a hook, a fetch or the
 * club-time provider, and everything here is answerable from a calendar day and
 * two integers. The component was at 669 of its 700-line ceiling before CT-4's
 * last group moved these functions onto the kernel, and explaining WHY they are
 * kernel calls rather than `Date` arithmetic is worth more lines than the calls
 * themselves — which is exactly the case for lifting them out rather than
 * declaring a size allowance and leaving a component holding date arithmetic.
 *
 * ## What changed, and the one thing that deliberately did not
 *
 * `monthKeysForDateRange` and `getMonthGrid` are now calendar-day arithmetic and
 * construct no `Date` at all. `getMonthStart` still takes and returns a `Date`,
 * because the component holds `visibleMonth` in React state as one; converting
 * that state to a `CalendarDate` is a change to the component's own shape rather
 * than to this arithmetic, and it belongs with the rest of the `src/lib` sweep
 * (#2870) or with CT-6 (#2991).
 */

import {
  addCalendarMonths,
  calendarDateFromParts,
  calendarDayOfWeek,
  calendarMonthOf,
  daysInCalendarMonth,
  parseCalendarDate,
  startOfCalendarMonth,
} from "@/lib/club-time";
import { formatMonthOnly, parseDateOnly } from "@/lib/date-only";

/**
 * The first day of that month, as the same date-only `Date` shape.
 *
 * `formatMonthOnly` IS THE RIGHT ENCODER HERE and must not become the
 * club-timezone one. Every value that reaches it on this path is a date-only
 * `Date` — this function's own output, or `visibleMonth`, which is built from it
 * — so UTC midnight is the encoding of the month rather than a moment in it. The
 * component's "Deliberately UTC, NOT club time" note on `visibleMonth` is the
 * other half of that reasoning. It assembled the key from UTC parts by hand until
 * #2684, which is the truncation in a fourth spelling and invisible to a census
 * looking for the ISO ones.
 *
 * IT IS CALLED DIRECTLY, not through a local `monthKey` alias. That alias existed
 * here for one commit and `date-only-encoding-guard.test.ts` refused it the moment
 * the extraction EXPORTED it: a one-line exported rename of a canonical encoder is
 * how roughly eighteen Xero document dates once hid from every date audit. It was
 * invisible while it was module-private, which is worth knowing — the ban only
 * fires on the exported shape.
 */
export function getMonthStart(date: Date): Date {
  return parseDateOnly(`${formatMonthOnly(date)}-01`);
}

/**
 * Every `yyyy-MM` key a selected lodge-night range touches — calendar-day
 * arithmetic, with no `Date` constructed (CT-4, #2870; see
 * `docs/CLUB_TIME_KERNEL.md`).
 *
 * THE MALFORMED-BOUND ANSWER CHANGED, AND THE OLD ONE WAS UNREACHABLE. The
 * spelling this replaces read `Number.isNaN(start.getTime())` — but it could never
 * evaluate that test, because reaching it went through `formatMonthOnly`, which is
 * `date.toISOString().slice(0, 10)`, and `new Date(NaN).toISOString()` throws
 * `RangeError: Invalid time value` first. So the old behaviour for a malformed
 * bound was a THROW out of a `useMemo`, and the guard beside it was dead code that
 * read as the answer. `parseCalendarDate` returning `null` gives the empty list
 * that guard was written to give. Both are academic from the one production call
 * site, which is fed by the panel above from values it has already validated —
 * which is why nobody ever saw the throw.
 *
 * THE INVERTED-RANGE TEST COMPARES MONTH STARTS, not the raw bounds, which is what
 * the old code did by flooring before comparing. A range running backwards inside
 * one month still yields that month's key, and changing that would silently stop
 * loading a month.
 *
 * Plain `<`/`<=` on these values IS chronological order — the property the
 * four-digit-year `CalendarDate` brand exists to guarantee.
 */
export function monthKeysForDateRange(
  startDate: string,
  endDate: string,
): string[] {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (start === null || end === null) return [];

  const last = startOfCalendarMonth(end);
  let cursor = startOfCalendarMonth(start);
  if (last < cursor) return [];

  const keys: string[] = [];
  while (cursor <= last) {
    keys.push(calendarMonthOf(cursor));
    cursor = addCalendarMonths(cursor, 1);
  }
  return keys;
}

/**
 * How long the month is, and how far into a Monday-first week its first day sits.
 *
 * BOTH HALVES ARE CALENDAR-DAY FACTS and the kernel answers them exactly, with
 * no `Date` built. The spelling this replaces made two UTC instants — one of them
 * the `day: 0` trick for "the last day of the previous month" — and read fields
 * back off them. Correct, but it is the shape from which somebody eventually
 * writes `new Date(year, monthIndex, 1).getDay()`: host-local midnight, whose
 * weekday is the PREVIOUS day's for any host far enough west, shifting the whole
 * grid by a column, invisible on a New Zealand machine and on CI.
 *
 * `monthIndex` is 0-based because `visibleMonth.getUTCMonth()` hands it that way;
 * the kernel counts months 1-12, hence the `+ 1` on both calls.
 */
export function getMonthGrid(
  year: number,
  monthIndex: number,
): { daysInMonth: number; startOffset: number } {
  const daysInMonth = daysInCalendarMonth(year, monthIndex + 1);
  const day = calendarDayOfWeek(calendarDateFromParts(year, monthIndex + 1, 1));
  const startOffset = day === 0 ? 6 : day - 1;
  return { daysInMonth, startOffset };
}
