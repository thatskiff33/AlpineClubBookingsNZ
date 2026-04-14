import {
  Address,
  Phone,
  type Contact,
  type Invoice,
  type Payment as XeroPayment,
  type XeroClient,
} from "xero-node";
import { CreditType } from "@prisma/client";
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
  refreshAllMembershipStatuses,
  refreshXeroContactCachesFromContact,
  syncContactsFromXero,
  XeroDailyLimitError,
} from "@/lib/xero";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
  type XeroObjectLinkInput,
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

interface ResolvedXeroObjectLink {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  role: string;
}

interface CreditNoteAmounts {
  total?: number | null;
  appliedAmount?: number | null;
  remainingCredit?: number | null;
}

const MEMBERSHIP_SYNC_CURSOR_RESOURCE = "MEMBERSHIP_INVOICE_SYNC";
const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";
const DEFAULT_XERO_SYNC_SCOPE = "default";
const DEFAULT_XERO_SYNC_SCOPE_PREFIX = "season:";
const DEFAULT_XERO_INBOUND_BATCH_SIZE = 10;
const DEFAULT_XERO_INBOUND_MAX_BATCHES = 5;
const DEFAULT_CONTACT_RECONCILE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MEMBERSHIP_RECONCILE_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface ProcessStoredXeroInboundEventsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface IncrementalMembershipReconciliationResult {
  seasonYear: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  changedInvoices: number;
  changedInvoiceIds: string[];
  affectedMembers: number;
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  skipped?: boolean;
  reason?: string;
}

export interface IncrementalContactReconciliationResult {
  cursorFrom: string | null;
  cursorTo: string | null;
  total: number;
  created: number;
  updated: number;
  skippedNoChanges: number;
  skippedNoEmail: number;
  skippedOther: number;
  errors: number;
  skipped?: boolean;
  reason?: string;
}

export interface IncrementalInvoiceReconciliationResult {
  processed: number;
  succeeded: number;
  failed: number;
  errorDetails: Array<{ invoiceId: string; error: string }>;
  skipped?: boolean;
  reason?: string;
}

export interface RunXeroInboundReconciliationCycleResult {
  inbound: ProcessStoredXeroInboundEventsResult & {
    batches: number;
  };
  contactReconciliation: IncrementalContactReconciliationResult | null;
  membershipReconciliation: IncrementalMembershipReconciliationResult | null;
  invoiceReconciliation: IncrementalInvoiceReconciliationResult | null;
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

function buildSyntheticAllocationLinkId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}

function getPositiveCurrencyAmountCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100);
}

function getCreditNoteAmountCents(
  creditNote: CreditNoteAmounts
): number | null {
  const totalAmountCents = getPositiveCurrencyAmountCents(creditNote.total);
  if (totalAmountCents !== null) {
    return totalAmountCents;
  }

  const appliedAmount = creditNote.appliedAmount ?? 0;
  const remainingAmount = creditNote.remainingCredit ?? 0;
  return getPositiveCurrencyAmountCents(appliedAmount + remainingAmount);
}

function buildXeroPaymentDisplayNumber(payment: XeroPayment): string | null {
  return payment.invoiceNumber ?? payment.creditNoteNumber ?? null;
}

function dedupeXeroObjectLinks(links: XeroObjectLinkInput[]): XeroObjectLinkInput[] {
  const seen = new Map<string, XeroObjectLinkInput>();

  for (const link of links) {
    seen.set(
      [
        link.localModel,
        link.localId,
        link.xeroObjectType,
        link.xeroObjectId,
        link.role,
      ].join(":"),
      link
    );
  }

  return Array.from(seen.values());
}

function getDerivedInboundPaymentRole(link: Pick<ResolvedXeroObjectLink, "xeroObjectType" | "role">) {
  if (link.xeroObjectType === "PAYMENT") {
    return link.role;
  }

  switch (link.role) {
    case "PRIMARY_INVOICE":
      return "INVOICE_PAYMENT";
    case "SUPPLEMENTARY_INVOICE":
      return "SUPPLEMENTARY_INVOICE_PAYMENT";
    case "SUBSCRIPTION_INVOICE":
      return "SUBSCRIPTION_PAYMENT";
    case "REFUND_CREDIT_NOTE":
      return "REFUND_PAYMENT";
    default:
      return null;
  }
}

