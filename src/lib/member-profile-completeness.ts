import {
  POSTAL_ADDRESS_FIELDS,
  STREET_ADDRESS_FIELDS,
  type MemberAddressField,
} from "@/lib/member-address";
import { hasAccessRole } from "@/lib/access-roles";

type MemberProfileConfirmationMode = "self" | "delegated" | "not_allowed";

export type MemberProfileMissingField =
  | "firstName"
  | "lastName"
  | "phoneCountryCode"
  | "phoneAreaCode"
  | "phoneNumber"
  | "dateOfBirth"
  | MemberAddressField;

export interface MemberProfileCompletenessInput {
  id?: string | null;
  active?: boolean | null;
  canLogin?: boolean | null;
  role?: string | null;
  accessRoles?: ReadonlyArray<string | { role: string | null }> | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  dateOfBirth?: Date | string | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
  profileCompletedAt?: Date | string | null;
  detailsConfirmedAt?: Date | string | null;
  detailsConfirmedByMemberId?: string | null;
  onboardingConfirmedAt?: Date | string | null;
}

export interface SelfServiceProfilePayloadInput
  extends Omit<
    MemberProfileCompletenessInput,
    | "id"
    | "active"
    | "canLogin"
    | "role"
    | "accessRoles"
    | "profileCompletedAt"
    | "detailsConfirmedAt"
    | "detailsConfirmedByMemberId"
    | "onboardingConfirmedAt"
  > {
  postalSameAsPhysical?: boolean | null;
}

export interface MemberProfileCompletenessResult {
  isProfileComplete: boolean;
  isDetailsConfirmed: boolean;
  canBeBookedAsMember: boolean;
  missingFields: MemberProfileMissingField[];
  needsOwnLoginConfirmation: boolean;
  confirmationMode: MemberProfileConfirmationMode;
}

export interface MemberProfileCompletenessOptions {
  delegatedConfirmationValid?: boolean;
}

export interface SelfServiceProfilePayloadCompletenessResult {
  isProfileComplete: boolean;
  missingFields: MemberProfileMissingField[];
}

const PROFILE_NAME_FIELDS = ["firstName", "lastName"] as const;
const PHONE_FIELDS = ["phoneCountryCode", "phoneAreaCode", "phoneNumber"] as const;
const REQUIRED_STREET_ADDRESS_FIELDS = STREET_ADDRESS_FIELDS.filter(
  (field) => field !== "streetAddressLine2"
);
const REQUIRED_POSTAL_ADDRESS_FIELDS = POSTAL_ADDRESS_FIELDS.filter(
  (field) => field !== "postalAddressLine2"
);

const MEMBER_PROFILE_FIELD_LABELS: Record<MemberProfileMissingField, string> = {
  firstName: "First Name",
  lastName: "Last Name",
  phoneCountryCode: "Phone Country Code",
  phoneAreaCode: "Phone Area Code",
  phoneNumber: "Phone Number",
  dateOfBirth: "Date of Birth",
  streetAddressLine1: "Physical Address Line 1",
  streetAddressLine2: "Physical Address Line 2",
  streetCity: "Physical City / Town",
  streetRegion: "Physical Region",
  streetPostalCode: "Physical Address Postcode",
  streetCountry: "Physical Country",
  postalAddressLine1: "Postal Address Line 1",
  postalAddressLine2: "Postal Address Line 2",
  postalCity: "Postal City / Town",
  postalRegion: "Postal Region",
  postalPostalCode: "Postal Address Postcode",
  postalCountry: "Postal Country",
};

export function formatMemberProfileMissingField(field: MemberProfileMissingField) {
  return MEMBER_PROFILE_FIELD_LABELS[field];
}

export function getMissingMemberProfileFieldDetails(
  missingFields: readonly MemberProfileMissingField[]
) {
  return missingFields.map((key) => ({
    key,
    label: formatMemberProfileMissingField(key),
  }));
}

function hasPresentValue(value: unknown): boolean {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function getProfileMissingFields(
  input: SelfServiceProfilePayloadInput,
  options?: { requirePostalAddress?: boolean }
): MemberProfileMissingField[] {
  const missingFields: MemberProfileMissingField[] = [];
  const requirePostalAddress = options?.requirePostalAddress ?? true;

  for (const field of PROFILE_NAME_FIELDS) {
    if (!hasPresentValue(input[field])) missingFields.push(field);
  }

  for (const field of PHONE_FIELDS) {
    if (!hasPresentValue(input[field])) missingFields.push(field);
  }

  if (!hasPresentValue(input.dateOfBirth)) {
    missingFields.push("dateOfBirth");
  }

  for (const field of REQUIRED_STREET_ADDRESS_FIELDS) {
    if (!hasPresentValue(input[field])) missingFields.push(field);
  }

  if (requirePostalAddress) {
    for (const field of REQUIRED_POSTAL_ADDRESS_FIELDS) {
      if (!hasPresentValue(input[field])) missingFields.push(field);
    }
  }

  return missingFields;
}

export function evaluateSelfServiceProfilePayload(
  input: SelfServiceProfilePayloadInput
): SelfServiceProfilePayloadCompletenessResult {
  const missingFields = getProfileMissingFields(input, {
    requirePostalAddress: !input.postalSameAsPhysical,
  });

  return {
    isProfileComplete: missingFields.length === 0,
    missingFields,
  };
}

// test seam
export function isSelfServiceProfilePayloadComplete(
  input: SelfServiceProfilePayloadInput
): boolean {
  return evaluateSelfServiceProfilePayload(input).isProfileComplete;
}

export function evaluateMemberProfileCompleteness(
  member: MemberProfileCompletenessInput,
  options: MemberProfileCompletenessOptions = {}
): MemberProfileCompletenessResult {
  // Admin-only and lodge kiosk accounts are exempt from the confirm-details
  // onboarding (they are not bookable members). A dual-hat account (USER
  // token alongside admin/lodge roles) books under full member rules (#1442),
  // so it confirms its details like any member — without this, dual-hat
  // admins are permanently canBeBookedAsMember=false and can never be added
  // to their own booking.
  //
  // A record classification, not a privilege decision, so it reads the
  // classification helper with whatever `canLogin` the caller holds rather
  // than the privilege checks that require it (#3603).
  const confirmationExemptRole =
    (hasAccessRole(member, "ADMIN") || hasAccessRole(member, "LODGE")) &&
    !hasAccessRole(member, "USER");
  const confirmationMode: MemberProfileConfirmationMode =
    member.active === false || confirmationExemptRole
      ? "not_allowed"
      : member.canLogin
        ? "self"
        : "delegated";
  const missingFields = getProfileMissingFields(member);
  const isProfileComplete = missingFields.length === 0;
  const selfConfirmedByMember =
    Boolean(member.id) && member.detailsConfirmedByMemberId === member.id;
  const isDetailsConfirmed =
    confirmationMode === "self"
      ? hasPresentValue(member.detailsConfirmedAt) && selfConfirmedByMember
      : confirmationMode === "delegated"
        ? hasPresentValue(member.detailsConfirmedAt) &&
          hasPresentValue(member.detailsConfirmedByMemberId) &&
          options.delegatedConfirmationValid !== false
        : false;

  return {
    isProfileComplete,
    isDetailsConfirmed,
    canBeBookedAsMember:
      member.active !== false && isProfileComplete && isDetailsConfirmed,
    missingFields,
    needsOwnLoginConfirmation:
      confirmationMode === "self" && (!isProfileComplete || !isDetailsConfirmed),
    confirmationMode,
  };
}

export const getMemberProfileCompleteness = evaluateMemberProfileCompleteness;
