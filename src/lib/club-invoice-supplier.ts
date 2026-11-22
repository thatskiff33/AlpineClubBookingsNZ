import "server-only";

import { CLUB_IDENTITY_SETTINGS_ID, getClubIdentity } from "@/lib/club-identity-settings";
import { postalAddressLines } from "@/lib/postal-address-lines";
import { prisma } from "@/lib/prisma";

/**
 * WHO ISSUES THE APP'S GENERATED BOOKING INVOICE (#5066, owner decision 4 of
 * 15 Nov 2026): the club's legal name and postal address. The lodge is named
 * separately on the document, as the place of stay.
 *
 * Both are Club identity settings (`ClubIdentitySettings.legalName`,
 * `.postalAddress`), admin-edited, never environment configuration
 * (`INV-CONFIG-001`). A club that has not entered a legal name prints its club
 * name (`getClubIdentity().name`, itself DB -> club.json -> default); with no
 * postal address the document prints none, rather than guessing one.
 */
export type ClubInvoiceSupplier = {
  name: string;
  addressLines: string[];
};

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** Pure: the two stored settings and the club's resolved name in, the supplier block out. */
export function resolveClubInvoiceSupplier(
  persisted: { legalName: string | null; postalAddress: string | null } | null,
  clubName: string,
): ClubInvoiceSupplier {
  return {
    name: trimmed(persisted?.legalName) ?? clubName,
    addressLines: postalAddressLines(persisted?.postalAddress),
  };
}

export async function getClubInvoiceSupplier(): Promise<ClubInvoiceSupplier> {
  const [persisted, identity] = await Promise.all([
    prisma.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { legalName: true, postalAddress: true },
    }),
    getClubIdentity(),
  ]);
  return resolveClubInvoiceSupplier(persisted, identity.name);
}
