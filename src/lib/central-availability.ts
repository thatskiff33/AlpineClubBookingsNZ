import "server-only";
import { getLodgeCapacity, getMonthAvailability } from "@/lib/capacity";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";

/** The longest stay the central server may ask about, and how far ahead it may start. */
export const CENTRAL_AVAILABILITY_MAX_NIGHTS = 30;
export const CENTRAL_AVAILABILITY_MAX_DAYS_AHEAD = 730;

/** One night's free beds as the central server is told them (#79). */
export interface CentralNightAvailability {
  /** The night, `YYYY-MM-DD`. */
  date: string;
  freeBeds: number;
}

export interface CentralStayAvailability {
  /** The fewest free beds on any night: the most guests the whole stay can take. */
  freeBeds: number;
  /** Every night of the stay, in order (#79: the central server's bed planner). */
  nights: CentralNightAvailability[];
}

/**
 * Free beds for a stay, as the Alpine Central Server's public lodge search is
 * told them (#62, owner decision D2; night by night since #79, owner decision
 * 17 Oct 2026): THE MEMBER CALENDAR'S OWN NUMBER for each night, and the
 * smallest of them — the most guests the whole stay can take. Counts only:
 * what every member already sees on the calendar, nothing about who.
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
): Promise<CentralStayAvailability> {
  const nights = eachDateOnlyInRange(from, toExclusive);
  const capacity = await getLodgeCapacity(lodgeId);

  // The (year, month) of every month the stay touches: up to three for the
  // route's 30-night cap (31 January to 1 March in a non-leap year).
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

  const byNight = nights.map((night) => {
    const date = formatDateOnly(night);
    return { date, freeBeds: Math.max(0, capacity - (occupied.get(date) ?? 0)) };
  });
  return {
    freeBeds: byNight.reduce((fewest, n) => Math.min(fewest, n.freeBeds), Math.max(0, capacity)),
    nights: byNight,
  };
}
