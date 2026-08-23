/**
 * A calendar day, as a `Date` whose HOST-LOCAL clock face reads that day
 * (CT-4, #2870; epic #2988).
 *
 * ## Why this exists rather than a kernel formatter
 *
 * The reports screen and its charts render their axis and range labels through
 * date-fns `format` with fixed English patterns — `"MMM d"`, `"EEE, MMM d yyyy"`,
 * `"d MMM"`. Two of those are not house shapes, and `APP_LOCALE` is
 * configurable, so swapping them for `formatClubDate` would change what a
 * non-`en-NZ` deployment renders. Rule 3 of #2870 says intentional display
 * shapes stay visually unchanged, so the patterns stay and only the value
 * handed to them changes.
 *
 * ## Why HOST-LOCAL is the correct encoding here, and not a mistake
 *
 * date-fns `format` reads its argument with host-local getters — `getMonth()`,
 * `getDate()`. So the `Date` it is handed must carry the day on its host-local
 * clock face, or the label is off by one. Pairing the kernel's UTC-midnight
 * encoding with a host-local reader is the actual defect in that combination,
 * and it is the one this repository keeps re-finding from the other direction.
 *
 * The old spelling was `new Date(value + "T00:00:00")` — a hand-rolled
 * local-midnight rule (#2870 rule 6) with two further problems: it validated
 * nothing, so a malformed `from` in the URL produced an `Invalid Date` and
 * date-fns then threw a `RangeError` that blanked the whole reports page; and
 * on the 19 zones where local midnight does not exist it relied on `Date`
 * silently rolling forward. Parsing through `parseCalendarDate` and building
 * from parts is explicit about both.
 *
 * NO ZONE IS INVOLVED and none should be: a calendar date has none. 16 April
 * 2026 is 16 April 2026 for a viewer in London and one at the lodge.
 */

import { calendarDateParts, parseCalendarDate } from "@/lib/club-time";

/**
 * `null` for anything that is not a `yyyy-MM-dd` calendar day, so the caller
 * decides what an unusable range bound should render as. It must never throw:
 * these values arrive from the URL and from chart payloads.
 */
export function calendarDayAsLocalDate(value: string): Date | null {
  const day = parseCalendarDate(value);
  if (day === null) return null;
  const { year, month, day: dayOfMonth } = calendarDateParts(day);
  // Building a Date FROM parts is the safe direction; it is reading a date key
  // back OUT of clock-face parts that `INV-DATE-019` bans.
  return new Date(year, month - 1, dayOfMonth);
}
