import { assignedMembersOnlyOwnNights } from "@/lib/promo-guest-scope";

// Which guests a promotion covers on an EXISTING booking, read off the stored
// redemption.
//
// This is the persisted counterpart to `promo-guest-scope.ts`. That module
// answers who a promotion would reach while a booking is being priced, from the
// candidate guest list. This one answers the narrower question every REPRICE
// asks: where the booker was made to pick guests, which guests did they pick —
// as recorded in `PromoRedemption.guestTargets` — and where do those guests sit
// in the guest list being repriced now.
//
// One home, per `INV-SSOT-001`. Until #3131 these three functions and the type
// existed FIVE times over, with nothing connecting them:
//
//   src/app/api/bookings/[id]/guests/route.ts
//   src/app/api/bookings/[id]/modify-quote/route.ts       (two of the three)
//   src/lib/booking-date-modification-service.ts
//   src/lib/booking-guest-removal-service.ts
//   src/lib/booking-modify-plan.ts                        <- already diverged
//
// Four were byte-identical; `booking-modify-plan.ts` had already drifted in
// shape, taking `PromoCode & { assignments }` where the others took the
// structural type below. A fix applied to one copy and not the rest would have
// priced the same booking differently depending on whether the member changed
// dates, removed a guest, or asked for a quote.
//
// Every function here is synchronous and side-effect free — no database, no
// clock, no zone.

/**
 * The part of a loaded `PromoRedemption` these functions read. Structural on
 * purpose: `booking-modify-validation.ts`'s `LoadedPromoRedemption` (Prisma
 * `PromoRedemption & { promoCode: PromoCode & … }`) satisfies it, and so do the
 * narrower selects the routes and services load, so all five call sites pass
 * their own shape without a cast.
 */
export type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

/**
 * Whether the booker was asked to pick specific guests for this promotion, so
 * the redemption's stored `guestTargets` rows are the record of who it covers.
 *
 * True only for an ASSIGNED code (at least one assignment) that is NOT scoped to
 * the assigned members' own nights.
 *
 * **`null` and `undefined` mean the same as `true`.** The column is
 * `assignedMembersOnlyOwnNights Boolean @default(true)` in `schema.prisma`, so
 * own-night scoping is the default and an absent value must not read as "off".
 * The read routes through `promo-guest-scope.ts`'s `assignedMembersOnlyOwnNights`
 * — the one definition of that field's meaning — rather than restating
 * `=== false` a sixth time; the two are equivalent over all four values, and
 * `promo-stored-guest-targets.test.ts` pins the whole truth table so unifying
 * the five copies could not shift behaviour unnoticed. Four of those copies
 * typed the field `boolean | null | undefined` while `booking-modify-plan.ts`
 * passed the non-nullable Prisma column, which is why the table is pinned rather
 * than assumed.
 *
 * Deliberately NOT `assignmentRequiresGuestSelection` from
 * `promo-guest-scope.ts`, which asks a different question and gives a different
 * answer: that one returns false for a fixed-nightly GROUP code, where the
 * booker never picks guests. This one returns true for such a code, and
 * `selectedIndexesForStoredGuestTargets` then falls to its empty-targets branch
 * — every guest — which is the group behaviour. Same field read, different
 * question, so they are two derivations of one fact and not two definitions of
 * it.
 */
export function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    !assignedMembersOnlyOwnNights(redemption.promoCode)
  );
}

/**
 * The positional indexes, over the guest list being repriced, that this
 * promotion covers — or `undefined` when the promotion is not guest-scoped at
 * all and every eligible guest is in scope by default.
 *
 * When the promotion IS guest-scoped but no targets are stored, every guest is
 * selected. That branch is load-bearing: a redemption written before targets
 * were recorded, and any assignment mode where the booker was never asked to
 * pick, both arrive here, and narrowing them to nobody would silently drop the
 * discount.
 *
 * A stored target whose `bookingGuestId` is no longer on the repriced list is
 * dropped rather than refused, and a guest row with no `bookingGuestId` (a
 * to-be-added guest) never matches one.
 */
export function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

/**
 * The `bookingGuestId`s behind a set of selected indexes, for persisting back as
 * the redemption's guest targets. `undefined` in, `undefined` out — that carries
 * "this promotion is not guest-scoped" through to `redeemPromoCode`, which
 * writes no target rows for it. An index pointing at a guest with no id yet is
 * dropped.
 */
export function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}
