import "server-only";

import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import type { ClubFormat } from "@/lib/club-format";
import type { AgeTierSettingData } from "@/lib/age-tier";
import { loadMembershipLockoutSettings } from "@/lib/membership-lockout-settings";
import { liabilityRuleFor, resolveSubscriptionLiability } from "@/lib/policies/subscription";
import { prisma } from "@/lib/prisma";
import {
  activeWindow,
  ageLabel,
  ageSort,
  isPublicContentEnabled,
  loadAgeTierLabels,
  money,
  type PublicFeeGroup,
  type PublicMoney,
} from "@/lib/public-page-content-tokens";

export type PublicFirstYearCostOptions = { typeKey?: string };

const FLAT = "FLAT";

/**
 * #4295: what it costs to join, as one figure per membership type and age tier:
 * the current joining fee plus the current annual fee, resolved as the invoicing
 * resolves them (`getEffectiveJoiningFee`, `getEffectiveMembershipAnnualFee`,
 * `membership-subscription-billing`). The figure is for ONE person: a flat
 * `PER_FAMILY` annual fee is added once, a `PER_MEMBER` one is not multiplied.
 *
 * - An exact-tier row wins, then the type's flat row. A type without age groups
 *   reads only its flat rows, as the invoicing does for its single tier.
 * - No subscription is added for a `NOT_REQUIRED` type, for a `NO_INVOICE` fee,
 *   or for a tier the club's liability rule exempts (#5190, billing side —
 *   before a club chooses, only a `BASED_ON_AGE_TIER` tier) when its fee is per
 *   member (a per-family fee still applies to it).
 * - A subscription that is required but has no annual fee leaves the row out:
 *   a joining fee alone would read as the whole first-year cost. No joining fee
 *   set means no joining fee.
 * - A prorated annual fee shows "up to", since a mid-season joiner pays less.
 * Needs BOTH the Joining fees and Annual membership fees opt-ins.
 */
export async function loadPublicFirstYearCosts(
  format: ClubFormat,
  options: PublicFirstYearCostOptions = {},
): Promise<PublicFeeGroup[]> {
  const [joiningOn, annualOn] = await Promise.all([
    isPublicContentEnabled("entranceFees"),
    isPublicContentEnabled("annualFees"),
  ]);
  if (!joiningOn || !annualOn) return [];
  const today = await clubTodayDateOnlyInstant();
  const [types, tiers, tierSettings, lockoutSettings] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        subscriptionBehavior: true,
        joiningFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true },
        },
        annualFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true, billingBasis: true, prorationRule: true },
        },
      },
    }),
    loadAgeTierLabels(),
    prisma.ageTierSetting.findMany({ select: { tier: true, subscriptionRequiredForBooking: true } }),
    loadMembershipLockoutSettings(),
  ]);
  // The tier rows here are the fee's own tiers, so the rule reads the tier as
  // given rather than a member's age (#5190).
  const liabilityRule = liabilityRuleFor("billing", lockoutSettings);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;

  const rows: Array<{ sort: number; label: string; fee: PublicMoney }> = [];
  let typeOrder = 0;
  for (const type of listed) {
    typeOrder += 1;
    // Rows are effectiveFrom desc, so the first seen per tier is current. A
    // type without age groups is resolved on its flat rows alone.
    const tierKey = (ageTier: string | null) => (type.ageGroupsApply ? ageTier ?? FLAT : FLAT);
    const joining = new Map<string, number>();
    for (const row of type.joiningFees) {
      if (!type.ageGroupsApply && row.ageTier !== null) continue;
      if (!joining.has(tierKey(row.ageTier))) joining.set(tierKey(row.ageTier), row.amountCents);
    }
    const annual = new Map<string, { cents: number; basis: string; prorated: boolean }>();
    for (const row of type.annualFees) {
      if (!type.ageGroupsApply && row.ageTier !== null) continue;
      const key = tierKey(row.ageTier);
      if (annual.has(key)) continue;
      const invoiced = row.billingBasis !== "NO_INVOICE";
      annual.set(key, {
        cents: invoiced ? row.amountCents : 0,
        basis: row.billingBasis,
        prorated: invoiced && row.prorationRule !== "NONE",
      });
    }
    // A flat key is only a fallback once the type has tier rows of its own.
    const keys = [...new Set([...joining.keys(), ...annual.keys()])];
    const rowKeys = keys.some((key) => key !== FLAT) ? keys.filter((key) => key !== FLAT) : keys;
    for (const key of rowKeys) {
      const tier = key === FLAT ? null : key;
      const resolved = annual.get(key) ?? annual.get(FLAT);
      const owes = resolveSubscriptionLiability({
        subscriptionBehavior: type.subscriptionBehavior,
        ageTier: tier as AgeTierSettingData["tier"] | null,
        seasonRowStatus: null,
        rule: liabilityRule,
        ageTierSettings: tierSettings as AgeTierSettingData[],
      });
      // An exempt tier still pays a per-family fee (#2148 Q5), as billing does.
      const liable =
        type.subscriptionBehavior !== "NOT_REQUIRED" &&
        (owes || (resolved !== undefined && resolved.basis !== "PER_MEMBER"));
      if (liable && !resolved) continue;
      const yearly = liable && resolved ? resolved : { cents: 0, prorated: false };
      const totalCents = (joining.get(key) ?? joining.get(FLAT) ?? 0) + yearly.cents;
      if (totalCents <= 0) continue;
      const fee = money(totalCents, format);
      rows.push({
        sort: typeOrder * 1_000_000_000 + Math.min(ageSort(tiers, tier), 999_999_999),
        label: tier === null ? type.name : `${type.name} — ${ageLabel(tiers, tier)}`,
        fee: yearly.prorated ? { ...fee, label: `up to ${fee.label}` } : fee,
      });
    }
  }
  if (rows.length === 0) return [];
  return [{
    heading: "Joining fee plus first year's subscription",
    rows: rows.sort((a, b) => a.sort - b.sort).map(({ label, fee }) => ({ label, fee })),
  }];
}
