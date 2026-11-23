export const NZ_COUNTRY_NAME = "New Zealand";

export const STREET_ADDRESS_FIELDS = [
  "streetAddressLine1",
  "streetAddressLine2",
  "streetCity",
  "streetRegion",
  "streetPostalCode",
  "streetCountry",
] as const;

export const POSTAL_ADDRESS_FIELDS = [
  "postalAddressLine1",
  "postalAddressLine2",
  "postalCity",
  "postalRegion",
  "postalPostalCode",
  "postalCountry",
] as const;

const POSTAL_ADDRESS_MATERIAL_FIELDS = [
  "postalAddressLine1",
  "postalAddressLine2",
  "postalCity",
  "postalRegion",
  "postalPostalCode",
] as const;

/** All twelve address columns, street then postal: the one list (#5398, #5407). */
export const MEMBER_ADDRESS_FIELDS = [
  ...STREET_ADDRESS_FIELDS,
  ...POSTAL_ADDRESS_FIELDS,
] as const;

export type StreetAddressField = (typeof STREET_ADDRESS_FIELDS)[number];
export type PostalAddressField = (typeof POSTAL_ADDRESS_FIELDS)[number];
export type MemberAddressField = (typeof MEMBER_ADDRESS_FIELDS)[number];

export type StreetAddressValues<T = string> = Record<StreetAddressField, T>;
export type PostalAddressValues<T = string> = Record<PostalAddressField, T>;
export type MemberAddressValues = StreetAddressValues<string> &
  PostalAddressValues<string>;

export type AddressValue = string | null | undefined;

export const STREET_TO_POSTAL_FIELD_MAP: Record<
  StreetAddressField,
  PostalAddressField
> = {
  streetAddressLine1: "postalAddressLine1",
  streetAddressLine2: "postalAddressLine2",
  streetCity: "postalCity",
  streetRegion: "postalRegion",
  streetPostalCode: "postalPostalCode",
  streetCountry: "postalCountry",
};

// test seam
export function normalizeAddressValue(value: AddressValue) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeCountryName(value: AddressValue) {
  const country = normalizeAddressValue(value);
  const upperCountry = country.toUpperCase();

  if (!country || upperCountry === "NZ" || upperCountry === "NZL") {
    return NZ_COUNTRY_NAME;
  }

  return country;
}

export function withDefaultNzCountry(value: AddressValue) {
  return normalizeCountryName(value);
}

export function copyStreetAddressToPostal<T>(
  values: StreetAddressValues<T>
): PostalAddressValues<T> {
  return {
    postalAddressLine1: values.streetAddressLine1,
    postalAddressLine2: values.streetAddressLine2,
    postalCity: values.streetCity,
    postalRegion: values.streetRegion,
    postalPostalCode: values.streetPostalCode,
    postalCountry: values.streetCountry,
  };
}

// test seam
export function postalMatchesPhysical(
  values: Partial<Record<MemberAddressField, AddressValue>>
) {
  return STREET_ADDRESS_FIELDS.every((streetField) => {
    const postalField = STREET_TO_POSTAL_FIELD_MAP[streetField];
    return (
      normalizeAddressValue(values[streetField]) ===
      normalizeAddressValue(values[postalField])
    );
  });
}

function hasMaterialPostalAddressValues(
  values: Partial<Record<PostalAddressField, AddressValue>>
) {
  return POSTAL_ADDRESS_MATERIAL_FIELDS.some((postalField) =>
    Boolean(normalizeAddressValue(values[postalField])),
  );
}

export function shouldDefaultPostalSameAsPhysical(
  values: Partial<Record<MemberAddressField, AddressValue>>
) {
  if (!hasMaterialPostalAddressValues(values)) {
    return true;
  }

  return postalMatchesPhysical({
    ...values,
    streetCountry: normalizeCountryName(values.streetCountry),
    postalCountry: normalizeCountryName(values.postalCountry),
  });
}

export function pickStreetAddressValues<T>(
  values: StreetAddressValues<T> & Partial<PostalAddressValues<T>>
) {
  return {
    streetAddressLine1: values.streetAddressLine1,
    streetAddressLine2: values.streetAddressLine2,
    streetCity: values.streetCity,
    streetRegion: values.streetRegion,
    streetPostalCode: values.streetPostalCode,
    streetCountry: values.streetCountry,
  };
}

/**
 * All twelve address columns, picked from a wider object (#5398): the street
 * and postal lists above, so a source carrying extra keys (an application's
 * `postalSameAsPhysical`) never spreads them into a member write. A field the
 * source leaves out comes back `undefined`, exactly as `values.field` reads,
 * so a write leaves that column alone just as a field-by-field copy did.
 */
export function pickMemberAddressValues<T>(
  values: Partial<Record<MemberAddressField, T>>
): Record<MemberAddressField, T | undefined> {
  return Object.fromEntries(
    MEMBER_ADDRESS_FIELDS.map((field) => [field, values[field]]),
  ) as Record<MemberAddressField, T | undefined>;
}

/** The member's three phone columns, in column order: the one list (#5398). */
export const MEMBER_PHONE_FIELDS = [
  "phoneCountryCode",
  "phoneAreaCode",
  "phoneNumber",
] as const;

export type MemberPhoneField = (typeof MEMBER_PHONE_FIELDS)[number];

/** The member's three phone columns, picked from a wider object (#5398). */
export function pickMemberPhoneValues<T>(
  values: Record<MemberPhoneField, T>
): Record<MemberPhoneField, T> {
  return Object.fromEntries(
    MEMBER_PHONE_FIELDS.map((field) => [field, values[field]]),
  ) as Record<MemberPhoneField, T>;
}
