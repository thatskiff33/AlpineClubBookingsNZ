import type { AgeTier } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getNightlyRate, type SeasonRateData } from "@/lib/policies/pricing";
import { toSeasonRateData } from "@/lib/policies/booking-route-decisions";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";

// Suggested per-guest-night rates for the admin booking-request pricing panel
// (#2749). For each age tier we surface BOTH the non-member and the Full-member
// nightly rate so the panel can pre-fill the rate fields:
//   * a normal non-member request pre-fills the non-member rate;
//   * a request whose requester indicated they belong to another lodge pre-fills
//     the Full-member rate (reciprocal "other club member" treatment) and shows
//     the non-member rate as a reference underneath.
// Rates come from the SAME engine that prices bookings (@/lib/policies/pricing),
// keyed on the built-in FULL / NON_MEMBER membership types configured on
// /admin/fees.
//
// The rate is read at the stay's CHECK-IN night. That matches the quote model,
// which stores one rate per tier for the whole stay (rate x night count); a stay
// that crosses a season boundary with different rates therefore pre-fills the
// check-in season's rate, exactly the single value an officer would otherwise
// type. Null means no active season covers the check-in, or no rate row exists
// for that tier/type — the panel then leaves the field blank.

// Built-in membership type keys (defined in @/lib/membership-types). The rate
// table is keyed on the MembershipType row, not a member/non-member boolean.
const FULL_MEMBERSHIP_TYPE_KEY = "FULL";
const NON_MEMBER_MEMBERSHIP_TYPE_KEY = "NON_MEMBER";

const PERSON_AGE_TIERS: readonly AgeTier[] = [
  "ADULT",
  "YOUTH",
  "CHILD",
  "INFANT",
];

export interface SuggestedTierRates {
  /** Non-member nightly rate in cents for this tier, or null if none. */
  nonMemberCents: number | null;
  /** Full-member nightly rate in cents for this tier, or null if none. */
  memberCents: number | null;
}

export type SuggestedGuestNightRates = Partial<
  Record<AgeTier, SuggestedTierRates>
>;

type SuggestedRatesRequest = {
  id: string;
  lodgeId: string | null;
  checkIn: Date;
  guests: Array<{ ageTier: string }>;
};

type SuggestedRatesDb = Pick<
  typeof prisma,
  "membershipType" | "season" | "lodge"
>;

/**
 * Batch-resolve suggested non-member and Full-member per-guest-night rates for a
 * page of booking requests. One membership-type lookup, one default-lodge
 * lookup, and one season query per distinct effective lodge; the per-tier rate
 * resolution is pure in-memory computation after that, so the query count stays
 * flat as the queue grows (mirrors resolveWholeLodgeFlatPricesForRequests).
 */
export async function resolveSuggestedGuestNightRatesForRequests(
  requests: readonly SuggestedRatesRequest[],
  db: SuggestedRatesDb = prisma,
): Promise<Map<string, SuggestedGuestNightRates>> {
  const result = new Map<string, SuggestedGuestNightRates>();
  if (requests.length === 0) return result;

  const types = await db.membershipType.findMany({
    where: {
      key: { in: [FULL_MEMBERSHIP_TYPE_KEY, NON_MEMBER_MEMBERSHIP_TYPE_KEY] },
    },
    select: { id: true, key: true },
  });
  const fullTypeId =
    types.find((type) => type.key === FULL_MEMBERSHIP_TYPE_KEY)?.id ?? null;
  const nonMemberTypeId =
    types.find((type) => type.key === NON_MEMBER_MEMBERSHIP_TYPE_KEY)?.id ??
    null;
  // Nothing to resolve if neither built-in type exists (shouldn't happen after
  // seeding) — return an empty map so the panel simply shows no pre-fill.
  if (!fullTypeId && !nonMemberTypeId) return result;

  // A null lodgeId means the club's default lodge (BookingRequest null
  // semantics), resolved once here.
  const defaultLodgeId = await getDefaultLodgeId(db);

  const effectiveLodgeIds = new Set(
    requests.map((request) => request.lodgeId ?? defaultLodgeId),
  );
  const seasonsByLodgeId = new Map<string, SeasonRateData[]>();
  await Promise.all(
    [...effectiveLodgeIds].map(async (lodgeId) => {
      const seasons = await db.season.findMany({
        where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
        include: { membershipTypeRates: true },
      });
      seasonsByLodgeId.set(lodgeId, toSeasonRateData(seasons));
    }),
  );

  for (const request of requests) {
    const seasons =
      seasonsByLodgeId.get(request.lodgeId ?? defaultLodgeId) ?? [];
    const tiers = new Set(
      request.guests
        .map((guest) => guest.ageTier)
        .filter((tier): tier is AgeTier =>
          (PERSON_AGE_TIERS as readonly string[]).includes(tier),
        ),
    );
    const byTier: SuggestedGuestNightRates = {};
    for (const tier of tiers) {
      byTier[tier] = {
        nonMemberCents: nonMemberTypeId
          ? getNightlyRate(request.checkIn, tier, nonMemberTypeId, seasons)
              ?.priceCents ?? null
          : null,
        memberCents: fullTypeId
          ? getNightlyRate(request.checkIn, tier, fullTypeId, seasons)
              ?.priceCents ?? null
          : null,
      };
    }
    result.set(request.id, byTier);
  }

  return result;
}
