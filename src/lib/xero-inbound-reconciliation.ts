import { Address, Phone, type Contact, type Invoice, type XeroClient } from "xero-node";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { getSeasonYear } from "@/lib/utils";
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  callXeroApi,
  checkMembershipStatus,
  findSubscriptionInvoice,
  getAccountMapping,
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "@/lib/xero";
import {
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";

interface StoredXeroInboundEvent {
  id: string;
  source: string;
  eventCategory: string | null;
  eventType: string;
  resourceId: string | null;
  correlationKey: string;
  payload: unknown;
}

interface MemberBackfillCandidate {
  id: string;
  xeroContactId: string | null;
  dateOfBirth: Date | null;
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  streetAddressLine1: string | null;
  postalAddressLine1: string | null;
  joinedDate: Date | null;
}

export interface ProcessStoredXeroInboundEventsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export class XeroInboundReplayError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "XeroInboundReplayError";
    this.status = status;
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
  );
}

function buildProcessedWebhookEventType(event: Pick<StoredXeroInboundEvent, "eventCategory" | "eventType">) {
  return `${event.eventCategory ?? "UNKNOWN"}.${event.eventType}`;
}

function buildInboundXeroObjectType(eventCategory: string | null): string | null {
  if (!eventCategory) {
    return null;
  }

  const normalized = eventCategory.trim().toUpperCase();
  return normalized || null;
}

function parseXeroDateOfBirth(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

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
    const firstInvoice = response.body.invoices?.[0];
    if (!firstInvoice?.date) {
      return null;
    }

    const invoiceDate = new Date(firstInvoice.date);
    return Number.isNaN(invoiceDate.getTime()) ? null : invoiceDate;
  } catch (error) {
    if (error instanceof XeroDailyLimitError) {
      throw error;
    }

    logger.warn({ err: error, contactId }, "Failed to fetch first Xero invoice date for contact");
    return null;
  }
}

