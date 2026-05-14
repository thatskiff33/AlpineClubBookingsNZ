export interface AddressSelection {
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface AddyAddressDetails {
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  city?: string | null;
  country?: string | null;
  displayline?: string | null;
  full?: string | null;
  mailtown?: string | null;
  postcode?: string | null;
  region?: string | null;
  suburb?: string | null;
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.find((value) => value && value.trim())?.trim() ?? "";
}

export function mapAddyAddressToSelection(
  address: AddyAddressDetails,
): AddressSelection {
  const address2 = firstNonEmpty(address.address2);
  const suburb = firstNonEmpty(address.suburb);
  const isRuralDelivery = address2.startsWith("RD ");

  return {
    addressLine1: firstNonEmpty(
      isRuralDelivery || firstNonEmpty(address.address4)
        ? address.address1
        : address.displayline,
      address.address1,
      address.full,
    ),
    addressLine2: isRuralDelivery
      ? address2
      : firstNonEmpty(suburb, address2),
    city: firstNonEmpty(address.mailtown, address.city),
    region: firstNonEmpty(address.region),
    postalCode: firstNonEmpty(address.postcode),
    country: firstNonEmpty(address.country, "NZ"),
  };
}
