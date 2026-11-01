/**
 * A BOOKING CHANGE'S CARD CAPTURE IS RECORDED AGAINST THE XERO INVOICE THAT
 * BILLS IT (#3953, `INV-PAY-139`; owner decision and plan, 21 Oct 2026: "check,
 * then bill and pay").
 *
 * A change made while the booking's primary invoice did not yet exist queues no
 * supplementary invoice: the primary is built later from the post-change price
 * and bills the extra itself. A capture of that change's ask that the primary's
 * own payment did not record gets a receipt row
 * (`additional-capture-receipt-enqueue.ts`) - from the late-success release
 * when it lands after the invoice, or from the invoice's link save when it
 * landed before - and this worker records it, AT CAPTURE TIME, against the
 * invoice that bills it:
 *
 *  - THE GAP INVOICE, where the capture's change is one the #3980 gap invoice
 *    bills for (`INV-PAY-136`): the primary bills the booking as it was before
 *    that change, and the gap invoice bills the change's extra.
 *  - OTHERWISE THE PRIMARY INVOICE, built from the post-change price. Its room
 *    is its AmountDue less the applied account credit its settle still
 *    allocates there (`primaryInvoiceStripeCashCents`), so that allocation
 *    always fits.
 *
 * One invoice, never split: the capture's gross cents (less any part the
 * primary's own payment took), capped at that invoice's room. Cash it leaves
 * over is told to an officer with both figures.
 *
 * ONE RECORDER PER CAPTURE (review round 1, `additional-capture-recorder.ts`).
 * Before it decides anything the worker reads who records the capture and
 * stands down for the primary's own payment, a supplementary invoice for the
 * change or naming the capture, or a gap invoice whose payment took it. It
 * plans one capture per booking at a time, and not while the booking's
 * invoice create is running (it waits, back to PENDING). The gap invoice never
 * pays itself from a capture with a receipt row.
 *
 * NOTHING IS GUESSED. The worker refuses - the row FAILED with
 * `ADDITIONAL_CAPTURE_RECEIPT_REFUSED`, an officer told - where Xero cannot be
 * read, the invoice that bills the capture has nothing due, the gap invoice
 * has not reached Xero, the invoice's own payment is still owed (a PARTIAL
 * create), or a retry's invoice no longer has the room it was sized at. It
 * WAITS while the gap invoice is still being sent. Where the primary cannot
 * take the capture and no gap invoice exists, #3980's own check
 * (`recheckPrimaryInvoiceWorthGap`) raises one, never a second, and the
 * receipt waits for it. A capture on a booking since cancelled - save one a
 * treasurer KEPT, whose change the primary bills (#4324, `INV-PAY-144`,
 * `kept-late-capture-change-receipt.ts`) - or paid by internet banking, is
 * closed unsent.
 *
 * NEVER TWICE. One row per capture, queued under the per-anchor
 * supplementary-invoice lock; the payment link returns early; an earlier run's
 * payment is found by its reference; and the payment decided is stored on the
 * row BEFORE Xero is called, so a retry sends the same invoice, amount, date
 * and Xero key, or refuses - it never decides again.
 *
 * No provider call is made under a lock or inside a transaction (`INV-LOCK-004`).
 */
