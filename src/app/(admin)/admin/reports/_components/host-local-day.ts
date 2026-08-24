/**
 * A calendar day, as a `Date` whose HOST-LOCAL clock face reads that day
 * (CT-4, #2870; epic #2988).
 *
 * ## NOT `admin/_lib/calendar-day.ts`, and the file names now say so
 *
 * Two modules in this route tree decode a calendar day and they return OPPOSITE
 * encodings. `admin/_lib/calendar-day.ts` returns the kernel's `CalendarDate`,
 * which is UTC-encoded and is read back with UTC getters; this returns a plain
 * `Date` whose HOST-LOCAL clock face carries the day, because date-fns `format`
 * reads its argument with `getMonth()`/`getDate()`. Pair either one with the
 * other's reader and the label is a day out, silently, on exactly the
 * deployments this epic exists to protect.
 *
 * Both files were called `calendar-day.ts` until the CT-4 review pointed out
 * that nothing but the import path distinguished them — an autocomplete slip
 * would have compiled. This one is named for its encoding instead, which is the
 * property that actually differs.
 *
 * ## Why this exists rather than a kernel formatter
 *
 * The reports charts render their axis and tooltip labels through date-fns
 * `format` with patterns the kernel has no equivalent for — `"MMM d"`,
 * `"EEE, MMM d yyyy"`, `"MMM d, yyyy"`, and the year-less `"d MMM"` in one
 * subtitle. There is nothing to bend those onto, so the patterns stay and only
 * the value handed to them changes.
 *
 * THE RULE, corrected by the CT-4 review, because a first version of this
 * paragraph had it backwards. It argued that swapping a pattern for
 * `formatClubDate` would change what a non-`en-NZ` deployment renders — but the
 * kernel's shapes format through `APP_LOCALE`, and it is the date-fns pattern
 * string that hard-codes English month names for every deployment. So the rule
 * is: a value in a HOUSE shape goes through the kernel, which honours the
 * configured locale; a value in a shape the kernel does not have stays on
 * date-fns, and that is a locale limitation this change inherits rather than
 * creates. `reports/page.tsx` used to render its `"d MMM yyyy"` range bounds
 * here, which IS the house medium shape; they moved onto `formatClubDate`, the
 * same way `payments/page.tsx` and `subscriptions/page.tsx` treated that shape.
 * For `en-NZ` the two are byte-identical, so rule 3 of #2870 holds: nothing
 * visible changed.
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
