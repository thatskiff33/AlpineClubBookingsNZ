/**
 * A membership application's stored fields: the address and family-member
 * shapes, the parsers that read them back out of their JSON columns, and the
 * error those parsers and the application flow throw. A leaf shared by
 * `nomination.ts` and `member-application-mapping.ts`, so the two do not
 * import each other (#4930, INV-SSOT-007: no import loop).
 */
import { z } from "zod";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { nameField } from "@/lib/zod-helpers";

const maxStr = (len: number) => z.string().max(len).optional().nullable();
// Deliberately NOT `dateOnlyStringSchema`: this is the READ schema
// `parseApplicationFamilyMembers` runs over already-stored JSON, and a refusal
// here would blank the nominating member's page. Write paths refuse a non-day
// where it arrives (#3082; `member-application-date-of-birth.ts`).
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

const applicationAddressSchema = z.object({
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

const familyMemberSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  dateOfBirth: isoDateSchema,
});

export type ApplicationAddress = z.infer<typeof applicationAddressSchema>;
export type ApplicationFamilyMember = z.infer<typeof familyMemberSchema>;

export class MembershipApplicationError extends Error {
  status: number;
  details?: Record<string, string[]>;

  constructor(message: string, status = 400, details?: Record<string, string[]>) {
    super(message);
    this.name = "MembershipApplicationError";
    this.status = status;
    this.details = details;
  }
}

export function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

export function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

export function parseApplicantPhone(phone: string | null) {
  const trimmed = cleanNullableString(phone);
  if (!trimmed) {
    return {
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: null,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3) {
    return {
      phoneCountryCode: parts[0] || null,
      phoneAreaCode: parts[1] || null,
      phoneNumber: parts.slice(2).join(" ") || null,
    };
  }

  return {
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: trimmed,
  };
}

export function parseApplicationAddress(raw: unknown): ApplicationAddress {
  if (raw == null) {
    return {
      streetAddressLine1: null,
      streetAddressLine2: null,
      streetCity: null,
      streetRegion: null,
      streetPostalCode: null,
      streetCountry: null,
      postalAddressLine1: null,
      postalAddressLine2: null,
      postalCity: null,
      postalRegion: null,
      postalPostalCode: null,
      postalCountry: null,
      postalSameAsPhysical: false,
    };
  }

  const parsed = applicationAddressSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored application address is invalid", 500);
  }

  const {
    streetAddressLine1,
    streetAddressLine2,
    streetCity,
    streetRegion,
    streetPostalCode,
    streetCountry,
    postalAddressLine1,
    postalAddressLine2,
    postalCity,
    postalRegion,
    postalPostalCode,
    postalCountry,
    postalSameAsPhysical,
  } = parsed.data;

  const normalized = {
    streetAddressLine1: cleanNullableString(streetAddressLine1),
    streetAddressLine2: cleanNullableString(streetAddressLine2),
    streetCity: cleanNullableString(streetCity),
    streetRegion: cleanNullableString(streetRegion),
    streetPostalCode: cleanNullableString(streetPostalCode),
    streetCountry: cleanNullableString(streetCountry),
    postalAddressLine1: cleanNullableString(postalAddressLine1),
    postalAddressLine2: cleanNullableString(postalAddressLine2),
    postalCity: cleanNullableString(postalCity),
    postalRegion: cleanNullableString(postalRegion),
    postalPostalCode: cleanNullableString(postalPostalCode),
    postalCountry: cleanNullableString(postalCountry),
    postalSameAsPhysical: Boolean(postalSameAsPhysical),
  };

  if (normalized.postalSameAsPhysical) {
    return {
      ...normalized,
      ...copyStreetAddressToPostal({
        streetAddressLine1: normalized.streetAddressLine1,
        streetAddressLine2: normalized.streetAddressLine2,
        streetCity: normalized.streetCity,
        streetRegion: normalized.streetRegion,
        streetPostalCode: normalized.streetPostalCode,
        streetCountry: normalized.streetCountry,
      }),
    };
  }

  return normalized;
}

export function parseApplicationFamilyMembers(raw: unknown): ApplicationFamilyMember[] {
  if (raw == null) {
    return [];
  }

  const parsed = z.array(familyMemberSchema).safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored family member details are invalid", 500);
  }

  return parsed.data.map((member) => ({
    firstName: cleanString(member.firstName),
    lastName: cleanString(member.lastName),
    dateOfBirth: member.dateOfBirth,
  }));
}
