import { prisma } from "@/lib/prisma";

const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";
const DEFAULT_XERO_SYNC_SCOPE = "default";

interface MemberNameCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  active: boolean;
  xeroContactId: string | null;
}

interface XeroContactNameCandidate {
  contactId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
}

export interface XeroContactLinkMismatchEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  active: boolean;
  xeroContactId: string;
  xeroContactName: string;
  xeroContactEmail: string | null;
  reasons: string[];
}

export interface XeroContactLinkMismatchSnapshot {
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  count: number;
  mismatches: XeroContactLinkMismatchEntry[];
}

export interface XeroContactNameOrderRepair {
  name: string;
  firstName: string;
  lastName: string;
}

function normalizeComparableName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function joinComparableNameParts(...parts: Array<string | null>): string | null {
  const joined = parts.filter(Boolean).join(" ").trim();
  return joined.length > 0 ? joined : null;
}

function getMemberComparableNames(member: Pick<MemberNameCandidate, "firstName" | "lastName">): {
  firstName: string | null;
  lastName: string | null;
  variants: Set<string>;
} {
  const firstName = normalizeComparableName(member.firstName);
  const lastName = normalizeComparableName(member.lastName);
  const variants = new Set<string>();

  const firstLast = joinComparableNameParts(firstName, lastName);
  if (firstLast) {
    variants.add(firstLast);
  }

  const lastFirst = joinComparableNameParts(lastName, firstName);
  if (lastFirst) {
    variants.add(lastFirst);
  }

  return {
    firstName,
    lastName,
    variants,
  };
}

function getContactComparableNames(contact: XeroContactNameCandidate): {
  firstName: string | null;
  lastName: string | null;
  candidates: Set<string>;
} {
  const firstName = normalizeComparableName(contact.firstName);
  const lastName = normalizeComparableName(contact.lastName);
  const candidates = new Set<string>();
  const structuredName = joinComparableNameParts(firstName, lastName);

  if (structuredName) {
    candidates.add(structuredName);
    return {
      firstName,
      lastName,
      candidates,
    };
  }

  const displayName = normalizeComparableName(contact.name);
  if (displayName) {
    candidates.add(displayName);
  }

  return {
    firstName: null,
    lastName: null,
    candidates,
  };
}

function comparableNamesIntersect(
  memberVariants: Set<string>,
  contactCandidates: Set<string>
): boolean {
  if (memberVariants.size === 0 || contactCandidates.size === 0) {
    return false;
  }

  for (const candidate of contactCandidates) {
    if (memberVariants.has(candidate)) {
      return true;
    }
  }

  return false;
}

function getContactDisplayName(contact: XeroContactNameCandidate): string {
  const displayName =
    contact.name?.trim() ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();

  return displayName || contact.contactId;
}

export function getXeroContactNameOrderRepair(
  member: Pick<MemberNameCandidate, "firstName" | "lastName">,
  contact: Pick<XeroContactNameCandidate, "name" | "firstName" | "lastName">
): XeroContactNameOrderRepair | null {
  const memberFirst = member.firstName.trim();
  const memberLast = member.lastName.trim();
  const memberFirstName = normalizeComparableName(memberFirst);
  const memberLastName = normalizeComparableName(memberLast);

  if (!memberFirstName || !memberLastName) {
    return null;
  }

  const desiredComparable = joinComparableNameParts(memberFirstName, memberLastName);
  const reversedComparable = joinComparableNameParts(memberLastName, memberFirstName);
  const contactFirstName = normalizeComparableName(contact.firstName);
  const contactLastName = normalizeComparableName(contact.lastName);
  const contactDisplayName = normalizeComparableName(contact.name);
  const structuredNameHasBothParts = Boolean(contactFirstName && contactLastName);
  const structuredNameMatches =
    contactFirstName === memberFirstName && contactLastName === memberLastName;
  const structuredNameIsReversed =
    contactFirstName === memberLastName && contactLastName === memberFirstName;
  const displayNameIsReversed = Boolean(
    contactDisplayName && contactDisplayName === reversedComparable
  );
  const displayNameNeedsRepair = Boolean(
    contactDisplayName &&
      contactDisplayName !== desiredComparable &&
      displayNameIsReversed
  );

  if (
    !structuredNameIsReversed &&
    !(
      displayNameNeedsRepair &&
      (!structuredNameHasBothParts || structuredNameMatches)
    )
  ) {
    return null;
  }

  return {
    name: `${memberFirst} ${memberLast}`,
    firstName: memberFirst,
    lastName: memberLast,
  };
}

