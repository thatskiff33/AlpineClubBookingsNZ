/**
 * Reading a real INSTANT back out of an admin API payload (CT-4, #2870;
 * epic #2988).
 *
 * ## The sibling of `calendar-day.ts`, and the distinction is the whole point
 *
 * `calendar-day.ts` next door decodes a `@db.Date` column — a lodge night, a
 * date of birth, a season edge — and takes NO ZONE, because a calendar day has
 * none. This decodes the other kind: a `createdAt`, a `paidAt`, an audit stamp,
 * a consent response. Those are moments, and a moment has no civil date until a
 * zone is chosen. That zone is the club's persisted one (`INV-CONFIG-002`),
 * which a browser receives as data through `ClubTimeProvider` — never the
 * viewer's clock and never `APP_TIME_ZONE`.
 *
 * Confusing the two is the defect this epic exists to close, and no runtime type
 * can tell them apart: both arrive as the same ISO string. So the choice of
 * module IS the classification, and a call site that picks the wrong one is
 * visible in its import line rather than buried in a formatter.
 *
 * ## Why it degrades instead of throwing
 *
 * The same reason `calendar-day.ts` returns `null`: every caller renders inside
 * a table row or an inline sentence in a `"use client"` tree, where a throw
 * reaches the nearest error boundary and blanks the whole screen. This also
 * preserves the behaviour of `formatMemberDateNz`, the member-detail helper
 * these call sites are moving off — #2264 gave it an em-dash fallback precisely
 * because it is fed straight from API payloads and from `joinedDate ||
 * createdAt` fallbacks.
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
