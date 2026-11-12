/**
 * #4299 (`INV-PAY-142`, decision 1): RAISE THE GROUP ORGANISER'S EXTRA INVOICE
 * for one change that raised the price of a joiner's place the organiser paid
 * for by Internet Banking.
 *
 * It is the change's supplementary invoice in every way the rest of the app
 * reads one - anchored `BookingModification/<id>`, keyed by
 * `buildXeroSupplementaryInvoiceKey`, linked `SUPPLEMENTARY_INVOICE`, so the
 * enqueue's per-anchor lock and link check make it the change's one and only
 * invoice, and the inbound sync links the organiser's payment to it
 * (`SUPPLEMENTARY_INVOICE_PAYMENT`) - with three differences, all read from
 * the change's `OrganiserExtraInvoice` row, never from the payload alone:
 *
 *  - it is addressed to the ORGANISER's Xero contact
 *    (`findOrCreateOrganiserXeroContact`, the combined invoice's own), never the
 *    joiner's - the joiner has no invoice to supplement;
 *  - its reference names the group, the joiner's place and the combined
 *    invoice, so the treasurer can tie the organiser's transfer to it;
 *  - it posts NO payment. The organiser pays it by bank transfer and the
 *    treasurer reconciles it in Xero; the app records nothing until the inbound
 *    sync reports it paid (`INV-PAY-139`: no capture recorder reads these places).
 *
 * `createXeroSupplementaryInvoice` routes every change that has such a row
 * here, on the outbox path and on an officer's Retry alike, so no route can
 * raise a joiner-addressed invoice for an organiser-billed change.
 *
 * A change whose extra was wholly taken off by a later cut or cancel before its
 * invoice was sent (`reducedCents` covers it and nothing was paid) raises
 * nothing; its queued adjustments then complete with nothing to do.
 */
import { Invoice, LineAmountTypes, type LineItem } from "xero-node";

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { bookingOwner } from "@/lib/booking-owner";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { asRecord } from "@/lib/xero-json";
import { buildXeroSupplementaryInvoiceKey } from "@/lib/xero-supplementary-invoice-key";
import { completeXeroSyncOperation, failXeroSyncOperation, sanitizeForJson, startXeroSyncOperation } from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import { findOrCreateOrganiserXeroContact } from "@/lib/group-organiser-billing-target";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday, xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";
import {
  changeFeeLineItem,
  MODIFICATION_DOCUMENT_LINES_SELECT,
  resolveModificationDocumentLineItems,
} from "@/lib/xero-modification-line-items";
import { ORGANISER_BILL_TO, organiserExtraUnpaidCents } from "@/lib/organiser-extra-invoice";
import { notifyOrganiserOfExtraInvoice } from "@/lib/organiser-extra-notify";
import type { ClubFormat } from "@/lib/club-format";

/** The row a change's organiser-billed supplementary invoice is raised from. */
export async function findOrganiserExtraForChange(bookingModificationId: string) {
  return prisma.organiserExtraInvoice.findUnique({ where: { bookingModificationId } });
}

/** The invoice's reference: the group, the joiner's place and the group's combined invoice (decision 1). */
export function organiserExtraInvoiceReference(input: {
  groupBookingId: string;
  joinerName: string;
  bookingId: string;
  combinedInvoiceNumber: string | null;
  combinedInvoiceId: string;
}): string {
  const combined = input.combinedInvoiceNumber ?? input.combinedInvoiceId.slice(0, 8);
  return `Group ${input.groupBookingId.slice(0, 8)} extra for ${input.joinerName}'s place, booking ${input.bookingId.slice(0, 8)} (group invoice ${combined})`;
}

