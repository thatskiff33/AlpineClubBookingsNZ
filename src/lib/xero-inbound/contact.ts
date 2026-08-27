import { Address, Phone, type Contact, type XeroClient } from "xero-node";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient, XeroDailyLimitError } from "@/lib/xero-api-client";
import { refreshXeroContactCachesFromContact } from "@/lib/xero-contact-cache";
import {
  applyInboundMemberContactPatch,
  XeroContactLinkChangedError,
  XeroMemberUnavailableError,
  type InboundMemberContactPatch,
} from "@/lib/xero-contact-create-recovery";
import { parseXeroContactDateOfBirth } from "@/lib/xero-contact-date-of-birth";
import { xeroCalendarDateAsDateOnly } from "@/lib/xero-provider-dates";
import { writeXeroInboundAuditLogs } from "./audit";

function extractContactPhone(contact: Contact) {
  const phones = contact.phones ?? [];
  const mobile = phones.find(
    (phone) =>
      phone.phoneNumber && phone.phoneType === Phone.PhoneTypeEnum.MOBILE
  );
  const best = mobile ?? phones.find((phone) => phone.phoneNumber);
  if (!best?.phoneNumber) {
    return null;
  }

  return {
    phoneCountryCode: best.phoneCountryCode ?? null,
    phoneAreaCode: best.phoneAreaCode ?? null,
    phoneNumber: best.phoneNumber,
  };
}

function extractContactAddresses(contact: Contact) {
  const addresses = contact.addresses ?? [];
  const street = addresses.find(
    (address) =>
      address.addressType === Address.AddressTypeEnum.STREET && address.addressLine1
  );
  const postal = addresses.find(
    (address) =>
      address.addressType === Address.AddressTypeEnum.POBOX && address.addressLine1
  );

  return {
    street: street
      ? {
          streetAddressLine1: street.addressLine1 ?? null,
          streetAddressLine2: street.addressLine2 ?? null,
          streetCity: street.city ?? null,
          streetRegion: street.region ?? null,
          streetPostalCode: street.postalCode ?? null,
          streetCountry: street.country ?? null,
        }
      : null,
    postal: postal
      ? {
          postalAddressLine1: postal.addressLine1 ?? null,
          postalAddressLine2: postal.addressLine2 ?? null,
          postalCity: postal.city ?? null,
          postalRegion: postal.region ?? null,
          postalPostalCode: postal.postalCode ?? null,
          postalCountry: postal.country ?? null,
        }
      : null,
  };
}

/**
 * The calendar day of a contact's earliest Xero invoice, as the UTC-midnight
 * date-only value `Member.joinedDate` holds.
 *
 * A private sibling of the exported reader in `xero-contacts.ts`: the workflow
 * label and the operation ledger context differ, the temporal semantics do not,
 * and both now decode through the one Xero boundary rather than through two
 * copies of `new Date(...)`.
 */
async function getContactFirstInvoiceDate(
  xero: XeroClient,
  tenantId: string,
  contactId: string
): Promise<Date | null> {
  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined,
          undefined,
          "Date ASC",
          undefined,
          undefined,
          [contactId],
          undefined,
          1,
          false,
          false,
          undefined,
          false
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "reconcileXeroContact",
        context: `reconcileContactFirstInvoiceDate(${contactId})`,
      }
    );
    // Same classification as the exported reader in `xero-contacts.ts` — see
    // `xero-provider-dates.ts`. This clone existed BEFORE that boundary did, and
    // it carried the identical `new Date(provider.date)` hazard one indirection
    // away from the spelling any census was searching for (#2869, INV-DATE-019).
    return xeroCalendarDateAsDateOnly(response.body.invoices?.[0]?.date);
  } catch (error) {
    if (error instanceof XeroDailyLimitError) {
      throw error;
    }

    logger.warn({ err: error, contactId }, "Failed to fetch first Xero invoice date for contact");
    return null;
  }
}

