/**
 * THE XERO INVOICE THAT PUTS A FAILED CARD REFUND'S MONEY BACK IN THE STRIPE
 * ACCOUNT (#4369, `INV-PAY-151`, owner 10 Nov 2026).
 *
 * A card refund Stripe accepted, then failed, kept the credit note raised
 * while it counted. That note says the money left the Stripe account. When
 * the treasurer pays the member by bank and closes the debt as Paid another
 * way, and that note covers some of the close, two documents are queued in
 * the close's transaction: this invoice, for the covered cents, and a
 * bank-transfer refund credit note for the whole close.
 *
 * The invoice is an ACCREC charge coded like the credit note it undoes
 * (`hutFeeRefunds`, GST inclusive), paid in full into `stripeBankAccount`,
 * never emailed and never allocated, and never written onto
 * `Payment.xeroInvoiceId`. It is dated the club day of the close. A Xero
 * lock date on or after that day moves the invoice and its payment to the
 * next open day; the reference keeps the close day.
 *
 * A voided or deleted one is not raised again. The worker does not create
 * another when the link is inactive, and the enqueue will not insert a
 * second row for the same close.
 *
 * No provider call runs in the close's transaction. This worker runs after
 * the outbox claim, the same claim every other queue type uses.
 */
import { Invoice, LineAmountTypes, type LineItem } from "xero-node";
import type { Prisma } from "@prisma/client";
import { addCalendarDays, requireCalendarDate } from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";
import { bookingOwner } from "@/lib/booking-owner";
import { hutFeeRefundLine } from "@/lib/xero-hut-fee-line-codes";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import {
  findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair,
} from "@/lib/organisation-xero-contacts";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import { getXeroErrorBodyMessage } from "@/lib/xero-error-shape";
import { getEffectiveXeroLockDate, getXeroLockDates } from "@/lib/xero-organisation";
import { asRecord } from "@/lib/xero-json";
import {
  CARD_REFUND_REVERSAL_INVOICE_ROLE,
  CARD_REFUND_REVERSAL_PAYMENT_ROLE,
  XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE,
} from "@/lib/xero-card-refund-reversal-outbox";
import { readQueuedOutboxPayload } from "@/lib/xero-operation-outbox-payload";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

export {
  CARD_REFUND_REVERSAL_INVOICE_ROLE,
  CARD_REFUND_REVERSAL_PAYMENT_ROLE,
  XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE,
};

/** The club day of the close, or the first open day after a lock on or after it. */
export function cardRefundReversalDocumentDate(
  closedOn: string,
  lockDay: string | null,
): { date: string; redated: boolean } {
  if (lockDay && closedOn <= lockDay) {
    return { date: addCalendarDays(requireCalendarDate(lockDay), 1), redated: true };
  }
  return { date: closedOn, redated: false };
}

export function cardRefundReversalDescription(bookingId: string): string {
  return `Failed card refund's money returned to the Stripe account — booking ${bookingId.slice(0, 8)}`;
}

/** The close day stays here even when the invoice is dated the next open day. */
export function cardRefundReversalReference(bookingId: string, closedOn: string): string {
  return `Failed card refund back in Stripe, booking ${bookingId.slice(0, 8)}, closed ${closedOn}`;
}

export function cardRefundReversalInvoiceKey(paymentId: string, closeTaskId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "card-refund-reversal", closeTaskId);
}

function cardRefundReversalPaymentKey(paymentId: string, closeTaskId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "card-refund-reversal-payment", closeTaskId);
}

