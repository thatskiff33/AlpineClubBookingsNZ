/**
 * The date-of-birth bound an age-tier candidate query filters on.
 *
 * One pure derivation, lifted out of `cron-age-up.ts` so that the reasoning
 * below sits on the value it governs rather than in the middle of a cron that
 * also sends email, mints tokens and rewrites members. The reasoning IS the
 * deliverable here: three separate off-by-ones (#2859, #2872, #3082) have
 * already been shipped on this one bound, and each time the wrong version looked
 * like the simpler one.
 */

import {
  addCalendarDays,
  addCalendarMonths,
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";

/**
 * The EXCLUSIVE upper bound on `Member.dateOfBirth` for a member who has reached
 * `minAge` by `seasonStart`, as a `@db.Date` calendar-day encoding.
 *
 * IT DELIBERATELY OVER-ADMITS, and everything below is why.
 *
 * #2859: this comparison used to be instant-against-instant with the two sides
 * encoded differently. `cutoffDate` derived from `getSeasonStartDate`, which was
 * `new Date(year, month, 1)` — LOCAL midnight, so `(D-1)T11:00Z` or
 * `(D-1)T12:00Z` under the `TZ=Pacific/Auckland` pin. A stored date of birth is
 * a date-only value at UTC MIDNIGHT (INV-DATE-024). A member born on exactly the
 * season-start anniversary therefore sat a few hours AFTER the cutoff instant
 * and was filtered out here, one season late for their own age-up — the same
 * off-by-one INV-DATE-013 names, on the one boundary where it decides a tier.
 *
 * This is not a defect #2859 introduced, and it is not rare: it was already
 * reachable for EVERY correctly stored date of birth, which on the live site is
 * 365 of the 375 members who hold one. (An earlier census reported the reverse —
 * 364 wrong, 10 right — from a query that applied `AT TIME ZONE` to this naive
 * column and read it back through the session zone; it is retracted. The ten
 * rows #2859's migration repairs are re-encoded into this same correct shape, so
 * they join the exposure rather than create it.)
 *
 * So the prefilter is widened to the END of the cutoff calendar day. Widening is
 * the safe direction: the query this bound feeds only proposes candidates, and
 * `computeAgeTierWithSettings` at the call site is the authority that promotes
 * or skips each one.
 *
 * #2872 (CT-3): THE BOUND IS THE CALENDAR DAY, NOT LOCAL MIDNIGHT ON IT.
 * `Member.dateOfBirth` is now `DateTime @db.Date`, and `@prisma/adapter-pg`
 * narrows a bound `Date` for such a column to its UTC calendar date and throws
 * the time away (`formatDate` in `mapArg`; pinned by
 * `prisma-date-column-binding.test.ts`). A local-midnight instant east of UTC is
 * 11:00 or 12:00 on the PREVIOUS UTC day, so binding one here would narrow to
 * the day BEFORE and drop the member born on exactly the season-start
 * anniversary — reopening the #2859 off-by-one the widening above exists to
 * close, on the one boundary that decides a tier and therefore a price.
 *
 * #3082: THE INPUT IS A CALENDAR DAY, WHICH IS WHY THERE IS NO ROUND TRIP LEFT
 * TO PROTECT. This function used to take a HOST-LOCAL midnight `Date` and read
 * its parts back with `.getFullYear()/.getMonth()/.getDate()`, and the docblock
 * defended those host-local getters as a deliberate round trip:
 * `getSeasonStartDate` built `new Date(year, month, 1)` with the matching local
 * setters, so the getters recovered exactly the parts it was constructed from in
 * every host zone. That was TRUE — swept over 418 zones, 2015-2036 and all
 * twelve possible season-start months, it never once failed — and it was still
 * the wrong thing to depend on, because it made the correctness of this bound a
 * property of its CALLER's encoding rather than of its own argument. The moment
 * `computeAge` had to be moved off host-local getters (its date-of-birth side
 * was reading a UTC-midnight value a day early for any host behind Greenwich),
 * `getSeasonStartDate` had to move with it, and the round trip's premise
 * evaporated. Taking a {@link CalendarDate} removes the reading instead of
 * re-deriving it: text carries no zone, so there is nothing for a host to move
 * and no pairing with a particular constructor to preserve.
 *
 * `dateOnlyInstantOf` then encodes the answer as UTC midnight, so the value
 * handed to Prisma names ONE calendar day and names the SAME day wherever the
 * process runs.
 *
 * The bound is still only a PREFILTER. `computeAgeTierWithSettings` at the call
 * site remains the authority on who is promoted, and #3082 corrected that
 * authority as well — the two now read the same frame, so a candidate this bound
 * admits is judged against the same calendar day the bound was derived from.
 * What this bound has to be is wide enough never to drop a candidate, and
 * host-zone-independent so it is the same width everywhere.
 *
 * It is also behaviour-identical against the OLD column type — a stored date of
 * birth is UTC midnight, so `< 2008-04-02T00:00:00Z` admits all of 1 April 2008
 * either way — which is what makes it safe to land beside the migration rather
 * than after it.
 *
 * @param seasonStart the first day of the season year, as
 *   `getSeasonStartCalendarDate` builds it: a club calendar day, with no zone
 *   and no instant to read it in.
 * @param minAge the configured minimum age of the tier being selected for.
 */
export function dateOfBirthPrefilterBoundForMinAge(
  seasonStart: CalendarDate,
  minAge: number,
): Date {
  // Whole years back, spelled as months so the step is the kernel's clamping
  // one: a season start is always day 1 of a month, so the clamp is unreachable
  // from `getSeasonStartCalendarDate` — but a 29 February argument must land on
  // 28 February rather than throw or roll into March.
  const cutoffDay = addCalendarMonths(seasonStart, -12 * minAge);

  return dateOnlyInstantOf(addCalendarDays(cutoffDay, 1));
}
