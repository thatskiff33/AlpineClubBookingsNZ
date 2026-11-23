import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  Role,
  SubscriptionStatus,
} from "@prisma/client";

import type { AgeTierSettingData } from "@/lib/age-tier";
import {
  effectiveSubscriptionBehavior,
  isSubscriptionNotRequiredForMembershipType,
} from "@/lib/membership-types";
import type { SubscriptionLiabilitySettings } from "@/lib/policies/subscription";
import {
  notRequiredRowBillingNote,
  type SeasonRowState,
} from "@/lib/subscription-season-row-note";

/**
 * The admin subscriptions list's two per-row liability answers (#2149, #5190):
 * whether to show a member as "Not required", and the billing note for a saved
 * "Not required" row whose member billing treats as owing. Both read the shared
 * liability rule on the lists' side, as the members list and its export do.
 */

export function isSubscriptionsListMemberNotRequired(
  member: {
    role: Role;
    ageTier: AgeTier;
    dateOfBirth: Date | null;
    seasonalMembershipAssignments?: Array<{
      membershipType: { subscriptionBehavior: MembershipTypeSubscriptionBehavior };
    }>;
  },
  rule: {
    seasonYear: number;
    ageTierSettings: AgeTierSettingData[];
    liabilitySettings: SubscriptionLiabilitySettings;
  },
  seasonSubscriptionStatus?: SubscriptionStatus
) {
  // #2149/#5190: membership type is the sole authority (role carries no
  // exemption), through the shared liability rule on the lists' side (billing
  // until the club chooses, #5190 Q2), so this admin list agrees with the
  // members list and export.
  return isSubscriptionNotRequiredForMembershipType({
    subscriptionBehavior: effectiveSubscriptionBehavior(
      member.seasonalMembershipAssignments?.[0]?.membershipType
        .subscriptionBehavior,
      member.role
    ),
    member,
    seasonRowStatus: seasonSubscriptionStatus,
    ...rule,
  });
}

/**
 * #5190 (owner decision 22 Nov 2026): the row note for a saved "Not required"
 * season row whose member billing treats as owing, from the shared rule on the
 * lists' side, as the members list and export compute it.
 */
export function subscriptionsListBillingNote(
  subscription: SeasonRowState & {
    member: Parameters<typeof isSubscriptionsListMemberNotRequired>[0] & {
      active: boolean;
      archivedAt: Date | null;
    };
  },
  rule: Parameters<typeof isSubscriptionsListMemberNotRequired>[1],
) {
  const { member } = subscription;
  return notRequiredRowBillingNote({
    subscriptionBehavior: effectiveSubscriptionBehavior(
      member.seasonalMembershipAssignments?.[0]?.membershipType
        .subscriptionBehavior,
      member.role
    ),
    member,
    seasonRow: subscription,
    ...rule,
  });
}
