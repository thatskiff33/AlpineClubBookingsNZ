/**
 * How a membership season is NAMED, derived from the club's own year-end.
 *
 * The subscriptions page's season picker read `{y} - {y + 1} (Apr-Mar)`, with
 * both halves written out as literal text. CT-4 group F1 (#2870) moved the
 * season YEAR onto the shared derivation and left this label behind, recording
 * why in a comment on that page: rendering a month name needs an explicitly
 * pinned formatter (`INV-DATE-015`), so it was more than a string edit. This is
 * that edit.
 *
 * ## What was actually wrong with `(Apr-Mar)`
 *
 * April is not the rule. It is the shipped DEFAULT of a configurable value:
 * `getSeasonStartMonth()` is the month after the club's financial year-end, so a
 * club with a June year-end runs July to June and a club with a December
 * year-end runs January to December. A literal `Apr-Mar` is the same class of
 * copy F1 found in the season-year helper — a copy of the default rather than of
 * the rule — and it goes stale silently, because nothing compares a string to a
 * setting.
 *
 * **The years half was wrong too, and less obviously.** `{y} - {y + 1}` assumes
 * a season straddles two calendar years. It does for eleven of the twelve
 * possible year-ends; for a December year-end the season starts in January and
 * ends in December of the SAME year, and `seasonYearOfCalendarDate` agrees —
 * with a start month of 1 its `month >= startMonth` test is always true, so the
 * season year IS the calendar year. Naming that season "2026 - 2027" would
 * contradict the derivation it is labelling, so the single-year case is spelled
 * differently rather than papered over.
 *
 * ## What this does NOT fix, stated because a reader will ask
 *
 * On the client the year-end month is always the March default. The module cache
 * in `financial-year.ts` is seeded by `refreshFinancialYearConfig()`, whose only
 * callers are server-side (it reads Prisma, and `INV-OPS-013` keeps that off the
 * client graph), so a `"use client"` page importing the rule gets
 * `DEFAULT_FINANCIAL_YEAR_END_MONTH`. Every deployment therefore still renders
 * `2026 - 2027 (Apr-Mar)`, byte for byte, and this change moves no pixel today.
 *
 * That is the same bargain F1 struck for the season year on the same page, and
 * for the same reason: **the rule becomes shared even where the value has not
 * arrived yet, so the divergence cannot reappear.** Plumbing the year-end month
 * to the client — through `ClubTimeSettings` and the provider, as the zone
 * already is — is a separate change with its own surface, and until it happens
 * this helper answers correctly wherever the cache IS seeded, which is every
 * server caller.
 *
 * Three other admin surfaces keep their own local `formatSeasonLabel` producing
 * `${y}/${y + 1}`, each with the same two-calendar-year assumption. They are not
 * changed here — a different label shape on three unrelated pages is its own
 * decision — and they are reported on #2870 rather than left as a comment.
 */
import {
  calendarDateFromParts,
  formatClubShortMonth,
} from "@/lib/club-time";
import {
  getFinancialYearEndMonth,
  getSeasonStartMonth,
} from "@/lib/financial-year";

/**
 * The months a membership season runs between — `"Apr-Mar"` for a March
 * year-end, `"Jan-Dec"` for a December one.
 *
 * The month names come from the kernel's pinned formatter, so they follow
 * `APP_LOCALE` and read no timezone at all: a calendar day has none
 * (`INV-DATE-019`), and the day of month is arbitrary because only the month is
 * rendered.
 */
export function seasonMonthsLabel(): string {
  const startMonth = getSeasonStartMonth();
  const endMonth = getFinancialYearEndMonth();
  // Any year with those months in it; the year is not rendered. 2001 is used
  // rather than the caller's season year so that the two names cannot depend on
  // which season is being labelled.
  const start = calendarDateFromParts(2001, startMonth, 1);
  const end = calendarDateFromParts(2001, endMonth, 1);
  return `${formatClubShortMonth(start)}-${formatClubShortMonth(end)}`;
}

/**
 * The calendar years a season spans — `"2026 - 2027"`, or `"2026"` when the
 * club's year-end is December and the season is one calendar year.
 */
export function seasonYearsLabel(seasonYear: number): string {
  return getSeasonStartMonth() === 1
    ? String(seasonYear)
    : `${seasonYear} - ${seasonYear + 1}`;
}

/**
 * The full picker label: `"2026 - 2027 (Apr-Mar)"`.
 *
 * Both halves derive from the club's configured year-end, so they cannot
 * disagree with each other or with `seasonYearOfCalendarDate`.
 */
export function seasonSelectLabel(seasonYear: number): string {
  return `${seasonYearsLabel(seasonYear)} (${seasonMonthsLabel()})`;
}
