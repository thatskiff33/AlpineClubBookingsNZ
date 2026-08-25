import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

const NZ_TIME_ZONE = APP_TIME_ZONE;

const NZ_DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
});

const NZ_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

// #2264 — four further shapes, added because the repo kept hand-rolling them.
// Before this, `nzst-date` offered only the two `dateStyle` shapes above, so
// every screen that legitimately wanted a bare time, a month heading, a
// weekday-bearing date or the long spelled-out date had to call
// `toLocaleTimeString`/`toLocaleDateString` itself — and a hand-rolled call is
// exactly where the club's time zone gets forgotten. Three such sites were
// rendering in the VIEWER's zone (the lobby clock, the events-calendar time,
// and the lodge-display date line), so an operator or a TV browser outside New
// Zealand showed the wrong time.
//
// Each helper below pins BOTH the locale and the zone, so a caller cannot
// reintroduce that bug. A screen whose format is none of these six keeps its
// own module-level `Intl.DateTimeFormat` constant pinned the same way — that,
// not an eslint-disable, is the escape hatch (see `eslint.config.mjs`).

// The long, spelled-out month form. Owner decision (#2264, 2 Aug 2026): the
// member-facing surfaces that used to render this — the booking messages and
// emails a member receives, the lodge/hut-leader "last updated" stamps, and the
// generated report cover — keep reading "16 April 2026", NOT the "16 Apr 2026"
// house medium. Admin and internal surfaces stay on `formatNZDate`.
const NZ_LONG_DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "long",
});

const NZ_TIME_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  timeStyle: "short",
});

const NZ_MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  month: "long",
  year: "numeric",
});

const NZ_WEEKDAY_DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatNZDate(date: Date): string {
  return NZ_DATE_FORMATTER.format(date);
}

export function formatNZDateTime(date: Date): string {
  return NZ_DATE_TIME_FORMATTER.format(date);
}

/**
 * An ISO instant from a JSON payload, in club time, falling back to the raw
 * string when it will not parse.
 *
 * The fallback is the point: a screen that renders `Invalid Date` for a value it
 * did not expect has told the reader nothing, while the raw string at least says
 * what arrived. Client components on the environment-safety screens share this
 * rather than each carrying their own three-line copy.
 *
 * IT IS `formatNZDateTime`, which is the same formatter `/admin/audit-log` uses
 * for the very same class of timestamp — the audit row an override save writes.
 * One admin screen quietly spelling an instant in a different zone from the
 * screen beside it is worse than both sitting on one shared formatter, and
 * pinning locale and zone together is what `INV-DATE-015` and the ESLint date
 * guard require of any formatter on this surface.
 */
export function formatNZInstantOrRaw(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : formatNZDateTime(parsed);
}

/**
 * Long, spelled-out date in club time — "16 April 2026". Reserved for the
 * member-facing surfaces the owner asked to keep it on (#2264): booking
 * messages and the emails built from them, the lodge/hut-leader instruction
 * "last updated" stamps, and the generated report cover. Everything admin-side
 * or internal uses `formatNZDate`.
 */
export function formatNZLongDate(date: Date): string {
  return NZ_LONG_DATE_FORMATTER.format(date);
}

/** Time of day only, in club time — "11:30 am". No date, no seconds. */
export function formatNZTime(date: Date): string {
  return NZ_TIME_FORMATTER.format(date);
}

/** Month heading in club time — "April 2026". */
export function formatNZMonthYear(date: Date): string {
  return NZ_MONTH_YEAR_FORMATTER.format(date);
}

/**
 * Weekday-bearing date in club time — "Thu, 16 Apr 2026". For lists where the
 * day of the week is the thing being scanned (arrivals, stays, rosters).
 */
export function formatNZWeekdayDate(date: Date): string {
  return NZ_WEEKDAY_DATE_FORMATTER.format(date);
}

// The NZST "today"/"tomorrow" helpers were removed (issue #1878): they built
// `new Date(`${y}-${m}-${d}T00:00:00`)` — no timezone suffix, so the string
// parsed in the server's LOCAL zone and, under the production
// TZ=Pacific/Auckland pin, serialized as the previous UTC day in every Prisma
// @db.Date comparison. Cron jobs that need the NZ calendar date must use
// getTodayDateOnly()/addDaysDateOnly() from "@/lib/date-only", which pin the
// NZ calendar date to UTC midnight.