export async function resolveMemberIdsForContact(contactId: string): Promise<string[]> {
  const [members, links] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: contactId,
      },
      select: {
        id: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Member",
        xeroObjectType: "CONTACT",
        xeroObjectId: contactId,
        role: "CONTACT",
        active: true,
      },
      select: {
        localId: true,
      },
    }),
  ]);

  return [...new Set([...members.map((member) => member.id), ...links.map((link) => link.localId)])];
}

export async function reconcileXeroContact(contactId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getContact(tenantId, contactId),
    {
      operation: "getContact",
      resourceType: "CONTACT",
      workflow: "reconcileXeroContact",
      context: `reconcileXeroContact(${contactId})`,
    }
  );
  const contact = response.body.contacts?.[0];

  if (!contact?.contactID) {
    throw new Error(`Xero contact ${contactId} was not found`);
  }

  const fetchedAt = new Date();
  const { cachedContact, groupMemberships } =
    await refreshXeroContactCachesFromContact(contact, fetchedAt);
  const phone = extractContactPhone(contact);
  const addresses = extractContactAddresses(contact);

  const memberIds = await resolveMemberIdsForContact(contactId);
  if (memberIds.length === 0) {
    return {
      handled: true,
      kind: "CONTACT",
      resourceId: contactId,
      matchedMembers: 0,
      updatedMembers: 0,
      linkedMembers: 0,
      backfilledFields: 0,
      cacheUpdated: cachedContact !== null,
      contactGroupsSeen: groupMemberships.contactGroupsSeen,
      groupMembershipsAdded: groupMemberships.membershipsAdded,
      groupMembershipsRemoved: groupMemberships.membershipsRemoved,
    };
  }

  const members = await prisma.member.findMany({
    where: {
      id: {
        in: memberIds,
      },
    },
    select: {
      id: true,
      xeroContactId: true,
      dateOfBirth: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      streetAddressLine1: true,
      postalAddressLine1: true,
      joinedDate: true,
    },
  });
  const dateOfBirth = parseXeroContactDateOfBirth(contact.companyNumber);
  const joinedDate = members.some((member) => !member.joinedDate)
    ? await getContactFirstInvoiceDate(xero, tenantId, contactId)
    : null;
  const canApplyCanonicalLink = members.length === 1;
  let updatedMembers = 0;
  let linkedMembers = 0;
  let backfilledFields = 0;

  for (const member of members) {
    const patch: InboundMemberContactPatch = {
      dateOfBirth,
      joinedDate,
      ...(phone ?? {}),
      ...(addresses.street ?? {}),
      ...(addresses.postal ?? {}),
    };
    let applied;
    try {
      applied = await applyInboundMemberContactPatch({
        memberId: member.id,
        xeroContactId: contactId,
        patch,
        setCanonicalLink: canApplyCanonicalLink,
      });
    } catch (error) {
      if (
        error instanceof XeroMemberUnavailableError ||
        error instanceof XeroContactLinkChangedError ||
        (error instanceof Error && error.message === `Member not found: ${member.id}`)
      ) {
        logger.info(
          { memberId: member.id, contactId, reason: error.message },
          "Skipped stale inbound Xero contact participant",
        );
        continue;
      }
      throw error;
    }

    const updateKeys = applied.appliedFields;
    if (applied.linked) linkedMembers += 1;
    if (updateKeys.length > 0) {
      updatedMembers += 1;
      backfilledFields += updateKeys.length;
      await writeXeroInboundAuditLogs({
        source: "xero-inbound-contact",
        links: [
          {
            localModel: "Member",
            localId: member.id,
            xeroObjectType: "CONTACT",
            xeroObjectId: contactId,
            role: "CONTACT",
          },
        ],
        metadata: {
          changedFields: updateKeys,
        },
      });
    }
  }

  return {
    handled: true,
    kind: "CONTACT",
    resourceId: contactId,
    matchedMembers: members.length,
    updatedMembers,
    linkedMembers,
    backfilledFields,
    cacheUpdated: cachedContact !== null,
    contactGroupsSeen: groupMemberships.contactGroupsSeen,
    groupMembershipsAdded: groupMemberships.membershipsAdded,
    groupMembershipsRemoved: groupMemberships.membershipsRemoved,
  };
}