import { XERO_ACTIVE_OPERATION_STATUSES } from "./xero-active-operation-statuses";
import { PaymentSource } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import { readStripeCaptureDocumentDate } from "@/lib/stripe-capture-date";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { asRecord } from "@/lib/xero-json";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";
import { buildXeroIdempotencyKey, completeXeroSyncOperation, failXeroSyncOperation, sanitizeForJson } from "@/lib/xero-sync";
import { readCaptureRecorder } from "@/lib/additional-capture-recorder";
import {
  ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE,
  passPlanningGate,
  switchUnsentRecorderUnpaid,
  waitFor,
} from "@/lib/additional-capture-receipt-gate";
import {
  ADDITIONAL_CAPTURE_PAYMENT_ROLE,
  bookingHasPaidUnnamedSupplementary,
  captureChangeId,
} from "@/lib/additional-capture-receipt-link";
import {
  answerKeptLateCaptureRefunds,
  closeKeptReceiptNotKept,
  hasLateCaptureApprovalTask,
  keptCaptureAnchorId,
  keptReceiptStillKeptElseClosed,
  lateCaptureStillKept,
} from "@/lib/kept-late-capture-change-receipt";
import { amountDueOn, findRecordedPayment, ownPaymentPending, type InvoiceRead } from "@/lib/additional-capture-receipt-invoice-read";
import {
  readAdditionalCaptureReceiptPayload,
  type AdditionalCaptureReceiptPlan,
  type AdditionalCaptureReceiptTarget,
} from "@/lib/additional-capture-receipt-payload";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import type { cardSettleAppliedCreditCents } from "@/lib/xero-primary-invoice-fee-gap";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

/** The payment figures the primary's applied-credit reservation reads. */
type CardSettlePayment = Parameters<typeof cardSettleAppliedCreditCents>[1];

/** Stamped on a row the worker refused: an officer checks Xero and records it by hand, or retries. */
export const ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE = "ADDITIONAL_CAPTURE_RECEIPT_REFUSED";


/** Another writer that now records the capture, and the change the capture pays for. */
type OtherRecorder = { kind: string; operationId: string | null; changeId: string | null };

/** The outbox row's key: one per capture. */
export function additionalCaptureReceiptKey(paymentIntentId: string): string {
  return buildXeroIdempotencyKey("payment-intent", paymentIntentId, "additional-capture-receipt", "v1");
}

/** The Xero payment's key: the capture and the invoice it is recorded against. */
export function additionalCapturePaymentKey(paymentIntentId: string, invoiceId: string): string {
  return buildXeroIdempotencyKey("payment-intent", paymentIntentId, "additional-capture-payment", invoiceId, "v1");
}

/** The reference the payment is recorded under, as every Stripe payment the app records is. */
export function additionalCapturePaymentReference(paymentIntentId: string): string {
  return `Stripe ${paymentIntentId}`;
}

/** What one invoice can take of the capture, as Xero shows it now. */
export type ReceiptCandidate = {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  /** Cents this capture may be recorded against; 0 when it can take none. */
  roomCents: number;
};

/**
 * THE ONE DECISION, pure: the first candidate with room, in the order given,
 * and the capture's cents capped at that room. Null when none has any. The
 * worker offers the gap invoice only where it bills the capture's change, so
 * there is one candidate in practice; the order is the rule where there are
 * more.
 */
export function chooseAdditionalCaptureReceiptTarget(
  capturedCents: number,
  candidates: readonly ReceiptCandidate[],
): { target: AdditionalCaptureReceiptTarget; invoiceId: string; amountCents: number } | null {
  if (!Number.isInteger(capturedCents) || capturedCents <= 0) return null;
  const chosen = candidates.find((candidate) => candidate.roomCents > 0);
  if (!chosen) return null;
  return {
    target: chosen.target,
    invoiceId: chosen.invoiceId,
    amountCents: Math.min(capturedCents, chosen.roomCents),
  };
}

/**
 * Test seam: the worker's provider calls, so tests drive it without Xero or
 * Stripe. Production passes nothing.
 */
export interface AdditionalCaptureReceiptProviders {
  getAuthenticatedXeroClient: typeof getAuthenticatedXeroClient;
  callXeroApi: typeof callXeroApi;
  createXeroPaymentForInvoice: typeof createXeroPaymentForInvoice;
  readStripeCaptureDocumentDate: typeof readStripeCaptureDocumentDate;
}

const PROVIDERS: AdditionalCaptureReceiptProviders = {
  getAuthenticatedXeroClient,
  callXeroApi,
  createXeroPaymentForInvoice,
  readStripeCaptureDocumentDate,
};

const OUTSTANDING_STATUSES = new Set<string>(XERO_ACTIVE_OPERATION_STATUSES);

/**
 * WHY A ROW IS REFUSED, in the officer's words. Each names what to check; none
 * is retried automatically.
 */
