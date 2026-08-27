/**
 * Xero contact cache mapping and refresh helpers.
 *
 * Translates a Xero `Contact` payload into the local `XeroContactCache`
 * snapshot and keeps the per-contact `XeroContactGroupMembershipCache`
 * rows in sync. Other Xero domain modules depend on these primitives
 * but this module deliberately has no dependency on contact CRUD or
 * bulk sync flows.
 */

import {
  Address,
  Contact,
  ContactGroup,
  Phone,
  type XeroClient,
} from "xero-node";
import { prisma } from "./prisma";
import { xeroInstant } from "@/lib/xero-provider-dates";
import { callXeroApi } from "./xero-api-client";
import {
  DEFAULT_XERO_SYNC_SCOPE,
} from "./xero-sync-cursors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTACT_GROUP_CACHE_CURSOR_RESOURCE = "CONTACT_GROUP_CACHE";
/**
 * Cursor resource tracking only the last *full* contact-group cache rebuild
 * (the "Refresh Xero Groups" admin action). Distinct from
 * `CONTACT_GROUP_CACHE_CURSOR_RESOURCE`, whose `lastSuccessfulSyncAt` is also
 * bumped by per-contact reconciliation (member link/import, inbound contact
 * webhooks, cancellation, bulk sync). The admin members page reads this cursor
 * so its "last refreshed" hint reflects staleness of the whole cached snapshot,
 * not a single-contact touch.
 */
export const CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE =
  "CONTACT_GROUP_FULL_REFRESH";
const XERO_PAGE_SIZE = 100;
const XERO_CONTACT_ID_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedXeroContact {
  contactId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  companyNumber: string | null;
  contactStatus: string;
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  streetAddressLine1: string | null;
  streetAddressLine2: string | null;
  streetCity: string | null;
  streetRegion: string | null;
  streetPostalCode: string | null;
  streetCountry: string | null;
  postalAddressLine1: string | null;
  postalAddressLine2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountry: string | null;
}

interface RefreshXeroContactGroupMembershipCacheForContactResult {
  contactId: string | null;
  observed: boolean;
  contactGroupsSeen: number;
  membershipsAdded: number;
  membershipsRemoved: number;
  groupsTouched: number;
  reason?: string;
}

