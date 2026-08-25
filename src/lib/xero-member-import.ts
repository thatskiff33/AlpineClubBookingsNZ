/**
 * Cached-contact import from configured Xero contact groups.
 *
 * Reads `XeroContactCache` + `XeroContactGroupMembershipCache` (populated
 * by xero-bulk-contact-sync and xero-contact-groups) and creates local
 * `Member` rows for contacts in each mapped group. Falls back to a live
 * Xero fetch only when the caller opts in via `allowLiveXeroFetch`.
 *
 * #2108: each group mapping may additionally carry a `membershipTypeId`. When
 * it does, the import writes a current-season `SeasonalMembershipAssignment`
 * for the contact (source `IMPORT`, sourceDetail = group name). Newly-created
 * members are batched via `createMany`; matched-EXISTING members are routed
 * through `saveSeasonalMembershipAssignment` so the age-exemption force,
 * shared-double sweep, and per-member audit apply.
 *
 * Never-overwrite invariant: an existing current-season assignment is NEVER
 * replaced (remediation is the bulk-assign tool). That is enforced by the
 * PRE-READ skip below — matched-existing members who already hold a
 * current-season assignment are filtered out and reported before any save runs
 * (the preview token-staleness 409 in `saveSeasonalMembershipAssignment` is a
 * backstop for a race). The save path itself upserts by design, so it must only
 * ever be reached for members with no current-season assignment.
 *
 * Scale tradeoff: matched-existing members are assigned in a sequential loop,
 * one `saveSeasonalMembershipAssignment` call each (preview + save + per-member
 * Xero contact-group sync fan-out). For a very large tenant importing thousands
 * of already-linked members this is O(n) round-trips; it is the accepted interim
 * posture (see the #2107-rebase TODO at the save call site for the batched
 * reconcile that supersedes the per-member fan-out).
 */

import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import type { AgeTier } from "@prisma/client";
import { prisma } from "./prisma";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";

/**
 * #2255: the Xero contact import writes email inheritance directly and used to
 * do it with no validation at all. `existingPrimary` is matched on
 * `email` + `canLogin`, which guarantees neither that they are an adult, nor
 * that they are TERMINAL (a member who themselves inherits would make this a
 * chained pointer, which every reader's single-hop join then resolves to the
 * wrong mailbox), nor that their address is real.
 *
 * A bad source drops the inheritance rather than failing the import row: the
 * dependant is still created and still joins the family group, it just keeps
 * its own address — which for an import row is the same address anyway. The
 * fallback is LOGGED because it is otherwise invisible: an operator reviewing
 * an import has no other way to learn that some rows came out without the
 * inheritance the import normally sets.
 */
