/**
 * A BOOKING CHANGE'S CARD CAPTURE IS RECORDED AGAINST THE XERO INVOICE THAT
 * BILLS IT (#3953, `INV-PAY-139`; owner decision and plan, 21 Oct 2026: "check,
 * then bill and pay").
 *
 * A change before the primary invoice exists queues no supplementary invoice:
 * the primary later bills the post-change price. A capture the primary's own
 * payment did not record gets a receipt row (`additional-capture-receipt-enqueue.ts`),
 * from late-success release or the invoice's link save. This worker records it
 * at capture time against the invoice that bills it:
 *
 *  - THE GAP INVOICE, where the capture's change is one the #3980 gap invoice
 *    bills for (`INV-PAY-136`): the primary bills the booking as it was before
 *    that change, and the gap invoice bills the change's extra.
 *  - OTHERWISE THE PRIMARY INVOICE, built from the post-change price. Its room
 *    is its AmountDue less the applied account credit its settle still
 *    allocates there (`primaryInvoiceStripeCashCents`), so that allocation
 *    always fits.
 *
 * One recorder per dollar (#4434): the capture's cents, less any part another
 * writer took, are recorded against each invoice in turn, capped at that
 * invoice's room. What none of them can take is told to an officer.
 *
 * ONE RECORDER PER CAPTURE (`additional-capture-recorder.ts`). The worker
 * stands down for the primary's own payment or a paying supplementary or gap
 * invoice that records this capture. One receipt plans per booking at a time,
 * waiting back to PENDING during a running invoice create. A gap invoice never
 * pays itself from a capture with a receipt row.
 *
 * NOTHING IS GUESSED. An unreadable invoice, nothing due, a gap invoice not
 * yet in Xero, an invoice's PARTIAL create still owing its own payment, or a
 * retry with insufficient room causes FAILED `ADDITIONAL_CAPTURE_RECEIPT_REFUSED`
 * and an officer alert. A gap invoice being sent causes a wait. If the primary
 * cannot take the capture and no gap exists, `recheckPrimaryInvoiceWorthGap`
 * raises one (never a second) and the receipt waits. Cancelled or internet-
 * banking bookings close unsent, save a treasurer-kept capture whose change
 * the primary bills (#4324, `INV-PAY-144`, `kept-late-capture-change-receipt.ts`).
 *
 * NEVER TWICE. One row per capture, queued under the per-anchor
 * supplementary-invoice lock; the payment link returns early; an earlier run's
 * payment counts only when the reference matches, the amount equals the
 * receipt, and it has no active credit-release payment link. The decision is
 * stored on the row BEFORE Xero is called, so a retry sends the same invoice,
 * amount, date and Xero key, or refuses - it never decides again.
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
import { asRecord } from "@/lib/xero-json";
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
  closeKeptReceiptNotKept,
  hasLateCaptureApprovalTask,
  keptCaptureAnchorId,
  keptReceiptStillKeptElseClosed,
  lateCaptureStillKept,
} from "@/lib/kept-late-capture-change-receipt";
import { amountDueOn, ownPaymentPending, type InvoiceRead } from "@/lib/additional-capture-receipt-invoice-read";
import { completeRecordedReceipt, findReceiptLegPayment, sendAdditionalCaptureReceiptLegs } from "@/lib/additional-capture-receipt-send";
import {
  buildStoredReceiptPlan,
  everyPlannedLegLinked,
  fillAdditionalCaptureReceiptLegs,
  invoiceIdsForReceiptTargets,
  sameInvoiceIds,
} from "@/lib/additional-capture-receipt-legs";
import {
  readAdditionalCaptureReceiptPayload,
  type AdditionalCaptureReceiptPlan,
  type AdditionalCaptureReceiptTarget,
} from "@/lib/additional-capture-receipt-payload";
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

/** The Xero payment's key: the capture and the invoice it is recorded against. One key per leg. */
export function additionalCapturePaymentKey(paymentIntentId: string, invoiceId: string): string {
  return buildXeroIdempotencyKey("payment-intent", paymentIntentId, "additional-capture-payment", invoiceId, "v1");
}

