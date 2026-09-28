/**
 * THE XERO RECORD OF A KEPT LATE CAPTURE (#3635, owner decision 29 Sep 2026,
 * `INV-PAY-110`): "When a treasurer keeps a late card capture on a cancelled
 * booking, the app raises a Xero invoice for the kept amount and marks it paid
 * from the Stripe account, the same way a normal card payment is recorded."
 *
 * For the booking's OWN payment (a change payment keeps its own supplementary
 * invoice, released by the late-capture release). One invoice per kept capture,
 * ANCHORED ON THE #3639 APPROVAL TASK (`ManualRefundTask`, the one row per
 * capture), billing exactly the kept cents, with a payment of those cents from
 * the Stripe bank account. It needs no primary invoice and reads nothing the
 * booking's price says, so it records the kept cash whatever happened to the
 * booking invoice: none ever raised, one cleared by the cancellation's note,
 * account credit used, a price changed since.
 *
 * WHY IT CANNOT COUNT TWICE. The booking's own invoice (if any) and the
 * cancellation's clearing note are left exactly as they are: they describe the
 * stay the cancellation settled, and between them they already net to what the
 * cancellation decided. This invoice describes only money that arrived AFTER,
 * and is paid by exactly that money, so it adds the kept cents to income and to
 * the Stripe clearing account once. `late-capture-kept-xero.test.ts` works each
 * case through.
 *
 * WHY A NEW QUEUE TYPE and not a third supplementary-invoice anchor: the
 * supplementary builder is a booking CHANGE's document (itemised change lines,
 * "original invoice" reference, refuses without a primary invoice), and its
 * `ManualRefundTask` anchor already means a second ask, which the retry screen
 * replays unpaid by definition. Folding this in would change what that anchor
 * means to every reader of it.
 */
import { Invoice, LineAmountTypes, type LineItem } from "xero-node";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { bookingOwner } from "@/lib/booking-owner";
import { asRecord } from "@/lib/xero-json";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { getAccountMapping, getResolvedAccountMapping } from "@/lib/xero-mappings";
import { retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import {
  findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair,
} from "@/lib/organisation-xero-contacts";
import { applyHutFeeLineCodes } from "@/lib/xero-hut-fee-line-codes";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import {
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  readQueuedOutboxPayload,
} from "@/lib/xero-operation-outbox-payload";

/** The link roles this document writes, named once. */
export const KEPT_LATE_CAPTURE_INVOICE_ROLE = "KEPT_LATE_CAPTURE_INVOICE";
export const KEPT_LATE_CAPTURE_PAYMENT_ROLE = "KEPT_LATE_CAPTURE_PAYMENT";

/** Stamped on a queued row an approval (after a reopen) cancelled unsent. */
export const KEPT_LATE_CAPTURE_REFUNDED_ERROR_CODE = "KEPT_LATE_CAPTURE_REFUNDED";

/** The one-line description the member and the treasurer read (`INV-CONFIG-001`: no club value). */
export function keptLateCaptureLineDescription(bookingId: string): string {
  return `Payment kept after cancellation - booking ${bookingId.slice(0, 8)}`;
}

function invoiceKey(taskId: string) {
  return buildXeroIdempotencyKey("manual-refund-task", taskId, "kept-late-capture-invoice", "v1");
}

function paymentKey(taskId: string) {
  return buildXeroIdempotencyKey("manual-refund-task", taskId, "kept-late-capture-payment", "v1");
}

const KEPT_INVOICE_CREATE = {
  direction: "OUTBOUND",
  entityType: "INVOICE",
  operationType: "CREATE",
  localModel: "ManualRefundTask",
  queueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
} as const;

/**
 * QUEUE IT, once per task. Run by the dismissal inside its status-fenced claim
 * (and by the repair tool), so it commits with the decision. A row for the task
 * in any state but CANCELLED is returned instead of a second one; the Xero
 * idempotency keys are the task's, so even a replay that reached Xero twice
 * would be answered with the first document.
 */
export async function enqueueXeroKeptLateCaptureInvoiceOperation(params: {
  manualRefundTaskId: string;
  bookingId: string;
  paymentIntentId: string;
  keptCents: number;
  createdByMemberId?: string | null;
  store?: Prisma.TransactionClient;
}): Promise<{ queueOperationId: string | null; message: string }> {
  const db = params.store ?? prisma;
  if (!Number.isInteger(params.keptCents) || params.keptCents <= 0) {
    return { queueOperationId: null, message: "Nothing was kept, so no Xero invoice is needed." };
  }
  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      ...KEPT_INVOICE_CREATE,
      localId: params.manualRefundTaskId,
      status: { not: "CANCELLED" },
    },
    select: { id: true },
  });
  if (existing) {
    return {
      queueOperationId: existing.id,
      message: "The Xero invoice for this kept payment is already queued or sent.",
    };
  }
  const key = invoiceKey(params.manualRefundTaskId);
  const operation = await startXeroSyncOperation({
    ...KEPT_INVOICE_CREATE,
    localId: params.manualRefundTaskId,
    status: "PENDING",
    idempotencyKey: key,
    correlationKey: key,
    requestPayload: {
      queueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
      bookingId: params.bookingId,
      manualRefundTaskId: params.manualRefundTaskId,
      paymentIntentId: params.paymentIntentId,
      keptCents: params.keptCents,
    },
    createdByMemberId: params.createdByMemberId ?? null,
    store: params.store,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero invoice for the kept payment queued for background processing.",
  };
}

