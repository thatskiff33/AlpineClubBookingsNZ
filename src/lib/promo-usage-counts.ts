import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// How much of a promotion has already been used, and what counts as a use.
//
// Split out of `promo.ts` unchanged (#3128). It holds the benefit test in both
// of its forms — the TypeScript predicate and the Prisma filter expressing the
// same rule over stored rows — and the BENEFIT-FILTERED queries that count
// prior use against it: uses per member, distinct benefiting members, and
// lifetime free nights (`INV-MONEY-005`).
//
// NOT every cap denominator lives here, and reading this module as though they
// all do is the mistake to avoid. Two deliberately stayed in `promo.ts`:
//
//   - `excludedBookingRedemptionCount` — the rows the booking being repriced
//     already holds (`INV-MONEY-025`). It is an UNFILTERED `count()`, because
//     `currentRedemptions` is a raw row count and its delta must be raw too
//     (`INV-MONEY-005` corollary (a)). Putting a raw counter beside these
//     benefit-filtered ones is how somebody eventually filters it, and
//     `INV-MONEY-025` names that cost exactly: a booking holding a code's last
//     slot fails its OWN reprice, silently drops the discount, and bills the
//     member the discount back for a date change.
//   - the per-member allocation read inside
//     `getAssignedPromoCodeSummariesForMember`, which drives the member-facing
//     "already used" status as well as a count, so it belongs with the summary
//     it builds.
//
// Both are correctly placed. This paragraph exists because the header used to
// claim otherwise, and a reader who greps only this module for cap counting
// would have concluded it was complete.
//
// Nothing here reads a date, opens a transaction or takes a lock, which is why
// it could leave `promo.ts` at all: the club-day helpers and the row-lock
// protocol stayed behind, with the comparisons and the writers they serve.
//
// ONE INBOUND CITATION IS NOW STALE, AND DELIBERATELY LEFT THAT WAY.
// `prisma/migrations/20260731140000_repair_zero_benefit_promo_allocations/migration.sql`
// names `isBeneficialPromoAllocation` / `BENEFICIAL_PROMO_ALLOCATION_FILTER`
// "in src/lib/promo.ts" and declares that the migration's `DELETE` and the
// application's benefit test can never disagree about which rows count. That
// lockstep claim is still exactly true — the two symbols simply live here now.
//
// The comment was not corrected, because editing an already-applied migration
// changes its Prisma checksum and breaks `migrate deploy` on every environment
// that has run it (`docs/BLUE_GREEN_MIGRATION_POLICY.md`).
//
// The correction is put where the stale reader is actually standing instead: a
// SYMBOLS-MOVED.md sibling in that migration'"'"'s own directory. Prisma checksums
// the contents of `migration.sql` alone, which is why `rollback.sql` files
// already ship inside migration directories here, so a sibling breaks nothing.
// `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` quotes the same sentence in that
// migration's historical review row and is likewise left alone: it is an audit
// record of what was reviewed at the time, not a live pointer.
//
// This note is the other half of that link. If either symbol is renamed or
// moved again, fix it HERE — the migration cannot be made to follow.

export type PromoUsageClient = typeof prisma | Prisma.TransactionClient;

/**
 * Did this allocation actually give the member something? (#2299, owner
 * decision 1: "any price effect".) A money-off discount, a price change in
 * either direction, or a subsidised night all count as a benefit; an
 * application that moved none of the three delivered nothing.
 *
 * A price-RAISING fixed-nightly application counts as a use, because the
 * member's price genuinely changed — the rejected alternative was to count
 * price reductions only.
 *
 * LOCKSTEP: this predicate, `BENEFICIAL_PROMO_ALLOCATION_FILTER` below, and the
 * `DELETE` predicate in
 * `prisma/migrations/20260731140000_repair_zero_benefit_promo_allocations`
 * are the same rule expressed three times (TypeScript, Prisma, SQL). Change one
 * and you must change all three, or the repair migration will delete rows the
 * runtime counts, or leave rows it does not.
 */
export function isBeneficialPromoAllocation(allocation: {
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}): boolean {
  return (
    allocation.discountCents > 0 ||
    allocation.priceAdjustmentCents !== 0 ||
    allocation.freeNightsUsed > 0
  );
}

