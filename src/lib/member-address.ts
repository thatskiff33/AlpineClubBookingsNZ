export const NZ_COUNTRY_CODE = "NZ";

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

export function normalizeAddressValue(value: AddressValue) {
  return typeof value === "string" ? value.trim() : "";
}

export function withDefaultNzCountry(value: AddressValue) {
  return normalizeAddressValue(value) || NZ_COUNTRY_CODE;
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
