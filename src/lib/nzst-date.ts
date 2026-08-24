/**
 * COMPATIBILITY ADAPTER over `@/lib/club-time`. Retired by CT-6 (#2991).
 *
 * These six helpers were the club's one rendering seam (`INV-DATE-015`) and they
 * still are — but the formatting itself now lives in the kernel, and each
 * function here is one line that supplies the zone.
 *
 * ## What the delegation does and does not change
 *
 * It single-sources the FORMATTING LOGIC: there is no longer a second set of
 * frozen `Intl.DateTimeFormat` constants that could drift from the kernel's
 * shapes, and `club-time/__tests__/house-shapes.test.ts` pins the kernel's output
 * against the constants this file used to hold, written out by hand there.
 *
 * It changes **no caller's zone authority.** Every function below still passes
 * `APP_TIME_ZONE` — `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"` —
 * so after CT-2 all 132 modules importing this file read the environment exactly
 * as they did before. Moving a call site onto the persisted club timezone is
 * per-call-site work and belongs to CT-4 and CT-5.
 *
 * **No test on this deployment can tell the difference**, and that is worth
 * stating plainly rather than leaving for someone to discover: `TZ` is
 * `Pacific/Auckland` here and the persisted zone is `Pacific/Auckland`, and
 * `club-time-zone-env-agreement.test.ts` deliberately pins the two together
 * while both exist. A claim that CT-2 "moves the application onto the persisted
 * zone" would be false and green.
 *
 * ## New code does not import this file
 *
 * A server module reads the zone with `clubTime()` from `@/lib/club-time/server`
 * and formats through the binding; a client module receives the identifier as
 * data and calls `bindClubTime`. Holding a lodge night rather than a moment? It
 * is a `CalendarDate` and wants `formatClubDate`, which takes no zone at all.
 *
 * ## History kept, because it explains the shapes
 *
 * #2264 added the last four shapes because the repo kept hand-rolling them, and
 * a hand-rolled call is exactly where the club's zone gets forgotten: three
 * sites were rendering in the VIEWER's zone (the lobby clock, the events-calendar
 * time and the lodge-display date line), so an operator or a TV browser outside
 * New Zealand showed the wrong time.
 *
 * The NZST "today"/"tomorrow" helpers were removed in #1878: they built
 * `new Date(`${y}-${m}-${d}T00:00:00`)` with no timezone suffix, so the string
 * parsed in the server's LOCAL zone and, under the production
 * `TZ=Pacific/Auckland` pin, serialized as the previous UTC day in every Prisma
 * `@db.Date` comparison. Cron jobs that need the club's calendar date use
 * `getTodayDateOnly()` / `addDaysDateOnly()` from `@/lib/date-only`, or
 * `clubToday()` from the kernel.
 */

import { APP_TIME_ZONE } from "@/config/operational";
import {
  formatClubInstantDate,
  formatClubInstantDateTime,
  formatClubInstantLongDate,
  formatClubInstantMonthYear,
  formatClubInstantTime,
  formatClubInstantWeekdayDate,
  unvalidatedLegacyClubTimeZone,
} from "@/lib/club-time";

/** See `unvalidatedLegacyClubTimeZone` for why this is not validated. */
const LEGACY_CLUB_ZONE = unvalidatedLegacyClubTimeZone(APP_TIME_ZONE);

export function formatNZDate(date: Date): string {
  return formatClubInstantDate(date, LEGACY_CLUB_ZONE);
}

export function formatNZDateTime(date: Date): string {
  return formatClubInstantDateTime(date, LEGACY_CLUB_ZONE);
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
 * or internal uses `formatNZDate`. INV-DATE-016.
 */
export function formatNZLongDate(date: Date): string {
  return formatClubInstantLongDate(date, LEGACY_CLUB_ZONE);
}

/** Time of day only, in club time — "11:30 am". No date, no seconds. */
export function formatNZTime(date: Date): string {
  return formatClubInstantTime(date, LEGACY_CLUB_ZONE);
}

/** Month heading in club time — "April 2026". */
export function formatNZMonthYear(date: Date): string {
  return formatClubInstantMonthYear(date, LEGACY_CLUB_ZONE);
}

/**
 * Weekday-bearing date in club time — "Thu, 16 Apr 2026". For lists where the
 * day of the week is the thing being scanned (arrivals, stays, rosters).
 */
export function formatNZWeekdayDate(date: Date): string {
  return formatClubInstantWeekdayDate(date, LEGACY_CLUB_ZONE);
}