/**
 * WITHDRAW WHAT A KEEP QUEUED, when the task is reopened and then APPROVED
 * (refunded). Runs inside the approval's claim transaction. A row still
 * PENDING never reached Xero, so it is cancelled unsent by a status-guarded
 * write and the refund needs no credit note (the refund path's
 * `hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent` no longer
 * counts it). A row already sent, or on its way, is left to that same refund
 * path, which credits it back. The change payment's released supplementary
 * invoice for the same capture is withdrawn the same way.
 */
export async function withdrawQueuedKeptLateCaptureRecord(params: {
  manualRefundTaskId: string;
  paymentIntentId: string;
  store: Prisma.TransactionClient;
}): Promise<number> {
  const data = {
    status: "CANCELLED" as const,
    completedAt: new Date(),
    lastErrorCode: KEPT_LATE_CAPTURE_REFUNDED_ERROR_CODE,
    lastErrorMessage:
      "Withdrawn unsent: the treasurer reopened the kept payment and refunded it instead.",
  };
  const own = await params.store.xeroSyncOperation.updateMany({
    where: { ...KEPT_INVOICE_CREATE, localId: params.manualRefundTaskId, status: "PENDING" },
    data,
  });
  const change = await params.store.xeroSyncOperation.updateMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: "PENDING",
      requestPayload: { path: ["paymentIntentId"], equals: params.paymentIntentId },
    },
    data,
  });
  return own.count + change.count;
}

/**
 * The kept invoice for a payment, when one was sent: the refund-note path
 * accepts it in place of a primary invoice (`createXeroCreditNote`), so a refund
 * after a reopen credits back what this document recorded.
 */
export async function findKeptLateCaptureInvoiceIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { paymentId, lateCaptureApprovalIntentId: { not: null } },
    select: { id: true },
  });
  if (tasks.length === 0) return null;
  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "ManualRefundTask",
      localId: { in: tasks.map((task) => task.id) },
      xeroObjectType: "INVOICE",
      role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
      active: true,
    },
    orderBy: { createdAt: "desc" },
    select: { xeroObjectId: true },
  });
  return link?.xeroObjectId ?? null;
}

/**
 * THE WORKER, from the outbox. Raises the invoice, then records its payment. A
 * retry of a row whose invoice was raised re-uses it (the task's link) and only
 * records the missing payment, so neither is ever raised twice.
 */
