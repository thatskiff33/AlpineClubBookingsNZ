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
 *
 * ## What "one rule" covers, and what it does not
 *
 * Both callers take their types, their season scope and their tier list from
 * this module, so they cannot disagree about which types owe rows, which
 * seasons are in scope, or what is missing. Neither of those is a claim about
 * WHICH ROWS each caller loaded: the readiness snapshot asks about the whole
 * installation and the Hut Fees screen about the lodge on screen. A caller that
 * builds its season scope some other way — a database filter comparing an
 * INSTANT against a date-only column, which is what the snapshot did before
 * #2933's fix round — has left this module behind and the two surfaces diverge
 * again. Give `seasonRequiresRates` the club's today, or encode that same day
 * for the query; do not reach for the current instant.
 */

import { compareCalendarDates, type CalendarDate } from "@/lib/club-time";

/**
 * The built-in type every true non-member prices from. It is the single
 * exception to "rate-bearing means `MEMBER_RATE`", and the reason the rule is a
 * function rather than an enum comparison.
 */
export const NON_MEMBER_RATE_HOLDER_KEY = "NON_MEMBER";

/**
 * The built-in type a member the engine cannot place prices from — a member
 * with no assignment for the season year, and a guest a booking officer has
 * recognised as another lodge's member.
 */
const MEMBER_RATE_FALLBACK_HOLDER_KEY = "FULL";

/**
 * The two built-in types the pricing engine resolves BY KEY, with no active
 * filter, on paths that depend on nobody's membership record
 * (`membership-type-policy.ts`: `nonMemberTypeId()` for every true non-member
 * and every type-policy-forced member, `fullTypeId()` for an unplaceable member
 * and for an other-lodge guest).
 *
 * NEITHER ARCHIVING ONE NOR RE-ANSWERING ITS BOOKING-BEHAVIOUR QUESTION TAKES
 * IT OUT OF PRICING, which is why they are the exception to BOTH tests in
 * `requiresHutRates` below and not only to the archived-types one. The
 * built-in guard on the membership-type route covers deletion only, so an
 * officer may archive one of these in one click and may pick a different
 * booking behaviour for it in one more — the officer screen renders that
 * selector for every type, and its labels ("Member rate", "Non-member rate")
 * read like a pricing preference rather than like a structural fact. Neither
 * edit reaches the resolver, which looks these two up by key and asks nothing
 * about what it found. So an archived `NON_MEMBER` still prices every
 * non-member guest the club takes, and a `FULL` re-labelled "Non-member rate"
 * still prices every unplaceable member and every other-lodge guest — in both
 * cases from rows the officer can no longer see or set.
 *
 * Deliberately these two and not every built-in. `LIFE` or `FAMILY` reach
 * pricing only when some member actually holds that role or assignment, which
 * is data this rule cannot see; telling a club that retired a type it never
 * used to go and price it would be noise, and a warning panel that cries wolf
 * is worth less than no panel. These two are reachable in every club, always.
 */
const KEY_RESOLVED_RATE_HOLDER_KEYS: readonly string[] = [
  NON_MEMBER_RATE_HOLDER_KEY,
  MEMBER_RATE_FALLBACK_HOLDER_KEY,
];

/** Is this the kind of rate holder an officer's edits cannot retire? */
export function isKeyResolvedRateHolder(type: { key: string }): boolean {
  return KEY_RESOLVED_RATE_HOLDER_KEYS.includes(type.key);
}

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
 *
 * **This is the behaviour question alone, and it is not the whole coverage
 * rule.** `FULL` answers it `true` only because its booking behaviour SAYS
 * `MEMBER_RATE` today, and that is an officer-editable field; what makes `FULL`
 * owe rows regardless is `isKeyResolvedRateHolder`, which `requiresHutRates`
 * asks first. Do not fold the key-resolved set in here to close that: `FULL` is
 * not rate-bearing BECAUSE of a behaviour value, the two comparisons in this
 * expression are the positive anchor
 * `rate-bearing-membership-type-census.test.ts` matches to prove its patterns
 * still work, and widening this would leave that anchor matching nothing.
 */