export interface RefreshXeroContactCachesFromContactResult {
  cachedContact: CachedXeroContact | null;
  groupMemberships: RefreshXeroContactGroupMembershipCacheForContactResult;
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

/**
 * Find the best phone from a Xero contact's phones array and return structured
 * fields. Prefers MOBILE, falls back to any phone with a number.
 */
function getXeroContactPhoneStructured(
  phones?: Array<{
    phoneType?: Phone.PhoneTypeEnum;
    phoneCountryCode?: string;
    phoneAreaCode?: string;
    phoneNumber?: string;
  }>
): {
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string;
} | null {
  if (!phones) return null;
  const mobile = phones.find(
    (p) => p.phoneNumber && p.phoneType === Phone.PhoneTypeEnum.MOBILE
  );
  const best = mobile || phones.find((p) => p.phoneNumber);
  if (!best || !best.phoneNumber) return null;
  return {
    phoneCountryCode: best.phoneCountryCode || null,
    phoneAreaCode: best.phoneAreaCode || null,
    phoneNumber: best.phoneNumber,
  };
}

/**
 * Extract structured address data from a Xero contact's addresses array.
 * Returns STREET and POBOX addresses separately.
 */
function getXeroContactAddresses(
  addresses?: Array<{
    addressType?: Address.AddressTypeEnum;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  }>
): {
  street: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  postal: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
} {
  if (!addresses) return { street: null, postal: null };

  const extract = (addr: (typeof addresses)[0]) => ({
    addressLine1: addr.addressLine1 || null,
    addressLine2: addr.addressLine2 || null,
    city: addr.city || null,
    region: addr.region || null,
    postalCode: addr.postalCode || null,
    country: addr.country || null,
  });

  const streetAddr = addresses.find(
    (a) =>
      a.addressType === Address.AddressTypeEnum.STREET && a.addressLine1
  );
  const postalAddr = addresses.find(
    (a) =>
      a.addressType === Address.AddressTypeEnum.POBOX && a.addressLine1
  );

  return {
    street: streetAddr ? extract(streetAddr) : null,
    postal: postalAddr ? extract(postalAddr) : null,
  };
}

export function getXeroContactDisplayName(contact: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  return (
    contact.name ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    "Unknown"
  );
}

/**
 * The exact moment Xero last changed this contact, or `null`.
 *
 * `updatedDateUTC` is an INSTANT — the provider names its zone in the field —
 * and it is classified at the Xero boundary rather than round-tripped through
 * `new Date(value.toString())`.
 *
 * WHAT THAT ROUND TRIP ACTUALLY COST, stated at the size it is (#2869 review).
 * `xero-node` types this field `Date` and its deserialiser builds one, so on the
 * SDK path the old code rendered a `Date` to its host-local string and parsed it
 * back — which recovers the SAME INSTANT, and loses only the MILLISECONDS,
 * because `Date.prototype.toString()` renders to the second. That is the whole
 * of the reachable defect here: `XeroContactCache.sourceUpdatedAt` could sit up
 * to 999 ms behind Xero's own value, which is enough to make a
 * changed-since comparison flap and is not enough to move a day.
 *
 * The larger hazard the boundary exists for — an offset-less
 * `"2019-03-11T00:00:00"` resolved in the container's zone, up to thirteen hours
 * out — belongs to the fields that arrive as TEXT rather than through the
 * deserialiser, and is documented at the boundary itself. Routing this call
 * there as well is not a cost: it costs one function call and it means a payload
 * that did NOT come through the deserialiser (a replayed body, a fixture, a
 * cached response) is read correctly instead of by luck.
 */
function getXeroContactSourceUpdatedAt(contact: Contact): Date | null {
  return xeroInstant(contact.updatedDateUTC);
}

function buildCachedXeroContact(
  contact: Contact
): CachedXeroContact | null {
  if (!contact.contactID) {
    return null;
  }

  const phone = getXeroContactPhoneStructured(contact.phones);
  const addresses = getXeroContactAddresses(contact.addresses);

  return {
    contactId: contact.contactID,
    name: contact.name ?? null,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    emailAddress: contact.emailAddress ?? null,
    // #2859: `?? null` collapses "Xero returned no value for this field" into
    // "Xero's field is empty", and downstream that difference matters — a cache
    // row holding `null` is what `buildXeroContactCompanyNumberPatch` reads as
    // permission to write a date of birth into the NZBN field. Safe as written,
    // because every endpoint feeding this builder returns FULL contacts: Xero
    // omits `CompanyNumber` only in `summaryOnly` responses, and nothing in this
    // repository sets that flag. Do not introduce a summary-mode caller without
    // revisiting this line.
    companyNumber: contact.companyNumber ?? null,
    contactStatus: contact.contactStatus?.toString() || "ACTIVE",
    phoneCountryCode: phone?.phoneCountryCode ?? null,
    phoneAreaCode: phone?.phoneAreaCode ?? null,
    phoneNumber: phone?.phoneNumber ?? null,
    streetAddressLine1: addresses.street?.addressLine1 ?? null,
    streetAddressLine2: addresses.street?.addressLine2 ?? null,
    streetCity: addresses.street?.city ?? null,
    streetRegion: addresses.street?.region ?? null,
    streetPostalCode: addresses.street?.postalCode ?? null,
    streetCountry: addresses.street?.country ?? null,
    postalAddressLine1: addresses.postal?.addressLine1 ?? null,
    postalAddressLine2: addresses.postal?.addressLine2 ?? null,
    postalCity: addresses.postal?.city ?? null,
    postalRegion: addresses.postal?.region ?? null,
    postalPostalCode: addresses.postal?.postalCode ?? null,
    postalCountry: addresses.postal?.country ?? null,
  };
}

export function extractActiveXeroContactGroups(contact: Contact) {
  if (!Array.isArray(contact.contactGroups)) {
    return null;
  }

  const groupsById = new Map<string, { id: string; name: string | null }>();

  for (const group of contact.contactGroups) {
    const groupId =
      typeof group.contactGroupID === "string"
        ? group.contactGroupID.trim()
        : "";
    if (!groupId || group.status === ContactGroup.StatusEnum.DELETED) {
      continue;
    }

    const groupName =
      typeof group.name === "string" && group.name.trim().length > 0
        ? group.name.trim()
        : null;

    groupsById.set(groupId, {
      id: groupId,
      name: groupName,
    });
  }

  return Array.from(groupsById.values());
}

// ---------------------------------------------------------------------------
// Cache writes
// ---------------------------------------------------------------------------

async function refreshXeroContactGroupMembershipCacheForContact(
  contact: Contact,
  fetchedAt: Date = new Date()
): Promise<RefreshXeroContactGroupMembershipCacheForContactResult> {
  if (!contact.contactID) {
    return {
      contactId: null,
      observed: false,
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
      groupsTouched: 0,
      reason: "Xero contact payload did not include a contactID.",
    };
  }

  const activeGroups = extractActiveXeroContactGroups(contact);
  if (!activeGroups) {
    return {
      contactId: contact.contactID,
      observed: false,
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
      groupsTouched: 0,
      reason: "Xero contact payload did not include contactGroups.",
    };
  }

  const contactId = contact.contactID;
  const sourceUpdatedAt = getXeroContactSourceUpdatedAt(contact) ?? fetchedAt;
  const contactName = getXeroContactDisplayName(contact) || null;
  const desiredGroupIds = activeGroups.map((group) => group.id);
  const existingGroups =
    desiredGroupIds.length > 0
      ? await prisma.xeroContactGroupCache.findMany({
          where: {
            contactGroupId: {
              in: desiredGroupIds,
            },
          },
          select: {
            contactGroupId: true,
            name: true,
          },
        })
      : [];
  const existingGroupNames = new Map(
    existingGroups.map((group) => [group.contactGroupId, group.name])
  );

  await Promise.all(
    activeGroups.map((group) =>
      prisma.xeroContactGroupCache.upsert({
        where: {
          contactGroupId: group.id,
        },
        create: {
          contactGroupId: group.id,
          name: group.name ?? existingGroupNames.get(group.id) ?? group.id,
          status: "ACTIVE",
          contactCount: 0,
          fetchedAt,
          sourceUpdatedAt,
        },
        update: {
          name: group.name ?? existingGroupNames.get(group.id) ?? group.id,
          status: "ACTIVE",
          fetchedAt,
          sourceUpdatedAt,
        },
      })
    )
  );

  return prisma.$transaction(
    async (tx) => {
      const previousMemberships =
        await tx.xeroContactGroupMembershipCache.findMany({
          where: {
            contactId,
          },
          select: {
            contactGroupId: true,
          },
        });
      const previousGroupIds = previousMemberships.map(
        (membership) => membership.contactGroupId
      );
      const previousGroupIdSet = new Set(previousGroupIds);
      const desiredGroupIdSet = new Set(desiredGroupIds);
      const addedGroupIds = desiredGroupIds.filter(
        (groupId) => !previousGroupIdSet.has(groupId)
      );
      const removedGroupIds = previousGroupIds.filter(
        (groupId) => !desiredGroupIdSet.has(groupId)
      );
      const retainedGroupIds = desiredGroupIds.filter((groupId) =>
        previousGroupIdSet.has(groupId)
      );

      if (removedGroupIds.length > 0) {
        await tx.xeroContactGroupMembershipCache.deleteMany({
          where: {
            contactId,
            contactGroupId: {
              in: removedGroupIds,
            },
          },
        });

        await tx.xeroContactGroupCache.updateMany({
          where: {
            contactGroupId: {
              in: removedGroupIds,
            },
            contactCount: {
              gt: 0,
            },
          },
          data: {
            contactCount: {
              decrement: 1,
            },
            fetchedAt,
            sourceUpdatedAt,
          },
        });
      }

      if (retainedGroupIds.length > 0) {
        await tx.xeroContactGroupMembershipCache.updateMany({
          where: {
            contactId,
            contactGroupId: {
              in: retainedGroupIds,
            },
          },
          data: {
            contactName,
            fetchedAt,
          },
        });
      }

      if (addedGroupIds.length > 0) {
        await tx.xeroContactGroupMembershipCache.createMany({
          data: activeGroups
            .filter((group) => addedGroupIds.includes(group.id))
            .map((group) => ({
              contactGroupId: group.id,
              contactId,
              contactName,
              fetchedAt,
            })),
          skipDuplicates: true,
        });

        await tx.xeroContactGroupCache.updateMany({
          where: {
            contactGroupId: {
              in: addedGroupIds,
            },
          },
          data: {
            contactCount: {
              increment: 1,
            },
            fetchedAt,
            sourceUpdatedAt,
          },
        });
      }

      await tx.xeroSyncCursor.upsert({
        where: {
          resourceType_scope: {
            resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
            scope: DEFAULT_XERO_SYNC_SCOPE,
          },
        },
        create: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
          cursorDateTime: sourceUpdatedAt,
          lastSuccessfulSyncAt: fetchedAt,
        },
        update: {
          cursorDateTime: sourceUpdatedAt,
          lastSuccessfulSyncAt: fetchedAt,
        },
      });

      return {
        contactId,
        observed: true,
        contactGroupsSeen: activeGroups.length,
        membershipsAdded: addedGroupIds.length,
        membershipsRemoved: removedGroupIds.length,
        groupsTouched: Array.from(
          new Set([...desiredGroupIds, ...removedGroupIds])
        ).length,
      } satisfies RefreshXeroContactGroupMembershipCacheForContactResult;
    },
    { timeout: 15000 }
  );
}

