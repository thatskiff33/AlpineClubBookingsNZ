import {
  getMemberProfileCompleteness,
  type MemberProfileCompletenessInput,
} from "@/lib/member-profile-completeness";

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
  ageTier: true,
  active: true,
  canLogin: true,
  profileCompletedAt: true,
  detailsConfirmedAt: true,
  detailsConfirmedByMemberId: true,
  onboardingConfirmedAt: true,
} as const;

export const MEMBER_ONBOARDING_GATE_SELECT = {
  ...MEMBER_ONBOARDING_PROFILE_SELECT,
  forcePasswordChange: true,
  financeAccessLevel: true,
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
  forcePasswordChange?: boolean | null;
  financeAccessLevel?: string | null;
};

function toDateInputValue(value: Date | string | null | undefined) {
  if (!value) return "";

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ""
      : value.toISOString().substring(0, 10);
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
  const profileStatus = getMemberProfileCompleteness(member);
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
    member.role === "LODGE" ||
    member.forcePasswordChange === true
  ) {
    return false;
  }

  return getMemberOnboardingStatus(member).requiresWizard;
}