export function isRateBearingMembershipType(
  type: RateBearingMembershipTypeShape,
): boolean {
  return (
    type.bookingBehavior === "MEMBER_RATE" ||
    type.key === NON_MEMBER_RATE_HOLDER_KEY
  );
}

/**
 * MAY this type hold hut rate rows at all — the question every WRITE surface
 * asks (`INV-MOD-007`).
 *
 * The read side asks `requiresHutRates`: does this type owe rows *now*. The
 * write side asks something weaker and timeless: would a row saved here ever be
 * read? Season create/update, the Xero hut-fee item-code route and the two
 * config-transfer importers all reject a row for a type that owns none, because
 * such a row is unreadable by construction and saving it would be a lie about
 * what the club charges.
 *
 * **The two questions must agree about the key-resolved pair or the product
 * contradicts itself.** They are the same set for the same reason — the engine
 * reads their rows by key — so a `FULL` whose booking behaviour an officer has
 * re-answered still holds rows, exactly as it still owes them. Before these two
 * predicates were separated, that officer was told on the Hut Fees screen to set
 * a rate the season save then refused, naming a type the engine was at that
 * moment pricing from.
 *
 * What it does NOT relax is the archived/active question. Activity is a read-side
 * scoping concern — is this work an operator can usefully act on now — and has
 * never gated a write; a rate row for a club's own archived `MEMBER_RATE` type
 * is still readable pricing history and is still allowed.
 */
export function holdsHutRateRows(type: RateBearingMembershipTypeShape): boolean {
  return isKeyResolvedRateHolder(type) || isRateBearingMembershipType(type);
}

/** A membership type as the "does it owe rates *now*" question sees it. */
export interface HutRateRequirementShape extends RateBearingMembershipTypeShape {
  isActive: boolean;
}

/**
 * Does this type owe hut rates for the seasons a club is still selling?
 *
 * Archived types are excluded: an ordinary one is reached only through a
 * member's assignment, so an archived one is mostly pricing history, and a
 * missing rate on it is not work an operator can usefully act on.
 *
 * **The two key-resolved holders answer `true` before either test runs**
 * (`isKeyResolvedRateHolder`), and the ORDER below is the point. They owe rows
 * because the resolver reaches them by key and asks nothing about what it
 * found, so no field on the row can excuse them — not `isActive`, and not
 * `bookingBehavior` either.
 *
 * Both fields are one officer click away, and both fail the same way. Archive
 * the built-in `NON_MEMBER` and every non-member guest still prices from its
 * rows; give the built-in `FULL` a different booking behaviour — which the
 * membership-types screen offers for every type, labelled like a pricing
 * preference — and every unplaceable member and every other-lodge guest still
 * prices from ITS rows. In each case the fee grid, which filters on this very
 * rule, stops showing the type, so the officer cannot set a rate; a season
 * created from that grid gets no rows for it; the warning panel and setup
 * readiness both say nothing; and the first booking that needs it throws
 * outright. That is the defect #2933 exists to close, pointing the other way,
 * so the rule follows what actually PRICES rather than what the row currently
 * says about itself.
 *
 * Everything else is judged on both tests together: rate-bearing by behaviour,
 * AND active. Whether an officer should be able to archive or re-behaviour a
 * built-in at all is a separate question about the membership-type route, not
 * about this rule — this rule only declines to be fooled by the answer.
 */
export function requiresHutRates(type: HutRateRequirementShape): boolean {
  if (isKeyResolvedRateHolder(type)) return true;
  return isRateBearingMembershipType(type) && type.isActive;
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
 * they cannot act on — the scope the setup-readiness snapshot has meant since
 * #1930, and has actually asked the database for since #2933: its bound was the
 * current INSTANT against a date-only column, which is a different question and
 * dropped a season ending today from midday onwards in any club ahead of
 * Greenwich.
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
