/**
 * How a membership season is NAMED, derived from the club's own year-end.
 *
 * The subscriptions page's season picker read `{y} - {y + 1} (Apr-Mar)`, with
 * both halves written out as literal text. CT-4 group F1 (#2870) moved the
 * season YEAR on that page onto the shared derivation and left this label
 * behind, recording why in a comment there: rendering a month name needs an
 * explicitly pinned formatter (`INV-DATE-015`), so it was more than a string
 * edit. This is that edit.
 *
 * ## What was actually wrong with `(Apr-Mar)`
 *
 * April is not the rule. It is the shipped DEFAULT of a configurable value:
 * `seasonStartMonthOf` returns the month after the club's financial year-end,
 * so a club with a June year-end runs July to June and a club with a December
 * year-end runs January to December. A literal `Apr-Mar` is the same class of
 * copy F1 found in the season-year helper - a copy of the default rather than of
 * the rule - and it goes stale silently, because nothing compares a string to a
 * setting.
 *
 * **The years half was wrong too, and less obviously.** `{y} - {y + 1}` assumes
 * a season straddles two calendar years. It does for eleven of the twelve
 * possible year-ends; for a December year-end the season starts in January and
 * ends in December of the SAME year, and `seasonYearOfCalendarDate` agrees -
 * with a start month of 1 its `month >= startMonth` test is always true, so the
 * season year IS the calendar year. Naming that season "2026 - 2027" would
 * contradict the derivation it is labelling, so the single-year case is spelled
 * differently rather than papered over.
 *
 * ## THIS MOVES NO PIXEL ON ANY DEPLOYMENT TODAY, AND THAT IS NOT AN OVERSIGHT
 *
 * Be plain about it: a non-March club still sees `2026 - 2027 (Apr-Mar)` on that
 * screen, wrong on BOTH halves, exactly as before. What changed is true of the
 * code and not yet of the screen.
 *
 * The year-end month lives in `financial-year.ts`'s module cache, seeded by
 * `refreshFinancialYearConfig()`, whose only non-test caller reads Prisma and is
 * therefore server-side - so a `"use client"` page importing the rule reads
 * `DEFAULT_FINANCIAL_YEAR_END_MONTH`. `INV-OPS-013` is what keeps Prisma off the
 * client graph, but it is NOT the obstacle and reading it as one gets this
 * backwards: it PRESCRIBES the remedy, which is to do the work in a server
 * component or route and pass the RESULT to the client component.
 *
 * **The reason the value is not plumbed in this change is that plumbing it to
 * the label ALONE would make the screen worse.** `subscriptions/page.tsx`
 * derives the season year it is selecting with `clubSeasonYear(clubTime.zone)`,
 * which reads the same unseeded cache. Give the label the true year-end and
 * leave that call alone and the picker names `(Jul-Jun)` while still selecting
 * April-based season years: on 15 June 2026 a June-year-end club's current
 * season is 2025, yet the picker would centre on 2026 and label it Jul-Jun. The
 * label and the value would disagree, which is worse than both being uniformly
 * stale. Deferring the two together is coherent; finishing half is not.
 *
 * What this buys is that **the RULE is shared**, so when the year-end does reach
 * the client - through `ClubTimeSettings` and the provider, as the zone already
 * does - the label follows it instead of quietly contradicting it. Every helper
 * below takes the year-end as an optional argument for exactly that: a caller
 * that already HOLDS the value passes it, with no process-global write.
 *
 * ## A stated limit: the SSR pass is reasoned, not measured
 *
 * A `"use client"` module is still server-rendered on the first request, in a
 * process where the cache genuinely IS seeded - so "byte-identical on the
 * client" needs the SSR pass to agree, or hydration would mismatch. The reading
 * is that Next compiles the react-server and SSR layers separately, giving two
 * module instances of `financial-year.ts` of which only the react-server one is
 * seeded, so the SSR pass renders the default too. **Nothing in this repository
 * documents or tests that property**, and nothing here asserts it. The optional
 * argument is what makes it permanently moot rather than merely likely: a
 * plumbed value is passed in, and a passed value cannot differ between two
 * module instances of a cache.
 *
 * ## The rest of the tree writes this label by hand NINETEEN times
 *
 * Measured on this branch: **19 non-test sites** render a season as
 * `${seasonYear}/${seasonYear + 1}`, each carrying the same two-calendar-year
 * assumption. #3103 holds the list and the owner's decision, which covers four
 * of them - the admin member card, the admin membership-types page, the MEMBER
 * profile page (which inlines it TWICE, and is not an admin surface) and the
 * member data-export route.
 *
 * **AND NO GREP RETURNS EXACTLY THOSE NINETEEN.** Measured on this branch,
 * excluding tests and this file: `/[Ss]easonYear \+ 1/` matches 24 lines, and
 * FIVE of them are date ARITHMETIC rather than a label - a season's end bound in
 * `membership-subscription-billing.ts`, two in `xero-membership-sync.ts` (one
 * inside a Xero query string), and two building a picker's year window.
 * Rewriting one of those does not change a label, it changes a date. Meanwhile
 * the obvious lower-case `/seasonYear \+ 1/` matches only 18 lines and misses
 * FOUR of the nineteen outright, because they spell it `currentSeasonYear + 1`.
 * So 24 minus 5 is the nineteen, and the short grep silently finds fifteen of
 * them. Read each call site rather than trusting either number.
 *
 * **FOUR OF THE NINETEEN ARE ON MONEY AND PROVIDER PATHS AND ARE OUT OF SCOPE.**
 * Do not sweep them in, and do not reach them by grepping the template:
 *
 * - `xero-subscription-invoices.ts` and `membership-subscription-billing.ts` -
 *   Xero **invoice line descriptions**;
 * - `membership-cancellation-xero.ts` - a **credit-note** description;
 * - `xero-record-activity.ts` - `server-only`, so the cache IS seeded wherever
 *   it runs.
 *
 * `buildComponentLineDescription` in `membership-subscription-billing.ts` states
 * a frozen-string contract in its own comment: a single-component fee
 * reproduces that EXACT text, so a backfilled legacy charge re-driven through
 * the outbox mints a byte-identical invoice line. Unify it and a re-driven
 * charge stops doing that, and reconciliation sees a mismatch nothing explains.
 *
 * **That leaves a real unresolved tension rather than a tidy exclusion.** Those
 * four run on the server, where the year-end IS available - so for a
 * December-year-end club they already render `2026/2027` for a season entirely
 * inside 2026. This module is what establishes that such a season is ONE
 * calendar year, which makes the frozen-string contract and the correct label
 * directly incompatible: byte-identity requires keeping a label this module says
 * is wrong. Nothing here resolves that and nothing should - it needs its own
 * decision if a club with a non-March financial year ever adopts this product.
 */
