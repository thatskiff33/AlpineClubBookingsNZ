/**
 * The date-of-birth bound an age-tier candidate query filters on.
 *
 * One pure derivation, lifted out of `cron-age-up.ts` so that the reasoning
 * below sits on the value it governs rather than in the middle of a cron that
 * also sends email, mints tokens and rewrites members. The reasoning IS the
 * deliverable here: two separate off-by-ones (#2859, #2872) have already been
 * shipped on this one bound, and each time the wrong version looked like the
 * simpler one.
 */

import { dateOnlyFromParts } from "./date-only";

/**
 * The EXCLUSIVE upper bound on `Member.dateOfBirth` for a member who has reached
 * `minAge` by `seasonStart`, as a `@db.Date` calendar-day encoding.
 *
 * IT DELIBERATELY OVER-ADMITS, and everything below is why.
 *
 * #2859: this comparison is instant-against-instant, and the two sides are
 * encoded differently. `cutoffDate` derives from `getSeasonStartDate`, which is
 * `new Date(year, month, 1)` — LOCAL midnight, so `(D-1)T11:00Z` or
 * `(D-1)T12:00Z` under the `TZ=Pacific/Auckland` pin. A stored date of birth is
 * a date-only value at UTC MIDNIGHT (INV-DATE-024). A member born on exactly the
 * season-start anniversary therefore sits a few hours AFTER the cutoff instant
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
 * The calendar parts are read with the host-local getters, and the reason is
 * narrower than "everything here is host-local". It is a ROUND TRIP:
 * `getSeasonStartDate` builds `new Date(year, month, 1)` — host-local midnight —
 * and reading `.getFullYear()/.getMonth()/.getDate()` back off that same value
 * recovers exactly the parts it was constructed from, in every host zone.
 * `dateOnlyFromParts` then re-encodes those parts as UTC midnight, so the value
 * handed to Prisma names ONE calendar day and names the SAME day wherever the
 * process runs. The instant it replaces did not: `cutoffDate` itself is a
 * different moment in every zone, and once the column became `@db.Date` that
 * moment was narrowed to whichever UTC day it happened to fall on.
 *
 * Do NOT read this as "so every side of the comparison agrees". It does not:
 * `computeAge` reads a UTC-midnight date of birth with host-LOCAL getters, so
 * west of UTC it sees the previous day. That is a separate matter and this
 * prefilter is not where it would be fixed — the query only PROPOSES, and
 * `computeAgeTierWithSettings` at the call site is the authority. What this
 * bound has to be is wide enough never to drop a candidate, and
 * host-zone-independent so it is the same width everywhere.
 *
 * It is also behaviour-identical against the OLD column type — a stored date of
 * birth is UTC midnight, so `< 2008-04-02T00:00:00Z` admits all of 1 April 2008
 * either way — which is what makes it safe to land beside the migration rather
 * than after it.
 *
 * @param seasonStart the first day of the season year, as `getSeasonStartDate`
 *   builds it: a HOST-LOCAL midnight, which is what makes the round trip above
 *   valid.
 * @param minAge the configured minimum age of the tier being selected for.
 */
export function dateOfBirthPrefilterBoundForMinAge(
  seasonStart: Date,
  minAge: number,
): Date {
  const cutoffDate = new Date(seasonStart);
  cutoffDate.setFullYear(cutoffDate.getFullYear() - minAge);

  return dateOnlyFromParts(
    cutoffDate.getFullYear(),
    cutoffDate.getMonth(),
    cutoffDate.getDate() + 1,
  );
}
