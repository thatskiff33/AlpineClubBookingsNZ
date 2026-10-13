import "server-only";
import { getLodgeCapacity, getMonthAvailability } from "@/lib/capacity";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";

/** The longest stay the central server may ask about, and how far ahead it may start. */
export const CENTRAL_AVAILABILITY_MAX_NIGHTS = 30;
export const CENTRAL_AVAILABILITY_MAX_DAYS_AHEAD = 730;

/**
 * Free beds for a stay, as the Alpine Central Server's public lodge search is
 * told it (#62, owner decision D2): THE MEMBER CALENDAR'S OWN NUMBER, night by
 * night, and the smallest of them — the most guests the whole stay can take.
 *
 * Built on `getMonthAvailability`, the calendar's function, for each month the
 * stay touches, rather than on a new call into the occupancy calculation. So it
 * inherits every occupancy term (INV-CAP: booked guest nights, custodian holds,
 * held policy-exception reservations) and the calendar's presentation of a
 * whole-lodge-held night AS FULL (ADR-001 decision 6): a hold cannot be told
 * apart from a full lodge here any more than on the calendar. No lock is taken
 * and nothing is written, exactly like the calendar, which "has never held a
 * lock" — this is a read, not a claim.
 *
 * Never below 0: `occupied` can exceed capacity (an admin over-allocation), and
 * a negative bed count would read as nonsense on a public page.
 */
export async function freeBedsForStay(
  lodgeId: string,
  /** First night, inclusive, a UTC date-only value. */
  from: Date,
  /** Check-out day, exclusive, a UTC date-only value. */
  toExclusive: Date,
): Promise<number> {
  const nights = eachDateOnlyInRange(from, toExclusive);
  const capacity = await getLodgeCapacity(lodgeId);

  // The (year, month) of every month the stay touches: at most two for the
  // route's 30-night cap, three at most for any stay under a month and a bit.
  const months = new Map<string, { year: number; month: number }>();
  for (const night of nights) {
    const year = night.getUTCFullYear();
    const month = night.getUTCMonth();
    months.set(`${year}-${month}`, { year, month });
  }
  const occupied = new Map<string, number>();
  for (const { year, month } of months.values()) {
    for (const [night, beds] of await getMonthAvailability(lodgeId, year, month)) {
      occupied.set(night, beds);
    }
  }

  let free = capacity;
  for (const night of nights) {
    free = Math.min(free, capacity - (occupied.get(formatDateOnly(night)) ?? 0));
  }
  return Math.max(0, free);
}
