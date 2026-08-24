/**
 * Bulk Xero contact sync (incremental cursor-driven refresh).
 *
 * Owns `syncContactsFromXero`: fetches Xero contacts modified since the
 * cursor's checkpoint, writes them into the local `XeroContactCache`,
 * links them back to local members where possible, and persists any
 * skip/repair report. Cached-import of contacts inside Xero contact
 * groups lives in xero-member-import.ts.
 */

import type { Contact } from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { formatXeroPhone } from "./phone";
import { createAuditLog } from "@/lib/audit";
import {
  getMemberXeroContactLinkMismatch,
  getXeroContactNameOrderRepair,
  type XeroContactLinkMismatchEntry,
} from "@/lib/xero-contact-link-mismatches";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { isXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";
import {
  applyInboundMemberContactPatch,
  type InboundMemberContactPatch,
} from "@/lib/xero-contact-create-recovery";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  failXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  fetchChangedXeroContactsFromXero,
  fetchXeroContactsByIdsFromXero,
  getXeroContactDisplayName,
  refreshXeroContactCachesFromContact,
  type CachedXeroContact,
} from "./xero-contact-cache";
import {
  completeMemberContactUpdateOperation,
  getContactFirstInvoiceDate,
  reserveMemberContactUpdateOperation,
} from "./xero-contacts";
import {
  DEFAULT_XERO_SYNC_SCOPE,
  getXeroSyncCursor,
  getXeroSyncCursorMetadata,
  throttle,
  upsertXeroSyncCursor,
} from "./xero-sync-cursors";
import { formatDateOnly } from "@/lib/date-only";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";
const CONTACT_SYNC_CURSOR_OVERLAP_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncContactsFromXeroOptions {
  fullResync?: boolean;
  backfillJoinedDates?: boolean;
  auditActorMemberId?: string | null;
  auditSource?: string;
}