async function resolveImportInheritance(
  existingPrimary: { id: string },
  xeroContactId: string | null,
): Promise<string | null> {
  const validation = await validateInheritEmailSource({
    inheritEmailFromId: existingPrimary.id,
  });
  if (validation.ok) return existingPrimary.id;

  logger.info(
    {
      sourceMemberId: existingPrimary.id,
      xeroContactId,
      reason: validation.error,
    },
    "Xero import created a dependant without email inheritance",
  );
  return null;
}
import logger from "@/lib/logger";
import { sendPasswordResetEmail } from "./email";
import { issueActionToken } from "./action-tokens";
import { getSeasonYear } from "@/lib/utils";
import { computeAgeTier } from "@/lib/age-tier";
import {
  membershipTypeAgeExemption,
  type MembershipTypeAgeExemption,
} from "@/lib/membership-types";
import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "@/lib/audit";
import {
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "./xero-api-client";
import {
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
  fetchXeroContactsByIdsFromXero,
  getXeroContactDisplayName,
  upsertXeroContactCacheEntry,
} from "./xero-contact-cache";
import { parseXeroContactDateOfBirth } from "./xero-contact-date-of-birth";
import {
  applyInboundMemberContactPatch,
  type InboundMemberContactPatch,
} from "./xero-contact-create-recovery";
import { buildXeroContactUrl } from "./xero-links";
import { isXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";
import { upsertXeroObjectLink } from "./xero-sync";
import {
  DEFAULT_XERO_SYNC_SCOPE,
  getXeroSyncCursor,
  parseXeroError,
} from "./xero-sync-cursors";

// The bulk contact sync owns the canonical resource constant; depend on
// it directly so the two flows can never drift.
const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";

// #2108: bounds for the single summary audit row so it never carries an
// unbounded blob (a large import could touch thousands of members).
const AUDIT_MEMBER_ID_LIMIT = 200;
const AUDIT_LIST_LIMIT = 50;

// test seam — the one summary audit row a membership-type import writes.
export const XERO_MEMBER_IMPORT_MEMBERSHIP_TYPES_ACTION =
  "admin.xero.member_import_membership_types";

interface ImportMembersFromXeroGroupsOptions {
  allowLiveXeroFetch?: boolean;
  // #2108: the acting admin — required when any mapping carries a
  // membershipTypeId (assignments record `assignedByMemberId`, and the
  // matched-existing save path needs an actor for its audit rows).
  adminMemberId?: string;
  request?: StructuredAuditEvent["request"];
}

// #2108: a mapping may now carry an age tier (person tiers only — N/A is never
// submitted, it is only derived from an age-exempt type) and/or a membership
// type. The route enforces "at least one of tier/type" per mapping.
export interface XeroImportGroupMapping {
  groupId: string;
  groupName: string;
  ageTier?: AgeTier | null;
  membershipTypeId?: string | null;
}

interface ImportedXeroMemberDetail {
  name: string;
  email: string;
  xeroContactId: string;
  group: string;
}

interface ImportedXeroDependentDetail extends ImportedXeroMemberDetail {
  parentMemberId: string;
  parentName: string;
}

interface LinkedXeroMemberDetail extends ImportedXeroMemberDetail {
  memberId: string;
}

interface SkippedXeroContactDetail {
  name: string;
  xeroContactId: string;
  group: string;
  reason?: string;
}

// #2108: a matched-EXISTING member who already held a current-season assignment
// the import must not overwrite (a different type is remediated via the bulk
// assign tool, never silently changed here). `sameType` distinguishes a harmless
// "already on this type" keep from a genuine "kept a DIFFERENT type" keep so the
// UI can label them apart. The membership-type NAMES are resolved server-side so
// the panel never has to render raw ids.
interface KeptExistingAssignmentDetail {
  memberId: string;
  name: string;
  group: string;
  existingMembershipTypeId: string;
  attemptedMembershipTypeId: string;
  existingMembershipTypeName: string | null;
  attemptedMembershipTypeName: string | null;
  sameType: boolean;
}

// #2108 (L3): two DIFFERENT Xero contacts that link to the SAME local member but
// carry different membership-type mappings. The first matched contact's mapping
// wins deterministically (payload order); the loser is reported here rather than
// silently dropped.
interface MemberCollisionDetail {
  memberId: string;
  name: string;
  keptGroup: string;
  keptMembershipTypeId: string | null;
  droppedGroup: string;
  droppedMembershipTypeId: string | null;
}

// #2108: a contact that appeared in more than one mapped group. The first
// mapping in payload order wins deterministically; later occurrences are
// dropped and reported.
interface DroppedDuplicateDetail {
  name: string;
  xeroContactId: string;
  group: string;
  keptGroup: string;
}

interface CachedGroupContactRef {
  contactId: string;
  contactName: string | null;
}

// #2108: thrown when a mapping references a membership type that does not exist
// or is not active. The route maps it to a 422 listing the offenders.
export class XeroMemberImportValidationError extends Error {
  readonly offenders: Array<{ membershipTypeId: string; reason: string }>;
  constructor(
    offenders: Array<{ membershipTypeId: string; reason: string }>,
  ) {
    super("One or more membership types are invalid for import");
    this.name = "XeroMemberImportValidationError";
    this.offenders = offenders;
  }
}

// #2108: resolve the age tier stored on a NEWLY-created member. A FORCED
// (only-N/A) type wins unconditionally — it mirrors the org force and keeps new
// members consistent with matched-existing members (who are forced to N/A by
// saveSeasonalMembershipAssignment). Otherwise an explicit mapped person tier
// wins, else the DOB-derived tier, else ADULT.
async function resolveNewMemberAgeTier(params: {
  mappedTier: AgeTier | null | undefined;
  typeExemption: MembershipTypeAgeExemption | null | undefined;
  dateOfBirth: Date | null;
}): Promise<AgeTier> {
  if (params.typeExemption === "FORCED") {
    return "NOT_APPLICABLE";
  }
  if (params.mappedTier) {
    return params.mappedTier;
  }
  if (params.dateOfBirth) {
    return computeAgeTier(params.dateOfBirth);
  }
  return "ADULT";
}

export async function importMembersFromXeroGroups(
  groupMappings: XeroImportGroupMapping[],
  sendInvites: boolean,
  options: ImportMembersFromXeroGroupsOptions = {}
): Promise<{
  created: number;
  createdAsDependent: number;
  skippedExisting: number;
  linkedExisting: number;
  skippedNoEmail: number;
  skippedNoEmailDetails: Array<{
    name: string;
    xeroContactId: string;
    /** Present only when the contact HAS an address that cannot be used (#3036). */
    reason?: string;
  }>;
  skippedArchived: number;
  skippedArchivedDetails: SkippedXeroContactDetail[];
  createdMembers: ImportedXeroMemberDetail[];
  createdDependents: ImportedXeroDependentDetail[];
  linkedExistingDetails: LinkedXeroMemberDetail[];
  assignmentsCreated: number;
  keptExistingAssignments: KeptExistingAssignmentDetail[];
  droppedDuplicates: DroppedDuplicateDetail[];
  memberCollisions: MemberCollisionDetail[];
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  groupsProcessed: string[];
}> {
  let created = 0;
  let createdAsDependent = 0;
  let skippedExisting = 0;
  let linkedExisting = 0;
  let skippedNoEmail = 0;
  const skippedNoEmailDetails: Array<{
    name: string;
    xeroContactId: string;
    reason?: string;
  }> = [];
  let skippedArchived = 0;
  const skippedArchivedDetails: SkippedXeroContactDetail[] = [];
  const createdMembers: ImportedXeroMemberDetail[] = [];
  const createdDependents: ImportedXeroDependentDetail[] = [];
  const linkedExistingDetails: LinkedXeroMemberDetail[] = [];
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const groupsProcessed: string[] = [];

  // #2108 accumulators.
  const seasonYear = getSeasonYear();
  const adminMemberId = options.adminMemberId;
  const uniqueMembershipTypeIds = Array.from(
    new Set(
      groupMappings
        .map((mapping) => mapping.membershipTypeId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const hasTypeMappings = uniqueMembershipTypeIds.length > 0;
  // membershipTypeId -> exemption (only for active, existing types).
  const typeExemptionById = new Map<string, MembershipTypeAgeExemption>();
  // Assignment rows for NEWLY-created members, flushed via createMany at the end.
  const newMemberAssignments: Array<{
    memberId: string;
    seasonYear: number;
    membershipTypeId: string;
    source: "IMPORT";
    sourceDetail: string;
    assignedByMemberId: string | null;
  }> = [];
  // memberId -> mapping context for a matched-EXISTING member (first match wins).
  const matchedExistingByMemberId = new Map<
    string,
    { name: string; group: string; membershipTypeId: string | null }
  >();
  const keptExistingAssignments: KeptExistingAssignmentDetail[] = [];
  const droppedDuplicates: DroppedDuplicateDetail[] = [];
  const memberCollisions: MemberCollisionDetail[] = [];
  const affectedMemberIds: string[] = [];
  let assignmentsCreated = 0;

  // #2108 (L3): register a matched-EXISTING member's mapping context. The first
  // matched contact for a member wins (payload order). If a LATER contact links
  // to the same member with a DIFFERENT membership type, the loser is reported
  // as a member collision instead of being silently dropped.
  const registerMatchedExisting = (
    memberId: string,
    name: string,
    group: string,
    membershipTypeId: string | null,
  ) => {
    const existing = matchedExistingByMemberId.get(memberId);
    if (!existing) {
      matchedExistingByMemberId.set(memberId, { name, group, membershipTypeId });
      return;
    }
    if (
      membershipTypeId &&
      existing.membershipTypeId &&
      membershipTypeId !== existing.membershipTypeId
    ) {
      memberCollisions.push({
        memberId,
        name,
        keptGroup: existing.group,
        keptMembershipTypeId: existing.membershipTypeId,
        droppedGroup: group,
        droppedMembershipTypeId: membershipTypeId,
      });
    }
  };

  // #2108: resolve every referenced membership type up-front. Any that is
  // missing or inactive fails the whole import with a 422 listing offenders —
  // no partial write.
  if (hasTypeMappings) {
    if (!adminMemberId) {
      throw new Error(
        "adminMemberId is required to import members into membership types",
      );
    }
    const types = await prisma.membershipType.findMany({
      where: { id: { in: uniqueMembershipTypeIds } },
      select: {
        id: true,
        isActive: true,
        allowedAgeTiers: { select: { ageTier: true } },
      },
    });
    const typeById = new Map(types.map((type) => [type.id, type]));
    const offenders: Array<{ membershipTypeId: string; reason: string }> = [];
    for (const membershipTypeId of uniqueMembershipTypeIds) {
      const type = typeById.get(membershipTypeId);
      if (!type) {
        offenders.push({ membershipTypeId, reason: "not_found" });
        continue;
      }
      if (!type.isActive) {
        offenders.push({ membershipTypeId, reason: "inactive" });
        continue;
      }
      typeExemptionById.set(
        membershipTypeId,
        membershipTypeAgeExemption(
          type.allowedAgeTiers.map((tier) => tier.ageTier),
        ),
      );
    }
    if (offenders.length > 0) {
      throw new XeroMemberImportValidationError(offenders);
    }
  }

  // Hash a random UUID — unguessable placeholder password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);
  const groupCacheCursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!groupCacheCursor?.lastSuccessfulSyncAt) {
    throw new Error(
      "Xero contact group cache is empty. Refresh cached contact groups before importing members."
    );
  }

  const uniqueGroupIds = Array.from(
    new Set(groupMappings.map((mapping) => mapping.groupId))
  );
  const membershipRows = await prisma.xeroContactGroupMembershipCache.findMany({
    where: {
      contactGroupId: {
        in: uniqueGroupIds,
      },
    },
    select: {
      contactGroupId: true,
      contactId: true,
      contactName: true,
    },
  });
  const contactsByGroup = new Map<string, CachedGroupContactRef[]>();
  const contactNamesById = new Map<string, string>();
  for (const row of membershipRows) {
    const existing = contactsByGroup.get(row.contactGroupId) ?? [];
    existing.push({
      contactId: row.contactId,
      contactName: row.contactName ?? null,
    });
    contactsByGroup.set(row.contactGroupId, existing);

    if (row.contactName) {
      contactNamesById.set(row.contactId, row.contactName);
    }
  }

  const uniqueContactIds = Array.from(
    new Set(membershipRows.map((row) => row.contactId))
  );
  const contactSyncCursor = await getXeroSyncCursor(
    CONTACT_SYNC_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  const cachedContacts = uniqueContactIds.length
    ? await prisma.xeroContactCache.findMany({
        where: {
          contactId: {
            in: uniqueContactIds,
          },
        },
        select: {
          contactId: true,
          name: true,
          firstName: true,
          lastName: true,
          emailAddress: true,
          companyNumber: true,
          contactStatus: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          streetAddressLine1: true,
          streetAddressLine2: true,
          streetCity: true,
          streetRegion: true,
          streetPostalCode: true,
          streetCountry: true,
          postalAddressLine1: true,
          postalAddressLine2: true,
          postalCity: true,
          postalRegion: true,
          postalPostalCode: true,
          postalCountry: true,
        },
      })
    : [];
  const cachedContactsById = new Map(
    cachedContacts.map((contact) => [contact.contactId, contact])
  );
  const missingContactIds = uniqueContactIds.filter(
    (contactId) => !cachedContactsById.has(contactId)
  );

  if (missingContactIds.length > 0) {
    if (!contactSyncCursor?.lastSuccessfulSyncAt && !options.allowLiveXeroFetch) {
      throw new Error(
        "Xero contact cache is empty. Run contact sync before importing members."
      );
    }

    if (!options.allowLiveXeroFetch) {
      throw new Error(
        `Xero contact cache is missing ${missingContactIds.length} contact snapshot(s). Run contact sync first, or retry the import in repair mode.`
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const repairedContacts = await fetchXeroContactsByIdsFromXero({
      xero,
      tenantId,
      contactIds: missingContactIds,
      workflow: "importMembersFromXeroGroups",
      contextPrefix: "importMembersFromXeroGroups repair",
      includeArchived: true,
    });
    const repairedAt = new Date();

    for (const contact of repairedContacts) {
      const cachedContact = await upsertXeroContactCacheEntry(contact, repairedAt);
      if (cachedContact) {
        cachedContactsById.set(cachedContact.contactId, cachedContact);
      }
    }
  }

  // #2108: a contact may sit in two mapped groups; the first mapping in payload
  // order wins (deterministic). Track the winning group per contact.
  const winningGroupByContactId = new Map<string, string>();

  for (const mapping of groupMappings) {
    const groupContacts = contactsByGroup.get(mapping.groupId) ?? [];
    const typeExemption = mapping.membershipTypeId
      ? typeExemptionById.get(mapping.membershipTypeId) ?? null
      : null;
    groupsProcessed.push(mapping.groupName);
    logger.info(
      {
        groupName: mapping.groupName,
        groupContactCount: groupContacts.length,
        cachedContactCount: groupContacts.filter((groupContact) =>
          cachedContactsById.has(groupContact.contactId)
        ).length,
      },
      "Loaded cached group contacts for import"
    );

    for (const groupContact of groupContacts) {
      // #2108: drop a contact already handled by an earlier mapping.
      const winningGroup = winningGroupByContactId.get(groupContact.contactId);
      if (winningGroup !== undefined) {
        droppedDuplicates.push({
          name:
            groupContact.contactName ??
            contactNamesById.get(groupContact.contactId) ??
            groupContact.contactId,
          xeroContactId: groupContact.contactId,
          group: mapping.groupName,
          keptGroup: winningGroup,
        });
        continue;
      }
      winningGroupByContactId.set(groupContact.contactId, mapping.groupName);

      const contact = cachedContactsById.get(groupContact.contactId);
      if (!contact) {
        errors++;
        const contactName =
          groupContact.contactName ??
          contactNamesById.get(groupContact.contactId) ??
          groupContact.contactId;
        errorDetails.push({
          member: `${mapping.groupName}: ${contactName}`,
          error: options.allowLiveXeroFetch
            ? "Xero did not return a contact snapshot during repair, so this group member could not be imported."
            : "Missing cached Xero contact snapshot. Run contact sync first, or retry the import in repair mode.",
        });
        continue;
      }

      try {
        const contactName = getXeroContactDisplayName(contact);
        if (contact.contactStatus.toUpperCase() !== "ACTIVE") {
          skippedArchived++;
          skippedArchivedDetails.push({
            name: contactName,
            xeroContactId: contact.contactId,
            group: mapping.groupName,
            reason: `Xero contact status is ${contact.contactStatus}`,
          });
          continue;
        }

        // INV-CONFIG-005 (#3036): a contained address is not an address we may
        // give a member. It is a hash of somebody's real address on a reserved
        // domain, written onto the contact because this installation is a copy,
        // and a Member created from it would look reachable while being able to
        // receive nothing. So it joins the no-usable-address skip and carries
        // its own reason, because "no email address" would be false — the
        // contact has one, it just cannot be used.
        const containedAddress = isXeroSandboxContactEmail(contact.emailAddress);
        if (!contact.emailAddress || containedAddress) {
          skippedNoEmail++;
          skippedNoEmailDetails.push({
            name: contactName,
            xeroContactId: contact.contactId,
            reason: containedAddress
              ? "This contact's email address was replaced with a non-deliverable one because this installation is a copy. Import it on the club's live site instead."
              : undefined,
          });
          continue;
        }

        const email = contact.emailAddress.toLowerCase().trim();

        const alreadyLinked = await prisma.member.findFirst({
          where: { xeroContactId: contact.contactId },
        });
        if (alreadyLinked) {
          skippedExisting++;
          // #2108: a matched-EXISTING member — a candidate for a type assignment.
          registerMatchedExisting(
            alreadyLinked.id,
            `${alreadyLinked.firstName} ${alreadyLinked.lastName}`,
            mapping.groupName,
            mapping.membershipTypeId ?? null,
          );
          continue;
        }

        const existingPrimary = await prisma.member.findFirst({
          where: { email, canLogin: true },
        });

        if (existingPrimary) {
          const contactFirstName = (contact.firstName || "")
            .toLowerCase()
            .trim();
          const contactLastName = (contact.lastName || "").toLowerCase().trim();
          const primaryFirstName = existingPrimary.firstName.toLowerCase().trim();
          const primaryLastName = existingPrimary.lastName.toLowerCase().trim();

          const isSamePerson =
            (contactFirstName === primaryFirstName &&
              contactLastName === primaryLastName) ||
            (!contactFirstName && !contactLastName);

          if (isSamePerson) {
            skippedExisting++;
            // #2108: matched-EXISTING member.
            registerMatchedExisting(
              existingPrimary.id,
              `${existingPrimary.firstName} ${existingPrimary.lastName}`,
              mapping.groupName,
              mapping.membershipTypeId ?? null,
            );
            const updates: InboundMemberContactPatch = {};
            if (!existingPrimary.dateOfBirth) {
              const parsedDateOfBirth = parseXeroContactDateOfBirth(
                contact.companyNumber
              );
              if (parsedDateOfBirth) {
                updates.dateOfBirth = parsedDateOfBirth;
              }
            }
            if (!existingPrimary.phoneNumber && contact.phoneNumber) {
              updates.phoneCountryCode = contact.phoneCountryCode;
              updates.phoneAreaCode = contact.phoneAreaCode;
              updates.phoneNumber = contact.phoneNumber;
            }
            if (
              !existingPrimary.streetAddressLine1 &&
              contact.streetAddressLine1
            ) {
              updates.streetAddressLine1 = contact.streetAddressLine1;
              updates.streetAddressLine2 = contact.streetAddressLine2;
              updates.streetCity = contact.streetCity;
              updates.streetRegion = contact.streetRegion;
              updates.streetPostalCode = contact.streetPostalCode;
              updates.streetCountry = contact.streetCountry;
            }
            if (
              !existingPrimary.postalAddressLine1 &&
              contact.postalAddressLine1
            ) {
              updates.postalAddressLine1 = contact.postalAddressLine1;
              updates.postalAddressLine2 = contact.postalAddressLine2;
              updates.postalCity = contact.postalCity;
              updates.postalRegion = contact.postalRegion;
              updates.postalPostalCode = contact.postalPostalCode;
              updates.postalCountry = contact.postalCountry;
            }

            const applied = await applyInboundMemberContactPatch({
              memberId: existingPrimary.id,
              xeroContactId: contact.contactId,
              patch: updates,
            });
            if (applied.linked) {
              linkedExisting++;
              linkedExistingDetails.push({
                name: `${existingPrimary.firstName} ${existingPrimary.lastName}`,
                email: existingPrimary.email,
                memberId: existingPrimary.id,
                xeroContactId: contact.contactId,
                group: mapping.groupName,
              });
            }
            continue;
          }

          const existingFamilyMember = await prisma.member.findFirst({
            where: {
              email,
              canLogin: false,
              firstName: {
                equals: contact.firstName || "Unknown",
                mode: "insensitive",
              },
              lastName: {
                equals: contact.lastName || "Unknown",
                mode: "insensitive",
              },
            },
          });
          if (existingFamilyMember) {
            skippedExisting++;
            // #2108: matched-EXISTING member.
            registerMatchedExisting(
              existingFamilyMember.id,
              `${existingFamilyMember.firstName} ${existingFamilyMember.lastName}`,
              mapping.groupName,
              mapping.membershipTypeId ?? null,
            );
            if (!existingFamilyMember.xeroContactId) {
              await applyInboundMemberContactPatch({
                memberId: existingFamilyMember.id,
                xeroContactId: contact.contactId,
              });
              linkedExisting++;
              linkedExistingDetails.push({
                name: `${existingFamilyMember.firstName} ${existingFamilyMember.lastName}`,
                email,
                memberId: existingFamilyMember.id,
                xeroContactId: contact.contactId,
                group: mapping.groupName,
              });
            }
            continue;
          }

          let depFirstName = contact.firstName || "";
          let depLastName = contact.lastName || "";
          if (!depFirstName && !depLastName && contact.name) {
            const parts = contact.name.trim().split(/\s+/);
            depFirstName = parts[0] || "Unknown";
            depLastName = parts.slice(1).join(" ") || "Unknown";
          }
          if (!depFirstName) depFirstName = "Unknown";
          if (!depLastName) depLastName = "Unknown";

          const depDob = parseXeroContactDateOfBirth(contact.companyNumber);
          const dependentAgeTier = await resolveNewMemberAgeTier({
            mappedTier: mapping.ageTier,
            typeExemption,
            dateOfBirth: depDob,
          });
          const inheritEmailFromId = await resolveImportInheritance(
            existingPrimary,
            contact.contactId,
          );

          const newFamilyMember = await prisma.$transaction(async (tx) => {
            const created = await tx.member.create({
            data: {
              email,
              firstName: depFirstName,
              lastName: depLastName,
              passwordHash: placeholderHash,
              ageTier: dependentAgeTier,
              dateOfBirth: depDob,
              xeroContactId: contact.contactId,
              phoneCountryCode: contact.phoneCountryCode,
              phoneAreaCode: contact.phoneAreaCode,
              phoneNumber: contact.phoneNumber,
              streetAddressLine1: contact.streetAddressLine1,
              streetAddressLine2: contact.streetAddressLine2,
              streetCity: contact.streetCity,
              streetRegion: contact.streetRegion,
              streetPostalCode: contact.streetPostalCode,
              streetCountry: contact.streetCountry,
              postalAddressLine1: contact.postalAddressLine1,
              postalAddressLine2: contact.postalAddressLine2,
              postalCity: contact.postalCity,
              postalRegion: contact.postalRegion,
              postalPostalCode: contact.postalPostalCode,
              postalCountry: contact.postalCountry,
              active: true,
              emailVerified: true,
              canLogin: false,
              // #2255: the import writes email inheritance directly, and used to
              // do it with no validation at all. `existingPrimary` is matched on
              // `email` + `canLogin`, which guarantees neither that they are an
              // adult, nor that they are TERMINAL (a member who themselves
              // inherits would make this a chained pointer, which every reader's
              // single-hop join then resolves to the wrong mailbox), nor that
              // their address is real. Refuse the inheritance rather than write
              // a bad pointer — the dependant is still created and still joins
              // the family group, it simply keeps its own address, which for an
              // import row is the same address anyway.
              inheritEmailFromId,
              // #2716: the CHOICE is written with the pointer. `null` here is
              // the deliberate no-inheritance fallback above, so both columns
              // stay empty and the dependant keeps its own (imported) address.
              inheritEmailChoiceId: inheritEmailFromId,
            },
          });
            await upsertXeroObjectLink(
              {
                localModel: "Member",
                localId: created.id,
                xeroObjectType: "CONTACT",
                xeroObjectId: contact.contactId,
                xeroObjectUrl: buildXeroContactUrl(contact.contactId),
                role: "CONTACT",
              },
              { store: tx },
            );
            return created;
          });

          // #2108: batch the new dependent's current-season assignment.
          if (mapping.membershipTypeId) {
            newMemberAssignments.push({
              memberId: newFamilyMember.id,
              seasonYear,
              membershipTypeId: mapping.membershipTypeId,
              source: "IMPORT",
              sourceDetail: mapping.groupName,
              assignedByMemberId: adminMemberId ?? null,
            });
            affectedMemberIds.push(newFamilyMember.id);
          }

          const existingGroup = await prisma.familyGroupMember.findFirst({
            where: { memberId: existingPrimary.id },
            select: { familyGroupId: true },
          });

          if (existingGroup) {
            await prisma.familyGroupMember
              .create({
                data: {
                  familyGroupId: existingGroup.familyGroupId,
                  memberId: newFamilyMember.id,
                },
                // Result discarded — narrow the implicit RETURNING (#2130 house
                // rule). Doubly worth it here: the `.catch(() => {})` below
                // swallows the error, so an unnarrowed write naming a dropped
                // column would silently lose the family link rather than fail.
                select: { id: true },
              })
              .catch(() => {});
          } else {
            const group = await prisma.familyGroup.create({
              data: { name: `${existingPrimary.lastName} Family` },
            });
            await prisma.familyGroupMember.createMany({
              data: [
                { familyGroupId: group.id, memberId: existingPrimary.id },
                { familyGroupId: group.id, memberId: newFamilyMember.id },
              ],
              skipDuplicates: true,
            });
          }

          createdAsDependent++;
          createdDependents.push({
            name: `${depFirstName} ${depLastName}`,
            email,
            xeroContactId: contact.contactId,
            group: mapping.groupName,
            parentMemberId: existingPrimary.id,
            parentName: `${existingPrimary.firstName} ${existingPrimary.lastName}`,
          });
          continue;
        }

        let firstName = contact.firstName || "";
        let lastName = contact.lastName || "";
        if (!firstName && !lastName && contact.name) {
          const parts = contact.name.trim().split(/\s+/);
          firstName = parts[0] || "Unknown";
          lastName = parts.slice(1).join(" ") || "Unknown";
        }
        if (!firstName) firstName = "Unknown";
        if (!lastName) lastName = "Unknown";

        const dateOfBirth = parseXeroContactDateOfBirth(contact.companyNumber);
        const importedAgeTier = await resolveNewMemberAgeTier({
          mappedTier: mapping.ageTier,
          typeExemption,
          dateOfBirth,
        });

        const member = await prisma.$transaction(async (tx) => {
          const created = await tx.member.create({
          data: {
            email,
            firstName,
            lastName,
            passwordHash: placeholderHash,
            ageTier: importedAgeTier,
            dateOfBirth,
            xeroContactId: contact.contactId,
            phoneCountryCode: contact.phoneCountryCode,
            phoneAreaCode: contact.phoneAreaCode,
            phoneNumber: contact.phoneNumber,
            streetAddressLine1: contact.streetAddressLine1,
            streetAddressLine2: contact.streetAddressLine2,
            streetCity: contact.streetCity,
            streetRegion: contact.streetRegion,
            streetPostalCode: contact.streetPostalCode,
            streetCountry: contact.streetCountry,
            postalAddressLine1: contact.postalAddressLine1,
            postalAddressLine2: contact.postalAddressLine2,
            postalCity: contact.postalCity,
            postalRegion: contact.postalRegion,
            postalPostalCode: contact.postalPostalCode,
            postalCountry: contact.postalCountry,
            active: true,
            emailVerified: true,
          },
        });
          await upsertXeroObjectLink(
            {
              localModel: "Member",
              localId: created.id,
              xeroObjectType: "CONTACT",
              xeroObjectId: contact.contactId,
              xeroObjectUrl: buildXeroContactUrl(contact.contactId),
              role: "CONTACT",
            },
            { store: tx },
          );
          return created;
        });

        // #2108: batch the new member's current-season assignment.
        if (mapping.membershipTypeId) {
          newMemberAssignments.push({
            memberId: member.id,
            seasonYear,
            membershipTypeId: mapping.membershipTypeId,
            source: "IMPORT",
            sourceDetail: mapping.groupName,
            assignedByMemberId: adminMemberId ?? null,
          });
          affectedMemberIds.push(member.id);
        }

        created++;
        createdMembers.push({
          name: `${firstName} ${lastName}`,
          email,
          xeroContactId: contact.contactId,
          group: mapping.groupName,
        });

        if (sendInvites) {
          try {
            const { token, tokenHash } = issueActionToken();
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            await prisma.passwordResetToken.create({
              data: {
                tokenHash,
                memberId: member.id,
                expiresAt,
              },
            });

            sendPasswordResetEmail(member.email, token).catch((err) => {
              logger.error(
                { err, email: member.email },
                "Failed to send invite email during member import"
              );
            });
          } catch (emailErr) {
            logger.error(
              { err: emailErr, email: member.email },
              "Failed to create invite token during member import"
            );
          }
        }
      } catch (contactErr) {
        if (contactErr instanceof XeroDailyLimitError) throw contactErr;
        logger.error(
          { err: contactErr, contactEmail: contact.emailAddress },
          "Error processing cached contact during member import"
        );
        errors++;
        errorDetails.push({
          member: contact.name || contact.emailAddress || contact.contactId,
          error: parseXeroError(contactErr),
        });
      }
    }
  }

  // #2108: flush the newly-created members' assignments in one batch — new rows
  // have no prior tier/assignment state, so createMany(skipDuplicates) is safe.
  if (newMemberAssignments.length > 0) {
    const result = await prisma.seasonalMembershipAssignment.createMany({
      data: newMemberAssignments,
      skipDuplicates: true,
    });
    assignmentsCreated += result.count;
  }

  // #2108: assign matched-EXISTING members through the hardened save path so the
  // age-exemption force, shared-double sweep, and per-member audit apply. An
  // existing current-season assignment is NEVER overwritten (that is a
  // deliberate remediation for the bulk-assign tool), so we pre-read them and
  // skip — reporting the members we left untouched.
  const matchedTypeCandidates = [...matchedExistingByMemberId.entries()].filter(
    ([, context]) => context.membershipTypeId !== null,
  );
  if (matchedTypeCandidates.length > 0 && adminMemberId) {
    const candidateMemberIds = matchedTypeCandidates.map(([memberId]) => memberId);
    const existingAssignments =
      await prisma.seasonalMembershipAssignment.findMany({
        where: { seasonYear, memberId: { in: candidateMemberIds } },
        select: { memberId: true, membershipTypeId: true },
      });
    const existingAssignmentByMemberId = new Map(
      existingAssignments.map((assignment) => [
        assignment.memberId,
        assignment,
      ]),
    );

    // Lazily loaded to keep the seasonal module (and its Xero/email graph) out
    // of the tier-only import path and off the module import cycle.
    const { getSeasonalMembershipChangePreview, saveSeasonalMembershipAssignment } =
      await import("@/lib/seasonal-membership-assignments");

    for (const [memberId, context] of matchedTypeCandidates) {
      const membershipTypeId = context.membershipTypeId;
      if (!membershipTypeId) continue;

      const existing = existingAssignmentByMemberId.get(memberId);
      if (existing) {
        // Never overwrite — record the member we kept. `sameType` marks a
        // harmless "already on this type" keep so the UI does not report it as a
        // DIFFERENT-type keep that needs remediation. Names are filled in below.
        keptExistingAssignments.push({
          memberId,
          name: context.name,
          group: context.group,
          existingMembershipTypeId: existing.membershipTypeId,
          attemptedMembershipTypeId: membershipTypeId,
          existingMembershipTypeName: null,
          attemptedMembershipTypeName: null,
          sameType: existing.membershipTypeId === membershipTypeId,
        });
        continue;
      }

      try {
        const previewResult = await getSeasonalMembershipChangePreview({
          memberId,
          seasonYear,
          membershipTypeId,
        });
        if (previewResult.init?.status && previewResult.init.status >= 400) {
          errors++;
          errorDetails.push({
            member: context.name,
            error:
              (previewResult.body as { error?: string } | undefined)?.error ??
              "Failed to preview membership type assignment",
          });
          continue;
        }
        const previewToken = (
          previewResult.body as { preview: { previewToken: string } }
        ).preview.previewToken;

        // Per-member Xero contact-group sync is suppressed here (#2107's flag);
        // ONE batched reconcile of all affected members runs after this loop,
        // before the summary audit, replacing the per-member fan-out.
        const saveResult = await saveSeasonalMembershipAssignment({
          memberId,
          seasonYear,
          membershipTypeId,
          adminMemberId,
          reason: `Xero import: group ${context.group}`,
          previewToken,
          source: "IMPORT",
          skipXeroContactGroupSync: true,
          request: options.request,
        });
        if (saveResult.init?.status && saveResult.init.status >= 400) {
          errors++;
          errorDetails.push({
            member: context.name,
            error:
              (saveResult.body as { error?: string } | undefined)?.error ??
              "Failed to save membership type assignment",
          });
          continue;
        }
        assignmentsCreated++;
        affectedMemberIds.push(memberId);
      } catch (assignErr) {
        logger.error(
          { err: assignErr, memberId, membershipTypeId },
          "Failed to assign membership type to matched member during import",
        );
        errors++;
        errorDetails.push({
          member: context.name,
          error: parseXeroError(assignErr),
        });
      }
    }
  }

  // #2108 (HIGH-1): resolve the membership-type NAMES for kept-existing rows so
  // the results panel can render human-readable names, never raw ids. Covers the
  // attempted types (in `uniqueMembershipTypeIds`) AND each member's existing
  // type, which may be a type the import never referenced.
  if (keptExistingAssignments.length > 0) {
    const nameIds = Array.from(
      new Set(
        keptExistingAssignments.flatMap((kept) => [
          kept.existingMembershipTypeId,
          kept.attemptedMembershipTypeId,
        ]),
      ),
    );
    const namedTypes = await prisma.membershipType.findMany({
      where: { id: { in: nameIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(namedTypes.map((type) => [type.id, type.name]));
    for (const kept of keptExistingAssignments) {
      kept.existingMembershipTypeName =
        nameById.get(kept.existingMembershipTypeId) ?? null;
      kept.attemptedMembershipTypeName =
        nameById.get(kept.attemptedMembershipTypeId) ?? null;
    }
  }

  // #2108 + #2107: per-member sync was suppressed in the save loop above, so
  // reconcile every affected member's Xero contact group ONCE here — a bounded,
  // best-effort, daily-limit-aware batch (never throws). New members reconcile
  // through the periodic/mismatch tooling as before.
  if (affectedMemberIds.length > 0 && adminMemberId) {
    // Lazily loaded for the same import-cycle reason as the seasonal module.
    const { reconcileMembersXeroContactGroups } = await import(
      "@/lib/xero-contact-groups"
    );
    await reconcileMembersXeroContactGroups(affectedMemberIds, {
      createdByMemberId: adminMemberId,
      reason: "xero_member_import_membership_types",
    });
  }

  // #2108: one summary audit row for a membership-type import.
  if (hasTypeMappings && adminMemberId) {
    await prisma.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: XERO_MEMBER_IMPORT_MEMBERSHIP_TYPES_ACTION,
        actor: { memberId: adminMemberId },
        entity: {
          type: "SeasonalMembershipAssignment",
          id: `xero-import:${seasonYear}`,
        },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Xero member import assigned membership types",
        metadata: {
          seasonYear,
          membershipTypeIds: uniqueMembershipTypeIds,
          perGroup: groupMappings.map((mapping) => ({
            group: mapping.groupName,
            membershipTypeId: mapping.membershipTypeId ?? null,
            ageTier: mapping.ageTier ?? null,
          })),
          counts: {
            created,
            createdAsDependent,
            skippedExisting,
            linkedExisting,
            assignmentsCreated,
            keptExistingAssignments: keptExistingAssignments.length,
            droppedDuplicates: droppedDuplicates.length,
            memberCollisions: memberCollisions.length,
            errors,
          },
          affectedMemberIds: affectedMemberIds.slice(0, AUDIT_MEMBER_ID_LIMIT),
          affectedMemberIdsTruncated:
            affectedMemberIds.length > AUDIT_MEMBER_ID_LIMIT,
          keptExistingAssignments: keptExistingAssignments.slice(
            0,
            AUDIT_LIST_LIMIT,
          ),
          droppedDuplicates: droppedDuplicates.slice(0, AUDIT_LIST_LIMIT),
          memberCollisions: memberCollisions.slice(0, AUDIT_LIST_LIMIT),
        },
        request: options.request,
      }),
    );
  }

  return {
    created,
    createdAsDependent,
    skippedExisting,
    linkedExisting,
    skippedNoEmail,
    skippedNoEmailDetails,
    skippedArchived,
    skippedArchivedDetails,
    createdMembers,
    createdDependents,
    linkedExistingDetails,
    assignmentsCreated,
    keptExistingAssignments,
    droppedDuplicates,
    memberCollisions,
    errors,
    errorDetails,
    groupsProcessed,
  };
}
