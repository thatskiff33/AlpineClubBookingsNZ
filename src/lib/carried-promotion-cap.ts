/**
 * AN IN-PROGRESS EDIT CARRIES ITS PROMOTION AND CAPS IT, NEVER RE-DECIDES IT
 * (#4317 review round 4, epic #4302).
 *
 * A stay already under way prices from the nights already agreed and keeps
 * every code the booking carries exactly as stored: never re-validated, so a
 * code that has since expired or been switched off is not dropped and the
 * member is not charged for a shorter stay. Where the change leaves less to pay
 * than the promotion takes off, the planner caps the promotion at the new total
 * (`buildInProgressGuestRangePlan`, `max(promo, -total)`) — the one figure the
 * quote shows and the save writes. This module brings the stored records into
 * line with that figure:
 *
 *  - each redemption's adjustment is scaled to its share of the cap, in
 *    proportion to its stored adjustment, and each member's allocation to its
 *    share of that (`apportionCents`, leftover cents on the earliest entry);
 *  - the redemption rows stay in place, guest targets included, and so does
 *    every allocation row, so no code's `currentRedemptions` moves: a scale
 *    that would delete one — an allocation naming no member (a school's booker
 *    slot, which the shared writer does not rewrite), or one the cap would
 *    leave with no benefit (INV-MONEY-005) — is not made, and the records stay
 *    as they were. Only `replacePromoRedemptionAllocations`, the writer every
 *    re-price uses, touches them, under the promo row locks (INV-MONEY-023);
 *  - no night-adjustment row is written here. After the night rewrite the save
 *    hands the writer, `restoreBookingNightAdjustments`, the row scaler
 *    `carriedCapRowScaler` picks: `scaleCappedCarriedRows` (below) where the
 *    records were scaled — the one rule-derived amount INV-MONEY-029 allows
 *    (owner decision 24 Oct 2026 on #4302) — and one clearing every row where
 *    they were not, so the build-up reads not known rather than disagreeing.
 */
import type { Prisma } from "@prisma/client";

