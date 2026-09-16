/**
 * Admin season rate editor helpers (#1930, E4).
 *
 * The /admin/seasons rate editor writes `MembershipTypeSeasonRate` rows keyed
 * by membership type + optional age tier — the authoritative pricing table.
 * The legacy boolean-keyed `SeasonRate` table was dropped by #2129 step 2
 * (20260721120000_contract_drop_season_rate).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { holdsHutRateRows } from "@/lib/membership-type-rate-coverage";

// One editor rate row. `ageTier` is null for a flat type (ageGroupsApply=false)
// and set per tier otherwise. Prices are GST-inclusive integer cents.
export const membershipTypeSeasonRateInputSchema = z
  .array(
    z.object({
      membershipTypeId: z.string().min(1),
      ageTier: bookableAgeTierEnum.nullable(),
      pricePerNightCents: z.number().int().min(0),
    }),
  )
  .min(1, "Must provide at least one rate");

export type MembershipTypeSeasonRateInput = z.infer<
  typeof membershipTypeSeasonRateInputSchema
>;

/** Minimal shape the copy-seasons flow reads out of GET /api/admin/seasons. */
export interface CopyableSeason {
  name: string;
  type: "WINTER" | "SUMMER";
  startDate: string;
  endDate: string;
  active: boolean;
  membershipTypeRates: Array<{
    membershipTypeId: string;
    ageTier: string | null;
    pricePerNightCents: number;
  }>;
}

/**
 * Build the POST /api/admin/seasons body that clones one lodge's season onto
 * another (the lodge-setup wizard's "copy seasons" step).
 *
 * Two things this pins down, both of which were live bugs or near-bugs:
 *
 * 1. The rates go out under `membershipTypeRates`, NOT the legacy `rates` key.
 *    `seasonSchema` in the POST route requires `membershipTypeRates`, so the
 *    old `rates` body failed validation and every copy silently 400'd (#2129).
 * 2. `membershipTypeId` is carried across unchanged. `MembershipType` has no
 *    lodge scoping, so type ids are global and remain valid at the target lodge.
 *
 * Known rough edge (deliberate, fails loudly): a source season carrying a rate
 * row with `ageTier: "NOT_APPLICABLE"` copies as a hard 400. The column
 * `MembershipTypeSeasonRate.ageTier` is the full `AgeTier` enum and so permits
 * `NOT_APPLICABLE`, but `bookableAgeTierEnum` (`age-tier-schema.ts:22-28`)
 * deliberately excludes it — per-tier season rates are always people with an
 * age. Such a row cannot be created through the admin editor, so it should only
 * exist via direct SQL. The wizard collects the rejection into its `failed[]`
 * list and shows it, so this surfaces as a named per-season failure rather than
 * a silent skip — a rough edge, not a defect.
 */
export function buildCopiedSeasonPayload(
  season: CopyableSeason,
  targetLodgeId: string,
) {
  return {
    name: season.name,
    type: season.type,
    startDate: season.startDate.slice(0, 10),
    endDate: season.endDate.slice(0, 10),
    active: season.active,
    lodgeId: targetLodgeId,
    membershipTypeRates: season.membershipTypeRates.map((rate) => ({
      membershipTypeId: rate.membershipTypeId,
      ageTier: rate.ageTier,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  };
}

type MembershipTypeReadDelegate = {
  membershipType: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; key: true; bookingBehavior: true };
    }): Promise<
      Array<{ id: string; key: string; bookingBehavior: string }>
    >;
  };
};

/**
 * A membership type may carry hut rate rows iff it prices from its own rows:
 * every `MEMBER_RATE` type, plus the two built-ins the engine resolves by key
 * (`NON_MEMBER` and `FULL`), whose rows are read whatever their own row says.
 * Every other `NON_MEMBER_RATE` type and every `BLOCK_BOOKING` type carries zero
 * own rows — the D2 invariant, `INV-MOD-007`, asked in one place since #2933 via
 * `holdsHutRateRows`. That it is the same predicate the Hut Fees warning reads
 * is the point: this route is where the officer acts on that warning, so a type
 * the panel names must be a type this validator accepts. Also rejects duplicate
 * (membershipTypeId, ageTier) rows. Returns an error string, or null when valid.
 */
export async function validateMembershipTypeSeasonRates(
  db: MembershipTypeReadDelegate,
  rates: MembershipTypeSeasonRateInput,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const rate of rates) {
    const key = `${rate.membershipTypeId}::${rate.ageTier ?? "FLAT"}`;
    if (seen.has(key)) {
      return "Duplicate rate for the same membership type and age tier.";
    }
    seen.add(key);
  }

  const ids = [...new Set(rates.map((rate) => rate.membershipTypeId))];
  const types = await db.membershipType.findMany({
    where: { id: { in: ids } },
    select: { id: true, key: true, bookingBehavior: true },
  });
  const byId = new Map(types.map((type) => [type.id, type]));
  for (const id of ids) {
    const type = byId.get(id);
    if (!type) {
      return `Unknown membership type: ${id}`;
    }
    if (!holdsHutRateRows(type)) {
      return `Membership type "${type.key}" does not carry its own hut rates.`;
    }
  }
  return null;
}

/**
 * Replace a season's membership-type rate rows (delete + insert) inside a
 * transaction.
 */
export async function replaceMembershipTypeSeasonRates(
  tx: Prisma.TransactionClient,
  seasonId: string,
  rates: MembershipTypeSeasonRateInput,
): Promise<void> {
  await tx.membershipTypeSeasonRate.deleteMany({ where: { seasonId } });
  if (rates.length > 0) {
    await tx.membershipTypeSeasonRate.createMany({
      data: rates.map((rate) => ({
        seasonId,
        membershipTypeId: rate.membershipTypeId,
        ageTier: rate.ageTier,
        pricePerNightCents: rate.pricePerNightCents,
      })),
    });
  }
}