function getDerivedInboundAllocationRole(creditNoteRole: string) {
  return creditNoteRole === "MODIFICATION_CREDIT_NOTE"
    ? "MODIFICATION_CREDIT_NOTE_ALLOCATION"
    : "CREDIT_NOTE_ALLOCATION";
}

async function findActiveXeroObjectLinks(
  xeroObjectType: string | string[],
  xeroObjectId: string
): Promise<ResolvedXeroObjectLink[]> {
  return prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectId,
      xeroObjectType: Array.isArray(xeroObjectType)
        ? {
            in: xeroObjectType,
          }
        : xeroObjectType,
      active: true,
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      role: true,
    },
  });
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

function getMembershipSyncCursorScope(seasonYear: number): string {
  return `${DEFAULT_XERO_SYNC_SCOPE_PREFIX}${seasonYear}`;
}

function buildSkippedMembershipReconciliation(
  seasonYear: number,
  cursorFrom: string | null,
  reason: string
): IncrementalMembershipReconciliationResult {
  return {
    seasonYear,
    cursorFrom,
    cursorTo: null,
    changedInvoices: 0,
    changedInvoiceIds: [],
    affectedMembers: 0,
    checked: 0,
    updated: 0,
    errors: 0,
    errorDetails: [],
    skipped: true,
    reason,
  };
}

function buildSkippedContactReconciliation(
  cursorFrom: string | null,
  reason: string
): IncrementalContactReconciliationResult {
  return {
    cursorFrom,
    cursorTo: null,
    total: 0,
    created: 0,
    updated: 0,
    skippedNoChanges: 0,
    skippedNoEmail: 0,
    skippedOther: 0,
    errors: 0,
    skipped: true,
    reason,
  };
}

async function runIncrementalContactReconciliation(options?: {
  minimumIntervalMs?: number;
}): Promise<IncrementalContactReconciliationResult> {
  const minimumIntervalMs =
    options?.minimumIntervalMs ?? DEFAULT_CONTACT_RECONCILE_MIN_INTERVAL_MS;
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
    },
  });

  if (
    minimumIntervalMs > 0 &&
    cursor?.lastSuccessfulSyncAt &&
    Date.now() - cursor.lastSuccessfulSyncAt.getTime() < minimumIntervalMs
  ) {
    return buildSkippedContactReconciliation(
      cursor.cursorDateTime?.toISOString() ?? null,
      "Contact cursor was refreshed recently; skipping duplicate incremental reconcile."
    );
  }

  const report = await syncContactsFromXero();
  const updatedCursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: {
      cursorDateTime: true,
    },
  });

  return {
    cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
    cursorTo: updatedCursor?.cursorDateTime?.toISOString() ?? null,
    total: report.total,
    created: report.created.length,
    updated: report.updated.length,
    skippedNoChanges: report.skippedNoChanges,
    skippedNoEmail: report.skippedNoEmail.length,
    skippedOther: report.skippedOther.length,
    errors: report.errors.length,
  };
}

async function runIncrementalMembershipReconciliation(options?: {
  seasonYear?: number;
  minimumIntervalMs?: number;
}): Promise<IncrementalMembershipReconciliationResult> {
  const seasonYear = options?.seasonYear ?? getSeasonYear(new Date());
  const minimumIntervalMs =
    options?.minimumIntervalMs ?? DEFAULT_MEMBERSHIP_RECONCILE_MIN_INTERVAL_MS;
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: MEMBERSHIP_SYNC_CURSOR_RESOURCE,
        scope: getMembershipSyncCursorScope(seasonYear),
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
    },
  });

  if (
    minimumIntervalMs > 0 &&
    cursor?.lastSuccessfulSyncAt &&
    Date.now() - cursor.lastSuccessfulSyncAt.getTime() < minimumIntervalMs
  ) {
    return buildSkippedMembershipReconciliation(
      seasonYear,
      cursor.cursorDateTime?.toISOString() ?? null,
      "Membership cursor was refreshed recently; skipping duplicate incremental reconcile."
    );
  }

  return refreshAllMembershipStatuses(seasonYear);
}

