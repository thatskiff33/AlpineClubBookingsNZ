import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * How much of a promotion has already been used, and what counts as a use.
 *
 * Split out of `promo.ts` unchanged (#3128). It holds the benefit test in both
 * of its forms — the TypeScript predicate and the Prisma filter expressing the
 * same rule over stored rows — and every query that counts prior use against
 * it. Those queries are the DENOMINATOR of every promotional cap: uses per
 * member, distinct benefiting members, lifetime free nights, and the rows the
 * booking being repriced already holds (`INV-MONEY-005`, `INV-MONEY-025`).
 *
 * Nothing here reads a date, opens a transaction or takes a lock, which is why
 * it could leave `promo.ts` at all: the club-day helpers and the row-lock
 * protocol stayed behind, with the comparisons and the writers they serve.
 */

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
 * then awards them nothing. See `remainingFreeNightsByMemberId` below.
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