async function resolveMemberIdsForContact(contactId: string): Promise<string[]> {
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

async function reconcileXeroContact(contactId: string) {
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
  const phone = extractContactPhone(contact);
  const addresses = extractContactAddresses(contact);
  const dateOfBirth = parseXeroDateOfBirth(contact.companyNumber);
  const joinedDate = members.some((member) => !member.joinedDate)
    ? await getContactFirstInvoiceDate(xero, tenantId, contactId)
    : null;
  const canApplyCanonicalLink = members.length === 1;
  let updatedMembers = 0;
  let linkedMembers = 0;
  let backfilledFields = 0;

  for (const member of members as MemberBackfillCandidate[]) {
    const updates: Record<string, unknown> = {};

    if (!member.xeroContactId && canApplyCanonicalLink) {
      updates.xeroContactId = contactId;
      linkedMembers += 1;
    }

    if (!member.dateOfBirth && dateOfBirth) {
      updates.dateOfBirth = dateOfBirth;
    }

    if (!member.phoneNumber && phone) {
      updates.phoneCountryCode = phone.phoneCountryCode;
      updates.phoneAreaCode = phone.phoneAreaCode;
      updates.phoneNumber = phone.phoneNumber;
    }

    if (!member.streetAddressLine1 && addresses.street) {
      Object.assign(updates, addresses.street);
    }

    if (!member.postalAddressLine1 && addresses.postal) {
      Object.assign(updates, addresses.postal);
    }

    if (!member.joinedDate && joinedDate) {
      updates.joinedDate = joinedDate;
    }

    await upsertXeroObjectLink({
      localModel: "Member",
      localId: member.id,
      xeroObjectType: "CONTACT",
      xeroObjectId: contactId,
      xeroObjectUrl: buildXeroContactUrl(contactId),
      role: "CONTACT",
    });

    const updateKeys = Object.keys(updates);
    if (updateKeys.length > 0) {
      await prisma.member.update({
        where: {
          id: member.id,
        },
        data: updates,
      });
      updatedMembers += 1;
      backfilledFields += updateKeys.length;
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
  };
}

function buildSeasonYearFromInvoice(invoice: Invoice): number {
  const invoiceDate = invoice.date ? new Date(invoice.date) : new Date();
  return Number.isNaN(invoiceDate.getTime()) ? getSeasonYear(new Date()) : getSeasonYear(invoiceDate);
}

async function reconcileXeroInvoice(invoiceId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getInvoice(tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "reconcileXeroInvoice",
      context: `reconcileXeroInvoice(${invoiceId})`,
    }
  );
  const invoice = response.body.invoices?.[0];

  if (!invoice?.invoiceID) {
    throw new Error(`Xero invoice ${invoiceId} was not found`);
  }

  const invoiceUrl = buildXeroInvoiceUrl(invoice.invoiceID);
  const relatedLinks = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectId: invoice.invoiceID,
      xeroObjectType: {
        in: ["INVOICE", "SUBSCRIPTION"],
      },
      active: true,
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      role: true,
    },
  });

  for (const link of relatedLinks) {
    await upsertXeroObjectLink({
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: link.xeroObjectType,
      xeroObjectId: invoice.invoiceID,
      xeroObjectNumber: invoice.invoiceNumber ?? null,
      xeroObjectUrl: invoiceUrl,
      role: link.role,
    });
  }

  const linkedPaymentIds = relatedLinks
    .filter((link) => link.localModel === "Payment" && link.role === "PRIMARY_INVOICE")
    .map((link) => link.localId);
  const paymentWhere = [
    {
      xeroInvoiceId: invoice.invoiceID,
    },
    ...(linkedPaymentIds.length > 0
      ? [
          {
            id: {
              in: linkedPaymentIds,
            },
          },
        ]
      : []),
  ];
  const payments = await prisma.payment.findMany({
    where: {
      OR: paymentWhere,
    },
    select: {
      id: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
    },
  });
  const canApplyCanonicalPaymentLink = payments.length === 1;
  let updatedPayments = 0;

  for (const payment of payments) {
    const updates: Record<string, unknown> = {};

    if (!payment.xeroInvoiceId && canApplyCanonicalPaymentLink) {
      updates.xeroInvoiceId = invoice.invoiceID;
    }

    if (invoice.invoiceNumber && payment.xeroInvoiceNumber !== invoice.invoiceNumber) {
      updates.xeroInvoiceNumber = invoice.invoiceNumber;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: updates,
      });
      updatedPayments += 1;
    }
  }

  const linkedSubscriptionIds = relatedLinks
    .filter(
      (link) =>
        link.localModel === "MemberSubscription" &&
        link.role === "SUBSCRIPTION_INVOICE"
    )
    .map((link) => link.localId);
  const subscriptionWhere = [
    {
      xeroInvoiceId: invoice.invoiceID,
    },
    ...(linkedSubscriptionIds.length > 0
      ? [
          {
            id: {
              in: linkedSubscriptionIds,
            },
          },
        ]
      : []),
  ];
  const subscriptions = await prisma.memberSubscription.findMany({
    where: {
      OR: subscriptionWhere,
    },
    select: {
      id: true,
      memberId: true,
      seasonYear: true,
    },
  });

  const refreshedSubscriptions = new Set<string>();
  for (const subscription of subscriptions) {
    await checkMembershipStatus(subscription.memberId, subscription.seasonYear);
    refreshedSubscriptions.add(`${subscription.memberId}:${subscription.seasonYear}`);
  }

  const seasonYear = buildSeasonYearFromInvoice(invoice);
  const subscriptionIncomeCode = (await getAccountMapping("subscriptionIncome")) ?? "203";
  const looksLikeSubscriptionInvoice =
    findSubscriptionInvoice([invoice], seasonYear, subscriptionIncomeCode) !== null;

  if (looksLikeSubscriptionInvoice && refreshedSubscriptions.size === 0) {
    const contactId = invoice.contact?.contactID ?? null;
    if (contactId) {
      const memberIds = await resolveMemberIdsForContact(contactId);
      for (const memberId of memberIds) {
        await checkMembershipStatus(memberId, seasonYear);
        refreshedSubscriptions.add(`${memberId}:${seasonYear}`);
      }
    }
  }

  return {
    handled: true,
    kind: "INVOICE",
    resourceId: invoice.invoiceID,
    invoiceNumber: invoice.invoiceNumber ?? null,
    matchedPayments: payments.length,
    updatedPayments,
    refreshedSubscriptions: refreshedSubscriptions.size,
    relatedLinksUpdated: relatedLinks.length,
    looksLikeSubscriptionInvoice,
  };
}

async function processXeroInboundEvent(event: StoredXeroInboundEvent) {
  if (!event.resourceId) {
    return {
      handled: false,
      kind: event.eventCategory ?? "UNKNOWN",
      reason: "Event did not include a resourceId.",
    };
  }

  switch (event.eventCategory) {
    case "CONTACT":
      return reconcileXeroContact(event.resourceId);
    case "INVOICE":
      return reconcileXeroInvoice(event.resourceId);
    default:
      return {
        handled: false,
        kind: event.eventCategory ?? "UNKNOWN",
        resourceId: event.resourceId,
        reason: `No inbound reconciliation handler for ${event.eventCategory ?? "UNKNOWN"}.${event.eventType}.`,
      };
  }
}

async function claimStoredInboundEvent(eventId: string) {
  const result = await prisma.xeroInboundEvent.updateMany({
    where: {
      id: eventId,
      status: {
        in: ["RECEIVED", "FAILED"],
      },
    },
    data: {
      status: "PROCESSING",
      errorMessage: null,
      processedAt: null,
    },
  });

  return result.count === 1;
}

