/**
 * THE XERO RECORD OF A KEPT LATE CAPTURE (#3635, owner decision 29 Sep 2026,
 * `INV-PAY-110`): "When a treasurer keeps a late card capture on a cancelled
 * booking, the app raises a Xero invoice for the kept amount and marks it paid
 * from the Stripe account, the same way a normal card payment is recorded."
 *
 * RECORDED EXACTLY AS A CARD RECEIPT IS (orchestrator decision 29 Sep 2026): an
 * invoice for the GROSS captured cents, dated the club day Stripe took the
 * money, paid from the Stripe bank account on that day. Every refund of it -
 * from the dashboard, or on approval after a reopen - is answered by the
 * ordinary refund credit note against this invoice; nothing is netted here, so
 * a refund cannot be subtracted twice, and the receipt lands in the period the
 * Stripe payout does.
 *
 * For the booking's OWN payment, and for a change payment on a booking Xero
 * never invoiced (`keptLateCaptureRecordRoute`). One invoice per kept capture,
 * ANCHORED ON THE #3639 APPROVAL TASK (`ManualRefundTask`, one row per
 * capture). It needs no primary invoice and touches neither the booking's own
 * invoice nor the cancellation's clearing note, which between them already net
 * to what the cancellation decided; so the capture is counted once in every
 * case. `xero-kept-late-capture-ledger.test.ts` computes the resulting Xero
 * ledger from the documents the code produces, case by case.
 *
 * WHY A NEW QUEUE TYPE and not a third supplementary-invoice anchor: that
 * builder is a booking CHANGE's document (itemised change lines, "original
 * invoice" reference, refuses without a primary invoice), and its
 * `ManualRefundTask` anchor already means a second ask, which the retry screen
 * replays unpaid by definition.
 *
 * THE TASK ROW IS THE LOCK. The enqueue and the worker's send-time decision
 * both take the task row `FOR UPDATE` (`lockKeptLateCaptureTask`), the row the
 * dismissal's, reopen's and approval's status-fenced claims write, so a keep, a
 * reopen and the worker serialise: a re-keep either finds a live row or, once
 * the worker has withdrawn it, queues a new one.
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
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import {
  findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair,
} from "@/lib/organisation-xero-contacts";
import { applyHutFeeLineCodes } from "@/lib/xero-hut-fee-line-codes";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";
import { readStripeCaptureDocumentDate } from "@/lib/stripe-capture-date";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import type { ClubTimeZone } from "@/lib/club-time";
import {
  KEPT_LATE_CAPTURE_INVOICE_ROLE,
  KEPT_LATE_CAPTURE_PAYMENT_ROLE,
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
} from "@/lib/late-capture-kept-xero-rules";
import {
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  readQueuedOutboxPayload,
} from "@/lib/xero-operation-outbox-payload";

/** Stamped on a row withdrawn because the task stopped keeping the money. */
export const KEPT_LATE_CAPTURE_WITHDRAWN_ERROR_CODE = "KEPT_LATE_CAPTURE_WITHDRAWN";

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
 * Lock the approval task's row `FOR UPDATE` inside the caller's transaction.
 * A LOCK, NEVER A READ: the values are read back through the model under it.
 * The claims that change the task's status write this row, so they wait for
 * it and it waits for them; it composes with no advisory key.
 */
