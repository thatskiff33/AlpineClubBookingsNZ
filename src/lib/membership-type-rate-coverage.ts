/**
 * Which membership types must carry hut rates, and which of those rates are
 * missing (`INV-MOD-007`, `INV-SSOT-001`).
 *
 * ## The one rule, in one place
 *
 * `INV-MOD-007`: hut nightly rates are keyed by membership type. Every
 * `MEMBER_RATE` type carries its own `MembershipTypeSeasonRate` rows, non-members
 * price from the built-in `NON_MEMBER` type's rows, and every other type —
 * `NON_MEMBER_RATE` other than `NON_MEMBER`, and `BLOCK_BOOKING` — carries
 * **zero** own rows, because the rate resolver never consults them. A type that
 * owes rows and has none is a hard throw at pricing time; a type that owes none
 * must never be told it is missing anything.
 *
 * That sentence used to be re-typed at each of seven call sites — the season rate
 * editor's validator, two admin screens, the Xero item-code route, two
 * config-transfer categories and the setup-readiness snapshot — and the seventh
 * of them had already drifted: the readiness snapshot asked the database for
 * `bookingBehavior: "MEMBER_RATE"` alone, so the `NON_MEMBER` type, which prices
 * every non-member guest the club takes, was the one rate-bearing type whose
 * missing rates nothing warned about (#2933). Cannot change a fact in one place
 * is the defect; this module is the fix.
 *
 * ## What this module is NOT
 *
 * It is an **early warning**, never a price. Nothing here invents a rate,
 * substitutes zero, or inherits another type's amount: pricing still refuses at
 * runtime when a required row is absent, and that refusal is the safety
 * property. What a gap computed here buys is the officer finding out while they
 * are on the pricing screen rather than when a member's booking is refused.
 *
 * ## Isomorphic on purpose
 *
 * No Prisma, no `node:fs`, no zod, no clock: the admin Hut Fees screen is a
 * client component and reads the same rule the server-side readiness snapshot
 * does. "Today" and the club's configured age tiers arrive as arguments, so a
 * caller cannot get the club's calendar day from the host clock by accident
 * (`INV-DATE-019`) and a club running a subset of the four age tiers is judged
 * against its own subset (#2009).
 */

import { compareCalendarDates, type CalendarDate } from "@/lib/club-time";

/**
 * The built-in type every true non-member prices from. It is the single
 * exception to "rate-bearing means `MEMBER_RATE`", and the reason the rule is a
 * function rather than an enum comparison.
 */
export const NON_MEMBER_RATE_HOLDER_KEY = "NON_MEMBER";

/** The two fields the rate-bearing question is answered from, and no others. */
export interface RateBearingMembershipTypeShape {
  key: string;
  bookingBehavior: string;
}

/**
 * Does this membership type carry its own hut rate rows? (`INV-MOD-007`.)
 *
 * True for every `MEMBER_RATE` type and for the built-in `NON_MEMBER` type.
 * False for every other `NON_MEMBER_RATE` type and for `BLOCK_BOOKING` types —
 * those price from the `NON_MEMBER` rows or do not book at all, so a rate row of
 * their own would never be read.
 *
 * Note the shape of the test: `bookingBehavior === "MEMBER_RATE"`, never
 * `!== "NON_MEMBER_RATE"`. `BLOCK_BOOKING` is a third value and it is not a
 * rate-bearer — the mirror of `INV-MOD-031`, which makes the same point about
 * the opposite question.
 */
export function isRateBearingMembershipType(
  type: RateBearingMembershipTypeShape,
): boolean {
  return (
    type.bookingBehavior === "MEMBER_RATE" ||
    type.key === NON_MEMBER_RATE_HOLDER_KEY
  );
}

/** A membership type as the "does it owe rates *now*" question sees it. */
export interface HutRateRequirementShape extends RateBearingMembershipTypeShape {
  isActive: boolean;
}

/**
 * Does this type owe hut rates for the seasons a club is still selling?
 *
 * Archived types are excluded deliberately: they price history, and a booking
 * can no longer be created on one, so a missing rate on an archived type is not
 * a defect an operator has to fix.
 */
export function requiresHutRates(type: HutRateRequirementShape): boolean {
  return type.isActive && isRateBearingMembershipType(type);
}

/** Every type from `types` that owes hut rates, in the order given. */
export function selectTypesRequiringHutRates<T extends HutRateRequirementShape>(
  types: readonly T[],
): T[] {
  return types.filter((type) => requiresHutRates(type));
}

/**
 * Is this season one a missing rate would actually refuse a booking on?
 *
 * Active, or not yet ended. A closed past season keeps whatever rows it has for
 * the bookings it priced, and telling an operator to "fix" it would be noise
 * they cannot act on — the same scope the setup-readiness snapshot has asked the
 * database for since #1930.
 *
 * Both edges are calendar dates, so no timezone is involved and none should be.
 * `today` is the CLUB's day (`INV-DATE-019`) and is passed in rather than read
 * here, because this module holds no clock.
 */