export interface SyncReport {
  created: Array<{ name: string; email: string; xeroContactId: string; group?: string }>;
  updated: Array<{
    name: string;
    memberId: string;
    xeroContactId: string;
    changes: string[];
  }>;
  skippedNoChanges: number;
  skippedNameMismatch: Array<{
    memberId: string;
    memberName: string;
    memberEmail: string;
    xeroContactId: string;
    xeroContactName: string;
    xeroContactEmail: string | null;
    reasons: string[];
  }>;
  skippedNoEmail: Array<{ name: string; xeroContactId: string }>;
  skippedOther: Array<{ name: string; xeroContactId?: string; reason: string }>;
  errors: Array<{ name: string; xeroContactId?: string; error: string }>;
  total: number;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

function addNameMismatchToSyncReport(
  report: SyncReport,
  mismatch: XeroContactLinkMismatchEntry
) {
  report.skippedNameMismatch.push({
    memberId: mismatch.memberId,
    memberName: mismatch.memberName,
    memberEmail: mismatch.memberEmail,
    xeroContactId: mismatch.xeroContactId,
    xeroContactName: mismatch.xeroContactName,
    xeroContactEmail: mismatch.xeroContactEmail,
    reasons: mismatch.reasons,
  });
}

function getSafeXeroContactAuditChanges(changes: string[]) {
  const fields = new Set<string>();

  for (const change of changes) {
    if (change.startsWith("Linked to Xero contact")) {
      fields.add("xeroContactLink");
    } else if (change.startsWith("Joined date set")) {
      fields.add("joinedDate");
    } else if (change.startsWith("Phone set")) {
      fields.add("phone");
    } else if (change.startsWith("Street address set")) {
      fields.add("streetAddress");
    } else if (change.startsWith("Postal address set")) {
      fields.add("postalAddress");
    } else if (change.startsWith("Xero contact name set")) {
      fields.add("xeroContactName");
    } else {
      fields.add("other");
    }
  }

  return Array.from(fields);
}

async function writeXeroContactSyncAudit(input: {
  actorMemberId?: string | null;
  memberId: string;
  xeroContactId: string;
  changes: string[];
  source: string;
}) {
  const changedFields = getSafeXeroContactAuditChanges(input.changes);

  try {
    await createAuditLog({
      action: "xero.contact.synced_to_member",
      memberId: input.actorMemberId ?? null,
      targetId: input.memberId,
      subjectMemberId: input.memberId,
      entityType: "Member",
      entityId: input.memberId,
      category: "xero",
      severity: "critical",
      outcome: "success",
      summary: "Xero contact synced to member",
      details: `${changedFields.length} Xero contact field${changedFields.length === 1 ? "" : "s"} synced to member`,
      metadata: {
        source: input.source,
        xeroContactId: input.xeroContactId,
        changedFields,
      },
    });
  } catch (err) {
    logger.error(
      { err, memberId: input.memberId, xeroContactId: input.xeroContactId },
      "Failed to write Xero contact sync audit log"
    );
  }
}

// ---------------------------------------------------------------------------
// Name-order repair (pre-sync)
// ---------------------------------------------------------------------------

async function repairXeroContactNameOrderIfNeeded(input: {
  xero: import("xero-node").XeroClient;
  tenantId: string;
  contact: Contact;
  cachedContact: CachedXeroContact;
  member: { id: string; firstName: string; lastName: string };
}): Promise<string | null> {
  const contactId = input.cachedContact.contactId;
  const reservation = await reserveMemberContactUpdateOperation(
    input.member.id,
    contactId,
    (locked) => {
      const repair = getXeroContactNameOrderRepair(locked, {
        name: input.cachedContact.name,
        firstName: input.cachedContact.firstName,
        lastName: input.cachedContact.lastName,
      });
      if (!repair) return null;

      const contactUpdate: Contact = {
        contactID: contactId,
        name: repair.name,
        firstName: repair.firstName,
        lastName: repair.lastName,
      };
      const payload = { contacts: [contactUpdate] };
      const payloadHash = buildXeroPayloadHash(payload);
      const idempotencyKey = buildXeroIdempotencyKey(
        "contact",
        contactId,
        "repair-name-order",
        payloadHash,
        "v2",
      );
      return {
        input: {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "UPDATE",
          localModel: "Member",
          localId: locked.id,
          idempotencyKey,
          correlationKey: idempotencyKey,
          requestPayload: payload,
        },
        value: { repair, payload, idempotencyKey },
      };
    },
  );
  if (!reservation) return null;
  const { operation, value } = reservation;

  try {
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.updateContact(
          input.tenantId,
          contactId,
          value.payload,
          value.idempotencyKey,
        ),
      {
        operation: "updateContact",
        resourceType: "CONTACT",
        workflow: "syncContactsFromXero",
        context: `repairContactNameOrder(${contactId})`,
      }
    );
    const completedContactId =
      response.body.contacts?.[0]?.contactID ?? contactId;

    await completeMemberContactUpdateOperation(
      input.member.id,
      contactId,
      operation.id,
      {
        responsePayload: response.body,
        xeroObjectType: "CONTACT",
        xeroObjectId: completedContactId,
        xeroObjectUrl: buildXeroContactUrl(completedContactId),
        extraLinks: [
          {
            localModel: "Member",
            localId: input.member.id,
            xeroObjectType: "CONTACT",
            xeroObjectId: completedContactId,
            xeroObjectUrl: buildXeroContactUrl(completedContactId),
            role: "CONTACT",
          },
        ],
      },
    );

    await refreshXeroContactCachesFromContact(
      {
        ...input.contact,
        contactID: completedContactId,
        name: value.repair.name,
        firstName: value.repair.firstName,
        lastName: value.repair.lastName,
      },
      new Date()
    );

    return value.repair.name;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// syncContactsFromXero
// ---------------------------------------------------------------------------

export async function syncContactsFromXero(
  options: SyncContactsFromXeroOptions = {}
): Promise<SyncReport> {
  const syncStartedAt = new Date();
  const cursor = options.fullResync
    ? null
    : await getXeroSyncCursor(
        CONTACT_SYNC_CURSOR_RESOURCE,
        DEFAULT_XERO_SYNC_SCOPE
      );
  const cursorMetadata = getXeroSyncCursorMetadata(cursor?.metadata);
  const ifModifiedSince =
    !options.fullResync && cursor?.cursorDateTime
      ? new Date(
          cursor.cursorDateTime.getTime() - CONTACT_SYNC_CURSOR_OVERLAP_MS
        )
      : undefined;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const report: SyncReport = {
    created: [],
    updated: [],
    skippedNoChanges: 0,
    skippedNameMismatch: [],
    skippedNoEmail: [],
    skippedOther: [],
    errors: [],
    total: 0,
  };

  const changedContacts = await fetchChangedXeroContactsFromXero({
    xero,
    tenantId,
    ifModifiedSince,
  });
  const retryContactIds = options.fullResync
    ? []
    : Array.from(new Set(cursorMetadata.retryContactIds ?? []));
  const contactsById = new Map<string, Contact>();

  for (const contact of changedContacts) {
    if (contact.contactID) {
      contactsById.set(contact.contactID, contact);
    }
  }

  if (retryContactIds.length > 0) {
    const retryContacts = await fetchXeroContactsByIdsFromXero({
      xero,
      tenantId,
      contactIds: retryContactIds,
      workflow: "syncContactsFromXero",
      contextPrefix: "syncContacts retry",
    });

    for (const contact of retryContacts) {
      if (contact.contactID) {
        contactsById.set(contact.contactID, contact);
      }
    }
  }

  report.total = contactsById.size;
  const fetchedAt = new Date();
  const nextRetryContactIds: string[] = [];

  for (const contact of contactsById.values()) {
    const contactName = getXeroContactDisplayName(contact);

    if (!contact.contactID) {
      report.skippedOther.push({
        name: contactName,
        reason: "No Xero contact ID",
      });
      continue;
    }

    try {
      const { cachedContact } = await refreshXeroContactCachesFromContact(
        contact,
        fetchedAt
      );
      if (!cachedContact) {
        report.skippedOther.push({
          name: contactName,
          reason: "Failed to cache Xero contact snapshot",
        });
        continue;
      }

      const alreadyLinked = await prisma.member.findFirst({
        where: { xeroContactId: contact.contactID },
      });
      if (alreadyLinked) {
        const changes: string[] = [];
        const updateData: InboundMemberContactPatch = {};
        const mismatch = getMemberXeroContactLinkMismatch(
          {
            id: alreadyLinked.id,
            firstName: alreadyLinked.firstName,
            lastName: alreadyLinked.lastName,
            email: alreadyLinked.email,
            active: alreadyLinked.active,
            xeroContactId: contact.contactID,
          },
          {
            contactId: contact.contactID,
            name: cachedContact.name,
            firstName: cachedContact.firstName,
            lastName: cachedContact.lastName,
            emailAddress: cachedContact.emailAddress,
          }
        );

        if (mismatch) {
          addNameMismatchToSyncReport(report, mismatch);
          logger.warn(
            {
              memberId: alreadyLinked.id,
              xeroContactId: contact.contactID,
              reasons: mismatch.reasons,
            },
            "Skipped Xero contact backfill because linked member and contact names differ"
          );
          continue;
        }

        const repairedContactName = await repairXeroContactNameOrderIfNeeded({
          xero,
          tenantId,
          contact,
          cachedContact,
          member: alreadyLinked,
        });
        if (repairedContactName) {
          changes.push(`Xero contact name set to ${repairedContactName}`);
        }

        if (!alreadyLinked.joinedDate && options.backfillJoinedDates) {
          const invoiceDate = await getContactFirstInvoiceDate(
            xero,
            tenantId,
            contact.contactID
          );
          if (invoiceDate) {
            updateData.joinedDate = invoiceDate;
          }
          await throttle(1500);
        }

        if (!alreadyLinked.phoneNumber && cachedContact.phoneNumber) {
          updateData.phoneCountryCode = cachedContact.phoneCountryCode;
          updateData.phoneAreaCode = cachedContact.phoneAreaCode;
          updateData.phoneNumber = cachedContact.phoneNumber;
        }

        if (
          !alreadyLinked.streetAddressLine1 &&
          cachedContact.streetAddressLine1
        ) {
          updateData.streetAddressLine1 = cachedContact.streetAddressLine1;
          updateData.streetAddressLine2 = cachedContact.streetAddressLine2;
          updateData.streetCity = cachedContact.streetCity;
          updateData.streetRegion = cachedContact.streetRegion;
          updateData.streetPostalCode = cachedContact.streetPostalCode;
          updateData.streetCountry = cachedContact.streetCountry;
        }
        if (
          !alreadyLinked.postalAddressLine1 &&
          cachedContact.postalAddressLine1
        ) {
          updateData.postalAddressLine1 = cachedContact.postalAddressLine1;
          updateData.postalAddressLine2 = cachedContact.postalAddressLine2;
          updateData.postalCity = cachedContact.postalCity;
          updateData.postalRegion = cachedContact.postalRegion;
          updateData.postalPostalCode = cachedContact.postalPostalCode;
          updateData.postalCountry = cachedContact.postalCountry;
        }

        const applied = await applyInboundMemberContactPatch({
          memberId: alreadyLinked.id,
          xeroContactId: contact.contactID,
          patch: updateData,
        });
        if (applied.appliedFields.includes("joinedDate") && updateData.joinedDate) {
          changes.push(
            `Joined date set to ${formatDateOnly(updateData.joinedDate)}`,
          );
        }
        if (applied.appliedFields.includes("phoneNumber") && updateData.phoneNumber) {
          changes.push(
            `Phone set to ${
              formatXeroPhone({
                phoneCountryCode: updateData.phoneCountryCode,
                phoneAreaCode: updateData.phoneAreaCode,
                phoneNumber: updateData.phoneNumber,
              }) ?? updateData.phoneNumber
            }`,
          );
        }
        if (applied.appliedFields.includes("streetAddressLine1")) {
          changes.push("Street address set from Xero");
        }
        if (applied.appliedFields.includes("postalAddressLine1")) {
          changes.push("Postal address set from Xero");
        }

        if (changes.length > 0) {
          await writeXeroContactSyncAudit({
            actorMemberId: options.auditActorMemberId,
            memberId: alreadyLinked.id,
            xeroContactId: contact.contactID,
            changes,
            source: options.auditSource ?? "syncContactsFromXero",
          });
          report.updated.push({
            name: `${alreadyLinked.firstName} ${alreadyLinked.lastName}`,
            memberId: alreadyLinked.id,
            xeroContactId: contact.contactID,
            changes,
          });
        } else {
          report.skippedNoChanges += 1;
        }
        continue;
      }

      if (!cachedContact.emailAddress) {
        report.skippedNoEmail.push({
          name: contactName,
          xeroContactId: contact.contactID,
        });
        continue;
      }

      /*
        INV-CONFIG-005 (#3036): on a copy, this contact's address may have been
        REPLACED by containment — a hash on a reserved domain. Matching a member
        by it cannot succeed, and reporting that as "No matching member by email"
        below would be the same false reason this change fixed on the member-import
        path: the contact has an address, it simply cannot be used, and an
        operator reading the report would go looking for missing member data that
        is perfectly fine. So it is skipped with a reason that says what happened.
      */
      if (isXeroSandboxContactEmail(cachedContact.emailAddress)) {
        report.skippedOther.push({
          name: contactName,
          xeroContactId: contact.contactID,
          reason:
            "This contact's email address was replaced with a non-deliverable one because this installation is a copy, so it cannot be matched to a member here. Run this sync on the club's live site instead.",
        });
        continue;
      }

      const member = await prisma.member.findFirst({
        where: {
          email: cachedContact.emailAddress.toLowerCase(),
          canLogin: true,
        },
      });

      if (!member) {
        report.skippedOther.push({
          name: contactName,
          xeroContactId: contact.contactID,
          reason: "No matching member by email",
        });
        continue;
      }

      if (member.xeroContactId && member.xeroContactId !== contact.contactID) {
        report.skippedOther.push({
          name: contactName,
          xeroContactId: contact.contactID,
          reason: `Matching member ${member.firstName} ${member.lastName} is already linked to a different Xero contact`,
        });
        continue;
      }

      const changes: string[] = [];
      const updateData: InboundMemberContactPatch = {};

      const mismatch = getMemberXeroContactLinkMismatch(
        {
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          active: member.active,
          xeroContactId: contact.contactID,
        },
        {
          contactId: contact.contactID,
          name: cachedContact.name,
          firstName: cachedContact.firstName,
          lastName: cachedContact.lastName,
          emailAddress: cachedContact.emailAddress,
        }
      );

      if (mismatch) {
        addNameMismatchToSyncReport(report, mismatch);
        logger.warn(
          {
            memberId: member.id,
            xeroContactId: contact.contactID,
            reasons: mismatch.reasons,
          },
          "Skipped Xero contact auto-link because member and contact names differ"
        );
        continue;
      }

      if (!member.joinedDate && options.backfillJoinedDates) {
        const invoiceDate = await getContactFirstInvoiceDate(
          xero,
          tenantId,
          contact.contactID
        );
        if (invoiceDate) {
          updateData.joinedDate = invoiceDate;
        }
        await throttle(1500);
      }

      if (!member.phoneNumber && cachedContact.phoneNumber) {
        updateData.phoneCountryCode = cachedContact.phoneCountryCode;
        updateData.phoneAreaCode = cachedContact.phoneAreaCode;
        updateData.phoneNumber = cachedContact.phoneNumber;
      }

      if (!member.streetAddressLine1 && cachedContact.streetAddressLine1) {
        updateData.streetAddressLine1 = cachedContact.streetAddressLine1;
        updateData.streetAddressLine2 = cachedContact.streetAddressLine2;
        updateData.streetCity = cachedContact.streetCity;
        updateData.streetRegion = cachedContact.streetRegion;
        updateData.streetPostalCode = cachedContact.streetPostalCode;
        updateData.streetCountry = cachedContact.streetCountry;
      }
      if (!member.postalAddressLine1 && cachedContact.postalAddressLine1) {
        updateData.postalAddressLine1 = cachedContact.postalAddressLine1;
        updateData.postalAddressLine2 = cachedContact.postalAddressLine2;
        updateData.postalCity = cachedContact.postalCity;
        updateData.postalRegion = cachedContact.postalRegion;
        updateData.postalPostalCode = cachedContact.postalPostalCode;
        updateData.postalCountry = cachedContact.postalCountry;
      }

      const applied = await applyInboundMemberContactPatch({
        memberId: member.id,
        xeroContactId: contact.contactID,
        patch: updateData,
      });
      if (applied.linked) changes.push("Linked to Xero contact");
      if (applied.appliedFields.includes("joinedDate") && updateData.joinedDate) {
        changes.push(
          `Joined date set to ${formatDateOnly(updateData.joinedDate)}`,
        );
      }
      if (applied.appliedFields.includes("phoneNumber") && updateData.phoneNumber) {
        changes.push(
          `Phone set to ${
            formatXeroPhone({
              phoneCountryCode: updateData.phoneCountryCode,
              phoneAreaCode: updateData.phoneAreaCode,
              phoneNumber: updateData.phoneNumber,
            }) ?? updateData.phoneNumber
          }`,
        );
      }
      if (applied.appliedFields.includes("streetAddressLine1")) {
        changes.push("Street address set from Xero");
      }
      if (applied.appliedFields.includes("postalAddressLine1")) {
        changes.push("Postal address set from Xero");
      }
      const repairedContactName = await repairXeroContactNameOrderIfNeeded({
        xero,
        tenantId,
        contact,
        cachedContact,
        member,
      });
      if (repairedContactName) {
        changes.push(`Xero contact name set to ${repairedContactName}`);
      }

      if (changes.length > 0) {
        await writeXeroContactSyncAudit({
          actorMemberId: options.auditActorMemberId,
          memberId: member.id,
          xeroContactId: contact.contactID,
          changes,
          source: options.auditSource ?? "syncContactsFromXero",
        });
        report.updated.push({
          name: `${member.firstName} ${member.lastName}`,
          memberId: member.id,
          xeroContactId: contact.contactID,
          changes,
        });
      } else {
        report.skippedNoChanges += 1;
      }
    } catch (err) {
      nextRetryContactIds.push(contact.contactID);
      report.errors.push({
        name: contactName,
        xeroContactId: contact.contactID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const completedAt = new Date();
  await upsertXeroSyncCursor({
    resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
    scope: DEFAULT_XERO_SYNC_SCOPE,
    cursorDateTime: syncStartedAt,
    lastSuccessfulSyncAt: completedAt,
    metadata: {
      retryContactIds: Array.from(new Set(nextRetryContactIds)),
      changedContactCount: changedContacts.length,
      windowStart: ifModifiedSince?.toISOString(),
      windowEnd: syncStartedAt.toISOString(),
    },
  });

  return report;
}
