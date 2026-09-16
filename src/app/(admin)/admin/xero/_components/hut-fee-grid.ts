/**
 * Pure helpers for the admin hut-fee Xero item-code grid (#1930, E4).
 *
 * Hut-fee item codes are keyed `${membershipTypeId}_${seasonType}_${ageTier|FLAT}`,
 * mirroring the membership-type-keyed rate rows: rows = rate-bearing membership
 * types, columns = age tiers (or a single FLAT cell when the type prices from a
 * flat all-ages rate). Kept out of the React component so the grid model is
 * unit-testable.
 */

import { selectTypesRequiringHutRates } from "@/lib/membership-type-rate-coverage";

export const HUT_FEE_FLAT_KEY = "FLAT";
export const HUT_FEE_SEASON_TYPES = ["WINTER", "SUMMER"] as const;

export type HutFeeSeasonType = (typeof HUT_FEE_SEASON_TYPES)[number];

export interface HutFeeRateType {
  id: string;
  key: string;
  name: string;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  ageGroupsApply: boolean;
}

/** Composite cell key: `${membershipTypeId}_${seasonType}_${ageTier|FLAT}`. */
export function hutFeeCellKey(
  membershipTypeId: string,
  seasonType: HutFeeSeasonType,
  ageTier: string | typeof HUT_FEE_FLAT_KEY,
): string {
  return `${membershipTypeId}_${seasonType}_${ageTier}`;
}

/**
 * Rate-bearing membership types shown as grid rows: every active MEMBER_RATE
 * type plus the built-in NON_MEMBER type (the non-member rate holder). Other
 * NON_MEMBER_RATE and BLOCK_BOOKING types carry zero own hut-fee rows — the
 * D2 invariant, `INV-MOD-007` — and are not shown. The rule itself is asked in
 * one place (#2933).
 */
export function filterHutFeeRateTypes<
  T extends { isActive: boolean; key: string; bookingBehavior: string },
>(types: T[]): T[] {
  return selectTypesRequiringHutRates(types);
}

/** The tier cells one type's row carries: each age tier, or the single FLAT cell. */
export function hutFeeCellsForType(
  type: Pick<HutFeeRateType, "ageGroupsApply">,
  tiers: readonly string[],
): Array<string | typeof HUT_FEE_FLAT_KEY> {
  return type.ageGroupsApply ? [...tiers] : [HUT_FEE_FLAT_KEY];
}

/** Every cell key across the grid (used by "copy first item to all"). */
export function allHutFeeCellKeys(
  types: ReadonlyArray<Pick<HutFeeRateType, "id" | "ageGroupsApply">>,
  tiers: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const type of types) {
    for (const season of HUT_FEE_SEASON_TYPES) {
      for (const cell of hutFeeCellsForType(type, tiers)) {
        keys.push(hutFeeCellKey(type.id, season, cell));
      }
    }
  }
  return keys;
}
