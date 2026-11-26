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
 * ## How the year-end reaches a screen (#5259)
 *
 * The year-end month is resolved on the server - override, else Xero, else
 * March - by `refreshFinancialYearConfig()`, which reads Prisma. `INV-OPS-013`
 * keeps that off the client graph and prescribes the remedy: resolve on the
 * server, pass the RESULT. So the admin layout awaits
 * `clubFinancialYearEndMonth()` and hands the number to `ClubSeasonProvider`,
 * exactly as the zone reaches `ClubTimeProvider`; a client screen calls
 * `useClubSeason()`, and a server page calls {@link bindClubSeason} itself.
 *
 * **The label and the season year move together, and must.** Before #5259 a
 * `"use client"` screen read `financial-year.ts`'s process cache, which is never
 * seeded in a browser, so both read March. Giving only the label the true
 * year-end would have named `(Jul-Jun)` over a picker still selecting April-based
 * season years - on 15 June 2026 a June club's current season is 2025, and the
 * picker would have centred on 2026. {@link bindClubSeason} returns both from one
 * year-end so they cannot disagree.
 *
 * **Every helper below REQUIRES the year-end.** `seasonMonthsLabel` and
 * `seasonYearsLabel` lost their process-cache default in #3133;
 * `seasonSelectLabel` lost its own in #5259, once every display site had a
 * value to pass. An unstated year-end is a compile error rather than a silent
 * March, which also makes the SSR pass moot: a value passed in cannot differ
 * between the react-server and SSR module instances of a cache.
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
 * Every helper below USED TO default `yearEndMonth` to
 * `getFinancialYearEndMonth()`, the `financial-year.ts` process cache; none
 * does now (#3133, #5259, above). That default is right for a request
 * path and WRONG for a background one: the cache is seeded only by
 * `refreshFinancialYearConfig()`, and no outbox path calls it. Adopting the
 * shared derivation at those four sites while taking the default would have
 * reworded every existing club's invoice lines AND still rendered the
 * two-calendar-year name for the December-year-end club the change was for.
 *
 * So each of the four resolves the year-end and passes it explicitly, and
 * `buildComponentLineDescription` makes it a REQUIRED parameter - an unstated
 * year-end is a compile error rather than a silently wrong invoice line. On a
 * cron, an outbox worker or any other path that does not seed the cache,
 * resolve the year-end there rather than reading `getFinancialYearEndMonth()`.
 */
import {
  calendarDateFromParts,
  formatClubShortMonth,
  type ClubClock,
  type ClubDateFormat,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  clubSeasonYear,
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
 * The names come from the kernel's pinned formatter, so they follow the club's
 * locale (#3566) and read no timezone at all: a calendar day has none (`INV-DATE-019`).
 *
 * BOTH BOUNDS ARE THE FIRST OF THE MONTH IN ONE FIXED YEAR, and neither of those
 * choices is free. The fixed year is what stops the two names depending on which
 * season is being labelled. The day of month is NOT arbitrary "because only the
 * month is rendered" - that holds for a Gregorian locale and the club's locale
 * is a setting: under `fa-IR` the Persian calendar renders `2001-03-01` as
 * Esfand and `2001-03-21` as Farvardin, two different months, and an Islamic
 * calendar shifts with the year as well. So under a non-Gregorian locale this
 * names the month CONTAINING each Gregorian season boundary, which is the only
 * answer available: the boundary itself is defined as a Gregorian month number.
 */
export function seasonMonthsLabel(
  yearEndMonth: number,
  format: ClubDateFormat,
): string {
  const endMonth = normalizeYearEndMonth(yearEndMonth);
  const startMonth = seasonStartMonthOf(endMonth);
  const start = calendarDateFromParts(MONTH_NAME_ANCHOR_YEAR, startMonth, 1);
  const end = calendarDateFromParts(MONTH_NAME_ANCHOR_YEAR, endMonth, 1);
  return `${formatClubShortMonth(start, format)}-${formatClubShortMonth(end, format)}`;
}

/**
 * The calendar years a season spans - `"2026 - 2027"`, or `"2026"` when the
 * club's year-end is December and the season is one calendar year.
 */
export function seasonYearsLabel(
  seasonYear: number,
  yearEndMonth: number,
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
  format: ClubDateFormat,
  yearEndMonth: number,
): string {
  return `${seasonYearsLabel(seasonYear, yearEndMonth)} (${seasonMonthsLabel(yearEndMonth, format)})`;
}

/**
 * The club's seasons with its year-end, zone and date format already supplied:
 * the season year it is NOW and the name of any season, from ONE year-end.
 */
export interface BoundClubSeason {
  readonly yearEndMonth: number;
  /** The club's current season year, from the club's today in its own zone. */
  currentSeasonYear(): number;
  /** `"2026 - 2027 (Apr-Mar)"`, `"2025 - 2026 (Jul-Jun)"`, `"2026 (Jan-Dec)"`. */
  selectLabel(seasonYear: number): string;
}

/**
 * Bind a server-resolved year-end to the club's time. A client gets this from
 * `useClubSeason()`; a server page passes `await clubFinancialYearEndMonth()`
 * and `await clubTime()`. `clock` is for a caller that holds time still.
 */
export function bindClubSeason(
  yearEndMonth: number,
  clubTime: { readonly zone: ClubTimeZone; readonly format: ClubDateFormat },
  clock?: ClubClock,
): BoundClubSeason {
  const month = normalizeYearEndMonth(yearEndMonth);
  return {
    yearEndMonth: month,
    currentSeasonYear: () => clubSeasonYear(clubTime.zone, clock, month),
    selectLabel: (seasonYear) =>
      seasonSelectLabel(seasonYear, clubTime.format, month),
  };
}
