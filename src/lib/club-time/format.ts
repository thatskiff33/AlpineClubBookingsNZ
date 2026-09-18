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
 * `Intl.DateTimeFormat` constants `nzst-date` held before CT-2 (#2990) — written
 * out by hand there, first because delegation would have compared the kernel
 * with itself and now because #3123 deleted that file, so the transcription is
 * the only surviving record of what the club has always been shown — and against
 * the lodge-display constants these replace, over a 400-day sweep. The calendar-date half reaches the same strings by a different route
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
import {
  calendarDateOfDateOnlyInstant,
  calendarDateOfSerialisedDbDate,
  calendarDateOfSerialisedDbDateOrNull,
} from "./instant";
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

/**
 * "Apr 2026" — the SHORT month with the year, for a chart axis.
 *
 * Deliberately distinct from {@link formatClubMonthYear}: a trend axis fits a
 * dozen ticks side by side and the long month does not. Two call sites kept
 * their own pinned formatter with a comment saying exactly that.
 */
export function formatClubShortMonthYear(date: CalendarDate): string {
  return formatCalendarDateShape("shortMonthYear", date);
}

/**
 * "Apr" — the short month alone, with no day and no year.
 *
 * Asked of `Intl` as its own shape rather than sliced out of
 * {@link formatClubShortMonthYear}, for the reason `HOUSE_SHAPES` records: a
 * locale is free to order or punctuate a month-and-year differently, so
 * subtracting the year from a rendered pair is a guess about `APP_LOCALE` and
 * declaring the shape is not.
 *
 * The one caller is the membership-season label (`@/lib/season-label`), which
 * names the months a season runs between and derives them from the club's
 * financial year-end (`seasonStartMonthOf`) rather than from a hard-coded April.
 */
export function formatClubShortMonth(date: CalendarDate): string {
  return formatCalendarDateShape("shortMonth", date);
}

/** "Thu, 16 Apr 2026" — for lists scanned by day of the week. */
export function formatClubWeekdayDate(date: CalendarDate): string {
  return formatCalendarDateShape("weekdayDate", date);
}

/** "Thu" — the weekday alone. */
export function formatClubWeekday(date: CalendarDate): string {
  return formatCalendarDateShape("weekday", date);
}

/** "Thursday" — the weekday alone, spelled out. */
export function formatClubLongWeekday(date: CalendarDate): string {
  return formatCalendarDateShape("longWeekday", date);
}

/**
 * "16 Apr" — day and short month, no weekday and no year.
 *
 * The shape between {@link formatClubDate} ("16 Apr 2026") and a bare weekday
 * that six call sites were keeping a local formatter for: a grid column head or
 * a tight dashboard slot, where the year is already stated by the heading above.
 */
export function formatClubDayMonth(date: CalendarDate): string {
  return formatCalendarDateShape("dayMonth", date);
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

/**
 * "Thursday, 16 April 2026" — the spelled-out weekday and month WITH the year.
 *
 * The most-asked-for missing shape of this epic: four call sites kept a local
 * `Intl.DateTimeFormat` for it, each with a comment recording that the kernel
 * had `longWeekdayDayMonth` and nothing carrying the year as well. It is chosen
 * where a wrong day would be expensive to misread — a day button's screen-reader
 * label, a member's stay dates, a hut leader's roster heading — because
 * "Thursday, 16 April 2026" is harder to misread than "Thu, 16 Apr 2026".
 *
 * NOT covered by `INV-DATE-016`, which reserves the long SPELLED-OUT DATE
 * (`formatClubLongDate`, "16 April 2026") for four named member-facing surfaces.
 * That rule is about the date form; this shape leads with a weekday and answers
 * a different question.
 */
export function formatClubLongWeekdayDate(date: CalendarDate): string {
  return formatCalendarDateShape("longWeekdayDate", date);
}

// ---------------------------------------------------------------------------
// Stay dates — a stored lodge night, decoded and formatted in ONE call
// ---------------------------------------------------------------------------

/**
 * "16 Apr 2026" — a stored lodge night (`checkIn`, `checkOut`, a join deadline,
 * a booking-period edge: any `@db.Date`), whether it is still the `Date` Prisma
 * returned or the string it became crossing a JSON boundary.
 *
 * THE ONE HOME of a two-call composition that was written out about a dozen
 * times across `src/` (#3507) — `calendarDateOfSerialisedDbDate` then
 * `formatClubDate`, or the `calendarDateOfDateOnlyInstant` decoder for a value
 * still held as a `Date` — each copy carrying its own docblock of why the pair
 * must stay a pair. The reason is a defect that shipped once (CT-4, #2870;
 * `INV-DATE-010`): a `@db.Date` is encoded as UTC MIDNIGHT, so reading its day
 * THROUGH A TIMEZONE is the identity for a club east of Greenwich and THE DAY
 * BEFORE for any club west of it — a stay on the 16th renders as the 15th in
 * Vancouver. The kernel's decoders read the calendar day out of the encoding
 * instead, and `formatClubDate` takes no zone, so nothing here can move the day.
 * `__tests__/stay-date.test.ts` pins that west-of-Greenwich case.
 *
 * WHAT IT DOES NOT DO is tell you whether the value was a `@db.Date` in the
 * first place. Hand it a `createdAt` and you get that instant's UTC day, which
 * is the `INV-DATE-019` defect — use `formatClubInstantDate` with the club's
 * zone for a moment. Throws for a value that is not a calendar day at all; a
 * client render that must survive a malformed stored value takes
 * {@link formatStayDateOrNull}.
 *
 * `stay-date-format-census.test.ts` (`INV-SSOT-001`) refuses the composition
 * anywhere else in `src/`, so the next surface imports the rule rather than
 * re-spelling it.
 */
export function formatStayDate(value: string | Instant): string {
  return formatClubDate(
    typeof value === "string"
      ? calendarDateOfSerialisedDbDate(value)
      : calendarDateOfDateOnlyInstant(value),
  );
}

/**
 * {@link formatStayDate} for a SERIALISED value, answering `null` rather than
 * throwing — for a malformed value and for an absent one, so a nullable column
 * needs no guard. The caller chooses the fallback (`?? value` to show the raw
 * string, `?? "—"` for an empty cell), which is the same failure-mode line
 * {@link calendarDateOfSerialisedDbDateOrNull} draws and for the same reason: a
 * throw out of a client render blanks the whole screen.
 */
export function formatStayDateOrNull(
  value: string | null | undefined,
): string | null {
  const day = calendarDateOfSerialisedDbDateOrNull(value);
  return day === null ? null : formatClubDate(day);
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

/**
 * "16 Apr" — the club calendar day a moment falls on, without the year.
 *
 * The instant twin of {@link formatClubDayMonth}, added by #3123 for the same
 * reason the five calendar shapes were added in #2870: two call sites were
 * already building this exact `HOUSE_SHAPES.dayMonth` by hand, each with its own
 * per-zone memo map, because the kernel offered the shape for a calendar day and
 * not for an instant. The consent chip's response stamp and the consent badge's
 * "expires 7 Aug" are both real `DateTime` columns, so a zone is genuinely
 * required — and a shape available in one temporal kind and not the other is how
 * a hand-rolled formatter gets justified.
 */
export function formatClubInstantDayMonth(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("dayMonth", instant, zone);
}

/**
 * "Thu, 16 Apr" — the instant twin of {@link formatClubWeekdayDayMonth}.
 *
 * Added with {@link formatClubInstantDayMonth} (#3123) and for the same reason:
 * the member-guest consent card's lapse sentence names the weekday and day of a
 * real expiry instant, and had no kernel shape to ask for. The column it comes
 * from is deliberately not named here — a member-guest census sweeps the tree
 * for those five column names, and the temporal kernel has no business turning
 * up on it for the sake of an example.
 */
export function formatClubInstantWeekdayDayMonth(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return formatHouseShape("weekdayDayMonth", instant, zone);
}