export async function lockKeptLateCaptureTask(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  taskId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "ManualRefundTask" WHERE "id" = ${taskId} FOR UPDATE`;
}

/** The club day Stripe took the money: the task is raised by the capture. */
export function keptLateCaptureDocumentDate(capturedAt: Date, zone: ClubTimeZone): string {
  return xeroDocumentDateFromInstant(capturedAt, zone);
}

/**
 * QUEUE IT, once per task, on the caller's transaction and under the task's
 * row lock: the dismissal inside its status-fenced claim, the repair tool in a
 * transaction of its own. Re-reads the task under the lock and queues nothing
 * unless it is DISMISSED, so a stale repair snapshot cannot queue a record for
 * a capture since reopened or refunded. Both writers hold the lock across
 * find-and-create, so the active-correlation index can never raise inside the
 * transaction (whose fallback re-read an aborted Postgres transaction could not
 * run - the hazard `lockSupplementaryInvoiceAnchor` documents).
 */
export async function enqueueXeroKeptLateCaptureInvoiceOperation(params: {
  manualRefundTaskId: string;
  bookingId: string;
  paymentIntentId: string;
  capturedCents: number;
  /** The Xero date of the receipt: the club day of the capture. */
  capturedOn: string;
  createdByMemberId?: string | null;
  store: Prisma.TransactionClient;
}): Promise<{ queueOperationId: string | null; message: string }> {
  const db = params.store;
  if (!Number.isInteger(params.capturedCents) || params.capturedCents <= 0) {
    return { queueOperationId: null, message: "Nothing was captured, so no Xero invoice is needed." };
  }
  await lockKeptLateCaptureTask(db, params.manualRefundTaskId);
  const task = await db.manualRefundTask.findUnique({
    where: { id: params.manualRefundTaskId },
    select: { status: true },
  });
  if (task?.status !== "DISMISSED") {
    return {
      queueOperationId: null,
      message: "The payment is no longer kept, so no Xero invoice was queued.",
    };
  }
  const existing = await db.xeroSyncOperation.findMany({
    where: { ...KEPT_INVOICE_CREATE, localId: params.manualRefundTaskId },
    select: { id: true, queueType: true, status: true },
  });
  const live = existing.find((row) => keptLateCaptureInvoiceAsked([row]));
  if (live) {
    return {
      queueOperationId: live.id,
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
      capturedCents: params.capturedCents,
      capturedOn: params.capturedOn,
    },
    createdByMemberId: params.createdByMemberId ?? null,
    store: db,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero invoice for the kept payment queued for background processing.",
  };
}

/**
 * THE APPROVAL'S HALF, when a task kept earlier is reopened and then APPROVED
 * (refunded). Runs inside the approval's claim, which holds the task row.
 *  - A row that never reached Xero - PENDING, or FAILED with no invoice link -
 *    is withdrawn, and no refund note is raised for it.
 *  - A row whose invoice exists but whose payment was not recorded (PARTIAL)
 *    goes back to PENDING: the cash was really taken, so its worker records
 *    the payment whatever the task says now, and the refund note answers it.
 *  - A RUNNING row whose check has not run is withdrawn by that check, which
 *    runs under the task lock after this claim commits. One already past its
 *    check sends, and its worker credits the refund back; a SUCCEEDED one is
 *    answered by the refund note.
 *  - A row an officer resolved in Xero is left as it is: recorded by hand,
 *    never re-run (`INV-INT-025`). Its refund gets no automatic note: the
 *    officer records that by hand too, and the repair tool asks them to
 *    (`KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND`, round-3 R5).
 * The change's released supplementary invoice for the same capture, still
 * PENDING, is withdrawn too.
 */
export async function settleKeptLateCaptureRecordOnApproval(params: {
  manualRefundTaskId: string;
  paymentIntentId: string;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const db = params.store;
  const invoiceLink = await db.xeroObjectLink.count({
    where: {
      localModel: "ManualRefundTask",
      localId: params.manualRefundTaskId,
      xeroObjectType: "INVOICE",
      role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
      active: true,
    },
  });
  const withdrawnMessage =
    "Withdrawn unsent: the treasurer reopened the kept payment and refunded it instead.";
  if (invoiceLink === 0) {
    await db.xeroSyncOperation.updateMany({
      where: {
        ...KEPT_INVOICE_CREATE,
        localId: params.manualRefundTaskId,
        status: { in: ["PENDING", "FAILED"] },
        // `INV-INT-025`: a row an officer resolved in Xero was recorded by
        // hand; it stands, and the refund note answers it.
        manuallyResolvedAt: null,
      },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        lastErrorCode: KEPT_LATE_CAPTURE_WITHDRAWN_ERROR_CODE,
        lastErrorMessage: withdrawnMessage,
      },
    });
  } else {
    await db.xeroSyncOperation.updateMany({
      // Never a row resolved in Xero: resolved is done, and never re-run.
      where: {
        ...KEPT_INVOICE_CREATE,
        localId: params.manualRefundTaskId,
        status: "PARTIAL",
        manuallyResolvedAt: null,
      },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  }
  await db.xeroSyncOperation.updateMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: "PENDING",
      requestPayload: { path: ["paymentIntentId"], equals: params.paymentIntentId },
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastErrorCode: KEPT_LATE_CAPTURE_WITHDRAWN_ERROR_CODE,
      lastErrorMessage: withdrawnMessage,
    },
  });
}

/**
 * THE WORKER, from the outbox.
 *  1. If the task's invoice already exists (a retry, or an approval that sent
 *     a PARTIAL row back), only the missing Stripe payment is recorded, whatever
 *     the task says now: the money was taken, and any refund is its own note.
 *  2. Otherwise the send-time decision is taken under the task's row lock, and
 *     a row whose task no longer keeps the money is withdrawn in the same
 *     transaction, so a re-keep waiting on that lock then queues a new one.
 *  3. The invoice and its payment are sent, both dated the capture day.
 *  4. Any refund of the capture already taken is credited back by the ordinary
 *     refund note, now that Xero has the receipt.
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
  const { bookingId, manualRefundTaskId: taskId, paymentIntentId, capturedCents } = queued;
  let capturedOn = queued.capturedOn;

  const linkFor = (role: string) =>
    prisma.xeroObjectLink.findFirst({
      where: { localModel: "ManualRefundTask", localId: taskId, role, active: true },
      select: { xeroObjectId: true, xeroObjectNumber: true },
    });
  const invoiceLink = await linkFor(KEPT_LATE_CAPTURE_INVOICE_ROLE);

  if (!invoiceLink) {
    const withdrawnReason = await prisma.$transaction(async (tx) => {
      await lockKeptLateCaptureTask(tx, taskId);
      const task = await tx.manualRefundTask.findUnique({
        where: { id: taskId },
        select: { status: true },
      });
      const capture = await tx.paymentTransaction.findFirst({
        where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
        select: { status: true, amountCents: true },
      });
      const decision = decideLateCapture({
        taskStatus: task?.status ?? null,
        bookingStatus: "CANCELLED",
        superseded: false,
        capture,
      });
      if (decision.state === "kept" && decision.recordCents > 0) return null;
      const reason = `The kept payment's task is ${task?.status ?? "missing"}, not kept, so no Xero invoice was raised.`;
      await completeXeroSyncOperation(
        syncOperationId,
        { status: "CANCELLED", responsePayload: { skipped: true, reason } },
        { store: tx },
      );
      return reason;
    });
    if (withdrawnReason) return null;
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true, organisation: { select: { name: true, email: true } } },
  });
  if (!booking) throw new Error(`Booking not found: ${bookingId}`);

  try {
    let invoiceId = invoiceLink?.xeroObjectId ?? null;
    let invoiceNumber = invoiceLink?.xeroObjectNumber ?? null;
    let invoiceBody: unknown = null;

    if (!invoiceId) {
      // Round-3 R2: the receipt is dated the day of the Stripe CHARGE, read
      // once and stored before the Xero call. The enqueue's date - the task's
      // raise day - stands only when Stripe cannot say.
      let storedPayload = asRecord(row?.requestPayload) ?? {};
      if (!queued.capturedOnFromStripe) {
        const chargedOn = await readStripeCaptureDocumentDate(
          paymentIntentId,
          await readClubTimeZoneOutsideRequest(),
        );
        if (chargedOn) {
          capturedOn = chargedOn;
          storedPayload = { ...storedPayload, capturedOn, capturedOnFromStripe: true };
          await prisma.xeroSyncOperation.update({
            where: { id: syncOperationId },
            data: { requestPayload: sanitizeForJson(storedPayload) },
          });
        }
      }
      const { xero, tenantId } = await getAuthenticatedXeroClient();
      const contactId = await findOrCreateXeroContactForInvoicedParty(booking, {
        createdByMemberId: params.createdByMemberId,
        repairExistingLink: params.repairExistingLink,
      });
      const income = await getResolvedAccountMapping("hutFeesIncome");
      const line: LineItem = applyHutFeeLineCodes(
        {
          description: keptLateCaptureLineDescription(bookingId),
          quantity: 1,
          unitAmount: capturedCents / 100,
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
        date: capturedOn,
        dueDate: capturedOn,
        reference: `Kept late payment for booking ${bookingId.slice(0, 8)}`,
        status: Invoice.StatusEnum.AUTHORISED,
        lineAmountTypes: LineAmountTypes.Inclusive,
      });
      // Keep the queued instruction beside the request, so a retry replays it.
      const buildStoredPayload = (resolvedContactId: string) => ({
        ...storedPayload,
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

    // The one "record a Stripe payment on an invoice" step (`INV-SSOT`), dated
    // the capture day; it writes the task's payment link itself.
    let paymentId: string | null = null;
    let paymentError: unknown = null;
    if (!(await linkFor(KEPT_LATE_CAPTURE_PAYMENT_ROLE))) {
      try {
        paymentId = await createXeroPaymentForInvoice({
          localModel: "ManualRefundTask",
          localId: taskId,
          invoiceId: invoiceId!,
          amountCents: capturedCents,
          idempotencyKey: paymentKey(taskId),
          reference: `Stripe ${paymentIntentId}`,
          role: KEPT_LATE_CAPTURE_PAYMENT_ROLE,
          createdByMemberId: params.createdByMemberId,
          metadata: { invoiceId, amountCents: capturedCents },
          date: capturedOn,
        });
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
      responsePayload: { invoice: invoiceBody, paymentId, paymentError },
      xeroObjectType: "INVOICE",
      xeroObjectId: invoiceId,
      xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
      extraLinks: [
        {
          localModel: "ManualRefundTask",
          localId: taskId,
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId!,
          xeroObjectNumber: invoiceNumber,
          xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
          role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
          metadata: { amountCents: capturedCents, paymentIntentId },
        },
      ],
    });

    // Imported here, not at the top: that module reaches the outbox, which
    // dispatches to this worker.
    const { creditBackLateCaptureRefunds } = await import("@/lib/late-capture-refund-credit-note");
    await creditBackLateCaptureRefunds(paymentIntentId);
    return invoiceId;
  } catch (error) {
    await failXeroSyncOperation(syncOperationId, error);
    throw error;
  }
}