const REFUSAL_TEXT = {
  "not-captured": "no captured card payment could be found for it",
  "no-primary-invoice": "the booking has no Xero invoice linked",
  "xero-unreadable":
    "Xero did not return the invoice it belongs to, so how much is still due could not be read; retry this once Xero answers",
  "gap-invoice-not-in-xero":
    "the supplementary invoice that bills this change, which this payment belongs to, has not reached Xero (its operation failed or was resolved by hand)",
  "gap-review-task":
    "the booking's Xero invoice bills less than the booking is worth and no change explains it; a Xero Operations task asks the treasurer to bill it",
  "own-payment-pending":
    "the invoice's own card payment has not been recorded in Xero yet (its operation is PARTIAL); retry this once that is repaired",
  "nothing-due":
    "the Xero invoice this payment belongs to has nothing left due once any account credit still to be allocated to it is allowed for, so recording it would overpay that invoice",
  "recorded-elsewhere":
    "it was decided and stored before another document came to record the same payment (a supplementary invoice for the change, naming it or covering it). Check Xero shows the payment on one invoice only, correct it by hand if not, then mark this operation resolved",
  "change-unknown":
    "its ledger row names no booking change, and a supplementary invoice on this booking records a card payment without naming which, so whether this payment is already recorded cannot be told. Check Xero, record it by hand if it is missing, then mark this operation resolved",
  "figures-changed":
    "the invoice no longer has the amount due this payment was sized at when it was first tried, and Xero shows no payment under its reference. Record it by hand in Xero, then mark this operation resolved",
} as const;
export type AdditionalCaptureReceiptRefusal = keyof typeof REFUSAL_TEXT;

async function alertOfficer(paymentIntentId: string, operationId: string, message: string): Promise<void> {
  try {
    await sendAdminXeroSyncErrorAlert({
      errorType: "ADDITIONAL_CAPTURE_NOT_RECORDED",
      operation: `Card payment ${paymentIntentId} for a booking change`,
      errorMessage: `${message} Stripe holds this money; check Xero records it (outbox operation ${operationId}).`,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err, operationId }, "Failed to send the unrecorded card payment alert");
  }
}

