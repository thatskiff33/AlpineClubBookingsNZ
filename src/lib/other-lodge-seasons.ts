/**
 * The rules for an Other lodge's winter and summer seasons (#75, owner
 * decisions 16 Oct 2026), as this site checks them before a save. A COPY of
 * the Alpine Central Server's `seasonDatesProblem` (AlpineClubServerNZ
 * `src/lib/lodge-seasons.ts`, another repository), which applies the same rule
 * to an upload and skips a lodge that breaks it: change the two together.
 *
 *  - Seasons recur every year: only the month and day count, and a season may
 *    cross New Year. The end date is the season's last day.
 *  - A season with a start but no end runs up to the other season's start.
 *  - The two seasons may not share a day, and a start and end must differ.
 *
 * No `server-only` import: the Other lodges form checks the dates as well.
 */

interface SeasonDates {
  winterSeasonStart?: string | null;
  winterSeasonEnd?: string | null;
  summerSeasonStart?: string | null;
  summerSeasonEnd?: string | null;
}

/** `MM-DD` of a `YYYY-MM-DD` date: seasons recur, so the year is ignored. */
function monthDay(date: string): string {
  return date.slice(5);
}

interface Range {
  start: string;
  end: string;
  /** True for an explicit end date (its last day); false for the fallback. */
  inclusive: boolean;
}

function rangeOf(start?: string | null, end?: string | null, otherStart?: string | null): Range | null {
  if (!start) return null;
  if (end) return { start: monthDay(start), end: monthDay(end), inclusive: true };
  if (otherStart) return { start: monthDay(start), end: monthDay(otherStart), inclusive: false };
  return null;
}

function inRange(day: string, range: Range): boolean {
  const { start, end, inclusive } = range;
  if (start === end) return inclusive ? day === start : false;
  const afterStart = day >= start;
  const beforeEnd = inclusive ? day <= end : day < end;
  // A range whose end comes before its start (in the year) crosses New Year.
  return start < end ? afterStart && beforeEnd : afterStart || beforeEnd;
}

function ranges(dates: SeasonDates): { winter: Range | null; summer: Range | null } {
  return {
    winter: rangeOf(dates.winterSeasonStart, dates.winterSeasonEnd, dates.summerSeasonStart),
    summer: rangeOf(dates.summerSeasonStart, dates.summerSeasonEnd, dates.winterSeasonStart),
  };
}

/** Every `MM-DD` of a leap year, 29 February included. */
const DAYS_OF_YEAR: string[] = (() => {
  const days: string[] = [];
  for (let d = new Date(Date.UTC(2024, 0, 1)); d.getUTCFullYear() === 2024; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(5, 10));
  }
  return days;
})();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function spoken(day: string): string {
  const [month, date] = day.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1]}`;
}

/**
 * Why these season dates cannot be saved, in words an administrator can act
 * on, or null when they are fine. Checks the seasons as they will be used,
 * the fallback for a missing end included.
 */
/**
 * Why these season dates cannot be saved, in words an administrator can act
 * on, or null when they are fine. Checks the seasons as they will be used,
 * the fallback for a missing end included.
 */
export function seasonDatesProblem(dates: SeasonDates): string | null {
  for (const [label, start, end] of [
    ["winter", dates.winterSeasonStart, dates.winterSeasonEnd],
    ["summer", dates.summerSeasonStart, dates.summerSeasonEnd],
  ] as const) {
    if (end && !start) return `The ${label} season has an end date but no start date.`;
    if (start && end && monthDay(start) === monthDay(end)) {
      return `The ${label} season's start and end dates must be different days.`;
    }
  }
  const { winter, summer } = ranges(dates);
  if (!winter || !summer) return null;
  const shared = DAYS_OF_YEAR.find((day) => inRange(day, winter) && inRange(day, summer));
  return shared
    ? `The winter and summer seasons overlap: both include ${spoken(shared)}. Change the dates so each day is in one season at most.`
    : null;
}