export { chooseAdditionalCaptureReceiptTarget } from "@/lib/additional-capture-receipt-legs";

/** The reference the payment is recorded under, as every Stripe payment the app records is. */
export function additionalCapturePaymentReference(paymentIntentId: string): string {
  return `Stripe ${paymentIntentId}`;
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
    "the invoice no longer has the amount this payment was sized at, and Xero shows no payment of this amount that is not already the credit-release payment. Record it by hand in Xero, then mark this operation resolved",
  "naming-unreadable":
    "a Xero invoice that names this card payment is set to record part of it, but what that invoice bills could not be read, so nothing was guessed. Check that invoice, record the payment by hand, then mark this operation resolved",
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
    const recordedNote = typeof details.recordedNote === "string" && details.recordedNote ? ` ${details.recordedNote}` : "";
    const message = `The card payment for this booking change was not recorded in Xero: ${REFUSAL_TEXT[reason]}.${recordedNote}`;
    logger.error({ operationId, bookingId, paymentIntentId, reason, ...details }, message);
    const failed = await failXeroSyncOperation(params.syncOperation, new Error(message), { refused: reason, ...details }, {
      lastErrorMessage: message,
    });
    // #4673 (PR #4687 review): the row is no longer this run's (`INV-INT-029`): the
    // run that holds it decides, so no refusal stamp and no officer alert from here.
    if (failed === null) return null;
    await prisma.xeroSyncOperation.updateMany({
      where: { id: operationId, status: "FAILED", startedAt: params.syncOperation.startedAt },
      data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE },
    });
    await alertOfficer(paymentIntentId, operationId, message);
    return null;
  };
  /** Finished with nothing to send: another writer records it, or it is not this app's to record. */
  const standDown = async (status: "SUCCEEDED" | "CANCELLED", skipped: string, details: Record<string, unknown> = {}) => {
    await completeXeroSyncOperation(params.syncOperation, { status, responsePayload: { skipped, ...details } });
    // A CANCELLED completion keeps its code: the planning stamp is not an error.
    // #4707 (`INV-INT-029`): cleared only on the end this claim just wrote - never on a
    // newer claim's row (a retry after a stale reset), whose own planning stamp stays.
    await prisma.xeroSyncOperation.updateMany({
      where: { id: operationId, status, startedAt: params.syncOperation.startedAt, lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
      data: { lastErrorCode: null },
    });
    return null;
  };

  // One leg, or a row that has not planned yet: any link is the whole receipt,
  // read as before. Several legs are done only when every one of them is
  // linked, so a retry after the first payment still sends the rest (#4434).
  const plannedLegs = queued.plan?.legs;
  const severalLegs = Boolean(plannedLegs && plannedLegs.length > 1);
  const linkWhere = {
    localModel: "PaymentTransaction" as const,
    localId: paymentTransactionId,
    xeroObjectType: "PAYMENT" as const,
    role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
    active: true,
  };
  const existingLinks = severalLegs
    ? await prisma.xeroObjectLink.findMany({
        where: linkWhere,
        orderBy: { createdAt: "asc" },
        select: { xeroObjectId: true, metadata: true },
      })
    : await prisma.xeroObjectLink
        .findFirst({ where: linkWhere, select: { xeroObjectId: true, metadata: true } })
        .then((link) => (link ? [link] : []));
  const alreadyDone =
    existingLinks.length > 0 &&
    (!plannedLegs || plannedLegs.length <= 1 || everyPlannedLegLinked(plannedLegs, existingLinks));
  if (alreadyDone) {
    const linkedId = existingLinks[0]?.xeroObjectId;
    if (!linkedId) return null;
    await completeXeroSyncOperation(params.syncOperation, {
      responsePayload: { alreadyRecorded: true, paymentId: linkedId, paymentIds: existingLinks.map((link) => link.xeroObjectId) },
      xeroObjectType: "PAYMENT",
      xeroObjectId: linkedId,
    });
    return linkedId;
  }

  try {
    await passPlanningGate(operationId, bookingId);
    const plan = queued.plan ?? (await planReceipt());
    // No plan: the row is already finished - skipped, recorded, or refused.
    if (!plan) return null;
    return await sendAdditionalCaptureReceiptLegs({
      plan,
      fromStore: Boolean(queued.plan),
      providers,
      existingLinks,
      reference,
      paymentIntentId,
      paymentTransactionId,
      paymentId,
      bookingId,
      operationId,
      createdByMemberId: params.createdByMemberId,
      syncOperation: params.syncOperation,
      paymentKey: (invoiceId) => additionalCapturePaymentKey(paymentIntentId, invoiceId),
      readInvoice: (client, invoiceId) => readInvoice(providers, client, invoiceId),
      primaryRoom,
      refuse,
      recorderNowElsewhere,
      settleOtherRecorder,
      alertOfficer,
    });
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
    if (recorder.namingUnreadable) return refuse("naming-unreadable");
    const { gap, targets, alreadyRecordedCents } = recorder;
    // Only the part no other writer recorded. #4434: what is left is split
    // across the target invoices, each capped at its own room.
    const capturedCents = transaction.amountCents - alreadyRecordedCents;
    const waiting = targets.find(
      (target) => target.kind !== "PRIMARY_INVOICE" && target.operation && OUTSTANDING_STATUSES.has(target.operation.status),
    );
    if (waiting && waiting.kind !== "PRIMARY_INVOICE" && waiting.operation) {
      throw waitFor(
        `The supplementary invoice for this booking's change (operation ${waiting.operation.id}) is still on its way to Xero; this card payment is recorded once it is there`,
      );
    }
    const candidates: Array<{ target: AdditionalCaptureReceiptTarget; invoiceId: string }> = [];
    for (const target of targets) {
      if (target.kind === "PRIMARY_INVOICE") {
        candidates.push({ target: "PRIMARY_INVOICE", invoiceId: primaryInvoiceId });
        continue;
      }
      const invoiceId = target.link?.active ? target.link.xeroObjectId : null;
      if (!invoiceId) {
        if (candidates.length === 0) return refuse("gap-invoice-not-in-xero", { supplementaryOperationId: target.operation?.id ?? null });
        continue;
      }
      if (ownPaymentPending(target.operation)) return refuse("own-payment-pending", { supplementaryOperationId: target.operation?.id });
      candidates.push({ target: target.kind, invoiceId });
    }
    if (candidates.length === 0) return refuse("gap-invoice-not-in-xero");

    const client = await providers.getAuthenticatedXeroClient();
    const reads = new Map<string, InvoiceRead>();
    for (const candidate of candidates) {
      if (reads.has(candidate.invoiceId)) continue;
      const read = await readInvoice(providers, client, candidate.invoiceId);
      if (!read) return refuse("xero-unreadable", { invoiceId: candidate.invoiceId });
      reads.set(candidate.invoiceId, read);
    }
    // A lost response of the whole amount: the link is missing, the invoice
    // may now show nothing due, and the payment is still this receipt's.
    for (const candidate of candidates) {
      const owned = await findReceiptLegPayment(reads.get(candidate.invoiceId) ?? null, reference, capturedCents);
      if (!owned?.paymentID) continue;
      await completeRecordedReceipt(
        {
          plan: buildStoredReceiptPlan({
            legs: [{ target: candidate.target, invoiceId: candidate.invoiceId, amountCents: capturedCents }],
            capturedCents,
            date: String(owned.date ?? ""),
            targetInvoiceIds: [candidate.invoiceId],
          }),
          paymentTransactionId,
          paymentIntentId,
          paymentId,
          bookingId,
          operationId,
          syncOperation: params.syncOperation,
          alertOfficer,
        },
        { paymentIds: [owned.paymentID], recoveredExisting: true },
      );
      return null;
    }

    const withRoom = [];
    for (const candidate of candidates) {
      const read = reads.get(candidate.invoiceId);
      if (!read) return refuse("xero-unreadable", { invoiceId: candidate.invoiceId });
      const roomCents =
        candidate.target === "PRIMARY_INVOICE" ? await primaryRoom(read, payment, capturedCents) : amountDueOn(read);
      withRoom.push({ ...candidate, roomCents });
    }
    const legs = fillAdditionalCaptureReceiptLegs(capturedCents, withRoom);
    const recordedSoFar = legs.reduce((total, leg) => total + leg.amountCents, 0);
    const first = withRoom[0];
    // #4324: never on a cancelled booking - nothing new is billed there.
    // Only the first leg may raise a gap. A remainder on the primary never does:
    // the primary's figures at link time do not bill a later change.
    if (!cancelled && !gap && first?.target === "PRIMARY_INVOICE" && recordedSoFar < capturedCents) {
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
      if (recheck.reviewOperationId && legs.length === 0) {
        return refuse("gap-review-task", { reviewOperationId: recheck.reviewOperationId });
      }
    }
    if (legs.length === 0) {
      return refuse("nothing-due", { invoiceId: first?.invoiceId ?? primaryInvoiceId, target: first?.target ?? "PRIMARY_INVOICE", capturedCents });
    }
    if (legs.some((leg) => leg.target === "PRIMARY_INVOICE")) {
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

    const zone = await readClubTimeZoneOutsideRequest();
    const date =
      (await providers.readStripeCaptureDocumentDate(paymentIntentId, zone)) ?? xeroDocumentDateForClubToday(zone);
    const plan = buildStoredReceiptPlan({
      legs,
      capturedCents,
      date,
      targetInvoiceIds: invoiceIdsForReceiptTargets(targets, primaryInvoiceId),
    });
    // Stored BEFORE the Xero call, under the same anchor lock, after the
    // ordered target list is read again. No new key. A lost claim sends nothing.
    const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
    const stored = await prisma.$transaction(async (tx) => {
      const changeId = captureChangeId(transaction);
      await lockSupplementaryInvoiceAnchor(tx, keptCaptureAnchorId(transaction, bookingId));
      if (cancelled && !(await lateCaptureStillKept(tx, paymentIntentId))) {
        await closeKeptReceiptNotKept(tx, params.syncOperation, {});
        return "not-kept" as const;
      }
      const now = await readCaptureRecorder({ bookingId, primaryInvoiceId, paymentIntentId, bookingModificationId: changeId }, tx);
      if (now.kind !== "receipt") return now.kind;
      if (now.namingUnreadable) return "naming-unreadable" as const;
      if (!changeId && (await bookingHasPaidUnnamedSupplementary(tx, bookingId))) return "change-unknown" as const;
      const nowIds = invoiceIdsForReceiptTargets(now.targets, primaryInvoiceId);
      if (!plan.targetInvoiceIds || !sameInvoiceIds(nowIds, plan.targetInvoiceIds)) return "target-moved" as const;
      const written = await tx.xeroSyncOperation.updateMany({
        where: { id: operationId, status: "RUNNING", lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
        data: { requestPayload: sanitizeForJson({ ...(asRecord(row?.requestPayload) ?? {}), plan }) },
      });
      return written.count === 1 ? ("stored" as const) : ("lost-claim" as const);
    });
    if (stored === "change-unknown" || stored === "naming-unreadable") return refuse(stored);
    if (stored === "not-kept") return null;
    if (stored === "target-moved" || stored === "lost-claim") {
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
}