export async function createXeroKeptLateCaptureInvoice(params: {
  syncOperationId: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
}): Promise<string | null> {
  const { syncOperationId } = params;
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: syncOperationId },
    select: { requestPayload: true },
  });
  const queued = readQueuedOutboxPayload(row?.requestPayload);
  if (!queued || queued.queueType !== XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE) {
    throw new Error(
      `Kept late-capture invoice operation ${syncOperationId} has no readable queued payload`,
    );
  }
  const { bookingId, manualRefundTaskId: taskId, paymentIntentId, keptCents } = queued;

  // The decision at the moment of sending: a task reopened (OPEN) or approved
  // since (COMPLETED) no longer keeps the money, so nothing is raised. A later
  // keep queues a fresh row.
  const task = await prisma.manualRefundTask.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  if (task?.status !== "DISMISSED") {
    await completeXeroSyncOperation(syncOperationId, {
      status: "CANCELLED",
      responsePayload: {
        skipped: true,
        reason: `The kept payment's task is ${task?.status ?? "missing"}, not kept, so no Xero invoice was raised.`,
      },
    });
    return null;
  }

  const [invoiceLink, paymentLink] = await Promise.all(
    [KEPT_LATE_CAPTURE_INVOICE_ROLE, KEPT_LATE_CAPTURE_PAYMENT_ROLE].map((role) =>
      prisma.xeroObjectLink.findFirst({
        where: { localModel: "ManualRefundTask", localId: taskId, role, active: true },
        select: { xeroObjectId: true, xeroObjectNumber: true },
      }),
    ),
  );

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true, organisation: { select: { name: true, email: true } } },
  });
  if (!booking) throw new Error(`Booking not found: ${bookingId}`);

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const clubZone = await readClubTimeZoneOutsideRequest();
  const documentDate = xeroDocumentDateForClubToday(clubZone);

  try {
    let invoiceId = invoiceLink?.xeroObjectId ?? null;
    let invoiceNumber = invoiceLink?.xeroObjectNumber ?? null;
    let invoiceBody: unknown = null;

    if (!invoiceId) {
      const contactId = await findOrCreateXeroContactForInvoicedParty(booking, {
        createdByMemberId: params.createdByMemberId,
        repairExistingLink: params.repairExistingLink,
      });
      const income = await getResolvedAccountMapping("hutFeesIncome");
      const line: LineItem = applyHutFeeLineCodes(
        {
          description: keptLateCaptureLineDescription(bookingId),
          quantity: 1,
          unitAmount: keptCents / 100,
          taxType: "OUTPUT2",
        },
        {
          itemCode: income.itemCode,
          accountCode: income.code ?? "200",
          accountCodeExplicitlyConfigured: income.codeExplicitlyConfigured,
        },
      );
      const buildInvoice = (resolvedContactId: string): Invoice => ({
        type: Invoice.TypeEnum.ACCREC,
        contact: { contactID: resolvedContactId },
        lineItems: [line],
        date: documentDate,
        dueDate: documentDate,
        reference: `Kept late payment for booking ${bookingId.slice(0, 8)}`,
        status: Invoice.StatusEnum.AUTHORISED,
        lineAmountTypes: LineAmountTypes.Inclusive,
      });
      // Keep the queued instruction beside the request, so a retry replays it.
      const buildStoredPayload = (resolvedContactId: string) => ({
        ...(asRecord(row?.requestPayload) ?? {}),
        invoices: [buildInvoice(resolvedContactId)],
      });
      await prisma.xeroSyncOperation.update({
        where: { id: syncOperationId },
        data: { requestPayload: sanitizeForJson(buildStoredPayload(contactId)) },
      });
      const response = await retryXeroWriteWithContactRepair({
        memberId: bookingOwner(booking).memberId,
        currentContactId: contactId,
        repairContactLink: invoicedPartyContactRepair(booking),
        workflow: "createXeroKeptLateCaptureInvoice",
        operationId: syncOperationId,
        repairExistingLink: params.repairExistingLink,
        createdByMemberId: params.createdByMemberId,
        buildRequestPayload: buildStoredPayload,
        run: ({ contactId: resolvedContactId }) =>
          callXeroApi(
            () =>
              xero.accountingApi.createInvoices(
                tenantId,
                { invoices: [buildInvoice(resolvedContactId)] },
                undefined,
                undefined,
                invoiceKey(taskId),
              ),
            {
              operation: "createInvoices",
              resourceType: "INVOICE",
              workflow: "createXeroKeptLateCaptureInvoice",
              context: `createInvoices(kept late capture ${taskId})`,
            },
          ),
      });
      const created = response.body.invoices?.[0];
      if (!created?.invoiceID) throw new Error("Failed to create the kept late-capture Xero invoice");
      invoiceId = created.invoiceID;
      invoiceNumber = created.invoiceNumber ?? null;
      invoiceBody = response.body;
    }

    let paymentBody: { paymentID?: string } | null = null;
    let paymentError: unknown = null;
    if (!paymentLink) {
      try {
        const stripeBankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayments(
              tenantId,
              {
                payments: [
                  {
                    invoice: { invoiceID: invoiceId! },
                    account: { code: stripeBankCode },
                    amount: keptCents / 100,
                    date: documentDate,
                    reference: `Stripe ${paymentIntentId}`,
                  },
                ],
              },
              undefined,
              paymentKey(taskId),
            ),
          {
            operation: "createPayments",
            resourceType: "PAYMENT",
            workflow: "createXeroKeptLateCaptureInvoice",
            context: `createPayments(kept late capture ${taskId})`,
          },
        );
        paymentBody = paymentResponse.body.payments?.[0] ?? null;
      } catch (error) {
        paymentError = error;
        logger.warn(
          { err: error, taskId, invoiceId },
          "Raised the kept late-capture Xero invoice but could not record its Stripe payment",
        );
      }
    }

    await completeXeroSyncOperation(syncOperationId, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: { invoice: invoiceBody, payment: paymentBody, paymentError },
      xeroObjectType: "INVOICE",
      xeroObjectId: invoiceId,
      xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      extraLinks: [
        {
          localModel: "ManualRefundTask",
          localId: taskId,
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId,
          xeroObjectNumber: invoiceNumber,
          xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
          role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
          metadata: { amountCents: keptCents, paymentIntentId },
        },
        ...(paymentBody?.paymentID
          ? [
              {
                localModel: "ManualRefundTask",
                localId: taskId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentBody.paymentID,
                xeroObjectNumber: invoiceNumber,
                role: KEPT_LATE_CAPTURE_PAYMENT_ROLE,
                metadata: { invoiceId, amountCents: keptCents },
              },
            ]
          : []),
      ],
    });
    return invoiceId;
  } catch (error) {
    await failXeroSyncOperation(syncOperationId, error);
    throw error;
  }
}