export function getMemberXeroContactLinkMismatch(
  member: MemberNameCandidate,
  contact: XeroContactNameCandidate
): XeroContactLinkMismatchEntry | null {
  if (!member.xeroContactId) {
    return null;
  }

  const memberNames = getMemberComparableNames(member);
  const contactNames = getContactComparableNames(contact);

  if (
    comparableNamesIntersect(memberNames.variants, contactNames.candidates) ||
    getXeroContactNameOrderRepair(member, contact)
  ) {
    return null;
  }

  const reasons: string[] = [];

  if (
    contactNames.firstName &&
    memberNames.firstName &&
    contactNames.firstName !== memberNames.firstName
  ) {
    reasons.push("First name differs");
  }

  if (
    contactNames.lastName &&
    memberNames.lastName &&
    contactNames.lastName !== memberNames.lastName
  ) {
    reasons.push("Last name differs");
  }

  if (reasons.length === 0) {
    reasons.push(
      contactNames.candidates.size === 0 ? "Contact name unavailable" : "Full name differs"
    );
  }

  return {
    memberId: member.id,
    memberName: `${member.firstName} ${member.lastName}`,
    memberEmail: member.email,
    active: member.active,
    xeroContactId: member.xeroContactId,
    xeroContactName: getContactDisplayName(contact),
    xeroContactEmail: contact.emailAddress,
    reasons,
  };
}

export function namesAppearToMatchMemberAndContact(
  member: Pick<MemberNameCandidate, "firstName" | "lastName" | "xeroContactId">,
  contact: Pick<
    XeroContactNameCandidate,
    "name" | "firstName" | "lastName" | "emailAddress"
  >
): boolean {
  const contactCandidate = {
    contactId: member.xeroContactId ?? "candidate-contact",
    name: contact.name ?? null,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    emailAddress: contact.emailAddress ?? null,
  };

  return comparableNamesIntersect(
    getMemberComparableNames(member).variants,
    getContactComparableNames(contactCandidate).candidates
  ) || Boolean(getXeroContactNameOrderRepair(member, contactCandidate));
}

export async function getXeroContactLinkMismatchSnapshot(options?: {
  limit?: number;
}): Promise<XeroContactLinkMismatchSnapshot> {
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: {
      lastSuccessfulSyncAt: true,
    },
  });

  if (!cursor?.lastSuccessfulSyncAt) {
    return {
      cacheReady: false,
      lastRefreshedAt: null,
      count: 0,
      mismatches: [],
    };
  }

  const members = await prisma.member.findMany({
    where: {
      xeroContactId: {
        not: null,
      },
    },
    orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      active: true,
      xeroContactId: true,
    },
  });

  const contactIds = members
    .map((member) => member.xeroContactId)
    .filter((contactId): contactId is string => Boolean(contactId));

  const cachedContacts = contactIds.length
    ? await prisma.xeroContactCache.findMany({
        where: {
          contactId: {
            in: contactIds,
          },
        },
        select: {
          contactId: true,
          name: true,
          firstName: true,
          lastName: true,
          emailAddress: true,
        },
      })
    : [];

  const contactsById = new Map(
    cachedContacts.map((contact) => [contact.contactId, contact] as const)
  );

  const mismatches = members.flatMap((member) => {
    if (!member.xeroContactId) {
      return [];
    }

    const contact = contactsById.get(member.xeroContactId);
    if (!contact) {
      return [];
    }

    const mismatch = getMemberXeroContactLinkMismatch(member, contact);
    return mismatch ? [mismatch] : [];
  });

  return {
    cacheReady: true,
    lastRefreshedAt: cursor.lastSuccessfulSyncAt.toISOString(),
    count: mismatches.length,
    mismatches:
      typeof options?.limit === "number"
        ? mismatches.slice(0, Math.max(1, options.limit))
        : mismatches,
  };
}
