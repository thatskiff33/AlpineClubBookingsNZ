import { z } from "zod";

/**
 * Integer cents, non-negative — `INV-MONEY-001`, and the same rule the
 * `ManualRefundTask_amount_nonnegative` CHECK enforces in the database.
 *
 * `INV-SSOT`: the one shared spelling of the rule for request bodies, stored
 * evidence and the writers that refuse a value before storing it. A stored
 * `BookingGuestNight.priceCents` is a bare `Int` with no non-negative
 * constraint, so "is this stored value usable as money at all" is asked by the
 * readers that price from it as well as by the writers; those two disagreeing
 * is the difference between refusing a value and storing it.
 *
 * Its own client-safe module since #4344. It was born in
 * `edit-financial-review-context.ts` (#3030), and by the time the officer review
 * was retired the card-refund routes, the completion door and the stored-price
 * readers all depended on it, so it moved out before that module goes.
 *
 * The pre-existing inline `.number().int().nonnegative()` sites are
 * deliberately NOT refactored onto this; doing that half-way would leave the
 * rule looking centralised when it is not.
 */
export const nonNegativeCentsSchema = z.number().int().nonnegative();

/**
 * The same rule as a predicate, for the server callers that validate a number
 * they already hold and throw their own domain error. Derived FROM the schema
 * rather than re-implemented beside it, so there is one definition and not two
 * that agree today.
 */
export function isNonNegativeIntegerCents(value: unknown): value is number {
  return nonNegativeCentsSchema.safeParse(value).success;
}
