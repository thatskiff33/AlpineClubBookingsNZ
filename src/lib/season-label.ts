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
 * ## The rest of the tree still writes this label by hand SEVEN times
 *
 * It was nineteen when this module was written. #3103 adopted five of them (four
 * files - the MEMBER profile page inlines it twice), #3116 adopted the four
 * money and provider sites below, and a further three went with the surfaces
 * those changes touched.
 *
 * **Measured on this branch**, excluding tests and this file:
 * `/[Ss]easonYear \+ 1/` matches **12** lines, of which **FIVE are date
 * ARITHMETIC rather than a label** - a season's end bound in
 * `membership-subscription-billing.ts`, two in `xero-membership-sync.ts` (one
 * inside a Xero query string), and two building a picker's year window.
 * Rewriting one of those does not change a label, it changes a date. So 12 minus
 * 5 leaves the **seven** remaining names, in `admin/reports`, `bookings`,
 * `bookings/[id]/confirm-draft`, `member/subscription-status`,
 * `group-booking.ts`, `membership-type-policy.ts` and
 * `subscription-lockout-enforcement.ts`.
 *
 * **NO SINGLE GREP RETURNS EXACTLY THAT SET**, which is why the count is stated
 * with its method rather than on its own. The obvious lower-case
 * `/seasonYear \+ 1/` misses every site spelling it `currentSeasonYear + 1`, and
 * a raw-text scan additionally matches this very paragraph. Read each call site
 * rather than trusting any number here, and see
 * `__tests__/season-label-adoption-contract.test.ts`, which discriminates a NAME
 * from ARITHMETIC with a self-checked pattern over comment-stripped source.
 *
 * **THE FOUR MONEY AND PROVIDER SITES ADOPTED THIS IN #3116, AND THE EXCLUSION
 * LIST IS NOW EMPTY.** They were `xero-subscription-invoices.ts` and
 * `membership-subscription-billing.ts` (Xero **invoice line descriptions**),
 * `membership-cancellation-xero.ts` (a **credit-note** description) and
 * `xero-record-activity.ts` (a `server-only` activity label).
 *
 * They were held back on a frozen-string contract: a single-component fee
 * reproduces an exact invoice line, so a backfilled legacy charge re-driven
 * through the outbox was said to mint byte-identical text. **The mechanism was
 * misattributed.** `MembershipSubscriptionChargeComponent.description` is a
 * persisted column - the planner writes it, the mint reads it back - so an
 * existing charge is stable because the text was STORED, not because the
 * deriving code still produces it. And no matcher reads the text at all:
 * reconciliation finds the invoice by its immutable `Reference`, and the
 * snapshot comparison is handed amount, account code and item code only.
 *
 * ## The real hazard was the DEFAULT, not the sharing
 *
 * Every helper below defaults `yearEndMonth` to `getFinancialYearEndMonth()`,
 * the `financial-year.ts` process cache. That default is right for a request
 * path and WRONG for a background one: the cache is seeded only by
 * `refreshFinancialYearConfig()`, and no outbox path calls it. Adopting the
 * shared derivation at those four sites while taking the default would have
 * reworded every existing club's invoice lines AND still rendered the
 * two-calendar-year name for the December-year-end club the change was for.
 *
 * So each of the four resolves the year-end and passes it explicitly, and
 * `buildComponentLineDescription` makes it a REQUIRED parameter - an unstated
 * year-end is a compile error rather than a silently wrong invoice line. **If
 * you are adopting these helpers on a cron, an outbox worker or any other path
 * that does not seed the cache, pass the year-end.** The default will not tell
 * you it guessed.
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