import { calendarDateFromParts, formatClubShortMonth } from "@/lib/club-time";
import {
  getFinancialYearEndMonth,
  normalizeYearEndMonth,
  seasonStartMonthOf,
} from "@/lib/financial-year";

/**
 * The year the month names are rendered from. Any year with those months in it
 * would do for a Gregorian locale, and the year itself is never rendered - but
 * see {@link seasonMonthsLabel} on why the anchor is fixed rather than taken
 * from the season being labelled.
 */
const MONTH_NAME_ANCHOR_YEAR = 2001;

/**
 * The months a membership season runs between - `"Apr-Mar"` for a March
 * year-end, `"Jan-Dec"` for a December one.
 *
 * The names come from the kernel's pinned formatter, so they follow `APP_LOCALE`
 * and read no timezone at all: a calendar day has none (`INV-DATE-019`).
 *
 * BOTH BOUNDS ARE THE FIRST OF THE MONTH IN ONE FIXED YEAR, and neither of those
 * choices is free. The fixed year is what stops the two names depending on which
 * season is being labelled. The day of month is NOT arbitrary "because only the
 * month is rendered" - that holds for a Gregorian locale and `APP_LOCALE` is
 * env-configurable: under `fa-IR` the Persian calendar renders `2001-03-01` as
 * Esfand and `2001-03-21` as Farvardin, two different months, and an Islamic
 * calendar shifts with the year as well. So under a non-Gregorian locale this
 * names the month CONTAINING each Gregorian season boundary, which is the only
 * answer available: the boundary itself is defined as a Gregorian month number.
 */
export function seasonMonthsLabel(
  yearEndMonth: number = getFinancialYearEndMonth(),
): string {
  const endMonth = normalizeYearEndMonth(yearEndMonth);
  const startMonth = seasonStartMonthOf(endMonth);
  const start = calendarDateFromParts(MONTH_NAME_ANCHOR_YEAR, startMonth, 1);
  const end = calendarDateFromParts(MONTH_NAME_ANCHOR_YEAR, endMonth, 1);
  return `${formatClubShortMonth(start)}-${formatClubShortMonth(end)}`;
}

/**
 * The calendar years a season spans - `"2026 - 2027"`, or `"2026"` when the
 * club's year-end is December and the season is one calendar year.
 */
export function seasonYearsLabel(
  seasonYear: number,
  yearEndMonth: number = getFinancialYearEndMonth(),
): string {
  return seasonStartMonthOf(yearEndMonth) === 1
    ? String(seasonYear)
    : `${seasonYear} - ${seasonYear + 1}`;
}

/**
 * The full picker label: `"2026 - 2027 (Apr-Mar)"`.
 *
 * Both halves derive from the same year-end, so they cannot disagree with each
 * other or with `seasonYearOfCalendarDate`.
 */
export function seasonSelectLabel(
  seasonYear: number,
  yearEndMonth: number = getFinancialYearEndMonth(),
): string {
  return `${seasonYearsLabel(seasonYear, yearEndMonth)} (${seasonMonthsLabel(yearEndMonth)})`;
}