async function readInvoice(
  providers: AdditionalCaptureReceiptProviders,
  client: { xero: Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"]; tenantId: string },
  invoiceId: string,
): Promise<InvoiceRead | null> {
  // The seam's metered call, under the one name the Xero wrapper audit reads.
  const { callXeroApi } = providers;
  const response = await callXeroApi(
    () => client.xero.accountingApi.getInvoice(client.tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "recordAdditionalCaptureReceipt",
      context: `getInvoice(additional capture receipt ${invoiceId})`,
    },
  );
  const invoice = response.body.invoices?.[0];
  const amountDueCents = providerAmountToCents(invoice?.amountDue);
  if (!invoice || amountDueCents === null) return null;
  return { status: String(invoice.status ?? ""), amountDueCents, invoice };
}

/**
 * THE WORKER, from the outbox. Returns the Xero payment id it recorded or
 * found, or null when it recorded nothing.
 */
export async function recordAdditionalCaptureReceipt(
  params: { syncOperation: XeroOperationClaim; createdByMemberId?: string },
  providers: AdditionalCaptureReceiptProviders = PROVIDERS,
): Promise<string | null> {
  const operationId = params.syncOperation.id;
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: { requestPayload: true },
  });
  const queued = readAdditionalCaptureReceiptPayload(row?.requestPayload);
  if (!queued) {
    throw new Error(`Card capture receipt operation ${operationId} has no readable queued payload`);
  }
  const { bookingId, paymentId, paymentTransactionId, paymentIntentId } = queued;
  const reference = additionalCapturePaymentReference(paymentIntentId);

  const refuse = async (reason: AdditionalCaptureReceiptRefusal, details: Record<string, unknown> = {}) => {
    const message = `The card payment for this booking change was not recorded in Xero: ${REFUSAL_TEXT[reason]}.`;
    logger.error({ operationId, bookingId, paymentIntentId, reason, ...details }, message);
    await failXeroSyncOperation(params.syncOperation, new Error(message), { refused: reason, ...details }, {
      lastErrorMessage: message,
    });
    await prisma.xeroSyncOperation.updateMany({
      where: { id: operationId, status: "FAILED" },
      data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE },
    });
    await alertOfficer(paymentIntentId, operationId, message);
    return null;
  };
  /** Finished with nothing to send: another writer records it, or it is not this app's to record. */
  const standDown = async (status: "SUCCEEDED" | "CANCELLED", skipped: string, details: Record<string, unknown> = {}) => {
    await completeXeroSyncOperation(params.syncOperation, { status, responsePayload: { skipped, ...details } });
    // A CANCELLED completion keeps its code: the planning stamp is not an error.
    await prisma.xeroSyncOperation.updateMany({
      where: { id: operationId, lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
      data: { lastErrorCode: null },
    });
    return null;
  };

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: paymentTransactionId,
      xeroObjectType: "PAYMENT",
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      active: true,
    },
    select: { xeroObjectId: true },
  });
  if (existingLink) {
    await completeXeroSyncOperation(params.syncOperation, {
      responsePayload: { alreadyRecorded: true, paymentId: existingLink.xeroObjectId },
      xeroObjectType: "PAYMENT",
      xeroObjectId: existingLink.xeroObjectId,
    });
    return existingLink.xeroObjectId;
  }

  try {
    await passPlanningGate(operationId, bookingId);
    const plan = queued.plan ?? (await planReceipt());
    // No plan: the row is already finished - skipped, recorded, or refused.
    if (!plan) return null;
    return await sendPlannedPayment(plan, Boolean(queued.plan));
  } catch (error) {
    if (error instanceof XeroAppliedCreditOperationBusyError) throw error;
    await failXeroSyncOperation(params.syncOperation, error);
    throw error;
  }

  /** The room on the primary: its AmountDue less the applied credit its settle still allocates there. */
  async function primaryRoom(
    read: InvoiceRead,
    payment: CardSettlePayment,
    capturedCents: number,
  ): Promise<number> {
    if (read.status !== "AUTHORISED") return 0;
    const { cardSettleAppliedCreditCents, primaryInvoiceStripeCashCents } = await import(
      "@/lib/xero-primary-invoice-fee-gap"
    );
    return primaryInvoiceStripeCashCents({
      netCapturedCents: capturedCents,
      amountDueCents: read.amountDueCents,
      appliedCreditCents: await cardSettleAppliedCreditCents(bookingId, payment),
    });
  }

  /**
   * Decide the payment, store it on the row, and return it; or finish the row
   * (stood down, recorded elsewhere, or refused) and return null.
   */
  async function planReceipt(): Promise<AdditionalCaptureReceiptPlan | null> {
    const transaction = await prisma.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      select: {
        kind: true,
        source: true,
        status: true,
        amountCents: true,
        stripePaymentIntentId: true,
        bookingModificationId: true,
        reason: true,
        payment: {
          select: {
            id: true,
            source: true,
            status: true,
            amountCents: true,
            refundedAmountCents: true,
            creditAppliedCents: true,
            xeroInvoiceId: true,
            booking: { select: { status: true } },
          },
        },
      },
    });
    if (
      !transaction ||
      transaction.kind !== "ADDITIONAL" ||
      transaction.source !== "STRIPE" ||
      transaction.stripePaymentIntentId !== paymentIntentId ||
      !isCapturedTransactionStatus(transaction.status) ||
      transaction.amountCents <= 0
    ) {
      return refuse("not-captured");
    }
    const payment = transaction.payment;
    // Review round 1 (K, H): the cancellation answers a cancelled booking's
    // invoice; a booking paid by internet banking is the treasurer's to settle.
    // #4324: save a late capture whose approval task decides it (kept, below).
    const cancelled = payment.booking.status === "CANCELLED";
    if (cancelled && !(await hasLateCaptureApprovalTask(paymentIntentId))) return standDown("CANCELLED", "booking-cancelled");
    if (payment.source !== PaymentSource.STRIPE) return standDown("CANCELLED", "not-a-card-booking");
    const primaryInvoiceId = payment.xeroInvoiceId;
    if (!primaryInvoiceId) return refuse("no-primary-invoice");

    // Only a capture the club keeps is recorded. Imported here: that module
    // reaches the outbox, which dispatches to this worker.
    const { lateCaptureRefundState } = await import("@/lib/xero-supplementary-invoice-late-capture");
    const refundState = await lateCaptureRefundState({ paymentIntentId, bookingStatus: payment.booking.status });
    if (refundState !== "kept" && !cancelled) return standDown("CANCELLED", "capture-not-kept", { refundState });
    // #4324 (review C1): on a cancelled booking its approval task decides, read again and closed under the anchor.
    const anchorId = keptCaptureAnchorId(transaction, bookingId);
    if (refundState !== "kept" && !(await keptReceiptStillKeptElseClosed({ claim: params.syncOperation, anchorId, paymentIntentId }, { refundState }))) return null;

    // Review round 1: one recorder per capture.
    const recorder = await readCaptureRecorder({
      bookingId,
      primaryInvoiceId,
      paymentIntentId,
      bookingModificationId: captureChangeId(transaction),
    });
    if (recorder.kind === "primary-invoice") {
      return standDown("SUCCEEDED", "recorded-by-primary-invoice", { primaryInvoiceId });
    }
    if (recorder.kind === "supplementary-invoice" || recorder.kind === "kept-late-capture-invoice") {
      return standDown("SUCCEEDED", `recorded-by-${recorder.kind}`, { operationId: recorder.operationId });
    }
    if (recorder.kind === "credit-release-sweep") return standDown("SUCCEEDED", "recorded-by-credit-release-sweep");
    const { gap, target: supplementary, alreadyRecordedCents } = recorder;
    // Only the part no other writer recorded: the primary's payment, or the
    // gap invoice's, may have taken some of it (round 3, F2).
    const capturedCents = transaction.amountCents - alreadyRecordedCents;

    let supplementaryInvoiceId: string | null = null;
    if (supplementary) {
      // The gap invoice for its change, or the change's own invoice raised unpaid (round 3, F1).
      const { operation, link } = supplementary;
      if (operation && OUTSTANDING_STATUSES.has(operation.status)) {
        throw waitFor(
          `The supplementary invoice for this booking's change (operation ${operation.id}) is still on its way to Xero; this card payment is recorded once it is there`,
        );
      }
      supplementaryInvoiceId = link?.active ? link.xeroObjectId : null;
      if (!supplementaryInvoiceId) return refuse("gap-invoice-not-in-xero", { supplementaryOperationId: operation?.id ?? null });
      if (ownPaymentPending(operation)) return refuse("own-payment-pending", { supplementaryOperationId: operation?.id });
    } else {
      const primaryCreate = await prisma.xeroSyncOperation.findFirst({
        where: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
          xeroObjectId: primaryInvoiceId,
        },
        orderBy: { createdAt: "desc" },
        select: { status: true, responsePayload: true, manuallyResolvedAt: true },
      });
      if (ownPaymentPending(primaryCreate)) return refuse("own-payment-pending");
    }

    const target: AdditionalCaptureReceiptTarget = supplementary && supplementaryInvoiceId ? supplementary.kind : "PRIMARY_INVOICE";
    const invoiceId = supplementaryInvoiceId ?? primaryInvoiceId;
    const client = await providers.getAuthenticatedXeroClient();
    const read = await readInvoice(providers, client, invoiceId);
    if (!read) return refuse("xero-unreadable", { invoiceId });

    // A lost response: an earlier run recorded it, and only its link is missing.
    const recorded = findRecordedPayment(read, reference);
    if (recorded?.paymentID) {
      await finishRecorded({
        paymentId: recorded.paymentID,
        plan: {
          target,
          invoiceId,
          amountCents: providerAmountToCents(recorded.amount) ?? capturedCents,
          capturedCents,
          date: String(recorded.date ?? ""),
        },
        recoveredExisting: true,
      });
      return null;
    }

    const roomCents = target === "PRIMARY_INVOICE" ? await primaryRoom(read, payment, capturedCents) : amountDueOn(read);
    const chosen = chooseAdditionalCaptureReceiptTarget(capturedCents, [{ target, invoiceId, roomCents }]);

    // #4324: never on a cancelled booking - nothing new is billed there.
    if (!cancelled && !gap && target === "PRIMARY_INVOICE" && (!chosen || chosen.amountCents < capturedCents)) {
      // The primary cannot take it all and no gap invoice exists: the primary
      // may bill less than the booking was worth at its link. #3980's own check
      // raises that gap, or finds it raised, and never a second. This capture
      // has a receipt row, so the gap never pays itself from it (G): the
      // receipt waits for the gap invoice and records against it, or the
      // primary, next time.
      const { recheckPrimaryInvoiceWorthGap } = await import("@/lib/xero-primary-invoice-fee-gap");
      const recheck = await recheckPrimaryInvoiceWorthGap({
        bookingId,
        xeroInvoiceId: primaryInvoiceId,
        createdByMemberId: params.createdByMemberId,
      });
      if (recheck.queueOperationId) {
        throw waitFor(
          `The supplementary invoice for this booking's gap (operation ${recheck.queueOperationId}) was queued; this card payment is recorded once it is in Xero`,
        );
      }
      if (recheck.reviewOperationId && !chosen) {
        return refuse("gap-review-task", { reviewOperationId: recheck.reviewOperationId });
      }
    }
    if (!chosen) return refuse("nothing-due", { invoiceId, target, capturedCents, amountDueCents: read.amountDueCents });

    const zone = await readClubTimeZoneOutsideRequest();
    const date =
      (await providers.readStripeCaptureDocumentDate(paymentIntentId, zone)) ?? xeroDocumentDateForClubToday(zone);
    const plan: AdditionalCaptureReceiptPlan = { ...chosen, capturedCents, date };
    // Stored BEFORE the Xero call: a retry sends this, and never decides
    // again. Round 6 (1b): stored under the change's anchor lock - the lock a
    // supplementary invoice for the change is queued under, which reads this
    // stored decision there (`anchorCaptureHasReceipt`) - after reading who
    // records the capture again under it, so an invoice for the change and
    // this decision never both record it. Its own transaction, holding no
    // other key; no Xero call under it.
    const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
    const stored = await prisma.$transaction(async (tx) => {
      const changeId = captureChangeId(transaction);
      await lockSupplementaryInvoiceAnchor(tx, keptCaptureAnchorId(transaction, bookingId));
      // #4324: a kept capture is still kept, read under the lock the approval
      // withdraws an undecided receipt under, and closed there if not (C1).
      if (cancelled && !(await lateCaptureStillKept(tx, paymentIntentId))) {
        await closeKeptReceiptNotKept(tx, params.syncOperation, {});
        return "not-kept" as const;
      }
      const now = await readCaptureRecorder({ bookingId, primaryInvoiceId, paymentIntentId, bookingModificationId: changeId }, tx);
      if (now.kind !== "receipt") return now.kind;
      // Round 7: a capture no change can be read from decides under the
      // booking's key, which a supplementary enqueue on this booking takes
      // first; a paid invoice there naming no capture may be its recorder,
      // so nothing is guessed.
      if (!changeId && (await bookingHasPaidUnnamedSupplementary(tx, bookingId))) return "change-unknown" as const;
      const nowInvoiceId = now.target ? (now.target.link?.active ? now.target.link.xeroObjectId : null) : primaryInvoiceId;
      if (nowInvoiceId !== plan.invoiceId) return "target-moved" as const;
      await tx.xeroSyncOperation.update({
        where: { id: operationId },
        data: { requestPayload: sanitizeForJson({ ...(asRecord(row?.requestPayload) ?? {}), plan }) },
      });
      return "stored" as const;
    });
    if (stored === "change-unknown") return refuse("change-unknown");
    if (stored === "not-kept") return null;
    if (stored === "target-moved") {
      throw waitFor("The invoice this card payment belongs to changed while it was being decided; it is decided again on the next run");
    }
    if (stored !== "stored") return standDown("SUCCEEDED", `recorded-by-${stored}`, { decidedAgainUnderLock: true });
    return plan;
  }

  /** Another writer that now records this capture (`readCaptureRecorder`), or null where its receipt still does. */
  async function recorderNowElsewhere(): Promise<OtherRecorder | null> {
    const capture = await prisma.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      select: { bookingModificationId: true, reason: true, payment: { select: { xeroInvoiceId: true } } },
    });
    const primaryInvoiceId = capture?.payment.xeroInvoiceId;
    if (!primaryInvoiceId) return null;
    const recorder = await readCaptureRecorder({
      bookingId,
      primaryInvoiceId,
      paymentIntentId,
      bookingModificationId: captureChangeId(capture),
    });
    if (recorder.kind === "receipt") return null;
    return {
      kind: recorder.kind,
      operationId: "operationId" in recorder ? recorder.operationId : null,
      changeId: captureChangeId(capture),
    };
  }

  /** Rounds 6 and 9: this receipt's payment is in Xero and another invoice would record it too - set unpaid where unsent (`switchUnsentRecorderUnpaid`); an officer checks Xero either way. */
  async function settleOtherRecorder(other: OtherRecorder, invoiceId: string): Promise<void> {
    const switched =
      other.kind === "supplementary-invoice" &&
      other.operationId !== null &&
      (await switchUnsentRecorderUnpaid(other.operationId, { paymentIntentId, bookingModificationId: other.changeId }));
    await alertOfficer(
      paymentIntentId,
      operationId,
      switched
        ? `This card payment was recorded in Xero against invoice ${invoiceId} by its own receipt, and another supplementary invoice not yet sent (outbox operation ${other.operationId}) would have recorded it too; that invoice is now set to be raised unpaid. Check Xero shows the payment once when that invoice is raised.`
        : `This card payment was recorded in Xero against invoice ${invoiceId} by its own receipt, and another document now records it too (${other.kind}${other.operationId ? `, outbox operation ${other.operationId}` : ""}). Check Xero shows it once, and correct it by hand if not.`,
    );
  }

  async function sendPlannedPayment(plan: AdditionalCaptureReceiptPlan, fromStore: boolean): Promise<string | null> {
    if (fromStore) {
      // A retry: an earlier run may have recorded it and lost the reply, or
      // the invoice may have changed since. Never decided again. Its own
      // payment, found by reference, is linked FIRST (round 5, item 2): a
      // payment already in Xero is never refused as if it were not.
      const client = await providers.getAuthenticatedXeroClient();
      const read = await readInvoice(providers, client, plan.invoiceId);
      if (!read) return refuse("xero-unreadable", { plan });
      const otherRecorder = await recorderNowElsewhere();
      const recorded = findRecordedPayment(read, reference);
      if (recorded?.paymentID) {
        await finishRecorded({ paymentId: recorded.paymentID, plan, recoveredExisting: true });
        if (otherRecorder) await settleOtherRecorder(otherRecorder, plan.invoiceId);
        return recorded.paymentID;
      }
      // Round 4 (1b): a NEW payment is never sent past another document that
      // has since come to record the same capture - a repair-raised invoice
      // for the change that records it, say. Not a silent stand-down: an
      // officer checks.
      if (otherRecorder) return refuse("recorded-elsewhere", { plan, recorder: otherRecorder.kind, recorderOperationId: otherRecorder.operationId });
      // Review round 1 (I): the primary's room still leaves its applied credit room.
      const roomCents =
        plan.target === "PRIMARY_INVOICE"
          ? await primaryRoom(
              read,
              await prisma.payment.findUniqueOrThrow({
                where: { id: paymentId },
                select: { source: true, status: true, amountCents: true, refundedAmountCents: true, creditAppliedCents: true },
              }),
              plan.amountCents,
            )
          : amountDueOn(read);
      if (roomCents < plan.amountCents) {
        return refuse("figures-changed", { plan, amountDueCents: read.amountDueCents, roomCents });
      }
    }
    const paymentId_ = await providers.createXeroPaymentForInvoice({
      localModel: "PaymentTransaction",
      localId: paymentTransactionId,
      invoiceId: plan.invoiceId,
      amountCents: plan.amountCents,
      idempotencyKey: additionalCapturePaymentKey(paymentIntentId, plan.invoiceId),
      reference,
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      createdByMemberId: params.createdByMemberId,
      metadata: { invoiceId: plan.invoiceId, target: plan.target, amountCents: plan.amountCents, paymentIntentId },
      date: plan.date,
    });
    await finishRecorded({ paymentId: paymentId_, plan, recoveredExisting: false });
    return paymentId_;
  }

  async function finishRecorded(input: {
    paymentId: string;
    plan: AdditionalCaptureReceiptPlan;
    recoveredExisting: boolean;
  }): Promise<void> {
    const { plan } = input;
    const unrecordedCents = Math.max(0, plan.capturedCents - plan.amountCents);
    await completeXeroSyncOperation(params.syncOperation, {
      responsePayload: { paymentId: input.paymentId, plan, recoveredExisting: input.recoveredExisting, unrecordedCents },
      xeroObjectType: "PAYMENT",
      xeroObjectId: input.paymentId,
      xeroObjectUrl: buildXeroInvoiceUrl(plan.invoiceId),
      extraLinks: [
        {
          localModel: "PaymentTransaction",
          localId: paymentTransactionId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: input.paymentId,
          role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
          metadata: { invoiceId: plan.invoiceId, target: plan.target, amountCents: plan.amountCents, paymentIntentId },
        },
      ],
    });
    if (unrecordedCents > 0) {
      const format = await clubFormatValues();
      const message = `A card payment for a booking change was recorded in Xero for ${formatCents(plan.amountCents, format)} of the ${formatCents(plan.capturedCents, format)} captured: the invoice it was recorded against (${plan.invoiceId}) had no more due. The remaining ${formatCents(unrecordedCents, format)} is not on any Xero invoice.`;
      logger.error({ operationId, bookingId, paymentIntentId, plan, unrecordedCents }, message);
      await alertOfficer(paymentIntentId, operationId, message);
    }
    if (plan.target !== "PRIMARY_INVOICE") await flagRefundNotesNamingAnotherInvoice(plan.invoiceId);
    await answerKeptLateCaptureRefunds(paymentIntentId);
  }

  /**
   * Review round 1 (L): a Stripe refund of this capture taken before its
   * receipt reached Xero queued a refund note naming the booking's own invoice
   * (`findAdditionalCaptureReceiptInvoiceId` had nothing to name yet). The
   * note is unallocated, so the books balance either way, but it names the
   * wrong document; an officer is told, once, as this row completes.
   */
  async function flagRefundNotesNamingAnotherInvoice(receiptInvoiceId: string): Promise<void> {
    const firstRefund = await prisma.paymentRefund.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (!firstRefund) return;
    const notes = await prisma.xeroSyncOperation.findMany({
      where: {
        queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
        localModel: "Payment",
        localId: paymentId,
        status: { not: "CANCELLED" },
        createdAt: { gte: firstRefund.createdAt },
      },
      select: { id: true, requestPayload: true },
    });
    const naming = notes.filter((note) => asRecord(note.requestPayload)?.creditsInvoiceId !== receiptInvoiceId);
    if (naming.length === 0) return;
    await alertOfficer(
      paymentIntentId,
      operationId,
      `This card payment was refunded before its Xero receipt was recorded against supplementary invoice ${receiptInvoiceId}, and its refund credit note (outbox operation ${naming.map((note) => note.id).join(", ")}) names the booking's own invoice instead. The amounts balance; check the note's reference in Xero.`,
    );
  }
}