/**
 * The same "did the member actually get something" test, expressed as a Prisma
 * filter over stored allocation rows. Applied defensively to every cap count so
 * a historical all-zero row written before #2299 (or by an old colour during a
 * blue/green drain) stops consuming a member's slot immediately, without
 * waiting for the repair migration to run.
 *
 * SPREAD IT — and only into a `where` that has no `OR` of its own. An object
 * literal cannot hold two `OR` keys, so the later one silently wins and one of
 * the two conditions vanishes without a type error. All six current call sites
 * spread it into a plain AND-of-scalars filter, which is safe; a future caller
 * that needs its own `OR` must nest both under `AND: [...]` instead.
 *
 * Kept in lockstep with `isBeneficialPromoAllocation` and the repair
 * migration's `DELETE` predicate — see the note on that function.
 */
export const BENEFICIAL_PROMO_ALLOCATION_FILTER = {
  OR: [
    { discountCents: { gt: 0 } },
    { priceAdjustmentCents: { not: 0 } },
    { freeNightsUsed: { gt: 0 } },
  ],
} satisfies Prisma.PromoRedemptionAllocationWhereInput;

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 *
 * Deliberately NOT benefit-filtered: this sum is already benefit-proportional
 * (a zero-benefit row contributes zero nights), and summing every row is the
 * fail-safe direction — it can never miss a night a member really claimed.
 */
async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await db.promoRedemptionAllocation.aggregate({
    where,
    _sum: { freeNightsUsed: true },
  });

  return result._sum.freeNightsUsed ?? 0;
}

/**
 * Count distinct members who have BENEFITED from this promo code.
 * Excludes a specific booking id when updating an existing booking.
 */
export async function getUniqueMemberRedemptionCount(
  promoCodeId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }
  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return rows.length;
}

/**
 * How many times this member has already BENEFITED from this promo code — the
 * denominator of the uses-per-member cap. A zero-benefit application never
 * counts (#2299), so a member who applied a code that did nothing for them can
 * still use it later.
 */
async function getMemberPromoRedemptionCount(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    memberId,
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  return db.promoRedemptionAllocation.count({ where });
}

export async function getPromoBeneficiaryUsage(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
) {
  const usage: Record<string, { redemptionCount: number; freeNightsUsed: number }> = {};
  await Promise.all(
    [...new Set(memberIds)].map(async (memberId) => {
      const [redemptionCount, freeNightsUsed] = await Promise.all([
        getMemberPromoRedemptionCount(promoCodeId, memberId, excludeBookingId, db),
        getMemberFreeNightsUsed(promoCodeId, memberId, excludeBookingId, db),
      ]);
      usage[memberId] = { redemptionCount, freeNightsUsed };
    })
  );
  return usage;
}

export async function getExistingBeneficiaryMemberIds(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
): Promise<Set<string>> {
  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length === 0) return new Set();

  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    memberId: { in: uniqueMemberIds },
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return new Set(rows.map((row) => row.memberId));
}

/**
 * The members who are ALREADY benefiting from this promotion **on this booking**
 * (#2390) — the people an edit must never take the discount away from.
 *
 * Read from the allocation rows, which since #2299 mean "this member actually
 * got something", and benefit-filtered again defensively so a legacy all-zero
 * row cannot buy someone protection they never had.
 *
 * MUST be read before the reprice writes anything. Every reprice path calls it
 * during validation, which is before `replacePromoRedemptionAllocations`
 * touches the redemption — so the `PromoRedemption_sync_allocation_*` triggers
 * (20260527120000_add_promo_redemption_allocations) have not fired yet and
 * cannot conjure a transient row into this answer. Reading it after the
 * redemption write would let the trigger's booker row grant protection.
 *
 * Returns free nights as well as identity, because a FREE_NIGHTS promotion's
 * `lifetimeFreeNightsCap` is a budget rather than a slot: protecting the
 * member's place in the beneficiary list is not enough if the budget arithmetic
 * then awards them nothing. See `remainingFreeNightsByMemberId`, which stayed
 * in `promo.ts` when #3128 moved this function out — it said "below" while the
 * two shared a file.
 */
export async function getBookingBeneficiaryFreeNights(
  promoCodeId: string,
  bookingId: string,
  db: PromoUsageClient
): Promise<Map<string, number>> {
  const rows = await db.promoRedemptionAllocation.findMany({
    where: {
      promoCodeId,
      bookingId,
      ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
    },
    select: { memberId: true, freeNightsUsed: true },
  });
  const freeNightsByMemberId = new Map<string, number>();
  for (const row of rows) {
    freeNightsByMemberId.set(
      row.memberId,
      (freeNightsByMemberId.get(row.memberId) ?? 0) + (row.freeNightsUsed ?? 0)
    );
  }
  return freeNightsByMemberId;
}
