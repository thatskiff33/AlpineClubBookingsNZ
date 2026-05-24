import { Contact, CreditNote, LineAmountTypes, type Contacts, type LineItem } from "xero-node";
import { getAgeTierXeroContactGroupMappings } from "@/lib/age-tier-xero-groups";
import {
  loadMembershipCancellationSettings,
  type MembershipCancellationXeroContactGroupSetting,
} from "@/lib/membership-cancellation-settings";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  buildXeroContactUrl,
  buildXeroCreditNoteUrl,
  buildXeroInvoiceUrl,
} from "@/lib/xero-links";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getResolvedAccountMapping,
  refreshXeroContactCachesFromContact,
} from "@/lib/xero";

const MEMBERSHIP_CANCELLATION_CREDIT_ROLE = "MEMBERSHIP_CANCELLATION_CREDIT_NOTE";
const MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE =
  "MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION";
const MEMBERSHIP_CANCELLATION_CONTACT_ROLE = "MEMBERSHIP_CANCELLATION_CONTACT";

type XeroGroupReference = {
  id: string;
  name: string | null;
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function seasonLabel(seasonYear: number): string {
  return `${seasonYear}/${seasonYear + 1}`;
}

function centsFromAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value * 100));
}

function getContactGroupId(group: unknown): string | null {
  if (!group || typeof group !== "object") return null;
  const record = group as Record<string, unknown>;
  const id = record.contactGroupID ?? record.contactGroupId ?? record.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function getContactGroupName(group: unknown): string | null {
  if (!group || typeof group !== "object") return null;
  const record = group as Record<string, unknown>;
  const name = record.name;
  return typeof name === "string" && name.trim() ? name : null;
}

function extractActiveContactGroups(contact: Contact): XeroGroupReference[] {
  const groups = Array.isArray(contact.contactGroups) ? contact.contactGroups : [];
  return groups
    .map((group) => {
      const id = getContactGroupId(group);
      return id ? { id, name: getContactGroupName(group) } : null;
    })
    .filter((group): group is XeroGroupReference => Boolean(group));
}

function uniqueCancellationGroups(
  groups: MembershipCancellationXeroContactGroupSetting[],
): XeroGroupReference[] {
  const seen = new Set<string>();
  const result: XeroGroupReference[] = [];

  for (const group of groups) {
    if (seen.has(group.groupId)) continue;
    seen.add(group.groupId);
    result.push({ id: group.groupId, name: group.groupName });
  }

  return result;
}

function buildAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
) {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1",
  );
}

function buildCancellationRecordLinks(params: {
  requestId: string;
  participantId: string;
  memberId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  metadata?: Record<string, unknown>;
}) {
  const base = {
    xeroObjectType: params.xeroObjectType,
    xeroObjectId: params.xeroObjectId,
    xeroObjectNumber: params.xeroObjectNumber ?? null,
    xeroObjectUrl: params.xeroObjectUrl ?? null,
    role: params.role,
    metadata: params.metadata,
  };

  return [
    {
      ...base,
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
    },
    {
      ...base,
      localModel: "MembershipCancellationRequest",
      localId: params.requestId,
    },
    {
      ...base,
      localModel: "Member",
      localId: params.memberId,
    },
  ];
}