export function seasonRequiresRates(
  season: { active: boolean; endDate: CalendarDate },
  today: CalendarDate,
): boolean {
  return season.active || compareCalendarDates(season.endDate, today) >= 0;
}

/** One membership type as the gap computation reads it. */
export interface MembershipTypeRateGapType {
  id: string;
  name: string;
  ageGroupsApply: boolean;
}

/** One season as the gap computation reads it. */
export interface MembershipTypeRateGapSeason {
  id: string;
  name: string;
}

/** One existing rate row. Only its key matters here, never its amount. */
export interface MembershipTypeRateGapRow {
  seasonId: string;
  membershipTypeId: string;
  ageTier: string | null;
}

/**
 * What is absent for one (type, season) pair.
 *
 * `flat` is a type that prices from a single all-ages row and has none.
 * `tiers` names the bookable age tiers with no row of their own, for a type that
 * prices per tier and has no flat row to fall back to.
 */
export type MissingHutRates =
  | { kind: "flat" }
  | { kind: "tiers"; tiers: string[] };

/** One (type, season) pair a booking cannot price on. */
export interface MembershipTypeRateGap {
  membershipTypeId: string;
  membershipTypeName: string;
  seasonId: string;
  seasonName: string;
  missing: MissingHutRates;
}

/**
 * Tier-aware missing-rate coverage (#1930, E4; restructured by #2933).
 *
 * A (type, season) pair is covered when a booking for ANY bookable age tier can
 * price:
 *
 *   - `ageGroupsApply: true` — every bookable tier has an exact row, OR a flat
 *     (`NULL`-ageTier) row exists, because the engine prefers the exact tier and
 *     falls back to the flat row;
 *   - `ageGroupsApply: false` — the single flat row exists. Tier rows alone are a
 *     shape anomaly the write surfaces reject, so they are reported as a missing
 *     flat rate rather than silently accepted.
 *
 * Anything less means some guest hard-throws at pricing.
 *
 * **Pass only the types that owe rates** — `selectTypesRequiringHutRates` is how
 * — and only the seasons in scope. This function answers "is the configuration
 * complete", not "which types are in scope"; handing it a `BLOCK_BOOKING` type
 * would produce a warning about rows that type must never have.
 *
 * `bookableAgeTiers` is required rather than defaulted, because a club may run a
 * SUBSET of the four tiers and only its present tiers are ever priced (#2009).
 * Defaulting it here would quietly tell a CHILD + ADULT club it is missing
 * INFANT and YOUTH rates that nothing will ever read.
 */
export function computeMembershipTypeRateGaps(input: {
  types: readonly MembershipTypeRateGapType[];
  seasons: readonly MembershipTypeRateGapSeason[];
  rateRows: readonly MembershipTypeRateGapRow[];
  bookableAgeTiers: readonly string[];
}): MembershipTypeRateGap[] {
  const tiersByPair = new Map<string, Set<string | null>>();
  for (const row of input.rateRows) {
    const key = `${row.membershipTypeId}::${row.seasonId}`;
    const set = tiersByPair.get(key) ?? new Set<string | null>();
    set.add(row.ageTier);
    tiersByPair.set(key, set);
  }

  const gaps: MembershipTypeRateGap[] = [];
  for (const type of input.types) {
    for (const season of input.seasons) {
      const tiers = tiersByPair.get(`${type.id}::${season.id}`);
      const hasFlat = tiers?.has(null) ?? false;
      if (hasFlat) continue;
      if (type.ageGroupsApply) {
        const missingTiers = input.bookableAgeTiers.filter(
          (tier) => !tiers?.has(tier),
        );
        if (missingTiers.length === 0) continue;
        gaps.push({
          membershipTypeId: type.id,
          membershipTypeName: type.name,
          seasonId: season.id,
          seasonName: season.name,
          missing: { kind: "tiers", tiers: missingTiers },
        });
      } else {
        gaps.push({
          membershipTypeId: type.id,
          membershipTypeName: type.name,
          seasonId: season.id,
          seasonName: season.name,
          missing: { kind: "flat" },
        });
      }
    }
  }
  return gaps;
}

/**
 * One gap as the setup-readiness step lists it: `"Full — Winter 2026 (missing
 * INFANT, YOUTH)"`. The wording is what that step has published since #1930 and
 * is deliberately unchanged.
 */
export function formatMembershipTypeRateGap(gap: MembershipTypeRateGap): string {
  const missing =
    gap.missing.kind === "flat"
      ? "flat all-ages rate"
      : gap.missing.tiers.join(", ");
  return `${gap.membershipTypeName} — ${gap.seasonName} (missing ${missing})`;
}
