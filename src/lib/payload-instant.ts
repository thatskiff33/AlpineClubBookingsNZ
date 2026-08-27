/**
 * Reading a real INSTANT back out of a JSON payload (CT-4, #2870; #3123;
 * epic #2988).
 *
 * ## The sibling of the calendar-day decoders, and the distinction is the point
 *
 * A calendar-day decoder handles a `@db.Date` column — a lodge night, a date of
 * birth, a season edge — and takes NO ZONE, because a calendar day has none.
 * This decodes the other kind: a `createdAt`, a `paidAt`, an audit stamp, a
 * consent response. Those are moments, and a moment has no civil date until a
 * zone is chosen. That zone is the club's persisted one (`INV-CONFIG-002`),
 * which a browser receives as data through `ClubTimeProvider` — never the
 * viewer's clock and never `APP_TIME_ZONE`.
 *
 * Confusing the two is the defect this epic exists to close, and no runtime type
 * can tell them apart: both arrive as the same ISO string. So the choice of
 * function IS the classification, and a call site that picks the wrong one is
 * visible in its import line rather than buried in a formatter.
 *
 * ## Why it lives in `src/lib` rather than under `src/app/(admin)/admin/_lib`
 *
 * It began there, beside `calendar-day.ts`, because every caller was an admin
 * route. #3123 gave it callers in `src/components/admin/**` as well — the
 * environment-safety screens — and pulling an admin-route-scoped `_lib` into a
 * shared component tree is the wrong direction. So the decoders live here, on
 * the isomorphic side, and `app/(admin)/admin/_lib/payload-instant.ts`
 * re-exports them for the seven admin call sites that already name that path.
 *
 * THIS MODULE MUST STAY CLIENT-SAFE. Every caller is inside a `"use client"`
 * tree or renders into one. No `server-only`, no Prisma, no `process.env` read
 * of the zone: the binding arrives as an argument, from `useClubTime()` in the
 * browser or `clubTime()` on the server.
 *
 * ## Why these degrade instead of throwing
 *
 * Every caller renders inside a table row or an inline sentence in a
 * `"use client"` tree, where a throw reaches the nearest error boundary and
 * blanks the whole screen. This also preserves the behaviour of
 * `formatMemberDateNz`, the member-detail helper these call sites moved off —
 * #2264 gave it an em-dash fallback precisely because it is fed straight from
 * API payloads and from `joinedDate || createdAt` fallbacks.
 *
 * `requireInstant` remains the right choice where the value is a required
 * server field with no sensible fallback in scope; `member-table.tsx` uses it
 * for exactly that.
 */

import type { BoundClubTime } from "@/lib/club-time";
import { parseInstant } from "@/lib/club-time";

/**
 * A payload instant in the house medium shape — "16 Apr 2026" — read in the
 * club's persisted zone.
 *
 * `fallback` is what the screen shows for a value it cannot read; the default
 * em-dash suits a table cell and matches the helper this replaces.
 */
export function formatPayloadInstantDate(
  clubTime: BoundClubTime,
  value: string | Date | null | undefined,
  fallback = "—",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  const instant = parseInstant(value);
  return instant === null ? fallback : clubTime.instantDate(instant);
}

/**
 * A payload instant in the house date-and-time shape — "16 Apr 2026, 11:30 am" —
 * read in the club's persisted zone, falling back to the RAW STRING when it will
 * not parse.
 *
 * THE RAW FALLBACK IS THE POINT, and it is why this is a separate function from
 * {@link formatPayloadInstantDate} rather than that one with a different shape.
 * A screen that renders `Invalid Date` for a value it did not expect has told
 * the reader nothing, while the raw string at least says what arrived — and on
 * `/admin/environment`, where an operator is diagnosing an installation that is
 * already behaving oddly, that is the difference between a usable screen and a
 * dead end. This carries the contract `formatNZInstantOrRaw` held before #3123
 * moved these call sites onto the club's persisted zone; the only thing that
 * changed is which zone decides the day.
 *
 * ONE DELIBERATE TIGHTENING over that helper, stated because it moves the
 * fallback boundary rather than the happy path. `formatNZInstantOrRaw` parsed
 * with a bare `new Date(iso)`, which accepts an ISO string carrying NO offset —
 * a wall-clock reading in whichever zone happens to read it, which is precisely
 * what this epic exists to stop being an answer. `parseInstant` refuses one, so
 * such a value now renders raw instead of being projected through a zone it
 * never named. Every value on these screens is a Prisma `toISOString()`, so the
 * happy path is unchanged.
 */
export function formatPayloadInstantDateTimeOrRaw(
  clubTime: BoundClubTime,
  value: string,
): string {
  const instant = parseInstant(value);
  return instant === null ? value : clubTime.instantDateTime(instant);
}