async function markStoredInboundEventProcessed(eventId: string) {
  await prisma.xeroInboundEvent.update({
    where: {
      id: eventId,
    },
    data: {
      status: "PROCESSED",
      errorMessage: null,
      processedAt: new Date(),
    },
  });
}

async function markStoredInboundEventFailed(eventId: string, error: unknown) {
  await prisma.xeroInboundEvent.update({
    where: {
      id: eventId,
    },
    data: {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      processedAt: null,
    },
  });
}

async function claimProcessedWebhookEvent(event: StoredXeroInboundEvent) {
  try {
    await prisma.processedWebhookEvent.create({
      data: {
        eventId: event.correlationKey,
        source: "xero",
        eventType: buildProcessedWebhookEventType(event),
      },
    });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }
}

async function releaseProcessedWebhookEventClaim(event: StoredXeroInboundEvent) {
  await prisma.processedWebhookEvent.deleteMany({
    where: {
      eventId: event.correlationKey,
      source: "xero",
    },
  });
}

export async function processStoredXeroInboundEvents(options?: {
  limit?: number;
  eventIds?: string[];
}): Promise<ProcessStoredXeroInboundEventsResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const eventIds =
    options?.eventIds?.filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];
  const events = await prisma.xeroInboundEvent.findMany({
    where: {
      status: {
        in: ["RECEIVED", "FAILED"],
      },
      ...(eventIds.length > 0
        ? {
            id: {
              in: eventIds,
            },
          }
        : {}),
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessStoredXeroInboundEventsResult = {
    found: events.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const event of events as StoredXeroInboundEvent[]) {
    const claimed = await claimStoredInboundEvent(event.id);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const deduped = await claimProcessedWebhookEvent(event);
    if (!deduped) {
      await markStoredInboundEventProcessed(event.id);
      result.skipped += 1;
      continue;
    }

    let operationId: string | null = null;

    try {
      const operation = await startXeroSyncOperation({
        direction: "INBOUND",
        entityType: event.eventCategory ?? "UNKNOWN",
        operationType: "WEBHOOK_RECONCILE",
        correlationKey: event.correlationKey,
        replayable: true,
        requestPayload: event.payload,
      });
      operationId = operation.id;

      const reconcileResult = await processXeroInboundEvent(event);
      await completeXeroSyncOperation(operationId, {
        responsePayload: reconcileResult,
        xeroObjectType: buildInboundXeroObjectType(event.eventCategory),
        xeroObjectId: event.resourceId,
        xeroObjectUrl:
          event.eventCategory === "CONTACT" && event.resourceId
            ? buildXeroContactUrl(event.resourceId)
            : event.eventCategory === "INVOICE" && event.resourceId
              ? buildXeroInvoiceUrl(event.resourceId)
              : null,
      });
      await markStoredInboundEventProcessed(event.id);
      result.succeeded += 1;
    } catch (error) {
      logger.error(
        {
          err: error,
          inboundEventId: event.id,
          correlationKey: event.correlationKey,
          resourceId: event.resourceId,
        },
        "Failed to process stored Xero inbound event"
      );

      if (operationId) {
        await failXeroSyncOperation(operationId, error);
      }
      await markStoredInboundEventFailed(event.id, error);
      await releaseProcessedWebhookEventClaim(event);
      result.failed += 1;
    }
  }

  return result;
}

export async function replayStoredXeroInboundEvent(eventId: string) {
  const event = await prisma.xeroInboundEvent.findUnique({
    where: {
      id: eventId,
    },
    select: {
      id: true,
      correlationKey: true,
      status: true,
      errorMessage: true,
      processedAt: true,
    },
  });

  if (!event) {
    throw new XeroInboundReplayError("Xero inbound event not found.", 404);
  }

  if (event.status === "PROCESSING") {
    throw new XeroInboundReplayError(
      "This inbound event is already being processed.",
      409
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.processedWebhookEvent.deleteMany({
      where: {
        eventId: event.correlationKey,
        source: "xero",
      },
    });

    await tx.xeroInboundEvent.update({
      where: {
        id: event.id,
      },
      data: {
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      },
    });
  });

  const result = await processStoredXeroInboundEvents({
    limit: 1,
    eventIds: [event.id],
  });

  const replayedEvent = await prisma.xeroInboundEvent.findUnique({
    where: {
      id: event.id,
    },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      processedAt: true,
    },
  });

  if (!replayedEvent) {
    throw new XeroInboundReplayError(
      "Xero inbound event disappeared during replay.",
      500
    );
  }

  if (replayedEvent.status === "FAILED") {
    throw new XeroInboundReplayError(
      replayedEvent.errorMessage ?? "Xero inbound event replay failed.",
      409
    );
  }

  return {
    result,
    event: replayedEvent,
  };
}
