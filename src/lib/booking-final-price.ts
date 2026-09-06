/**
 * #3260 (`INV-SSOT-001`): the ONE home for a booking's final-price relation.
 *
 * A booking's final price is its total plus its signed promotional adjustment.
 * That sentence was written out inline at twelve places when #3260 measured it,
 * nine of which write the result to a booking row. Nobody was harmed by that,
 * because the twelve agreed - the issue is what happens when they stop. The
 * promotional-adjustment column REPLACED an older discount column and a
 * migration had to backfill every pre-existing booking so the two shapes would
 * compute alike; if the relation moves again - a second adjustment, a rounding
 * rule, a cap - it has to be found in twelve places and it will be changed in
 * ten. A booking whose stored final price disagrees with its own total is the
 * fault that shows up in reporting and reconciliation long after the change
 * that caused it.
 *
 * ## WHAT THIS FUNCTION IS NOT
 *
 * It is the ARITHMETIC, and deliberately not the decision about whether to apply
 * it. Four sites in the tree are ternaries whose PARKED branch writes the
 * booking's STORED final price back rather than recomputing it, each carrying a
 * comment saying why deriving there would be wrong: `priceDiffCents` is the
 * number every settlement decision reads, and on a parked edit it must be zero
 * because the booking did not move, not because two expressions happened to
 * cancel. Those sites call this function on their COMPUTED branch only.
 * Forcing one shared writer across all of them would be the contortion
 * `INV-SSOT-001` warns against, and it would quietly delete that distinction.
 *
 * `booking-final-price-one-home.test.ts` is the census that refuses a
 * thirteenth inline spelling, and it pins the parked branches by name.
 *
 * ## The named argument is the guard
 *
 * Both operands are integer cents of the same type, so a positional pair could
 * be swapped without the compiler noticing - and the relation is not symmetric
 * in meaning even though addition is: swapping them writes a total into the
 * final-price column on every call site that destructures the result. A named
 * object makes that unrepresentable rather than policed, which is the rule
 * `INV-SSOT-001` states about preferring the former.
 */

/**
 * A booking's final price: what it costs, after its promotion.
 *
 * `promoAdjustmentCents` is SIGNED - negative for a discount, positive for a
 * surcharge - which is why this is an addition rather than a subtraction, and
 * why nothing here clamps it. Whether the adjustment is capped so the result
 * cannot go below zero is the PROMOTION's business and is decided where the
 * promotion is recomputed (`recalculateBookingPromo`), not here: a clamp in this
 * function would silently disagree with the `PromoRedemption` row that produced
 * the figure, and the disagreement would be invisible.
 */
export function bookingFinalPriceCents({
  totalPriceCents,
  promoAdjustmentCents,
}: {
  totalPriceCents: number;
  promoAdjustmentCents: number;
}): number {
  return totalPriceCents + promoAdjustmentCents;
}
