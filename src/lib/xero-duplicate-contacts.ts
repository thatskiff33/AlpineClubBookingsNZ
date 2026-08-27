/**
 * Duplicate contact detection and admin link-suggestion helpers.
 *
 * Used by the admin Xero diagnostics UI: scans all Xero contacts and
 * groups duplicates by email; surfaces potential matches for a member
 * who has not yet been linked.
 */

import type { Contact } from "xero-node";
import { prisma } from "./prisma";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "./xero-api-client";
import {
  buildMemberFullName,
  buildXeroContactDisplayName,
  namesLookSimilarForPotentialMatch,
  normalizeXeroContactMatchValue,
} from "./xero-contacts";
import { isPlaceholderContactEmail } from "./placeholder-contact-email";
import { xeroInstant } from "@/lib/xero-provider-dates";

export interface PotentialXeroContactMatch {
  contactId: string;
  name: string;
  email: string | null;
  isLinked: boolean;
  linkedMemberName: string | null;
  matchReasons: string[];
  xeroLink: string;
}

interface DuplicateContact {
  contactID: string;
  name: string;
  firstName?: string;
  lastName?: string;
  emailAddress: string;
  hasInvoices: boolean;
  invoiceCount: number;
  contactStatus: string;
  updatedDateUTC?: string;
  xeroLink: string;
  memberId?: string;
  memberActive?: boolean;
}

export interface DuplicateGroup {
  email: string;
  contacts: DuplicateContact[];
  canCreateFamilyGroup: boolean;
  eligibleMemberIds: string[];
  suggestedGroupName?: string;
}

export async function findPotentialXeroContactsForMember(
  memberId: string
): Promise<PotentialXeroContactMatch[]> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });

  if (!member) {
    throw new Error(`Member not found: ${memberId}`);
  }

  const memberFullName = buildMemberFullName(member);
  const normalizedMemberName = normalizeXeroContactMatchValue(memberFullName);
  const normalizedMemberEmail = member.email.trim().toLowerCase();

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // #2314: the suggested-contact card renders these links, and this producer
  // used to be the one place in this file that omitted the short code while
  // findDuplicateContacts below passed one. Both now resolve it the same way,
  // off the shared 12-hour organisation cache; null degrades to the generic
  // go.xero.com link rather than hiding it.
  const shortCode = await getXeroOrgShortCode();
  const contactsById = new Map<string, Contact>();

  // Walk-in placeholder owners (#1935) have no real address on the reserved
  // `.invalid` domain: never send it as an OData EmailAddress filter (it would
  // match nothing, or worse a stray contact). Skip the email search entirely and
  // fall through to the name search — mirrors the guards in xero-contacts.ts.
  if (normalizedMemberEmail && !isPlaceholderContactEmail(member.email)) {
    const emailResponse = await callXeroApi(
      () =>
        xero.accountingApi.getContacts(
          tenantId,
          undefined,
          `EmailAddress="${member.email.replace(/"/g, "")}"`
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "findPotentialXeroContactsForMember",
        context: `findPotentialXeroContactsForMember searchByEmail(${member.email})`,
      }
    );

    for (const contact of emailResponse.body.contacts ?? []) {
      if (contact.contactID) {
        contactsById.set(contact.contactID, contact);
      }
    }
  }

  if (memberFullName.length >= 2) {
    const nameResponse = await callXeroApi(
      () =>
        xero.accountingApi.getContacts(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          1,
          false,
          true,
          memberFullName.replace(/"/g, ""),
          20
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "findPotentialXeroContactsForMember",
        context: `findPotentialXeroContactsForMember searchByName(${memberFullName})`,
      }
    );

    for (const contact of nameResponse.body.contacts ?? []) {
      if (contact.contactID) {
        contactsById.set(contact.contactID, contact);
      }
    }
  }

  const contactIds = [...contactsById.keys()];
  if (contactIds.length === 0) {
    return [];
  }

  const linkedMembers = await prisma.member.findMany({
    where: {
      xeroContactId: { in: contactIds },
    },
    select: {
      xeroContactId: true,
      firstName: true,
      lastName: true,
    },
  });
  const linkedMemberMap = new Map(
    linkedMembers.map((linkedMember) => [
      linkedMember.xeroContactId,
      `${linkedMember.firstName} ${linkedMember.lastName}`,
    ])
  );

  const matches = [...contactsById.values()]
    .map((contact) => {
      const contactName = buildXeroContactDisplayName(contact);
      const normalizedContactName = normalizeXeroContactMatchValue(contactName);
      const normalizedContactEmail =
        contact.emailAddress?.trim().toLowerCase() ?? "";
      const matchReasons: string[] = [];

      if (
        normalizedMemberEmail &&
        normalizedContactEmail === normalizedMemberEmail
      ) {
        matchReasons.push("Exact email match");
      }

      if (
        normalizedMemberName &&
        normalizedContactName === normalizedMemberName
      ) {
        matchReasons.push("Exact name match");
      } else if (
        memberFullName &&
        contactName &&
        namesLookSimilarForPotentialMatch(memberFullName, contactName)
      ) {
        matchReasons.push("Similar name match");
      }

      const linkedMemberName =
        linkedMemberMap.get(contact.contactID ?? "") ?? null;

      return {
        contactId: contact.contactID ?? "",
        name: contactName,
        email: contact.emailAddress?.trim() || null,
        isLinked: Boolean(linkedMemberName),
        linkedMemberName,
        matchReasons,
        xeroLink: buildXeroContactUrl(contact.contactID ?? "", { shortCode }),
      };
    })
    .filter(
      (match) =>
        Boolean(match.contactId) &&
        Boolean(match.name) &&
        match.matchReasons.length > 0
    );

  const getMatchPriority = (match: PotentialXeroContactMatch) => {
    if (match.matchReasons.includes("Exact email match")) return 3;
    if (match.matchReasons.includes("Exact name match")) return 2;
    return 1;
  };

  matches.sort((a, b) => {
    const priorityDiff = getMatchPriority(b) - getMatchPriority(a);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.isLinked !== b.isLinked) return Number(a.isLinked) - Number(b.isLinked);
    return a.name.localeCompare(b.name);
  });

  return matches.slice(0, 10);
}