function buildSkippedInvoiceReconciliation(
  reason: string
): IncrementalInvoiceReconciliationResult {
  return {
    processed: 0,
    succeeded: 0,
    failed: 0,
    errorDetails: [],
    skipped: true,
    reason,
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

async function syncLinkedPaymentInvoiceMetadata(
  invoiceId: string,
  invoiceNumber: string | null,
  linkedPaymentIds: string[]
) {
  const paymentWhere = [
    {
      xeroInvoiceId: invoiceId,
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
      updates.xeroInvoiceId = invoiceId;
    }

    if (invoiceNumber && payment.xeroInvoiceNumber !== invoiceNumber) {
      updates.xeroInvoiceNumber = invoiceNumber;
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

  return {
    matchedPayments: payments.length,
    updatedPayments,
  };
}

async function refreshLinkedSubscriptionsForInvoice(
  invoiceId: string,
  linkedSubscriptionIds: string[]
) {
  const subscriptionWhere = [
    {
      xeroInvoiceId: invoiceId,
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

  return {
    subscriptions,
    refreshedSubscriptions,
  };
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
    cacheUpdated: cachedContact !== null,
    contactGroupsSeen: groupMemberships.contactGroupsSeen,
    groupMembershipsAdded: groupMemberships.membershipsAdded,
    groupMembershipsRemoved: groupMemberships.membershipsRemoved,
  };
}

function buildSeasonYearFromInvoice(invoice: Invoice): number {
  const invoiceDate = invoice.date ? new Date(invoice.date) : new Date();
  return Number.isNaN(invoiceDate.getTime()) ? getSeasonYear(new Date()) : getSeasonYear(invoiceDate);
}

async function reconcileXeroInvoice(
  invoiceId: string,
  options?: { skipSubscriptionRefresh?: boolean }
) {
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
  const { matchedPayments, updatedPayments } =
    await syncLinkedPaymentInvoiceMetadata(
      invoice.invoiceID,
      invoice.invoiceNumber ?? null,
      linkedPaymentIds
    );

  const linkedSubscriptionIds = relatedLinks
    .filter(
      (link) =>
        link.localModel === "MemberSubscription" &&
        link.role === "SUBSCRIPTION_INVOICE"
    )
    .map((link) => link.localId);
  const { refreshedSubscriptions } = options?.skipSubscriptionRefresh
    ? { refreshedSubscriptions: new Set<string>() }
    : await refreshLinkedSubscriptionsForInvoice(
        invoice.invoiceID,
        linkedSubscriptionIds
      );

  const seasonYear = buildSeasonYearFromInvoice(invoice);
  const subscriptionIncomeCode = (await getAccountMapping("subscriptionIncome")) ?? "203";
  const looksLikeSubscriptionInvoice =
    findSubscriptionInvoice([invoice], seasonYear, subscriptionIncomeCode) !== null;

  if (
    !options?.skipSubscriptionRefresh &&
    looksLikeSubscriptionInvoice &&
    refreshedSubscriptions.size === 0
  ) {
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
    matchedPayments,
    updatedPayments,
    refreshedSubscriptions: refreshedSubscriptions.size,
    relatedLinksUpdated: relatedLinks.length,
    looksLikeSubscriptionInvoice,
  };
}

async function runIncrementalInvoiceReconciliation(options: {
  membershipReconciliation: IncrementalMembershipReconciliationResult | null;
}): Promise<IncrementalInvoiceReconciliationResult> {
  const changedInvoiceIds =
    options.membershipReconciliation?.changedInvoiceIds ?? [];
  if (changedInvoiceIds.length === 0) {
    return buildSkippedInvoiceReconciliation(
      "No changed membership invoices required invoice-linked reconciliation."
    );
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const errorDetails: Array<{ invoiceId: string; error: string }> = [];

  for (const invoiceId of changedInvoiceIds) {
    processed += 1;

    try {
      await reconcileXeroInvoice(invoiceId, { skipSubscriptionRefresh: true });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      errorDetails.push({
        invoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processed,
    succeeded,
    failed,
    errorDetails,
  };
}

async function reconcileXeroPayment(paymentId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getPayment(tenantId, paymentId),
    {
      operation: "getPayment",
      resourceType: "PAYMENT",
      workflow: "reconcileXeroPayment",
      context: `reconcileXeroPayment(${paymentId})`,
    }
  );
  const payment = response.body.payments?.[0];

  if (!payment?.paymentID) {
    throw new Error(`Xero payment ${paymentId} was not found`);
  }

  const invoiceId = payment.invoice?.invoiceID ?? null;
  const creditNoteId = payment.creditNote?.creditNoteID ?? null;
  const [existingPaymentLinks, invoiceLinks, creditNoteLinks] = await Promise.all([
    findActiveXeroObjectLinks("PAYMENT", payment.paymentID),
    invoiceId
      ? findActiveXeroObjectLinks(["INVOICE", "SUBSCRIPTION"], invoiceId)
      : Promise.resolve([]),
    creditNoteId
      ? findActiveXeroObjectLinks("CREDIT_NOTE", creditNoteId)
      : Promise.resolve([]),
  ]);

  const paymentLinks = dedupeXeroObjectLinks(
    [...existingPaymentLinks, ...invoiceLinks, ...creditNoteLinks]
      .flatMap((link) => {
        const role = getDerivedInboundPaymentRole(link);
        if (!role) {
          return [];
        }

        return [
          {
            localModel: link.localModel,
            localId: link.localId,
            xeroObjectType: "PAYMENT",
            xeroObjectId: payment.paymentID!,
            xeroObjectNumber: buildXeroPaymentDisplayNumber(payment),
            role,
            metadata: {
              invoiceId,
              creditNoteId,
              amount: payment.amount ?? null,
              date: payment.date ?? null,
              paymentType: payment.paymentType ?? null,
              status: payment.status ?? null,
            },
          },
        ] satisfies XeroObjectLinkInput[];
      })
  );

  for (const link of paymentLinks) {
    await upsertXeroObjectLink(link);
  }

  const linkedPaymentIds = invoiceLinks
    .filter((link) => link.localModel === "Payment" && link.role === "PRIMARY_INVOICE")
    .map((link) => link.localId);
  const linkedSubscriptionIds = invoiceLinks
    .filter(
      (link) =>
        link.localModel === "MemberSubscription" &&
        link.role === "SUBSCRIPTION_INVOICE"
    )
    .map((link) => link.localId);

  const { matchedPayments, updatedPayments } = invoiceId
    ? await syncLinkedPaymentInvoiceMetadata(
        invoiceId,
        payment.invoice?.invoiceNumber ?? payment.invoiceNumber ?? null,
        linkedPaymentIds
      )
    : { matchedPayments: 0, updatedPayments: 0 };
  const { refreshedSubscriptions } = invoiceId
    ? await refreshLinkedSubscriptionsForInvoice(invoiceId, linkedSubscriptionIds)
    : { refreshedSubscriptions: new Set<string>() };

  return {
    handled: true,
    kind: "PAYMENT",
    resourceId: payment.paymentID,
    paymentNumber: buildXeroPaymentDisplayNumber(payment),
    invoiceId,
    creditNoteId,
    matchedPayments,
    updatedPayments,
    refreshedSubscriptions: refreshedSubscriptions.size,
    relatedLinksUpdated: paymentLinks.length,
  };
}

async function reconcileXeroCreditNote(creditNoteId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "reconcileXeroCreditNote",
      context: `reconcileXeroCreditNote(${creditNoteId})`,
    }
  );
  const creditNote = response.body.creditNotes?.[0];

  if (!creditNote?.creditNoteID) {
    throw new Error(`Xero credit note ${creditNoteId} was not found`);
  }

  const [relatedLinks, canonicalPaymentLinks] = await Promise.all([
    findActiveXeroObjectLinks("CREDIT_NOTE", creditNote.creditNoteID),
    prisma.payment.findMany({
      where: {
        xeroRefundCreditNoteId: creditNote.creditNoteID,
      },
      select: {
        id: true,
      },
    }),
  ]);

  const existingRefundPaymentIds = new Set(
    relatedLinks
      .filter((link) => link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE")
      .map((link) => link.localId)
  );

  const creditNoteLinks = dedupeXeroObjectLinks([
    ...relatedLinks.map(
      (link) =>
        ({
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: creditNote.creditNoteID!,
          xeroObjectNumber: creditNote.creditNoteNumber ?? null,
          role: link.role,
          metadata: {
            status: creditNote.status ?? null,
            total: creditNote.total ?? null,
            appliedAmount: creditNote.appliedAmount ?? null,
            remainingCredit: creditNote.remainingCredit ?? null,
          },
        }) satisfies XeroObjectLinkInput
    ),
    ...canonicalPaymentLinks
      .filter((payment) => !existingRefundPaymentIds.has(payment.id))
      .map(
        (payment) =>
          ({
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: creditNote.creditNoteID!,
            xeroObjectNumber: creditNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
            metadata: {
              status: creditNote.status ?? null,
              total: creditNote.total ?? null,
              appliedAmount: creditNote.appliedAmount ?? null,
              remainingCredit: creditNote.remainingCredit ?? null,
            },
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  for (const link of creditNoteLinks) {
    await upsertXeroObjectLink(link);
  }

  const linkedRefundPaymentIds = creditNoteLinks
    .filter((link) => link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE")
    .map((link) => link.localId);
  const linkedAccountCreditPaymentIds = creditNoteLinks
    .filter((link) => link.localModel === "Payment" && link.role === "ACCOUNT_CREDIT_NOTE")
    .map((link) => link.localId);
  const paymentCandidates = await prisma.payment.findMany({
    where: {
      OR: [
        {
          xeroRefundCreditNoteId: creditNote.creditNoteID,
        },
        ...(linkedRefundPaymentIds.length > 0
          ? [
              {
                id: {
                  in: linkedRefundPaymentIds,
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      xeroRefundCreditNoteId: true,
    },
  });
  const accountCreditPayments =
    linkedAccountCreditPaymentIds.length > 0
      ? await prisma.payment.findMany({
          where: {
            id: {
              in: linkedAccountCreditPaymentIds,
            },
          },
          select: {
            id: true,
            bookingId: true,
            booking: {
              select: {
                memberId: true,
              },
            },
          },
        })
      : [];

  const canApplyCanonicalRefundLink = paymentCandidates.length === 1;
  let updatedPayments = 0;
  for (const payment of paymentCandidates) {
    if (!payment.xeroRefundCreditNoteId && canApplyCanonicalRefundLink) {
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          xeroRefundCreditNoteId: creditNote.creditNoteID,
        },
      });
      updatedPayments += 1;
    }
  }

  const creditNoteAmountCents = getCreditNoteAmountCents(creditNote);
  let updatedCredits = 0;
  for (const payment of accountCreditPayments) {
    if (creditNoteAmountCents === null) {
      continue;
    }

    const bookingLabel = payment.bookingId.slice(0, 8);
    const backfilledCredits = await prisma.memberCredit.updateMany({
      where: {
        memberId: payment.booking.memberId,
        sourceBookingId: payment.bookingId,
        amountCents: creditNoteAmountCents,
        type: CreditType.CANCELLATION_REFUND,
        description: `Cancellation refund for booking ${bookingLabel}`,
        xeroCreditNoteId: null,
      },
      data: {
        xeroCreditNoteId: creditNote.creditNoteID,
      },
    });
    updatedCredits += backfilledCredits.count;
  }

  const resolvedCreditNoteLinks = dedupeXeroObjectLinks([
    ...creditNoteLinks,
    ...paymentCandidates
      .filter(
        (payment) =>
          !creditNoteLinks.some(
            (link) =>
              link.localModel === "Payment" &&
              link.localId === payment.id &&
              link.role === "REFUND_CREDIT_NOTE"
          )
      )
      .map(
        (payment) =>
          ({
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: creditNote.creditNoteID!,
            xeroObjectNumber: creditNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
            metadata: {
              status: creditNote.status ?? null,
              total: creditNote.total ?? null,
              appliedAmount: creditNote.appliedAmount ?? null,
              remainingCredit: creditNote.remainingCredit ?? null,
            },
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  for (const link of resolvedCreditNoteLinks) {
    await upsertXeroObjectLink(link);
  }

  const allocationLinks = dedupeXeroObjectLinks(
    (creditNote.allocations ?? []).flatMap((allocation) => {
      const invoiceId = allocation.invoice?.invoiceID ?? null;
      const amount = allocation.amount;

      if (!invoiceId || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return [];
      }

      const amountCents = Math.round(amount * 100);

      return resolvedCreditNoteLinks.map(
        (link) =>
          ({
            localModel: link.localModel,
            localId: link.localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationLinkId(
              creditNote.creditNoteID!,
              invoiceId,
              amountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
            role: getDerivedInboundAllocationRole(link.role),
            metadata: {
              creditNoteId: creditNote.creditNoteID,
              invoiceId,
              amountCents,
            },
          }) satisfies XeroObjectLinkInput
      );
    })
  );

  for (const link of allocationLinks) {
    await upsertXeroObjectLink(link);
  }

  const refundPaymentLinks = dedupeXeroObjectLinks(
    (creditNote.payments ?? []).flatMap((payment) => {
      if (!payment.paymentID) {
        return [];
      }

      return resolvedCreditNoteLinks
        .filter((link) => link.role === "REFUND_CREDIT_NOTE")
        .map(
          (link) =>
            ({
              localModel: link.localModel,
              localId: link.localId,
              xeroObjectType: "PAYMENT",
              xeroObjectId: payment.paymentID!,
              xeroObjectNumber: buildXeroPaymentDisplayNumber(payment),
              role: "REFUND_PAYMENT",
              metadata: {
                creditNoteId: creditNote.creditNoteID,
                amount: payment.amount ?? null,
                date: payment.date ?? null,
                paymentType: payment.paymentType ?? null,
                status: payment.status ?? null,
              },
            }) satisfies XeroObjectLinkInput
        );
    })
  );

  for (const link of refundPaymentLinks) {
    await upsertXeroObjectLink(link);
  }

  return {
    handled: true,
    kind: "CREDIT_NOTE",
    resourceId: creditNote.creditNoteID,
    creditNoteNumber: creditNote.creditNoteNumber ?? null,
    matchedPayments: paymentCandidates.length,
    matchedAccountCreditPayments: accountCreditPayments.length,
    updatedPayments,
    updatedCredits,
    relatedLinksUpdated: resolvedCreditNoteLinks.length,
    allocationsUpdated: allocationLinks.length,
    refundPaymentsUpdated: refundPaymentLinks.length,
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
    case "PAYMENT":
      return reconcileXeroPayment(event.resourceId);
    case "CREDIT_NOTE":
      return reconcileXeroCreditNote(event.resourceId);
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

export async function runXeroInboundReconciliationCycle(options?: {
  batchSize?: number;
  maxBatches?: number;
  seasonYear?: number;
  contactMinimumIntervalMs?: number;
  membershipMinimumIntervalMs?: number;
  includeContactReconciliation?: boolean;
  includeMembershipReconciliation?: boolean;
  includeInvoiceReconciliation?: boolean;
}): Promise<RunXeroInboundReconciliationCycleResult> {
  const batchSize = Math.min(
    Math.max(options?.batchSize ?? DEFAULT_XERO_INBOUND_BATCH_SIZE, 1),
    50
  );
  const maxBatches = Math.max(options?.maxBatches ?? DEFAULT_XERO_INBOUND_MAX_BATCHES, 1);
  const totals: RunXeroInboundReconciliationCycleResult["inbound"] = {
    batches: 0,
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await processStoredXeroInboundEvents({ limit: batchSize });
    totals.batches += 1;
    totals.found += result.found;
    totals.processed += result.processed;
    totals.succeeded += result.succeeded;
    totals.failed += result.failed;
    totals.skipped += result.skipped;

    if (result.found < batchSize || result.processed === 0) {
      break;
    }
  }

  const contactReconciliation =
    options?.includeContactReconciliation === false
      ? null
      : await runIncrementalContactReconciliation({
          minimumIntervalMs: options?.contactMinimumIntervalMs,
        });
  const membershipReconciliation =
    options?.includeMembershipReconciliation === false
      ? null
      : await runIncrementalMembershipReconciliation({
          seasonYear: options?.seasonYear,
          minimumIntervalMs: options?.membershipMinimumIntervalMs,
        });
  const invoiceReconciliation =
    options?.includeInvoiceReconciliation === false
      ? null
      : await runIncrementalInvoiceReconciliation({
          membershipReconciliation,
        });

  return {
    inbound: totals,
    contactReconciliation,
    membershipReconciliation,
    invoiceReconciliation,
  };
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
