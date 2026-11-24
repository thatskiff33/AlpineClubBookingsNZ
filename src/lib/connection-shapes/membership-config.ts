/**
 * What the Membership configuration actions send an AI app connection
 * (ALP-720, `INV-MCP-006`). Configuration is the club's own, so a shape sends
 * every setting an officer could change through the matching action: an app
 * never changes a value it cannot read. Left out: the audit columns behind a
 * setting (`persisted`, who saved it), and the Xero item codes and unpaid
 * invoice numbers the lockout screens show only to Finance officers.
 */
import type { ClubPostSettingsValues } from "@/lib/club-post-retention";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  type ConnectionShapeFor,
} from "@/lib/connection-projection";
import type { FinancialYearResolution } from "@/lib/financial-year-server";
import type { MemberFieldsSettingsPayload } from "@/lib/member-fields-settings";
import type { MembershipCancellationSettings } from "@/lib/membership-cancellation-settings";
import type { MembershipLockoutSettings } from "@/lib/membership-lockout-settings";
import type { MembershipNominationSettings } from "@/lib/membership-nomination-settings";
import type { serializeMembershipType } from "@/lib/membership-types";
import type { serializeSubscriptionCategory } from "@/lib/subscription-categories";
import type { SubscriptionLiabilityImpact } from "@/lib/subscription-liability-impact";

// --- Settings ---------------------------------------------------------------
// Complete shapes: a save sends every setting back, so a field the app could
// not read would be saved empty. A new setting fails to compile until it is
// named here.

export const CLUB_POST_SETTINGS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  settings: ClubPostSettingsValues;
  beyondRetention: number;
}>({
  settings: { retentionDays: true, lastCleanupAt: true, lastCleanupDeleted: true },
  beyondRetention: true,
});

export const MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE = completeConnectionShapeFor<
  Omit<MemberFieldsSettingsPayload, "updatedByMemberId">
>({
  settings: { showTitle: true, showGender: true, showOccupation: true, showDietaryRequirements: true },
  updatedAt: true,
});

export const MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  settings: MembershipCancellationSettings;
}>({
  settings: {
    warningText: true,
    rejoinProcessText: true,
    xeroArchiveContactsOnCancellation: true,
    xeroContactGroups: { groupId: true, groupName: true },
  },
});

export const MEMBERSHIP_NOMINATION_SETTINGS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  settings: MembershipNominationSettings;
}>({
  settings: {
    gateEnabled: true,
    minimumMembershipMonths: true,
    minimumNights: true,
    requiredSignOffs: true,
    gateEffectiveFrom: true,
  },
});

export const MEMBERSHIP_LOCKOUT_SETTINGS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  settings: MembershipLockoutSettings;
  financialYear: FinancialYearResolution;
}>({
  settings: {
    mode: true,
    financialYearEndMonthOverride: true,
    textFallbackEnabled: true,
    useFeeScheduleItemCodes: true,
    requiredTypeAgeRule: true,
    liabilityAgeSource: true,
  },
  financialYear: { overrideMonth: true, xeroMonth: true, effectiveMonth: true },
});

const LIABILITY_RULE_SHAPE = { requiredTypeAgeRule: true, liabilityAgeSource: true } as const;
const IMPACT_MEMBER_SHAPE = { memberId: true, name: true, billingChanges: true, accessChanges: true } as const;

/** Who a proposed rule changes, by name; never the unpaid invoice numbers. */
export const LIABILITY_IMPACT_CONNECTION_SHAPE = connectionShapeFor<{ impact: SubscriptionLiabilityImpact }>({
  impact: {
    seasonYear: true,
    current: LIABILITY_RULE_SHAPE,
    proposed: LIABILITY_RULE_SHAPE,
    newlyOwing: IMPACT_MEMBER_SHAPE,
    noLongerOwing: IMPACT_MEMBER_SHAPE,
    staleRecords: { memberId: true, name: true },
  },
});

// --- Membership types and subscription categories ---------------------------

export type MembershipTypeAnswer = ReturnType<typeof serializeMembershipType>;

/** One membership type with its booking, subscription and age-tier rules. */
export const MEMBERSHIP_TYPE_SHAPE = {
  id: true,
  key: true,
  name: true,
  description: true,
  publicDescription: true,
  publiclyListed: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  ageGroupsApply: true,
  sortOrder: true,
  assignmentCount: true,
  allowedAgeTiers: true,
} as const satisfies ConnectionShapeFor<MembershipTypeAnswer>;

export const MEMBERSHIP_TYPE_CONNECTION_SHAPE = connectionShapeFor<{ membershipType: MembershipTypeAnswer }>({
  membershipType: MEMBERSHIP_TYPE_SHAPE,
});

export const MEMBERSHIP_TYPES_REORDERED_CONNECTION_SHAPE = connectionShapeFor<{
  membershipTypes: MembershipTypeAnswer[];
}>({ membershipTypes: MEMBERSHIP_TYPE_SHAPE });

export const MEMBERSHIP_TYPE_MERGED_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  reassignedCount: number;
  sourceId: string;
  targetId: string;
}>({ ok: true, reassignedCount: true, sourceId: true, targetId: true });

type SubscriptionCategoryAnswer = ReturnType<typeof serializeSubscriptionCategory>;

const SUBSCRIPTION_CATEGORY_SHAPE = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
  isBuiltIn: true,
  sortOrder: true,
  assignmentCount: true,
  feeCount: true,
} as const satisfies ConnectionShapeFor<SubscriptionCategoryAnswer>;

export const SUBSCRIPTION_CATEGORY_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  subscriptionCategories: SubscriptionCategoryAnswer[];
}>({ subscriptionCategories: SUBSCRIPTION_CATEGORY_SHAPE });

export const SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE = connectionShapeFor<{
  subscriptionCategory: SubscriptionCategoryAnswer;
}>({ subscriptionCategory: SUBSCRIPTION_CATEGORY_SHAPE });

/** A delete, an activation, or anything else answered with `ok` alone. */
export const CONFIG_OK_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });
