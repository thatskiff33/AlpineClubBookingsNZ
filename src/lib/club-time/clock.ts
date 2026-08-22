/**
 * The clock seam (CT-2, #2990).
 *
 * THE ONLY ARGUMENT-LESS `new Date()` IN THE KERNEL lives here, and
 * `club-time-kernel-census.test.ts` asserts that. It is not primarily a test
 * device — every unit test in this repository already runs with "today" frozen
 * at `2026-07-01T00:00:00.000Z` by `vitest.clock-setup.ts`. It exists so that
 * "no business-day decision reads the host clock directly" is a property a
 * census can check, rather than a habit that erodes one call site at a time.
 *
 * The frozen instant is midday in New Zealand, chosen so UTC and NZ agree on the
 * date. It does NOT make a club behind UTC agree: measured under the frozen
 * clock, `clubToday` is 2026-07-01 for Pacific/Auckland, Pacific/Chatham and
 * UTC, and **2026-06-30** for America/Denver and America/Los_Angeles. A contract
 * test for a behind-UTC club expects the earlier day, which is what stops the
 * whole "the club's day is not the UTC day" assertion from being tautological.
 */

import { clubCalendarDateOf } from "./instant";
import type { CalendarDate, ClubClock, ClubTimeZone, Instant } from "./types";

/** Reads the host clock. The one place in `src/lib/club-time/**` that may. */
export const systemClubClock: ClubClock = {
  nowInstant(): Instant {
    return new Date();
  },
};

/** A clock frozen at one moment — for a caller that must hold time still. */
export function fixedClubClock(instant: Instant): ClubClock {
  const frozen = instant.getTime();
  return {
    nowInstant(): Instant {
      return new Date(frozen);
    },
  };
}

/**
 * The club's calendar day, right now.
 *
 * `INV-DATE-019`: ask the club's calendar for "today", never the UTC clock. For
 * a club at UTC+12/+13 the UTC day is YESTERDAY for roughly the first half of
 * every club day, which is how fifteen "today" call sites went wrong in #2682.
 */
export function clubToday(
  zone: ClubTimeZone,
  clock: ClubClock = systemClubClock,
): CalendarDate {
  return clubCalendarDateOf(clock.nowInstant(), zone);
}
