/**
 * Do two stays share a night? One definition, in a module with no imports.
 *
 * It lived in `capacity.ts` (which imports Prisma at module scope) and was
 * therefore out of reach of the pure hosting modules, so #3232's
 * `dependentNeedsOwnQueueItem` hand-wrote the same two comparisons a second time
 * (`INV-SSOT-001`). That is not a cosmetic duplication: the queue item's night
 * window is what the drain turns back into bookings, so the predicate deciding
 * whether a dependent needs an item of its own MUST agree with the query that
 * found the dependent — and the SQL half of exactly this test is already
 * single-sourced as `nightOverlapClause` in
 * `adult-member-hosting-coverage-envelope.ts`. Two spellings of it in memory was
 * one drift away from the failure #3039 measured, where the refusal looks fixed
 * and the booking is dropped in the background instead.
 *
 * `capacity.ts` re-exports it so its long-standing importers and its own suite are
 * unaffected.
 */

/**
 * Two bookings overlap on at least one night when their [checkIn, checkOut)
 * half-open spans intersect. A booking departing on day D and one arriving that
 * night do NOT overlap (back-to-back handovers) — the same half-open rule the
 * hold-night span uses. Pure; admin conflict surfacing (issue #119) shares it.
 */
export function bookingsOverlap(
  a: { checkIn: Date; checkOut: Date },
  b: { checkIn: Date; checkOut: Date },
): boolean {
  return (
    a.checkIn.getTime() < b.checkOut.getTime() &&
    a.checkOut.getTime() > b.checkIn.getTime()
  );
}
