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
 *
 * ALSO THE RECEIPT OF A REFUND PAID ANOTHER WAY (#3924 round 6; owner, 8 Oct
 * 2026: "Record receipt, then credit"; `INV-PAY-122`). An APPROVED refund of
 * the capture that Stripe gave up on, closed as paid another way, leaves the
 * charge in the Stripe account: the close queues this same receipt, on the same
 * task, and its worker queues the close's bank-transfer refund note in the
 * transaction that records the receipt's link - so the note exists exactly
 * when the receipt does, and never runs before it.
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
  upsertXeroObjectLink,
  type XeroObjectLinkInput,
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
import { findLateCaptureRefundPaidAnotherWay } from "@/lib/late-capture-paid-another-way";
import {
  KEPT_LATE_CAPTURE_INVOICE_ROLE,
  KEPT_LATE_CAPTURE_PAYMENT_ROLE,
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
  keptReceiptMayHaveReachedXero,
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

type KeptReceiptRowStore = Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink">;

/** The task's receipt row that counts as asked for (`keptLateCaptureInvoiceAsked`), if any. */
async function findLiveKeptReceiptRow(db: KeptReceiptRowStore, manualRefundTaskId: string) {
  const existing = await db.xeroSyncOperation.findMany({
    where: { ...KEPT_INVOICE_CREATE, localId: manualRefundTaskId },
    select: { id: true, queueType: true, status: true, manuallyResolvedAt: true, requestPayload: true },
  });
  return existing.find((row) => keptLateCaptureInvoiceAsked([row])) ?? null;
}

/** Which of the receipt's links the task carries, and so whether a FAILED row may have reached Xero. */
async function readFailedKeptReceiptLinks(
  db: KeptReceiptRowStore,
  manualRefundTaskId: string,
  requestPayload: unknown,
): Promise<{ invoiceLinked: boolean; mayHaveReachedXero: boolean }> {
  const taskLinks = (
    await db.xeroObjectLink.findMany({
      where: {
        localModel: "ManualRefundTask",
        localId: manualRefundTaskId,
        role: { in: [KEPT_LATE_CAPTURE_INVOICE_ROLE, KEPT_LATE_CAPTURE_PAYMENT_ROLE] },
        active: true,
      },
      select: { role: true },
    })
  ).map((link) => link.role);
  return {
    invoiceLinked: taskLinks.includes(KEPT_LATE_CAPTURE_INVOICE_ROLE),
    mayHaveReachedXero: keptReceiptMayHaveReachedXero({
      requestPayload,
      paymentLinked: taskLinks.includes(KEPT_LATE_CAPTURE_PAYMENT_ROLE),
    }),
  };
}

/**
 * #3924 round 9: IS THIS TASK'S RECEIPT HELD FOR AN OFFICER? Its row FAILED,
 * unresolved, with no invoice link, after it may have reached Xero
 * (`keptReceiptMayHaveReachedXero`). A close never runs it again
 * (`requeueFailedUnsent` answers `awaitingOfficerRetry`): an officer checks
 * Xero, then retries it, and the close's note follows that retry. The close's
 * plan reads the same fact, so the dialog promises what the close does.
 */
export async function keptReceiptHeldForOfficer(db: KeptReceiptRowStore, manualRefundTaskId: string): Promise<boolean> {
  const live = await findLiveKeptReceiptRow(db, manualRefundTaskId);
  if (!live || live.status !== "FAILED" || live.manuallyResolvedAt !== null) return false;
  const { invoiceLinked, mayHaveReachedXero } = await readFailedKeptReceiptLinks(
    db,
    manualRefundTaskId,
    live.requestPayload,
  );
  return !invoiceLinked && mayHaveReachedXero;
}

/**
 * QUEUE IT, once per task, on the caller's transaction and under the task's
 * row lock: the dismissal inside its status-fenced claim, the repair tool in a
 * transaction of its own, and (#3924 round 6) a paid-another-way close of the
 * capture's approved refund, after writing its record. Re-reads the task under
 * the lock and queues nothing unless it is DISMISSED, or COMPLETED with its
 * refund closed as paid another way, so a stale repair snapshot cannot queue a
 * record for a capture since reopened or refunded. Both writers hold the lock across
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
  /**
   * #3924 round 7 (money M2): a row found FAILED before its invoice reached
   * Xero - no invoice link, never resolved by hand - is put back to PENDING
   * rather than taken as live, since nothing else retries it automatically.
   * Only the paid-another-way close asks for this; a keep does not, and the
   * repair tool offers the row's own retry instead
   * (`addPaidAnotherWayReceiptFinding`).
   *
   * Round 8 (money review): never a row that may have reached Xero
   * (`keptReceiptMayHaveReachedXero`: its Stripe payment is linked, or it
   * attempted `createInvoices`). That one is left FAILED for an officer, who
   * checks Xero before retrying it; the close's note then follows the retry.
   */
  requeueFailedUnsent?: boolean;
  store: Prisma.TransactionClient;
}): Promise<{
  queueOperationId: string | null;
  message: string;
  changedByOfficer?: true;
  /**
   * #3924 round 9: the id is a FAILED row that may have reached Xero, left for
   * an officer to check Xero and retry (`keptReceiptHeldForOfficer`) - not a
   * queued one.
   */
  awaitingOfficerRetry?: true;
}> {
  const db = params.store;
  if (!Number.isInteger(params.capturedCents) || params.capturedCents <= 0) {
    return { queueOperationId: null, message: "Nothing was captured, so no Xero invoice is needed." };
  }
  await lockKeptLateCaptureTask(db, params.manualRefundTaskId);
  const task = await db.manualRefundTask.findUnique({
    where: { id: params.manualRefundTaskId },
    select: { status: true },
  });
  // Kept, or (#3924 round 6) approved and its card refund closed as paid
  // another way: either way the charge is still in the Stripe account.
  const receiptOwed =
    task?.status === "DISMISSED" ||
    (task?.status === "COMPLETED" &&
      (await findLateCaptureRefundPaidAnotherWay(params.paymentIntentId, db)) !== null);
  if (!receiptOwed) {
    return {
      queueOperationId: null,
      message: "The payment is no longer kept, so no Xero invoice was queued.",
    };
  }
  const live = await findLiveKeptReceiptRow(db, params.manualRefundTaskId);
  if (live && params.requeueFailedUnsent && live.status === "FAILED" && live.manuallyResolvedAt === null) {
    const { invoiceLinked, mayHaveReachedXero } = await readFailedKeptReceiptLinks(
      db,
      params.manualRefundTaskId,
      live.requestPayload,
    );
    if (!invoiceLinked && mayHaveReachedXero) {
      // #3924 round 9: the row is left FAILED, and the caller is told so - it
      // is not queued, and its note waits for the officer's retry.
      return {
        queueOperationId: live.id,
        awaitingOfficerRetry: true,
        message:
          "The Xero invoice for this payment failed after it may have reached Xero, so it is not run again automatically. Check Xero, then retry it from the Xero operations list.",
      };
    }
    if (!invoiceLinked) {
      // Status-guarded: only the FAILED row this read found goes back to run.
      const requeued = await db.xeroSyncOperation.updateMany({
        where: { id: live.id, status: "FAILED", manuallyResolvedAt: null },
        data: { status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null },
      });
      if (requeued.count === 0) {
        // Round 8 (concurrency): an officer retried or resolved it after the
        // read above - neither takes the task row. Answer what it is now.
        const now = await db.xeroSyncOperation.findUnique({
          where: { id: live.id },
          select: { status: true, manuallyResolvedAt: true },
        });
        // Resolved by hand (or withdrawn): the receipt is the officer's now, as
        // `readLateCaptureXeroReceipt` reads it, so the caller's plan - made
        // before - no longer holds. The close refuses and is asked again.
        if (!now || now.manuallyResolvedAt !== null || now.status === "CANCELLED") {
          return {
            queueOperationId: null,
            changedByOfficer: true,
            message:
              "An officer resolved or withdrew this payment's Xero invoice while it was being queued again.",
          };
        }
        return {
          queueOperationId: live.id,
          message: "The Xero invoice for this payment is already queued or sent.",
        };
      }
      return {
        queueOperationId: live.id,
        message: "The failed Xero invoice for this payment was queued to run again.",
      };
    }
  }
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
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit"): THE ORDER
 * OF THE TWO XERO STEPS of a late capture's refund closed as paid another way.
 *
 * FIRST THE RECEIPT'S LINK - what makes the receipt "recorded"
 * (`readLateCaptureXeroReceipt`) - written under the task's row lock in a
 * transaction of its own (`recordKeptLateCaptureReceiptLink`). Until it
 * exists the close's bank cash is outside what any refund note may answer
 * (`readPaidAnotherWayCash`), so no note can run before its receipt.
 *
 * THEN THE NOTE, in a second transaction under the same lock
 * (`queueWaitingPaidAnotherWayNote`, #3924 round 7, concurrency C9): a failure
 * there no longer rolls the link back with it. The link stands, the row is
 * failed, and its retry - by an officer, or the repair tool's receipt finding -
 * finds the invoice and its payment linked and runs only this step again.
 *
 * The close takes the same row lock BEFORE it reads whether the receipt is
 * recorded (`closeCardRefundPaidAnotherWay`), so the two cannot miss each
 * other: a close that committed before the link is found by the note step,
 * and one that waited reads the receipt recorded and queues its note itself
 * (its key then says `now`, which the note step leaves alone). The note step
 * runs on every run of the row and queues a close's note at most once
 * (`notePaidAnotherWayCloseOnReceipt`). No provider call is made under the
 * lock; the zone is read before it (`INV-LOCK-004`).
 */
async function recordKeptLateCaptureReceiptLink(params: {
  taskId: string;
  receiptLink: XeroObjectLinkInput;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockKeptLateCaptureTask(tx, params.taskId);
    await upsertXeroObjectLink(params.receiptLink, { store: tx });
  });
}

/**
 * Test seam (#3924 round 8): the worker's provider calls - Xero's client and
 * metered call, the invoiced party's contact, the receipt's Stripe payment in
 * Xero, and Stripe's charge day - so the PostgreSQL proof drives this worker,
 * locks and all, without Xero or Stripe. Production passes nothing.
 */
export interface KeptLateCaptureProviderSeam {
  getAuthenticatedXeroClient: typeof getAuthenticatedXeroClient;
  callXeroApi: typeof callXeroApi;
  findOrCreateXeroContactForInvoicedParty: typeof findOrCreateXeroContactForInvoicedParty;
  createXeroPaymentForInvoice: typeof createXeroPaymentForInvoice;
  readStripeCaptureDocumentDate: typeof readStripeCaptureDocumentDate;
}

const KEPT_LATE_CAPTURE_PROVIDERS: KeptLateCaptureProviderSeam = {
  getAuthenticatedXeroClient,
  callXeroApi,
  findOrCreateXeroContactForInvoicedParty,
  createXeroPaymentForInvoice,
  readStripeCaptureDocumentDate,
};

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
 *     refund note, now that Xero has the receipt - a refund paid another way by
 *     its bank-transfer note, queued after the receipt's link (#3924 rounds 6
 *     and 7), on every run until it is queued.
 */
