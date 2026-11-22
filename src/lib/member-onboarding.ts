import {
  evaluateMemberProfileCompleteness,
  type MemberProfileCompletenessInput,
} from "@/lib/member-profile-completeness";
import { buildMemberFacingParentLinks } from "@/lib/member-parent-links";
import {
  hasAccessRole,
  type AccessRoleAssignmentInput,
} from "@/lib/access-roles";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { formatDateOnly } from "@/lib/date-only";

const PARENT_LINK_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  canLogin: true,
  inheritEmailFromId: true,
} as const;

export const MEMBER_ONBOARDING_PROFILE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  dateOfBirth: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
  role: true,
  accessRoles: { select: { role: true } },
  ageTier: true,
  active: true,
  canLogin: true,
  profileCompletedAt: true,
  detailsConfirmedAt: true,
  detailsConfirmedByMemberId: true,
  onboardingConfirmedAt: true,
  inheritEmailFromId: true,
  parent: { select: PARENT_LINK_SELECT },
  secondaryParent: { select: PARENT_LINK_SELECT },
} as const;

/**
 * #2424: the same profile, plus each parent's family groups — the fact the
 * MEMBER-facing family payload needs to decide whether this viewer may have the
 * parent's email address. Kept separate from the select above because that one
 * also loads the onboarding GATE on every authenticated page render, where the
 * parents' group rows would be two joins nobody reads.
 */
export const MEMBER_ONBOARDING_FAMILY_SELECT = {
  ...MEMBER_ONBOARDING_PROFILE_SELECT,
  parent: {
    select: {
      ...PARENT_LINK_SELECT,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  },
  secondaryParent: {
    select: {
      ...PARENT_LINK_SELECT,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  },
} as const;

export const MEMBER_ONBOARDING_GATE_SELECT = {
  ...MEMBER_ONBOARDING_PROFILE_SELECT,
  forcePasswordChange: true,
  financeAccessLevel: true,
  twoFactorEnabled: true,
  // Joined definitions so layout permission checks resolve definition-backed
  // (custom or edited) access roles.
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} as const;

export type MemberOnboardingProfile = MemberProfileCompletenessInput & {
  id: string;
  email?: string | null;
  firstName: string;
  lastName: string;
  streetAddressLine2?: string | null;
  postalAddressLine2?: string | null;
  ageTier?: string | null;
  profileCompletedAt?: Date | string | null;
  onboardingConfirmedAt?: Date | string | null;
  inheritEmailFromId?: string | null;
  parent?: Parameters<typeof buildMemberFacingParentLinks>[0]["parent"];
  secondaryParent?: Parameters<
    typeof buildMemberFacingParentLinks
  >[0]["secondaryParent"];
  forcePasswordChange?: boolean | null;
  financeAccessLevel?: string | null;
  accessRoles?: Array<AccessRoleAssignmentInput> | null;
};

function toDateInputValue(value: Date | string | null | undefined) {
  if (!value) return "";

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ""
      : formatDateOnly(value);
  }

  return value.substring(0, 10);
}

function toOptionalString(value: string | null | undefined) {
  return value ?? "";
}

export function getMemberDisplayName(member: {
  firstName?: string | null;
  lastName?: string | null;
}) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

export function serializeMemberProfile(member: MemberOnboardingProfile) {
  return {
    id: member.id,
    email: toOptionalString(member.email),
    firstName: toOptionalString(member.firstName),
    lastName: toOptionalString(member.lastName),
    phoneCountryCode: toOptionalString(member.phoneCountryCode),
    phoneAreaCode: toOptionalString(member.phoneAreaCode),
    phoneNumber: toOptionalString(member.phoneNumber),
    dateOfBirth: toDateInputValue(member.dateOfBirth),
    streetAddressLine1: toOptionalString(member.streetAddressLine1),
    streetAddressLine2: toOptionalString(member.streetAddressLine2),
    streetCity: toOptionalString(member.streetCity),
    streetRegion: toOptionalString(member.streetRegion),
    streetPostalCode: toOptionalString(member.streetPostalCode),
    streetCountry: toOptionalString(member.streetCountry),
    postalAddressLine1: toOptionalString(member.postalAddressLine1),
    postalAddressLine2: toOptionalString(member.postalAddressLine2),
    postalCity: toOptionalString(member.postalCity),
    postalRegion: toOptionalString(member.postalRegion),
    postalPostalCode: toOptionalString(member.postalPostalCode),
    postalCountry: toOptionalString(member.postalCountry),
  };
}

export function getMemberOnboardingStatus(member: MemberOnboardingProfile) {
  const profileStatus = evaluateMemberProfileCompleteness(member);
  const hasCompletedOnboarding = Boolean(member.onboardingConfirmedAt);
  const needsOnboardingConfirmation =
    profileStatus.confirmationMode === "self" && !hasCompletedOnboarding;

  return {
    ...profileStatus,
    hasCompletedOnboarding,
    needsOnboardingConfirmation,
    requiresWizard:
      profileStatus.confirmationMode === "self" &&
      (!profileStatus.isProfileComplete ||
        !profileStatus.isDetailsConfirmed ||
        !hasCompletedOnboarding),
  };
}

export function shouldShowMemberOnboarding(member: MemberOnboardingProfile) {
  if (
    member.active !== true ||
    member.canLogin !== true ||
    !hasAccessRole(member, "USER") ||
    member.forcePasswordChange === true
  ) {
    return false;
  }

  return getMemberOnboardingStatus(member).requiresWizard;
}

// Single-action, token-scoped routes that must render without the mandatory
// "Confirm member details" onboarding gate. A member who follows a nomination
// confirmation link (`/nominations/<token>`) is completing an action for
// someone else's application; trapping them behind a demand for their own DOB
// and address would block the one thing that page exists to do. This is a
// narrow allowlist by design — the gate still fires on every normal
// authenticated route (dashboard, bookings, profile, etc.).
const ONBOARDING_GATE_EXEMPT_PATH_PREFIXES = ["/nominations/"] as const;

// `pathname` is the value of the `x-pathname` request header, which is
// `${pathname}${search}`; matching by prefix stays correct even when a query
// string is present, and the trailing slash keeps `/nominations` (were an index
// page to exist) and unrelated `/nominations…` paths out of the allowlist.
export function isOnboardingGateExemptPath(
  pathname: string | null | undefined,
): boolean {
  if (!pathname) {
    return false;
  }

  return ONBOARDING_GATE_EXEMPT_PATH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}
