/**
 * Reading a CALENDAR DATE back out of an admin API payload (CT-4, #2870;
 * epic #2988).
 *
 * ## What this is for
 *
 * A `@db.Date` column — a lodge night, a season edge, a date of birth, a
 * membership start — holds a calendar day, not a moment. It reaches the browser
 * as one of two spellings, and which one depends on how the route happened to
 * build its response:
 *
 * - `"2026-04-01T00:00:00.000Z"` — Prisma's `Date`, serialised by
 *   `NextResponse.json`. The day is encoded as UTC midnight.
 * - `"2026-04-01"` — a bare day, from a route that encoded it itself or from a
 *   payload validated by a `yyyy-MM-dd` schema (a membership application's
 *   family-member date of birth is one).
 *
 * Both name the same civil day, so both decode to the same `CalendarDate` and a
 * caller should not have to know which it is holding. Getting that wrong is not
 * a cosmetic error: reading the UTC-midnight encoding through a timezone is
 * `INV-DATE-019`, and for a club behind UTC it names the day before —
 * a birthday, or the first night of a stay.
 *
 * ## Why it returns `null` instead of throwing
 *
 * These values arrive over `fetch` with no runtime schema check, and every
 * caller renders inside a list or a table. A throw in that position reaches the
 * nearest error boundary and replaces the whole screen, so one odd row would
 * blank an entire members list. Each caller has something honest to show
 * instead — the raw text, or an em-dash — so the decision belongs to them.
 *
 * ## Why it lives here and not in `src/lib`
 *
 * It should live in `src/lib/club-time`, next to the primitives it composes,
 * and group C of this issue asked for exactly that (`calendarDateOfSerialisedDbDate`)
 * after writing the same composition inline in nine files. `src/lib` is a
 * different lane's surface on this epic, so this is one admin-scoped module
 * rather than another dozen inline copies — and one call site for CT-6 to hoist
 * rather than a dozen.
 *
 * NO TIMEZONE IS INVOLVED anywhere below, and none should be.
 *
 * ## Its two siblings, and what tells them apart
 *
 * `admin/_lib/payload-instant.ts` is the OTHER half of this pair: it decodes a
 * real instant, and it takes the club's bound zone because an instant has no
 * civil date without one. Choosing between the two modules IS the
 * classification of the value, which is why they are separate files.
 *
 * `admin/reports/_components/host-local-day.ts` decodes the same calendar day
 * to the OPPOSITE encoding — a `Date` whose host-local clock face reads that
 * day — because date-fns `format` reads with host-local getters. It was also
 * called `calendar-day.ts` until the CT-4 review noted that nothing but the
 * import path told them apart. Do not swap one for the other: pairing this
 * module's UTC-encoded value with a host-local reader is a day out for every
 * club behind UTC.
 */

import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseCalendarDate,
  parseInstant,
  type CalendarDate,
} from "@/lib/club-time";

/**
 * The calendar day a payload field names, or `null` when it names none.
 *
 * The bare spelling is tried first because it is unambiguous and cheap; the
 * instant branch then decodes the UTC-midnight encoding in UTC, which is the
 * identity for every club rather than a projection.
 */
export function calendarDayFromPayload(
  value: string | null | undefined,
): CalendarDate | null {
  if (value === null || value === undefined || value === "") return null;
  const bare = parseCalendarDate(value);
  if (bare !== null) return bare;
  const instant = parseInstant(value);
  return instant === null ? null : calendarDateOfDateOnlyInstant(instant);
}

/**
 * {@link calendarDayFromPayload} rendered in the house medium shape —
 * "16 Apr 2026" — with no zone, because a calendar date has none.
 *
 * `fallback` is what the screen shows for a value it cannot read. Callers that
 * would rather show the raw text pass it; the default em-dash suits a table
 * cell.
 */
export function formatPayloadCalendarDay(
  value: string | null | undefined,
  fallback = "—",
): string {
  const day = calendarDayFromPayload(value);
  return day === null ? fallback : formatClubDate(day);
}