export async function createXeroKeptLateCaptureInvoice(
  params: {
    syncOperationId: string;
    createdByMemberId?: string;
    repairExistingLink?: boolean;
  },
  providers: KeptLateCaptureProviderSeam = KEPT_LATE_CAPTURE_PROVIDERS,
): Promise<string | null> {
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
        refundClosedPaidAnotherWay:
          task?.status === "COMPLETED" &&
          (await findLateCaptureRefundPaidAnotherWay(paymentIntentId, tx)) !== null,
      });
      if (decision.recordCents > 0) return null;
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
        const chargedOn = await providers.readStripeCaptureDocumentDate(
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
      const { xero, tenantId } = await providers.getAuthenticatedXeroClient();
      // The seam's metered call, under the one name the Xero wrapper audit reads.
      const { callXeroApi } = providers;
      const contactId = await providers.findOrCreateXeroContactForInvoicedParty(booking, {
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
        paymentId = await providers.createXeroPaymentForInvoice({
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

    const receiptLink: XeroObjectLinkInput = {
      localModel: "ManualRefundTask",
      localId: taskId,
      xeroObjectType: "INVOICE",
      xeroObjectId: invoiceId!,
      xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
      role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
      metadata: { amountCents: capturedCents, paymentIntentId },
    };
    if (!invoiceLink) {
      await recordKeptLateCaptureReceiptLink({ taskId, receiptLink });
    }
    // Round 7 (C9): after the link, on its own; a failure fails this row with
    // the link standing, and the row's retry runs only this again.
    // Imported here, not at the top: that module takes this one's task lock.
    const { queueWaitingPaidAnotherWayNote } = await import("@/lib/paid-another-way-receipt-note");
    await queueWaitingPaidAnotherWayNote(paymentIntentId);

    await completeXeroSyncOperation(syncOperationId, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: { invoice: invoiceBody, paymentId, paymentError },
      xeroObjectType: "INVOICE",
      xeroObjectId: invoiceId,
      xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId!),
      extraLinks: [receiptLink],
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