/** Xero refused the date because the period is locked. The message is the refusal; the status alone is not. */
export function isXeroLockDateRefusal(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : ""} ${getXeroErrorBodyMessage(error) ?? ""}`.toLowerCase();
  return /lock date|period lock|locked period|period is locked|end of year lock/.test(text);
}

/**
 * Queue the reversal for one close, once. A row already keyed on the close —
 * sent, failed, or voided — is the row; a voided invoice is not raised again.
 */
export async function enqueueCardRefundReversalInvoiceOperation(params: {
  paymentId: string;
  bookingId: string;
  closeTaskId: string;
  amountCents: number;
  /** The club day of the close (`YYYY-MM-DD`). */
  closedOn: string;
  createdByMemberId?: string | null;
  store: Prisma.TransactionClient;
}): Promise<{ queueOperationId: string | null; message: string }> {
  const db = params.store;
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    return { queueOperationId: null, message: "Nothing was covered, so no Stripe reversal invoice is needed." };
  }
  const key = cardRefundReversalInvoiceKey(params.paymentId, params.closeTaskId);
  const existing = await db.xeroSyncOperation.findFirst({
    where: { idempotencyKey: key, localModel: "Payment", localId: params.paymentId },
    select: { id: true },
  });
  if (existing) {
    return { queueOperationId: existing.id, message: "The Stripe reversal invoice for this close is already queued or sent." };
  }
  const voided = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: params.paymentId,
      xeroObjectType: "INVOICE",
      role: CARD_REFUND_REVERSAL_INVOICE_ROLE,
      active: false,
      metadata: { path: ["closeTaskId"], equals: params.closeTaskId },
    },
    select: { id: true },
  });
  if (voided) {
    return {
      queueOperationId: null,
      message: "This close's Stripe reversal invoice was voided in Xero, so it is not raised again.",
    };
  }
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: params.paymentId,
    status: "PENDING",
    idempotencyKey: key,
    correlationKey: key,
    requestPayload: {
      queueType: XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE,
      bookingId: params.bookingId,
      paymentId: params.paymentId,
      closeTaskId: params.closeTaskId,
      amountCents: params.amountCents,
      closedOn: params.closedOn,
    },
    createdByMemberId: params.createdByMemberId ?? null,
    store: db,
  });
  return { queueOperationId: operation.id, message: "Stripe reversal invoice queued for background processing." };
}

type ReversalProviders = {
  getAuthenticatedXeroClient: typeof getAuthenticatedXeroClient;
  callXeroApi: typeof callXeroApi;
  findOrCreateXeroContactForInvoicedParty: typeof findOrCreateXeroContactForInvoicedParty;
  createXeroPaymentForInvoice: typeof createXeroPaymentForInvoice;
  getResolvedAccountMapping: typeof getResolvedAccountMapping;
  getXeroLockDates: typeof getXeroLockDates;
  retryXeroWriteWithContactRepair: typeof retryXeroWriteWithContactRepair;
};

const PROVIDERS: ReversalProviders = {
  getAuthenticatedXeroClient,
  callXeroApi,
  findOrCreateXeroContactForInvoicedParty,
  createXeroPaymentForInvoice,
  getResolvedAccountMapping,
  getXeroLockDates,
  retryXeroWriteWithContactRepair,
};

async function reversalLink(paymentId: string, closeTaskId: string, role: string) {
  const { prisma } = await import("@/lib/prisma");
  return prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      role,
      metadata: { path: ["closeTaskId"], equals: closeTaskId },
    },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: { xeroObjectId: true, xeroObjectNumber: true, active: true, metadata: true },
  });
}

async function chooseDocumentDate(
  closedOn: string,
  providers: ReversalProviders,
): Promise<{ date: string; redated: boolean; lockKnown: boolean }> {
  try {
    const lock = getEffectiveXeroLockDate(await providers.getXeroLockDates());
    const chosen = cardRefundReversalDocumentDate(closedOn, lock ? formatDateOnly(lock) : null);
    return { ...chosen, lockKnown: true };
  } catch (error) {
    logger.warn({ err: error, closedOn }, "Could not read the Xero lock date for a failed-card-refund reversal; the close day will be tried");
    return { date: closedOn, redated: false, lockKnown: false };
  }
}

/**
 * Send one reversal. The outbox has already claimed the row. Xero is called
 * here, outside any transaction. An invoice link, active or not, is not
 * created again; a voided one is left voided.
 */
export async function createXeroCardRefundReversalInvoice(
  params: { syncOperation: XeroOperationClaim; createdByMemberId?: string },
  providers: ReversalProviders = PROVIDERS,
): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const { syncOperation } = params;
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: syncOperation.id },
    select: { requestPayload: true },
  });
  const queued = readQueuedOutboxPayload(row?.requestPayload);
  if (!queued || queued.queueType !== XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE) {
    throw new Error(`Card-refund reversal operation ${syncOperation.id} has no readable queued payload`);
  }
  const { bookingId, paymentId, closeTaskId, amountCents, closedOn } = queued;
  const reference = cardRefundReversalReference(bookingId, closedOn);

  try {
    const invoiceLink = await reversalLink(paymentId, closeTaskId, CARD_REFUND_REVERSAL_INVOICE_ROLE);
    if (invoiceLink && !invoiceLink.active) {
      await completeXeroSyncOperation(syncOperation, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: "The Stripe reversal invoice was voided or deleted in Xero, so it is not raised again.",
          closeTaskId,
        },
      });
      return null;
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, organisation: { select: { name: true, email: true } } },
    });
    if (!booking) throw new Error(`Booking not found: ${bookingId}`);

    let invoiceId = invoiceLink?.xeroObjectId ?? null;
    let invoiceNumber = invoiceLink?.xeroObjectNumber ?? null;
    let invoiceBody: unknown = null;
    const storedDate = asRecord(invoiceLink?.metadata)?.documentDate;
    let dated =
      typeof storedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(storedDate)
        ? { date: storedDate, redated: storedDate !== closedOn, lockKnown: true }
        : await chooseDocumentDate(closedOn, providers);

    if (!invoiceId) {
      const { xero, tenantId } = await providers.getAuthenticatedXeroClient();
      const { callXeroApi } = providers;
      const contactId = await providers.findOrCreateXeroContactForInvoicedParty(booking, {
        createdByMemberId: params.createdByMemberId,
      });
      const refunds = await providers.getResolvedAccountMapping("hutFeeRefunds");
      const line: LineItem = hutFeeRefundLine(cardRefundReversalDescription(bookingId), amountCents, refunds);
      const buildInvoice = (resolvedContactId: string, documentDate: string): Invoice => ({
        type: Invoice.TypeEnum.ACCREC,
        contact: { contactID: resolvedContactId },
        lineItems: [line],
        date: documentDate,
        dueDate: documentDate,
        reference,
        status: Invoice.StatusEnum.AUTHORISED,
        lineAmountTypes: LineAmountTypes.Inclusive,
      });
      const send = (documentDate: string) =>
        providers.retryXeroWriteWithContactRepair({
          memberId: bookingOwner(booking).memberId,
          currentContactId: contactId,
          repairContactLink: invoicedPartyContactRepair(booking),
          workflow: "createXeroCardRefundReversalInvoice",
          operationId: syncOperation.id,
          buildRequestPayload: (resolvedContactId: string) => ({
            ...(asRecord(row?.requestPayload) ?? {}),
            invoices: [buildInvoice(resolvedContactId, documentDate)],
          }),
          run: ({ contactId: resolvedContactId }) =>
            callXeroApi(
              () =>
                xero.accountingApi.createInvoices(
                  tenantId,
                  { invoices: [buildInvoice(resolvedContactId, documentDate)] },
                  undefined,
                  undefined,
                  cardRefundReversalInvoiceKey(paymentId, closeTaskId),
                ),
              {
                operation: "createInvoices",
                resourceType: "INVOICE",
                workflow: "createXeroCardRefundReversalInvoice",
                context: `createInvoices(card refund reversal ${closeTaskId})`,
              },
            ),
        });
      let response;
      try {
        response = await send(dated.date);
      } catch (error) {
        if (dated.lockKnown || dated.redated || !isXeroLockDateRefusal(error)) throw error;
        dated = { date: addCalendarDays(requireCalendarDate(dated.date), 1), redated: true, lockKnown: false };
        response = await send(dated.date);
      }
      const created = response.body.invoices?.[0];
      if (!created?.invoiceID) throw new Error("Failed to create the failed-card-refund reversal invoice");
      invoiceId = created.invoiceID;
      invoiceNumber = created.invoiceNumber ?? null;
      invoiceBody = response.body;
      await prisma.xeroSyncOperation.update({
        where: { id: syncOperation.id },
        data: {
          requestPayload: sanitizeForJson({
            ...(asRecord(row?.requestPayload) ?? {}),
            invoices: [buildInvoice(contactId, dated.date)],
          }),
        },
      });
    }

    let paymentRecordId: string | null = null;
    let paymentError: unknown = null;
    if (!(await reversalLink(paymentId, closeTaskId, CARD_REFUND_REVERSAL_PAYMENT_ROLE))) {
      try {
        paymentRecordId = await providers.createXeroPaymentForInvoice({
          localModel: "Payment",
          localId: paymentId,
          invoiceId: invoiceId!,
          amountCents,
          idempotencyKey: cardRefundReversalPaymentKey(paymentId, closeTaskId),
          reference,
          role: CARD_REFUND_REVERSAL_PAYMENT_ROLE,
          createdByMemberId: params.createdByMemberId,
          metadata: { closeTaskId, amountCents, bookingId, invoiceId },
          date: dated.date,
        });
      } catch (error) {
        paymentError = error;
        logger.warn(
          { err: error, paymentId, closeTaskId, invoiceId },
          "Raised the failed-card-refund reversal invoice but could not record its Stripe receipt",
        );
      }
    }

    await completeXeroSyncOperation(syncOperation, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: invoiceBody,
        paymentId: paymentRecordId,
        paymentError,
        documentDate: dated.date,
        closedOn,
        redated: dated.redated,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: invoiceId,
      xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId!,
          xeroObjectNumber: invoiceNumber,
          xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
          role: CARD_REFUND_REVERSAL_INVOICE_ROLE,
          metadata: { closeTaskId, amountCents, bookingId, documentDate: dated.date },
        },
      ],
    });
    return invoiceId;
  } catch (error) {
    await failXeroSyncOperation(syncOperation, error);
    throw error;
  }
}
