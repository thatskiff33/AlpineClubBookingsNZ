/**
 * A school's OWN email address and phone number at Xero (#5245).
 *
 * `organisation-xero-contact-persons.ts` keeps the PEOPLE named on a school's
 * Xero contact honest; this module does the same for the school's own address
 * and number, which an officer can now correct in the app
 * (`school-organisation-contact-edit.ts`). The correction queues one outbox row
 * in the same transaction that saves it, and the row runs here.
 *
 * ## What is sent, and what never is
 *
 * Exactly three keys: `contactID`, `emailAddress` and `phones`. NEVER `name`
 * (#3367): Xero enforces unique contact names and renaming a school is an
 * officer decision, not a sync. The payload is built by picking those keys out
 * of the shared organisation builder rather than spreading it, so a field added
 * to the builder later cannot ride along into this update.
 *
 * ## Read at send time
 *
 * The queued row holds no details. They are read when the row runs, so a row
 * retried a day later sends what the club holds then, and a row queued before a
 * second correction does not send the first one. A row a later correction has
 * superseded is closed CANCELLED without a provider call: the newer row is the
 * one that speaks for the school, and the one the officer's screen shows.
 *
 * ## No contact yet
 *
 * A school whose first invoice has not been raised has no Xero contact, so the
 * edit queues nothing: the create path builds the contact from the corrected
 * record (`buildOrganisationXeroContactPayload`). A correction that lands while
 * that create is in flight is queued by the link instead
 * (`enqueueOrganisationContactDetailsIfMoved`). A row that finds no contact
 * anyway (an officer unlinked it in between) closes as a no-op for the same
 * reason.
 */
import { Phone } from "xero-node";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { resolveXeroContactEmailPolicy } from "@/lib/xero-contact-containment";
import {
  buildOrganisationXeroContactPayload,
  ORGANISATION_LOCAL_MODEL,
  readOrganisationForXeroContact,
  refreshOrganisationContactPersons,
} from "@/lib/organisation-xero-contact-persons";
import {
  buildOrganisationContactDetailsPayload,
  XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE,
} from "@/lib/organisation-contact-details-payload";

const CONTACT_DETAILS_ROW = {
  queueType: XERO_OUTBOX_ORGANISATION_CONTACT_DETAILS_TYPE,
  localModel: ORGANISATION_LOCAL_MODEL,
  entityType: "CONTACT",
  operationType: "UPDATE",
} as const;

/**
 * Queue the school's details for its Xero contact, on the caller's transaction.
 *
 * Keyed on the record's `updatedAt` after the edit, so every correction gets a
 * row of its own and two corrections never share one.
 */
export async function enqueueOrganisationContactDetailsOperation(
  tx: Prisma.TransactionClient,
  input: { organisationId: string; version: Date; createdByMemberId: string | null },
) {
  const key = buildXeroIdempotencyKey(
    "organisation",
    input.organisationId,
    "contact",
    "details",
    input.version.toISOString(),
    "v1",
  );
  return startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: CONTACT_DETAILS_ROW.entityType,
    operationType: CONTACT_DETAILS_ROW.operationType,
    localModel: CONTACT_DETAILS_ROW.localModel,
    localId: input.organisationId,
    status: "PENDING",
    idempotencyKey: key,
    correlationKey: key,
    requestPayload: buildOrganisationContactDetailsPayload(),
    createdByMemberId: input.createdByMemberId,
    store: tx,
  });
}

/**
 * Queue the school's details when they moved after `read`: an officer's
 * correction that committed while the school's first contact was being created
 * from the older details, when the edit had no contact to queue for. Called on
 * the link's transaction, under the organisation contact key the edit takes, so
 * one or the other always queues it.
 */