export async function upsertXeroContactCacheEntry(
  contact: Contact,
  fetchedAt: Date
): Promise<CachedXeroContact | null> {
  const cachedContact = buildCachedXeroContact(contact);
  if (!cachedContact) {
    return null;
  }

  await prisma.xeroContactCache.upsert({
    where: { contactId: cachedContact.contactId },
    create: {
      ...cachedContact,
      sourceUpdatedAt: getXeroContactSourceUpdatedAt(contact),
      fetchedAt,
    },
    update: {
      ...cachedContact,
      sourceUpdatedAt: getXeroContactSourceUpdatedAt(contact),
      fetchedAt,
    },
  });

  return cachedContact;
}

export async function refreshXeroContactCachesFromContact(
  contact: Contact,
  fetchedAt: Date = new Date()
): Promise<RefreshXeroContactCachesFromContactResult> {
  const [cachedContact, groupMemberships] = await Promise.all([
    upsertXeroContactCacheEntry(contact, fetchedAt),
    refreshXeroContactGroupMembershipCacheForContact(contact, fetchedAt),
  ]);

  return {
    cachedContact,
    groupMemberships,
  };
}

// ---------------------------------------------------------------------------
// Xero contact fetchers
// ---------------------------------------------------------------------------

export async function fetchXeroContactsByIdsFromXero(input: {
  xero: XeroClient;
  tenantId: string;
  contactIds: string[];
  workflow: string;
  contextPrefix: string;
  includeArchived?: boolean;
}): Promise<Contact[]> {
  const contacts: Contact[] = [];

  for (
    let index = 0;
    index < input.contactIds.length;
    index += XERO_CONTACT_ID_BATCH_SIZE
  ) {
    const batch = input.contactIds.slice(
      index,
      index + XERO_CONTACT_ID_BATCH_SIZE
    );
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getContacts(
          input.tenantId,
          undefined,
          undefined,
          undefined,
          batch,
          undefined,
          input.includeArchived
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: input.workflow,
        context: `${input.contextPrefix} getContacts(batch ${Math.floor(index / XERO_CONTACT_ID_BATCH_SIZE) + 1})`,
      }
    );

    contacts.push(...(response.body.contacts ?? []));
  }

  return contacts;
}

export async function fetchChangedXeroContactsFromXero(input: {
  xero: XeroClient;
  tenantId: string;
  ifModifiedSince?: Date;
}): Promise<Contact[]> {
  const contacts: Contact[] = [];
  let page = 1;

  while (true) {
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getContacts(
          input.tenantId,
          input.ifModifiedSince,
          undefined,
          "UpdatedDateUTC ASC",
          undefined,
          page,
          false
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "syncContactsFromXero",
        context: `syncContacts getContacts(page ${page})`,
      }
    );

    const pageContacts = response.body.contacts ?? [];
    if (pageContacts.length === 0) {
      break;
    }

    contacts.push(...pageContacts);

    if (pageContacts.length < XERO_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return contacts;
}