export async function createXeroMembershipCancellationCreditNote(
  params: {
    subscriptionId: string;
    requestId: string;
    participantId: string;
    createdByMemberId?: string;
    syncOperationId?: string;
  },
): Promise<string | null> {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: params.subscriptionId },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          xeroContactId: true,
        },
      },
    },
  });

  if (!subscription) {
    throw new Error(`Member subscription not found: ${params.subscriptionId}`);
  }

  const operationId = params.syncOperationId ?? null;
  const shouldCredit =
    (subscription.status === "UNPAID" || subscription.status === "OVERDUE") &&
    Boolean(subscription.xeroInvoiceId);

  if (!shouldCredit) {
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "subscription_status_not_creditable",
          status: subscription.status,
          xeroInvoiceId: subscription.xeroInvoiceId,
        },
      });
    }
    return null;
  }

  const existingCreditLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: subscription.id,
      xeroObjectType: "CREDIT_NOTE",
      role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
      xeroObjectUrl: true,
    },
  });

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoiceId = subscription.xeroInvoiceId!;
  const invoiceResponse = await callXeroApi(
    () => xero.accountingApi.getInvoice(tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroMembershipCancellationCreditNote",
      context: `getInvoice(${invoiceId})`,
    },
  );
  const invoice = invoiceResponse.body.invoices?.[0];
  if (!invoice?.invoiceID) {
    throw new Error(`Xero subscription invoice not found: ${invoiceId}`);
  }

  const amountCents = centsFromAmount(invoice.amountDue ?? invoice.total);
  if (amountCents <= 0) {
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "invoice_has_no_amount_due",
          invoiceId,
          amountDue: invoice.amountDue ?? null,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: invoiceId,
        xeroObjectNumber: invoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      });
    }
    return null;
  }

  const contactId = invoice.contact?.contactID ?? subscription.member.xeroContactId;
  if (!contactId) {
    throw new Error(`No Xero contact available for subscription invoice: ${invoiceId}`);
  }

  if (existingCreditLink?.xeroObjectId) {
    await allocateMembershipCancellationCreditNote({
      creditNoteId: existingCreditLink.xeroObjectId,
      invoiceId,
      amountCents,
      subscriptionId: subscription.id,
      requestId: params.requestId,
      participantId: params.participantId,
      memberId: subscription.memberId,
      createdByMemberId: params.createdByMemberId,
    });
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          existingCreditNoteId: existingCreditLink.xeroObjectId,
          invoiceId,
          amountCents,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingCreditLink.xeroObjectId,
        xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
        xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
        extraLinks: [
          {
            localModel: "MemberSubscription",
            localId: subscription.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditLink.xeroObjectId,
            xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
            xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
            role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
            metadata: {
              requestId: params.requestId,
              participantId: params.participantId,
              seasonYear: subscription.seasonYear,
              invoiceId,
              amountCents,
            },
          },
          ...buildCancellationRecordLinks({
            requestId: params.requestId,
            participantId: params.participantId,
            memberId: subscription.memberId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditLink.xeroObjectId,
            xeroObjectNumber: existingCreditLink.xeroObjectNumber ?? null,
            xeroObjectUrl: existingCreditLink.xeroObjectUrl ?? null,
            role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
            metadata: {
              subscriptionId: subscription.id,
              seasonYear: subscription.seasonYear,
              invoiceId,
              amountCents,
            },
          }),
        ],
      });
    }
    return existingCreditLink.xeroObjectId;
  }

  const mapping = await getResolvedAccountMapping("membershipCancellationCredit");
  const accountCode = mapping.code ?? "203";
  const creditLineItem: LineItem = {
    description: `Membership cancellation credit for ${seasonLabel(subscription.seasonYear)} annual subscription`,
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
    accountCode,
  };
  if (mapping.itemCode) {
    creditLineItem.itemCode = mapping.itemCode;
  }

  const buildCreditNote = (): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: contactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: `Membership Cancellation ${params.participantId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    "member-subscription",
    subscription.id,
    "membership-cancellation-credit",
    params.participantId,
    amountCents,
    "v1",
  );
  let creditOperationId = operationId;
  const requestPayload = {
    creditNotes: [buildCreditNote()],
    allocation: {
      invoiceId,
      amountCents,
    },
    requestId: params.requestId,
    participantId: params.participantId,
  };

  if (creditOperationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: creditOperationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscription",
      localId: subscription.id,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: params.createdByMemberId ?? null,
    });
    creditOperationId = operation.id;
  }

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNotes(
          tenantId,
          { creditNotes: [buildCreditNote()] },
          undefined,
          undefined,
          idempotencyKey,
        ),
      {
        operation: "createCreditNotes",
        resourceType: "CREDIT_NOTE",
        workflow: "createXeroMembershipCancellationCreditNote",
        context: `createCreditNotes(membership cancellation ${subscription.id})`,
      },
    );
    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create membership cancellation Xero credit note");
    }

    const creditNoteUrl = buildXeroCreditNoteUrl(createdNote.creditNoteID);
    await upsertXeroObjectLink({
      localModel: "MemberSubscription",
      localId: subscription.id,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      xeroObjectUrl: creditNoteUrl,
      role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
      metadata: {
        requestId: params.requestId,
        participantId: params.participantId,
        seasonYear: subscription.seasonYear,
        invoiceId,
        amountCents,
      },
    });

    let allocationError: unknown = null;
    try {
      await allocateMembershipCancellationCreditNote({
        creditNoteId: createdNote.creditNoteID,
        invoiceId,
        amountCents,
        subscriptionId: subscription.id,
        requestId: params.requestId,
        participantId: params.participantId,
        memberId: subscription.memberId,
        createdByMemberId: params.createdByMemberId,
      });
    } catch (error) {
      allocationError = error;
    }

    await completeXeroSyncOperation(creditOperationId!, {
      status: allocationError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        creditNote: response.body,
        allocationError,
        invoiceId,
        amountCents,
      },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      xeroObjectUrl: creditNoteUrl,
      extraLinks: [
        {
          localModel: "MemberSubscription",
          localId: subscription.id,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          xeroObjectUrl: creditNoteUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
          metadata: {
            requestId: params.requestId,
            participantId: params.participantId,
            seasonYear: subscription.seasonYear,
            invoiceId,
            amountCents,
          },
        },
        ...buildCancellationRecordLinks({
          requestId: params.requestId,
          participantId: params.participantId,
          memberId: subscription.memberId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          xeroObjectUrl: creditNoteUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ROLE,
          metadata: {
            subscriptionId: subscription.id,
            seasonYear: subscription.seasonYear,
            invoiceId,
            amountCents,
          },
        }),
      ],
    });

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(creditOperationId!, error);
    throw error;
  }
}

async function allocateMembershipCancellationCreditNote(params: {
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  subscriptionId: string;
  requestId: string;
  participantId: string;
  memberId: string;
  createdByMemberId?: string;
}) {
  const allocationId = buildAllocationId(
    params.creditNoteId,
    params.invoiceId,
    params.amountCents,
  );
  const existingAllocation = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: allocationId,
      role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
      active: true,
    },
    select: { id: true },
  });
  if (existingAllocation) return;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    params.creditNoteId,
    "membership-cancellation",
    "invoice",
    params.invoiceId,
    params.amountCents,
    "v1",
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel: "MemberSubscription",
    localId: params.subscriptionId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      creditNoteId: params.creditNoteId,
      invoiceId: params.invoiceId,
      amountCents: params.amountCents,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          params.creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: params.invoiceId },
                amount: params.amountCents / 100,
                date: formatDate(new Date()),
              },
            ],
          },
          undefined,
          idempotencyKey,
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateMembershipCancellationCreditNote",
        context: `createCreditNoteAllocation(${params.creditNoteId} -> ${params.invoiceId})`,
      },
    );

    const allocationUrl = buildXeroInvoiceUrl(params.invoiceId);
    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: allocationId,
      xeroObjectUrl: allocationUrl,
      extraLinks: [
        {
          localModel: "MemberSubscription",
          localId: params.subscriptionId,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: allocationId,
          xeroObjectUrl: allocationUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
          metadata: {
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.amountCents,
            requestId: params.requestId,
            participantId: params.participantId,
          },
        },
        ...buildCancellationRecordLinks({
          requestId: params.requestId,
          participantId: params.participantId,
          memberId: params.memberId,
          xeroObjectType: "ALLOCATION",
          xeroObjectId: allocationId,
          xeroObjectUrl: allocationUrl,
          role: MEMBERSHIP_CANCELLATION_CREDIT_ALLOCATION_ROLE,
          metadata: {
            subscriptionId: params.subscriptionId,
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.amountCents,
          },
        }),
      ],
    });
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

export async function syncXeroMembershipCancellationContact(params: {
  memberId: string;
  requestId: string;
  participantId: string;
  createdByMemberId?: string;
  syncOperationId?: string;
}) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      xeroContactId: true,
    },
  });
  if (!member) {
    throw new Error(`Member not found: ${params.memberId}`);
  }

  const operationId = params.syncOperationId ?? null;
  if (!member.xeroContactId) {
    if (operationId) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: "member_has_no_xero_contact",
          memberId: params.memberId,
        },
      });
    }
    return {
      memberId: params.memberId,
      xeroContactId: null,
      addedGroupIds: [] as string[],
      removedGroupIds: [] as string[],
      archived: false,
      skippedReason: "member_has_no_xero_contact",
    };
  }

  const [settings, ageTierMappings] = await Promise.all([
    loadMembershipCancellationSettings(),
    getAgeTierXeroContactGroupMappings(),
  ]);
  const cancelledGroups = uniqueCancellationGroups(settings.xeroContactGroups);
  const managedGroupIds = Array.from(
    new Set(ageTierMappings.map((mapping) => mapping.groupId)),
  );
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = member.xeroContactId;

  const contactResponse = await callXeroApi(
    () => xero.accountingApi.getContact(tenantId, contactId),
    {
      operation: "getContact",
      resourceType: "CONTACT",
      workflow: "syncXeroMembershipCancellationContact",
      context: `getContact(${contactId})`,
    },
  );
  const contact = contactResponse.body.contacts?.[0];
  if (!contact?.contactID) {
    throw new Error(`Xero contact ${contactId} was not found`);
  }

  const currentGroups = extractActiveContactGroups(contact);
  const currentGroupIds = new Set(currentGroups.map((group) => group.id));
  const removedGroupIds = currentGroups
    .filter((group) => managedGroupIds.includes(group.id))
    .map((group) => group.id);
  const groupsAfterRemoval = new Set(
    [...currentGroupIds].filter((groupId) => !removedGroupIds.includes(groupId)),
  );
  const groupsToAdd = cancelledGroups.filter(
    (group) => !groupsAfterRemoval.has(group.id) || removedGroupIds.includes(group.id),
  );
  const shouldArchive =
    settings.xeroArchiveContactsOnCancellation &&
    contact.contactStatus !== Contact.ContactStatusEnum.ARCHIVED;
  const requestPayload = {
    memberId: member.id,
    memberName: `${member.firstName} ${member.lastName}`,
    requestId: params.requestId,
    participantId: params.participantId,
    xeroContactId: contactId,
    managedGroupIds,
    cancelledGroups,
    currentGroups,
    archiveContact: settings.xeroArchiveContactsOnCancellation,
  };
  const idempotencyKey = buildXeroIdempotencyKey(
    "membership-cancellation",
    params.participantId,
    "contact",
    buildXeroPayloadHash(requestPayload),
    "v1",
  );
  let contactOperationId = operationId;
  if (contactOperationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: contactOperationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: params.createdByMemberId ?? null,
    });
    contactOperationId = operation.id;
  }

  const addedGroupIds: string[] = [];
  try {
    for (const groupId of removedGroupIds) {
      await callXeroApi(
        () => xero.accountingApi.deleteContactGroupContact(tenantId, groupId, contactId),
        {
          operation: "deleteContactGroupContact",
          resourceType: "CONTACT_GROUP",
          workflow: "syncXeroMembershipCancellationContact",
          context: `deleteContactGroupContact(${groupId}, ${contactId})`,
        },
      );
    }

    for (const group of groupsToAdd) {
      const contacts: Contacts = { contacts: [{ contactID: contactId }] };
      const addIdempotencyKey = buildXeroIdempotencyKey(
        "contact",
        contactId,
        "cancelled-contact-group-add",
        group.id,
        "v1",
      );
      await callXeroApi(
        () =>
          xero.accountingApi.createContactGroupContacts(
            tenantId,
            group.id,
            contacts,
            addIdempotencyKey,
          ),
        {
          operation: "createContactGroupContacts",
          resourceType: "CONTACT_GROUP",
          workflow: "syncXeroMembershipCancellationContact",
          context: `createContactGroupContacts(${group.id}, ${contactId})`,
        },
      );
      addedGroupIds.push(group.id);
    }

    let archived = false;
    let archiveResponseBody: unknown = null;
    if (shouldArchive) {
      const archivePayload = {
        contacts: [
          {
            contactID: contactId,
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
          },
        ],
      };
      const archiveIdempotencyKey = buildXeroIdempotencyKey(
        "contact",
        contactId,
        "membership-cancellation-archive",
        params.participantId,
        "v1",
      );
      const archiveResponse = await callXeroApi(
        () =>
          xero.accountingApi.updateContact(
            tenantId,
            contactId,
            archivePayload,
            archiveIdempotencyKey,
          ),
        {
          operation: "updateContact",
          resourceType: "CONTACT",
          workflow: "syncXeroMembershipCancellationContact",
          context: `archiveContact(${contactId})`,
        },
      );
      archiveResponseBody = archiveResponse.body;
      archived = true;
    }

    try {
      const refreshedResponse = await callXeroApi(
        () => xero.accountingApi.getContact(tenantId, contactId),
        {
          operation: "getContact",
          resourceType: "CONTACT",
          workflow: "syncXeroMembershipCancellationContact",
          context: `refreshContact(${contactId})`,
        },
      );
      const refreshedContact = refreshedResponse.body.contacts?.[0];
      if (refreshedContact) {
        await refreshXeroContactCachesFromContact(refreshedContact);
      }
    } catch {
      await refreshXeroContactCachesFromContact(contact);
    }

    await completeXeroSyncOperation(contactOperationId!, {
      responsePayload: {
        addedGroupIds,
        removedGroupIds,
        archived,
        archiveResponse: archiveResponseBody,
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: contactId,
      xeroObjectUrl: buildXeroContactUrl(contactId),
      extraLinks: buildCancellationRecordLinks({
        requestId: params.requestId,
        participantId: params.participantId,
        memberId: params.memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: contactId,
        xeroObjectUrl: buildXeroContactUrl(contactId),
        role: MEMBERSHIP_CANCELLATION_CONTACT_ROLE,
        metadata: {
          addedGroupIds,
          removedGroupIds,
          archived,
        },
      }),
    });

    return {
      memberId: params.memberId,
      xeroContactId: contactId,
      addedGroupIds,
      removedGroupIds,
      archived,
      skippedReason: null,
    };
  } catch (error) {
    await failXeroSyncOperation(contactOperationId!, error);
    throw error;
  }
}