export async function enqueueOrganisationContactDetailsIfMoved(
  tx: Prisma.TransactionClient,
  input: {
    organisationId: string;
    read: { email: string | null; phone: string | null };
    fresh: { email: string | null; phone: string | null; updatedAt: Date };
    createdByMemberId?: string | null;
  },
) {
  const { read, fresh } = input;
  if (fresh.email === read.email && fresh.phone === read.phone) return null;
  return enqueueOrganisationContactDetailsOperation(tx, {
    organisationId: input.organisationId,
    version: fresh.updatedAt,
    createdByMemberId: input.createdByMemberId ?? null,
  });
}

/** The newest contact-details row for a school: what the officer's screen shows. */
export async function findLatestOrganisationContactDetailsOperation(
  organisationId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.xeroSyncOperation.findFirst({
    where: {
      queueType: CONTACT_DETAILS_ROW.queueType,
      localModel: CONTACT_DETAILS_ROW.localModel,
      localId: organisationId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      lastErrorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });
}

/**
 * The phones Xero is sent. An empty list leaves Xero's stored number in place,
 * so a cleared number is sent as the same phone type with every part blank.
 */
function phonesToSend(phones: Phone[] | undefined): Phone[] {
  if (phones && phones.length > 0) return phones;
  return [
    {
      phoneType: Phone.PhoneTypeEnum.MOBILE,
      phoneCountryCode: "",
      phoneAreaCode: "",
      phoneNumber: "",
    },
  ];
}

/**
 * Run one queued contact-details row. Throws on a provider failure; the outbox
 * records the row FAILED and replayable, which is what the officer's Retry
 * reads.
 */
export async function syncOrganisationContactDetails(input: {
  organisationId: string;
  syncOperation: XeroOperationClaim;
  createdByMemberId?: string;
}): Promise<void> {
  const { organisationId, syncOperation } = input;

  const latest = await findLatestOrganisationContactDetailsOperation(organisationId);
  if (latest && latest.id !== syncOperation.id) {
    await completeXeroSyncOperation(syncOperation, {
      status: "CANCELLED",
      responsePayload: { skipped: "superseded", supersededBy: latest.id },
    });
    return;
  }

  // INV-CONFIG-005 first, before any provider work: a copy sends a contained
  // address, and an undeclared installation refuses here.
  const { policy } = await resolveXeroContactEmailPolicy();
  const organisation = await readOrganisationForXeroContact(organisationId);
  const xeroContactId = organisation.xeroContactId;
  if (!xeroContactId) {
    await completeXeroSyncOperation(syncOperation, {
      responsePayload: { skipped: "no-xero-contact" },
    });
    return;
  }

  const built = buildOrganisationXeroContactPayload(organisation, policy);
  // A pick, never a spread: `name` must not reach this update (#3367).
  const contact = {
    contactID: xeroContactId,
    emailAddress: built.emailAddress ?? "",
    phones: phonesToSend(built.phones),
  };
  const idempotencyKey = buildXeroIdempotencyKey(
    "organisation",
    organisationId,
    "contact",
    "details",
    buildXeroPayloadHash(contact),
    "v1",
  );

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () =>
      xero.accountingApi.updateContact(
        tenantId,
        xeroContactId,
        { contacts: [contact] },
        idempotencyKey,
      ),
    {
      operation: "updateContact",
      resourceType: "CONTACT",
      workflow: "syncOrganisationContactDetails",
      context: `updateContact(organisation ${organisationId} details)`,
    },
  );
  await completeXeroSyncOperation(syncOperation, {
    responsePayload: response.body,
    xeroObjectType: "CONTACT",
    xeroObjectId: xeroContactId,
    xeroObjectUrl: buildXeroContactUrl(xeroContactId),
  });

  // The persons ride along when they have changed; best-effort, with their own
  // ledger row, exactly as on an invoice's contact resolution.
  await refreshOrganisationContactPersons({
    organisation,
    xeroContactId,
    policy,
    resolveClient: async () => ({ xero, tenantId }),
    createdByMemberId: input.createdByMemberId,
  });
}