import { bookingDiscountCents } from "@/lib/booking-final-price";
import logger from "@/lib/logger";
import { apportionCents } from "@/lib/night-price-runs";
import { compareOrdinal } from "@/lib/ordinal-order";
import { isBeneficialPromoAllocation } from "@/lib/promo-usage-counts";
import {
  deriveNightAdjustmentState,
  memberBenefitAllocations,
  nightKey,
  type CappedCarryScaler,
  type CarriedRowHeld,
} from "@/lib/night-adjustment-write";
import {
  lockPromoCodeRowsForUpdate,
  replacePromoRedemptionAllocations,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";

/** A stored redemption, as the cap reads it. */
export type CarriedRedemption = {
  id: string;
  promoCodeId: string;
  bookingId: string;
  memberId: string | null;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number | null;
  eligibleGuestCount: number | null;
  allocations: ReadonlyArray<{
    memberId: string | null;
    discountCents: number;
    priceAdjustmentCents: number;
    freeNightsUsed: number;
  }>;
};

/** A redemption's figures once scaled to its share of the cap. */
export type ScaledRedemption = {
  redemption: CarriedRedemption;
  discountCents: number;
  priceAdjustmentCents: number;
  allocations: PromoBeneficiaryAllocation[];
};

/**
 * Scale stored redemptions, in their application order, so their adjustments
 * add up to `cappedPromoAdjustmentCents`. Pure. `null` when the records are left
 * as they were (the booking-level figure is still capped): they did not add up
 * to the booking's stored figure, so there is no proportion to keep; or the
 * scale would delete an allocation row (see the module comment).
 */
export function scaleCarriedRedemptions(
  redemptions: readonly CarriedRedemption[],
  storedPromoAdjustmentCents: number,
  cappedPromoAdjustmentCents: number,
): ScaledRedemption[] | null {
  const storedSum = redemptions.reduce((sum, redemption) => sum + redemption.priceAdjustmentCents, 0);
  if (redemptions.length === 0 || storedSum === 0 || storedSum !== storedPromoAdjustmentCents) return null;
  const figures = apportionCents(
    cappedPromoAdjustmentCents,
    redemptions.map((redemption) => redemption.priceAdjustmentCents),
  );
  const scaled = redemptions.map((redemption, index) => {
    const priceAdjustmentCents = figures[index]!;
    // The allocations a member's benefit decomposes, read the one way the
    // INV-MONEY-029 identity reads them.
    const members = memberBenefitAllocations(redemption.allocations);
    const memberSum = members.reduce((sum, allocation) => sum + allocation.priceAdjustmentCents, 0);
    const shares =
      memberSum === 0
        ? members.map((allocation) => allocation.priceAdjustmentCents)
        : apportionCents(priceAdjustmentCents, members.map((allocation) => allocation.priceAdjustmentCents));
    return {
      redemption,
      priceAdjustmentCents,
      discountCents: bookingDiscountCents({ promoAdjustmentCents: priceAdjustmentCents }),
      allocations: members.map((allocation, at) => ({
        memberId: allocation.memberId,
        priceAdjustmentCents: shares[at]!,
        discountCents: bookingDiscountCents({ promoAdjustmentCents: shares[at]! }),
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    };
  });
  // Every allocation row the redemptions carry must survive the writer: one
  // naming no member is not among `members` (the writer does not rewrite it),
  // and one with no benefit left is dropped by it (INV-MONEY-005).
  const allSurvive = scaled.every(
    (entry, index) =>
      entry.allocations.length === redemptions[index]!.allocations.length &&
      entry.allocations.every(isBeneficialPromoAllocation),
  );
  return allSurvive ? scaled : null;
}

/**
 * Write the scaled figures for a booking whose in-progress edit capped its
 * carried promotion. Runs inside the edit's transaction, which already holds
 * `lock(1)` and the per-lodge capacity key, so the order stays lodge -> promo
 * rows (INV-MONEY-023); every read precedes the first write. Returns whether
 * the records were scaled, which picks the save's row scaler
 * (`carriedCapRowScaler`).
 */
export async function capCarriedPromotionRecords(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    storedPromoAdjustmentCents: number;
    cappedPromoAdjustmentCents: number;
  },
): Promise<boolean> {
  const { bookingId } = params;
  const codes = await tx.promoRedemption.findMany({ where: { bookingId }, select: { promoCodeId: true } });
  if (codes.length === 0) return false;
  await lockPromoCodeRowsForUpdate(tx, codes.map((code) => code.promoCodeId));
  const redemptions = await tx.promoRedemption.findMany({
    where: { bookingId },
    orderBy: [{ applicationOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      promoCodeId: true,
      bookingId: true,
      memberId: true,
      discountCents: true,
      priceAdjustmentCents: true,
      freeNightsUsed: true,
      eligibleGuestCount: true,
      allocations: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { memberId: true, discountCents: true, priceAdjustmentCents: true, freeNightsUsed: true },
      },
    },
  });
  const scaled = scaleCarriedRedemptions(
    redemptions,
    params.storedPromoAdjustmentCents,
    params.cappedPromoAdjustmentCents,
  );
  if (scaled === null) {
    logger.warn(
      { bookingId, storedPromoAdjustmentCents: params.storedPromoAdjustmentCents },
      "#4317: an in-progress edit capped the booking's promotion, but its redemptions could not be scaled to it (they did not add up to the stored figure, or an allocation row would go), so they were left as they were and its night rows cleared; the build-up derives as not known",
    );
    return false;
  }
  for (const entry of scaled) {
    await replacePromoRedemptionAllocations(
      tx,
      entry.redemption,
      entry.discountCents,
      entry.priceAdjustmentCents,
      entry.redemption.freeNightsUsed ?? undefined,
      entry.redemption.eligibleGuestCount ?? undefined,
      entry.allocations,
    );
  }
  return true;
}

/**
 * The row scaler the save hands `restoreBookingNightAdjustments` for a carried
 * promotion: none where the plan capped nothing (`undefined`), the scale where
 * the records were scaled, and one writing no row where they were left as they
 * were — rows scaled to figures the booking no longer carries would disagree
 * with it, where no rows read honestly as not known.
 */
export function carriedCapRowScaler(recordsScaled: boolean | undefined): CappedCarryScaler | undefined {
  if (recordsScaled === undefined) return undefined;
  return recordsScaled ? scaleCappedCarriedRows : (rows) => rows.map(() => null);
}

/** A night row before a guest-scope one; nights by date; then by guest. */
function earliestNightFirst(a: CarriedRowHeld, b: CarriedRowHeld): number {
  if (a.stayDate && b.stayDate) {
    const byNight = a.stayDate.getTime() - b.stayDate.getTime();
    if (byNight !== 0) return byNight;
  } else if (a.stayDate || b.stayDate) {
    return a.stayDate ? -1 : 1;
  }
  return compareOrdinal(a.bookingGuestId, b.bookingGuestId);
}

/**
 * THE ONE RULE-DERIVED AMOUNT (INV-MONEY-029's exception; owner decision
 * 24 Oct 2026 on #4302, #4317 review rounds 4 and 6). An in-progress edit
 * capped its carried promotion and `capCarriedPromotionRecords` scaled each
 * redemption and member allocation to the cap; here the stored rows left on the
 * stay are scaled to match, per redemption and beneficiary, in proportion to
 * their stored amounts, leftover cents on the earliest night (`apportionCents`).
 * A beneficiary whose rows already sum to its allocation keeps them byte for
 * byte. Returns each row's new amount, in `rows` order.
 *
 * EACH CODE ON ITS OWN: a redemption whose rows cannot be scaled honestly gets
 * none (`null` for each), so its build-up reads not known while another code's
 * rows stand. (While any code reads not known, the booking's build-up and its
 * Xero promotion lines fall back to the one aggregate, `planPromoAdjustmentLines`.)
 * That is a redemption with a NOT KNOWN amount among its rows; a beneficiary
 * with an allocation and no row left to scale from; a beneficiary whose rows mix
 * signs (a `SET_PRICE` code's raises beside its discounts: no proportion is
 * meaningful); a scale that would take more off a night than it is priced at,
 * or off a guest-scope row than its guest's held total, or raise a night
 * further than it was raised; and a result that does not reconcile. Then,
 * ACROSS CODES, no guest may end with more taken off than the guest's held
 * total, nor any night more than its held price (#4317 review rounds 7 and 8:
 * codes each in bounds can together exceed either); where one would, every code
 * with a row on that guest or night writes none, until none is over. A row
 * naming no redemption the booking carries is not written. Pure: the writer is
 * handed it by the batch save for a capped plan and writes what it returns.
 */
export const scaleCappedCarriedRows: CappedCarryScaler = (rows, redemptions) => {
  const amounts: Array<number | null> = rows.map((row) => row.amountCents);
  const known = new Set(redemptions.map((redemption) => redemption.id));
  rows.forEach((row, index) => {
    if (!known.has(row.promoRedemptionId)) amounts[index] = null;
  });
  for (const redemption of redemptions) {
    const mine = rows.flatMap((row, index) => (row.promoRedemptionId === redemption.id ? [index] : []));
    const scaled = scaleOneRedemption(rows, mine, redemption);
    mine.forEach((index, at) => {
      amounts[index] = scaled === null ? null : scaled[at]!;
    });
  }
  // Across codes: every guest and every night against what it is held at.
  // Each pass clears EVERY code on ANY over guest or night, so the answer does
  // not depend on row order; clearing a code can only remove a discount, or a
  // raise that was offsetting one, so repeat. A pass that finds anything clears
  // at least one more code, so there are at most as many as there are codes.
  for (let pass = 0; pass <= redemptions.length; pass += 1) {
    const involved = codesOverAHeldPrice(rows, amounts);
    if (involved.size === 0) break;
    rows.forEach((row, index) => {
      if (involved.has(row.promoRedemptionId)) amounts[index] = null;
    });
  }
  return amounts;
};

/**
 * Every code with a row on a guest, or on one of a guest's nights, whose rows
 * across every code take off more than it is held at: the guest's held total,
 * the night's held price (#4317 review rounds 7 and 8). Only rows still written
 * count, so a guest or night with none left is never over; a night whose price
 * is NOT KNOWN is not measured. Nights are keyed by guest and calendar day, the
 * writer's own `nightKey`.
 */
function codesOverAHeldPrice(rows: CarriedRowHeld[], amounts: Array<number | null>): Set<string> {
  const held = new Map<string, { takenCents: number; heldCents: number | null; codes: Set<string> }>();
  const add = (key: string, heldCents: number | null, cents: number, code: string) => {
    const entry = held.get(key) ?? { takenCents: 0, heldCents, codes: new Set<string>() };
    entry.takenCents += cents;
    entry.codes.add(code);
    held.set(key, entry);
  };
  rows.forEach((row, index) => {
    const cents = amounts[index];
    if (cents === null || cents === undefined) return;
    add(`guest|${row.bookingGuestId}`, row.guestHeldCents, cents, row.promoRedemptionId);
    if (row.stayDate) {
      add(`night|${nightKey(row.bookingGuestId, row.stayDate)}`, row.heldPriceCents, cents, row.promoRedemptionId);
    }
  });
  const involved = new Set<string>();
  for (const entry of held.values()) {
    if (entry.heldCents !== null && -entry.takenCents > entry.heldCents) {
      for (const code of entry.codes) involved.add(code);
    }
  }
  return involved;
}

/** One redemption's rows (`mine`, indexes into `rows`) scaled to its records, or `null`. */
function scaleOneRedemption(
  rows: CarriedRowHeld[],
  mine: number[],
  redemption: Parameters<CappedCarryScaler>[1][number],
): number[] | null {
  if (mine.some((index) => rows[index]!.amountCents === null)) return null;
  const amounts = new Map(mine.map((index) => [index, rows[index]!.amountCents!]));
  const allocated = new Map(
    memberBenefitAllocations(redemption.allocations).map((allocation) => [
      allocation.memberId,
      allocation.priceAdjustmentCents,
    ]),
  );
  const members = new Set([...allocated.keys(), ...mine.map((index) => rows[index]!.beneficiaryMemberId)]);
  for (const memberId of members) {
    const group = mine
      .filter((index) => rows[index]!.beneficiaryMemberId === memberId)
      .sort((a, b) => earliestNightFirst(rows[a]!, rows[b]!));
    const target = allocated.get(memberId) ?? 0;
    const weights = group.map((index) => amounts.get(index)!);
    const stored = weights.reduce((sum, cents) => sum + cents, 0);
    if (stored === target) continue;
    if (stored === 0) return null;
    if (weights.some((cents) => cents > 0) && weights.some((cents) => cents < 0)) return null;
    const shares = apportionCents(target, weights);
    const outOfBounds = shares.some((cents, at) => {
      const row = rows[group[at]!]!;
      if (cents > 0) return cents > row.amountCents!;
      return row.heldPriceCents === null || -cents > row.heldPriceCents;
    });
    if (outOfBounds) return null;
    shares.forEach((cents, at) => amounts.set(group[at]!, cents));
  }
  const result = mine.map((index) => amounts.get(index)!);
  // The result must reconcile, read the one way every reader reads it.
  const state = deriveNightAdjustmentState({
    rows: mine.map((index, at) => ({ beneficiaryMemberId: rows[index]!.beneficiaryMemberId, amountCents: result[at]! })),
    redemption: {
      priceAdjustmentCents: redemption.priceAdjustmentCents,
      allocations: memberBenefitAllocations(redemption.allocations),
    },
  });
  return state === "KNOWN" ? result : null;
}