export async function createXeroOrganiserExtraInvoice(params: {
  extra: NonNullable<Awaited<ReturnType<typeof findOrganiserExtraForChange>>>;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperationId?: string;
  format: ClubFormat;
}): Promise<string | null> {
  const { extra, createdByMemberId, repairExistingLink, syncOperationId } = params;
  const localId = extra.bookingModificationId;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: { localModel: "BookingModification", localId, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true },
    select: { xeroObjectId: true, xeroObjectNumber: true },
  });
  if (existingLink) {
    // Already raised (an earlier attempt linked it): one invoice per change.
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: { skipped: true, reason: "The organiser's extra invoice for this change is already in Xero." },
        xeroObjectType: "INVOICE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber,
      });
    }
    return existingLink.xeroObjectId;
  }

  if (extra.paidCents === 0 && organiserExtraUnpaidCents(extra) === 0) {
    // Decision N2: a later cut or cancel took the whole extra off before it was sent.
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reducedBeforeSend: true,
          reason: "A later change or cancellation took the whole extra off before the organiser's invoice was sent, so none was raised.",
        },
      });
    }
    return null;
  }

  const [booking, settlement, modification] = await Promise.all([
    prisma.booking.findUnique({
      where: { id: extra.bookingId },
      select: { id: true, memberId: true, member: { select: { firstName: true, lastName: true, email: true } }, organisation: { select: { name: true, email: true } } },
    }),
    prisma.groupBookingSettlement.findUnique({
      where: { id: extra.groupSettlementId },
      select: { groupBooking: { select: { id: true, organiserMemberId: true } } },
    }),
    prisma.bookingModification.findUnique({
      where: { id: localId },
      select: { createdAt: true, ...MODIFICATION_DOCUMENT_LINES_SELECT },
    }),
  ]);
  if (!booking || !settlement) {
    const error = new Error(`INV-PAY-142 (#4299): the organiser's extra invoice ${extra.id} names a booking or group settlement that no longer exists.`);
    if (syncOperationId) await failXeroSyncOperation(syncOperationId, error);
    throw error;
  }
  const organiserMemberId = settlement.groupBooking.organiserMemberId;
  const owner = bookingOwner(booking);
  const joinerName = `${owner.member.firstName} ${owner.member.lastName}`.trim();

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateOrganiserXeroContact(organiserMemberId, { createdByMemberId, repairExistingLink, xero, tenantId });

  const itemised = await resolveModificationDocumentLineItems({
    bookingId: extra.bookingId,
    row: modification,
    bookingModificationId: localId,
    document: "SUPPLEMENTARY_INVOICE",
    billedCents: extra.billedCents,
    billedFigures: { priceDiffCents: extra.priceDiffCents, changeFeeCents: extra.changeFeeCents },
  }, params.format);
  const lineItems: LineItem[] = itemised.lineItems ?? [];
  if (!itemised.lineItems) {
    const income = await getResolvedAccountMapping("hutFeesIncome");
    if (extra.priceDiffCents !== 0) {
      const mapping = extra.priceDiffCents < 0 ? await getResolvedAccountMapping("hutFeeRefunds") : income;
      const code = mapping.code ?? "200";
      const line: LineItem = {
        description: `Price change for ${joinerName}'s place (booking ${extra.bookingId.slice(0, 8)})`,
        quantity: 1,
        unitAmount: extra.priceDiffCents / 100,
        taxType: "OUTPUT2",
      };
      if (mapping.itemCode) line.itemCode = mapping.itemCode;
      if (!mapping.itemCode || code !== "200" || mapping.codeExplicitlyConfigured) line.accountCode = code;
      lineItems.push(line);
    }
    if (extra.changeFeeCents > 0) lineItems.push(changeFeeLineItem(extra.changeFeeCents, income));
  }

  const timeZone = await readClubTimeZoneOutsideRequest();
  const issueDate = xeroDocumentDateForClubToday(timeZone);
  const dueDate = xeroDocumentDateFromInstant(modification?.createdAt ?? extra.createdAt, timeZone);
  const reference = organiserExtraInvoiceReference({
    groupBookingId: settlement.groupBooking.id,
    joinerName,
    bookingId: extra.bookingId,
    combinedInvoiceNumber: extra.combinedInvoiceNumber,
    combinedInvoiceId: extra.combinedInvoiceId,
  });
  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: issueDate,
    dueDate,
    reference,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });
  const invoiceIdempotencyKey = buildXeroSupplementaryInvoiceKey({
    localModel: "BookingModification",
    localId,
    priceDiffCents: extra.priceDiffCents,
    changeFeeCents: extra.changeFeeCents,
  });

  // The queued payload is kept beside the invoice body, as every supplementary
  // invoice keeps its own (#3641), so a retry still reads `billTo`.
  const queued = syncOperationId
    ? asRecord((await prisma.xeroSyncOperation.findUnique({ where: { id: syncOperationId }, select: { requestPayload: true } }))?.requestPayload)
    : null;
  const buildStoredPayload = (resolvedContactId: string) => ({
    ...(queued ?? {}),
    billTo: ORGANISER_BILL_TO,
    organiserExtraInvoiceId: extra.id,
    invoices: [buildInvoice(resolvedContactId)],
    priceLines: itemised.record,
  });
  let operationId = syncOperationId ?? null;
  if (operationId) {
    await prisma.xeroSyncOperation.update({ where: { id: operationId }, data: { requestPayload: sanitizeForJson(buildStoredPayload(contactId)) } });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload: buildStoredPayload(contactId),
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  let created: { invoiceID?: string; invoiceNumber?: string } | undefined;
  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: organiserMemberId,
      currentContactId: contactId,
      workflow: "createXeroOrganiserExtraInvoice",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => buildStoredPayload(resolvedContactId),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () => xero.accountingApi.createInvoices(tenantId, { invoices: [buildInvoice(resolvedContactId)] }, undefined, undefined, invoiceIdempotencyKey),
          { operation: "createInvoices", resourceType: "INVOICE", workflow: "createXeroOrganiserExtraInvoice", context: `createInvoices(organiser extra ${localId})` },
        ),
    });
    created = response.body.invoices?.[0];
    if (!created?.invoiceID) throw new Error("Failed to create the group organiser's extra Xero invoice");
    await completeXeroSyncOperation(operationId!, {
      status: "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: null,
        paymentSkipped: true,
        paymentSkipReason: "The group organiser pays this invoice by bank transfer; the treasurer reconciles it in Xero.",
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel: "BookingModification",
          localId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "SUPPLEMENTARY_INVOICE",
          metadata: { billTo: ORGANISER_BILL_TO, organiserExtraInvoiceId: extra.id, combinedInvoiceId: extra.combinedInvoiceId },
        },
      ],
    });
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }

  const invoiceId = created.invoiceID!;
  await prisma.organiserExtraInvoice.updateMany({
    where: { id: extra.id, xeroInvoiceId: null },
    data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: created.invoiceNumber ?? null },
  });
  // Decision 2: the organiser's email, once the invoice exists so it carries
  // the number. After the row completes, never failing it: the invoice is in Xero.
  await notifyOrganiserOfExtraInvoice(extra.id, params.format).catch((error: unknown) =>
    logger.error({ err: error, organiserExtraInvoiceId: extra.id, invoiceId }, "Raised the group organiser's extra invoice but could not send their email (#4299)"),
  );
  return invoiceId;
}
