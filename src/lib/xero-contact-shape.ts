/**
 * THE one place that decides what a Xero contact payload LOOKS LIKE, for a
 * person and for an organisation alike (#3367, stage 2 of programme #2912).
 * INV-SSOT, INV-CONFIG-005.
 *
 * ## Why this module exists at all
 *
 * Before stage 2 there was exactly one kind of Xero contact this application
 * could build: a person. `buildMemberXeroContactCreatePayload` therefore hard-set
 * `firstName` and `lastName` and composed `name` out of them, which is why a
 * school arrived in Xero as a surnameless human — the defect programme #2912
 * exists to fix.
 *
 * A school needs the OTHER shape Xero models on the same resource: a contact
 * carrying `name` alone, with the person-name fields omitted, and the real human
 * attached through `contactPersons`. The obvious way to get one is a second
 * payload builder that copies the first, and that is precisely what this module
 * exists to prevent. Two builders means two places that decide whether an
 * address goes through the containment policy, two places that decide the key
 * ORDER of the object (see below), and two places to forget the next field. So
 * both shapes are produced HERE, by one function, and the two callers differ
 * only in what they pass it.
 *
 * ## `isCustomer` is NOT how a contact declares it is an organisation
 *
 * Xero's `Contact` carries an `isCustomer` flag and it reads like the answer.
 * It is not: it cannot be SET on write at all — Xero raises it itself the first
 * time an invoice names the contact — so nothing may key organisation-ness off
 * it, either when writing or when reading back. What makes a contact
 * organisation-shaped is the ABSENCE of `firstName`/`lastName` beside a
 * populated `name`, which is what {@link buildXeroContactShape} produces when it
 * is handed no `person`.
 *
 * ## KEY ORDER IS LOAD-BEARING — do not tidy it
 *
 * `buildXeroPayloadHash` hashes the outbound request object, and that hash is
 * part of a Xero idempotency key. Reordering the properties below would change
 * every key it produces, so a retry would no longer converge on the operation it
 * is retrying. The member create payload's order is therefore pinned exactly as
 * it shipped — `name`, the person names, `emailAddress`, the company-number
 * patch, `phones`, `addresses` — and the organisation-only `contactPersons` is
 * APPENDED after all of them rather than slotted in beside the person fields it
 * conceptually replaces.
 *
 * `updateXeroContact` deliberately does NOT use this builder. Its payload leads
 * with `contactID` and puts the names LAST, and that order is baked into its own
 * `v2` idempotency key the same way; routing it through here would silently
 * re-key every contact update in flight. It shares {@link buildXeroAddresses}
 * with this module and nothing else, which is the part that has no ordering
 * consequence.
 *
 * ## Every address still goes through the containment policy
 *
 * Both the contact's own address and each contact person's address are written
 * through `applyXeroContactEmailPolicy`, which is the identity function on the
 * club's live site and the containment transform on a copy (INV-CONFIG-005). A
 * caller cannot reach this function without a policy token, because the token
 * type can only be produced by `xero-contact-containment.ts` after the
 * environment role has been read. That is the same compile-time guarantee the
 * person builder always had, extended to the new shape rather than duplicated
 * beside it.
 */

import { Address, type Contact, Phone } from "xero-node";

