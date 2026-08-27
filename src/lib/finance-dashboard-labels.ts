import {
  formatClubDate,
  formatClubMonthYear,
  formatClubShortMonthYear,
  parseCalendarDate,
  requireCalendarDate,
} from "@/lib/club-time";

// The finance dashboard's display labels: formatters that take a month key or a
// calendar day and hand back a string. Split out of `finance-dashboard-ranges.ts`
// (#3123) because they share none of that file's range-resolution logic — they
// read nothing, reach no database, and consult no zone.
//
// THIS MODULE IS ON THE BROWSER GRAPH, inherited from the file it was split out
// of: `finance-dashboard-client.tsx` is `"use client"` and imports from
// `finance-dashboard-ranges.ts`, which imports this. Neither `club-time/server`
// (a bare throw in the browser) nor anything reaching Prisma may appear here.
//
// Trend-axis month label ("Jun 2026"). Deliberately the SHORT month, unlike
// `financeDashboardMonthLabel` ("June 2026") used for range headings: chart axes
// have to fit a dozen ticks side by side. That bag is the kernel's
// `shortMonthYear` shape (F3, #3079), so the local formatter this code kept is
// gone.
//
// CT-4 (#2870): THIS ALSO CORRECTS THE MONTH. A month key is a CALENDAR concept
// and takes no zone, and the local formatter was still pinned to
// `APP_TIME_ZONE` — a projection over the first-of-month's UTC-midnight encoding
// that cancelled only because New Zealand is east of Greenwich. For a club west
// of it every finance trend axis, and the sync-health freshness sentences, named
// the PREVIOUS month (INV-DATE-019).
//
// #3123 FINISHED THE JOB. The two labels CT-4 did not reach — the long month
// heading and the window-bound day — took the same correction. Nothing here
// reads a zone at all, which is what a place on the browser graph requires.

/**
 * The first day of a month key, as a date-only string ("2026-06" -> "2026-06-01").
 *
 * ONE definition, and it lives here because two of its three callers are the
 * month labels below; `finance-dashboard-ranges.ts` imports it back for a
 * window's `from` bound rather than keeping a second spelling of the same
 * concatenation. It cannot live there instead: this module must not import that
 * one, which already imports this.
 */
export function monthStartString(monthKey: string): string {
  return `${monthKey}-01`;
}

/**
 * A month key's heading ("June 2026"). A CALENDAR CONCEPT, SO IT TAKES NO ZONE.
 *
 * #3123 finishes what the header comment above records CT-4 doing to the trend
 * axis below: a `yyyy-MM` key is a month, not a moment, and
 * `formatNZMonthYear(parseDateOnly(...))` built a UTC-midnight first-of-month
 * and then projected it through `APP_TIME_ZONE`. That cancels only because New
 * Zealand is east of Greenwich; for a club west of it every finance range
 * heading named the PREVIOUS month (`INV-DATE-019`). Note this is the LONG month
 * ("June 2026"), unlike {@link financeDashboardTrendMonthLabel}'s short form,
 * which chart axes need so a dozen ticks fit side by side.
 */
export function financeDashboardMonthLabel(monthKey: string) {
  return formatClubMonthYear(requireCalendarDate(monthStartString(monthKey)));
}

/** Short month label ("Jun 2026") for trend axes. */
export function financeDashboardTrendMonthLabel(monthKey: string) {
  return formatClubShortMonthYear(requireCalendarDate(monthStartString(monthKey)));
}

/**
 * A window bound ("14 Jun 2026") from a `yyyy-MM-dd` key. NO ZONE — a window
 * bound is a calendar day, and #3123 takes it off `APP_TIME_ZONE` rather than
 * onto the club's, for the same reason {@link financeDashboardMonthLabel} above
 * does.
 *
 * IT MUST DEGRADE RATHER THAN THROW, and #2264 is why: `financeDashboardWindowDetail`
 * is exported and takes plain strings, so a malformed window has to produce a
 * readable label instead of taking the whole finance page down. `parseDateOnly`
 * answered `new Date(NaN)` for a non-`YYYY-MM-DD` string and `Intl.format`
 * throws on that, so the guard was a NaN check; `parseCalendarDate` returns
 * `null` for the same inputs and hands the decision back here. It is slightly
 * STRICTER — the old parser accepted a well-formed day that does not exist, such
 * as `2026-02-30`, and this one refuses it — which lands on the same side of the
 * contract: the raw string, not a rolled-forward date and not a throw.
 */
export function financeDashboardDayLabel(dateOnly: string) {
  const day = parseCalendarDate(dateOnly);
  return day === null ? dateOnly : formatClubDate(day);
}

export function financeDashboardWindowDetail(
  window: {
    from: string | null;
    to: string | null;
  } | null
) {
  if (!window || !window.from || !window.to) {
    return window ? "Unavailable" : "None";
  }
  return `${financeDashboardDayLabel(window.from)} to ${financeDashboardDayLabel(window.to)}`;
}
