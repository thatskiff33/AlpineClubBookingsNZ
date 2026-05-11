import type { XeroContactUpdateData } from "@/lib/xero";
import { prisma } from "@/lib/prisma";
import { getXeroContactNameOrderRepair } from "@/lib/xero-contact-link-mismatches";

export type MemberXeroContactSnapshot = XeroContactUpdateData & {
  firstName: string;
  lastName: string;
};

export type LinkedMemberXeroContactSnapshot = MemberXeroContactSnapshot & {
  xeroContactId?: string | null;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

export function buildXeroContactUpdatePayload(
  member: MemberXeroContactSnapshot
): XeroContactUpdateData {
  return {
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    dateOfBirth: member.dateOfBirth ?? null,
    phoneCountryCode: member.phoneCountryCode ?? null,
    phoneAreaCode: member.phoneAreaCode ?? null,
    phoneNumber: member.phoneNumber ?? null,
    streetAddressLine1: member.streetAddressLine1 ?? null,
    streetAddressLine2: member.streetAddressLine2 ?? null,
    streetCity: member.streetCity ?? null,
    streetRegion: member.streetRegion ?? null,
    streetPostalCode: member.streetPostalCode ?? null,
    streetCountry: member.streetCountry ?? null,
    postalAddressLine1: member.postalAddressLine1 ?? null,
    postalAddressLine2: member.postalAddressLine2 ?? null,
    postalCity: member.postalCity ?? null,
    postalRegion: member.postalRegion ?? null,
    postalPostalCode: member.postalPostalCode ?? null,
    postalCountry: member.postalCountry ?? null,
  };
}

export function hasMemberXeroContactChanges(
  previous: MemberXeroContactSnapshot,
  next: MemberXeroContactSnapshot
): boolean {
  return (
    normalizeOptionalString(previous.email) !== normalizeOptionalString(next.email) ||
    normalizeDateOnly(previous.dateOfBirth) !== normalizeDateOnly(next.dateOfBirth) ||
    normalizeOptionalString(previous.phoneCountryCode) !== normalizeOptionalString(next.phoneCountryCode) ||
    normalizeOptionalString(previous.phoneAreaCode) !== normalizeOptionalString(next.phoneAreaCode) ||
    normalizeOptionalString(previous.phoneNumber) !== normalizeOptionalString(next.phoneNumber) ||
    normalizeOptionalString(previous.streetAddressLine1) !== normalizeOptionalString(next.streetAddressLine1) ||
    normalizeOptionalString(previous.streetAddressLine2) !== normalizeOptionalString(next.streetAddressLine2) ||
    normalizeOptionalString(previous.streetCity) !== normalizeOptionalString(next.streetCity) ||
    normalizeOptionalString(previous.streetRegion) !== normalizeOptionalString(next.streetRegion) ||
    normalizeOptionalString(previous.streetPostalCode) !== normalizeOptionalString(next.streetPostalCode) ||
    normalizeOptionalString(previous.streetCountry) !== normalizeOptionalString(next.streetCountry) ||
    normalizeOptionalString(previous.postalAddressLine1) !== normalizeOptionalString(next.postalAddressLine1) ||
    normalizeOptionalString(previous.postalAddressLine2) !== normalizeOptionalString(next.postalAddressLine2) ||
    normalizeOptionalString(previous.postalCity) !== normalizeOptionalString(next.postalCity) ||
    normalizeOptionalString(previous.postalRegion) !== normalizeOptionalString(next.postalRegion) ||
    normalizeOptionalString(previous.postalPostalCode) !== normalizeOptionalString(next.postalPostalCode) ||
    normalizeOptionalString(previous.postalCountry) !== normalizeOptionalString(next.postalCountry)
  );
}

export async function shouldRepairXeroContactNameOrder(
  member: LinkedMemberXeroContactSnapshot
): Promise<boolean> {
  const xeroContactId = member.xeroContactId?.trim();
  if (!xeroContactId) {
    return false;
  }

  const cachedContact = await prisma.xeroContactCache.findUnique({
    where: { contactId: xeroContactId },
    select: {
      name: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!cachedContact) {
    return false;
  }

  return Boolean(getXeroContactNameOrderRepair(member, cachedContact));
}