import {
  applyXeroContactEmailPolicy,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";

/**
 * The address columns a contact payload reads. Structural rather than a Prisma
 * type, because the two callers pass different rows — a locked `Member`
 * snapshot and an update payload — and an organisation passes none at all.
 */
export type XeroContactAddressSource = {
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
  postalCountry?: string | null;
  postalPostalCode?: string | null;
};

/** The phone parts a contact payload reads, from wherever the caller holds them. */
export type XeroContactPhoneSource = {
  countryCode?: string | null;
  areaCode?: string | null;
  number?: string | null;
};

/**
 * A named human attached to an ORGANISATION's contact — the teacher on a
 * school's record (#3367, owner decision of 13 September 2026).
 *
 * `includeInEmails` is deliberately NOT part of this input and is always written
 * `false`. A contact person Xero is told to include receives Xero's own invoice
 * mail from Xero's own servers, which this application cannot see, cannot
 * suppress with the booking's "no emails" switch, and cannot contain on a copy
 * beyond replacing the stored address. The purpose the owner asked for is that
 * the treasurer can see WHO TO TALK TO without leaving Xero, and a name plus an
 * address on the record achieves that without adding a second delivery channel.
 */
export type XeroContactPersonInput = {
  firstName: string;
  lastName: string;
  email: string;
};

export function buildXeroAddresses(
  source: XeroContactAddressSource,
): Address[] {
  const addresses: Address[] = [];
  if (source.streetAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.STREET,
      addressLine1: source.streetAddressLine1,
      addressLine2: source.streetAddressLine2 || "",
      city: source.streetCity || "",
      region: source.streetRegion || "",
      postalCode: source.streetPostalCode || "",
      country: source.streetCountry || "",
    });
  }
  if (source.postalAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.POBOX,
      addressLine1: source.postalAddressLine1,
      addressLine2: source.postalAddressLine2 || "",
      city: source.postalCity || "",
      region: source.postalRegion || "",
      postalCode: source.postalPostalCode || "",
      country: source.postalCountry || "",
    });
  }
  return addresses;
}

/**
 * Build a Xero contact-create payload, person-shaped or organisation-shaped.
 *
 * Pass `person` and you get the shape this application has always sent: `name`
 * composed by the caller, plus `firstName` and `lastName`. Omit it and you get
 * an organisation: `name` alone, with neither person-name key present at all
 * rather than present-and-empty, because an empty surname beside a populated
 * one is exactly what Xero renders as a nameless human today.
 *
 * See the module docblock before changing the order of anything below.
 */
export function buildXeroContactShape(
  policy: XeroContactEmailPolicy,
  input: {
    /** Xero's required display name: a person's full name, or the organisation's. */
    name: string;
    /** Present for a person, absent for an organisation. */
    person?: { firstName: string; lastName: string } | null;
    /** The contact's own address. Empty string means "known to be empty". */
    email: string;
    /**
     * Fields spliced in after `emailAddress`, in the member create payload's
     * historical position — today only `buildXeroContactCompanyNumberPatch`.
     */
    extraFields?: Partial<Contact>;
    phone?: XeroContactPhoneSource | null;
    addresses?: XeroContactAddressSource | null;
    /** Organisation only. See {@link XeroContactPersonInput}. */
    contactPersons?: readonly XeroContactPersonInput[] | null;
  },
): Contact {
  const person = input.person ?? null;
  const phone = input.phone ?? null;
  const contactPersons = input.contactPersons ?? null;
  const hasAnyPhonePart = Boolean(
    phone?.countryCode?.trim() ||
      phone?.areaCode?.trim() ||
      phone?.number?.trim(),
  );

  return {
    name: input.name,
    ...(person
      ? { firstName: person.firstName, lastName: person.lastName }
      : {}),
    emailAddress: applyXeroContactEmailPolicy(policy, input.email),
    ...(input.extraFields ?? {}),
    phones: hasAnyPhonePart
      ? [
          {
            phoneType: Phone.PhoneTypeEnum.MOBILE,
            phoneCountryCode: phone?.countryCode || "",
            phoneAreaCode: phone?.areaCode || "",
            phoneNumber: phone?.number || "",
          },
        ]
      : [],
    addresses: buildXeroAddresses(input.addresses ?? {}),
    ...(contactPersons
      ? {
          contactPersons: contactPersons.map((entry) => ({
            firstName: entry.firstName,
            lastName: entry.lastName,
            emailAddress: applyXeroContactEmailPolicy(policy, entry.email),
            // Never true. See XeroContactPersonInput's docblock for why.
            includeInEmails: false,
          })),
        }
      : {}),
  };
}
