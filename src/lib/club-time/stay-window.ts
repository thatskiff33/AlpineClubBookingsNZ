/**
 * The noon-to-noon stay window (CT-2, #2990; epic #2988 decision 4).
 *
 * ## What this is, and what it must never be used for
 *
 * `checkIn` and `checkOut` are DATE-ONLY IDENTITIES and stay that way. Capacity,
 * occupancy and presence remain the half-open lodge-night range
 * `[checkIn, checkOut)` expanded to nights — `INV-DATE-002`, `INV-DATE-003`,
 * `INV-DATE-020` — and nothing here changes, replaces or is substituted for any
 * of that. The "stay window is not an occupancy decision" case in
 * `__tests__/club-time-kernel-census.test.ts` is what keeps it so.
 *
 * What this adds is the epic's "if an actual arrival or departure INSTANT is
 * needed, derive 12:00 club-local on each endpoint using named-zone/DST rules".
 * Nothing in the repository derived one before — `roster-editor.tsx` says
 * outright that "the midday boundary is definitional" and is never displayed —
 * so this is new capability, not a migration, and a caller that reaches for it
 * to decide who is in a bed is reaching for the wrong function.
 *
 * ## Why `nights` cannot come from the elapsed time
 *
 * Measured for `Pacific/Auckland` in 2026:
 *
 * | window                  |  elapsed | nights |
 * | ----------------------- | -------: | -----: |
 * | 2026-07-01 -> 2026-07-02 |     24 h |      1 |
 * | 2026-04-04 -> 2026-04-05 | **25 h** |      1 |
 * | 2026-09-26 -> 2026-09-27 | **23 h** |      1 |
 * | 2026-04-03 -> 2026-04-06 | **73 h** |      3 |
 *
 * `elapsed / 24h` gives 1.04, 0.96 and 3.04 for the last three. Rounded, two of
 * them are still right, which is exactly what makes the mistake survivable long
 * enough to reach production — so `nights` comes from `countClubNights`, integer
 * calendar arithmetic with no clock in it at all.
 */

import { countClubNights } from "./calendar-date";
import { noonOfClubDay } from "./boundaries";
import type { CalendarDate, ClubTimeZone, StayWindow } from "./types";

/**
 * A stay's two date-only identities, the two midday-club-time instants they
 * imply, and its calendar night count.
 *
 * A zero-night or inverted range is refused: `INV-DATE-008` says a zero-night
 * booking expands to no nights and every route refuses it, so producing a window
 * for one would be inventing a stay that cannot exist.
 */
export function stayWindow(
  checkIn: CalendarDate,
  checkOut: CalendarDate,
  zone: ClubTimeZone,
): StayWindow {
  const nights = countClubNights(checkIn, checkOut);
  if (nights <= 0) {
    throw new Error(
      `A stay must cover at least one lodge night: ${checkIn} to ${checkOut} covers ${nights}.`,
    );
  }
  return {
    checkIn,
    checkOut,
    arrival: noonOfClubDay(checkIn, zone),
    departure: noonOfClubDay(checkOut, zone),
    nights,
  };
}