/**
 * Scan all Xero contacts, find duplicate emails, and return grouped results
 * with invoice counts and deep links so the admin can merge in Xero UI.
 */
export async function findDuplicateContacts(): Promise<{
  duplicateGroups: DuplicateGroup[];
  totalContacts: number;
  totalDuplicateEmails: number;
  filteredByFamilyGroup: number;
}> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // #2314: the short code now comes from the shared connected-organisation
  // cache rather than a private `getOrganisations` call made on every scan.
  // Same value, same swallow-and-degrade posture, but it costs no extra Xero
  // request once any surface has warmed the 12-hour cache — and it is the same
  // one line every other server-side producer uses.
  const shortCode = await getXeroOrgShortCode();

  function xeroContactLink(contactID: string): string {
    return buildXeroContactUrl(contactID, { shortCode });
  }

  // Fetch all contacts, paginated
  const allContacts: Contact[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getContacts(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where
          undefined, // order
          undefined, // iDs
          page,
          false // includeArchived
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "findDuplicateContacts",
        context: `findDuplicateContacts getContacts(page ${page})`,
      }
    );

    const contacts = response.body.contacts ?? [];
    if (contacts.length === 0) {
      hasMore = false;
      break;
    }

    allContacts.push(...contacts);
    page++;
    if (contacts.length < 100) {
      hasMore = false;
    }
  }

  // Group by lowercase email
  const emailMap = new Map<string, Contact[]>();
  for (const contact of allContacts) {
    if (!contact.emailAddress) continue;
    const email = contact.emailAddress.toLowerCase().trim();
    const existing = emailMap.get(email) || [];
    existing.push(contact);
    emailMap.set(email, existing);
  }

  // Filter to only duplicates (2+ contacts per email)
  const duplicateEmails = Array.from(emailMap.entries()).filter(
    ([, contacts]) => contacts.length > 1
  );

  // For each duplicate group, get invoice counts
  const duplicateGroups: DuplicateGroup[] = [];

  for (const [email, contacts] of duplicateEmails) {
    const groupContacts: DuplicateContact[] = [];

    for (const contact of contacts) {
      let invoiceCount = 0;
      try {
        const invoiceResponse = await callXeroApi(
          () =>
            xero.accountingApi.getInvoices(
              tenantId,
              undefined, // ifModifiedSince
              undefined, // where
              undefined, // order
              undefined, // iDs
              undefined, // invoiceNumbers
              [contact.contactID!], // contactIDs
              undefined, // statuses
              1, // page
              false, // includeArchived
              undefined, // createdByMyApp
              undefined, // unitdp
              true, // summaryOnly
              1 // pageSize — we just need the count
            ),
          {
            operation: "getInvoices",
            resourceType: "INVOICE",
            workflow: "findDuplicateContacts",
            context: `findDuplicateContacts getInvoices(summary ${contact.contactID})`,
          }
        );
        invoiceCount = invoiceResponse.body.invoices?.length ?? 0;
        // If we got 1 result with pageSize 1, there may be more — fetch count properly
        if (invoiceCount > 0) {
          const fullResponse = await callXeroApi(
            () =>
              xero.accountingApi.getInvoices(
                tenantId,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [contact.contactID!],
                undefined,
                undefined,
                false,
                undefined,
                undefined,
                true
              ),
            {
              operation: "getInvoices",
              resourceType: "INVOICE",
              workflow: "findDuplicateContacts",
              context: `findDuplicateContacts getInvoices(full ${contact.contactID})`,
            }
          );
          invoiceCount = fullResponse.body.invoices?.length ?? 0;
        }
      } catch (err) {
        if (err instanceof XeroDailyLimitError) {
          throw err;
        }
        // If invoice fetch fails, just show 0
      }

      groupContacts.push({
        contactID: contact.contactID!,
        name:
          contact.name ||
          `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
        firstName: contact.firstName || undefined,
        lastName: contact.lastName || undefined,
        emailAddress: email,
        hasInvoices: invoiceCount > 0,
        invoiceCount,
        contactStatus: contact.contactStatus?.toString() || "ACTIVE",
        // An INSTANT crossing a JSON boundary, so it leaves as an unambiguous
        // instant. `Date.prototype.toString()` rendered it in the SERVER's zone
        // as human prose ("Wed Mar 11 2019 09:12:34 GMT+1300 (...)"), which is
        // neither a calendar date nor a machine-readable moment and changed
        // shape with the container (#2869).
        updatedDateUTC: xeroInstant(contact.updatedDateUTC)?.toISOString(),
        xeroLink: xeroContactLink(contact.contactID!),
      });
    }

    // Sort: contacts with invoices first, then by invoice count desc
    groupContacts.sort((a, b) => {
      if (a.hasInvoices !== b.hasInvoices) return a.hasInvoices ? -1 : 1;
      return b.invoiceCount - a.invoiceCount;
    });

    duplicateGroups.push({
      email,
      contacts: groupContacts,
      canCreateFamilyGroup: false,
      eligibleMemberIds: [],
    });
  }

  // Look up members for all contacts — used for both family group filtering (#17)
  // and enrichment (#18)
  const allContactIds = duplicateGroups.flatMap((g) =>
    g.contacts.map((c) => c.contactID)
  );

  let filteredByFamilyGroup = 0;

  if (allContactIds.length > 0) {
    const membersWithGroups = await prisma.member.findMany({
      where: { xeroContactId: { in: allContactIds } },
      select: {
        id: true,
        xeroContactId: true,
        firstName: true,
        lastName: true,
        active: true,
        canLogin: true,
        familyGroupMemberships: { select: { familyGroupId: true } },
      },
    });

    const contactToGroupIds = new Map<string, Set<string>>();
    const contactToMember = new Map<
      string,
      {
        id: string;
        firstName: string;
        lastName: string;
        active: boolean;
        canLogin: boolean;
      }
    >();
    for (const m of membersWithGroups) {
      if (m.xeroContactId) {
        contactToGroupIds.set(
          m.xeroContactId,
          new Set(m.familyGroupMemberships.map((fg) => fg.familyGroupId))
        );
        contactToMember.set(m.xeroContactId, {
          id: m.id,
          firstName: m.firstName,
          lastName: m.lastName,
          active: m.active,
          canLogin: m.canLogin,
        });
      }
    }

    // Filter out groups where all contacts share a common family group (#17)
    const beforeCount = duplicateGroups.length;
    const filtered = duplicateGroups.filter((group) => {
      const groupSets = group.contacts.map((c) =>
        contactToGroupIds.get(c.contactID)
      );
      if (groupSets.some((s) => !s || s.size === 0)) return true;
      const intersection = groupSets.reduce((acc, curr) => {
        const result = new Set<string>();
        for (const id of acc!) {
          if (curr!.has(id)) result.add(id);
        }
        return result;
      })!;
      if (intersection.size > 0) return false;
      return true;
    });
    filteredByFamilyGroup = beforeCount - filtered.length;
    duplicateGroups.length = 0;
    duplicateGroups.push(...filtered);

    // Enrich remaining groups with member info (#18)
    for (const group of duplicateGroups) {
      for (const contact of group.contacts) {
        const member = contactToMember.get(contact.contactID);
        if (member) {
          contact.memberId = member.id;
          contact.memberActive = member.active;
        }
      }

      const eligibleMembers = group.contacts
        .map((c) => contactToMember.get(c.contactID))
        .filter((m): m is NonNullable<typeof m> => !!m && m.canLogin);

      group.eligibleMemberIds = eligibleMembers.map((m) => m.id);
      group.canCreateFamilyGroup = eligibleMembers.length >= 2;

      if (group.canCreateFamilyGroup) {
        const lastNames = [...new Set(eligibleMembers.map((m) => m.lastName))];
        if (lastNames.length === 1) {
          group.suggestedGroupName = `${lastNames[0]} Family`;
        }
      }
    }
  }

  // Sort groups by email
  duplicateGroups.sort((a, b) => a.email.localeCompare(b.email));

  return {
    duplicateGroups,
    totalContacts: allContacts.length,
    totalDuplicateEmails: duplicateEmails.length,
    filteredByFamilyGroup,
  };
}
