// The payloads a Xero outbox row is put back in the queue with on Retry, and the
// row shape they read. Moved out of `xero-operation-retry.ts` unchanged (#4926,
// the hard ceiling on a file's length): each helper is a pure function of the
// operation row it is given, so nothing here reads or writes the database.
import type { XeroSyncOperation } from "@prisma/client";
import { XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE } from "@/lib/xero-card-refund-reversal-outbox";
import {
  readQueuedOutboxPayload,
  readQueueType,
  subscriptionInvoiceChargeId,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { asArray, asRecord } from "@/lib/xero-json";

export type RetryableOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "status"
  | "replayable"
  | "direction"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "requestPayload"
  | "responsePayload"
  | "xeroObjectId"
  | "xeroObjectNumber"
  // #3635: REQUIRED, so a caller whose select forgot it fails to compile
  // instead of silently offering a resolved row for retry.
  | "manuallyResolvedAt"
> & {
  // #1354: enqueue-time queue type (never updated afterward) — the only
  // reliable delta-mode marker once a handler has overwritten requestPayload.
  // Optional so row shapes selected before #1354 stay assignable; callers
  // that omit it simply fall back to payload-based delta detection.
  queueType?: XeroSyncOperation["queueType"];
  lastErrorCode?: XeroSyncOperation["lastErrorCode"]; // #4688: optional; Retry's own refusal reads the stored row
  lastErrorMessage?: XeroSyncOperation["lastErrorMessage"]; // #3993: a paid-off allocation or a shortfall before create
};

/**
 * #3642: the combined group invoice's outbox rows (its CREATE and both VOIDs)
 * go back to the outbox on Retry; they are never run inline, because their
 * handlers fence on `lock(1)` and the outbox claim is the one execution
 * authority. Returns the payload to queue them with, or null for any other
 * row. The CREATE's is rebuilt from the row itself — its worker overwrote the
 * queued payload with the invoice it sent — and its attempt lives in the
 * correlation key, which Retry leaves alone. A VOID keeps its queued payload.
 */
export function groupSettlementInvoiceRequeuePayload(
  operation: RetryableOperation,
): Record<string, unknown> | null {
  if (
    operation.direction !== "OUTBOUND" ||
    operation.entityType !== "INVOICE" ||
    operation.localModel !== "GroupBookingSettlement" ||
    !operation.localId
  ) {
    return null;
  }
  if (
    operation.operationType === "CREATE" &&
    operation.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE
  ) {
    return {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
      settlementId: operation.localId,
    };
  }
  const queued = readQueuedOutboxPayload(operation.requestPayload);
  if (
    operation.operationType === "UPDATE" &&
    queued?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE
  ) {
    return { ...queued };
  }
  return null;
}

/**
 * #3635: a kept late capture's invoice is replayed from its queued payload,
 * which its worker keeps: back to PENDING, where the worker re-uses an invoice
 * already raised (the task's link) and records only a missing payment. FAILED
 * or PARTIAL (the payment failed); null for any other row.
 */
/**
 * #4369 (`INV-PAY-151`): a failed card refund's Stripe reversal is replayed
 * from its queued payload, back to PENDING. The worker re-uses an invoice
 * already raised and records only a missing payment. A voided invoice is
 * completed and not raised again. FAILED or PARTIAL; null for any other row.
 * This must run before the generic invoice repair, which would send it as a
 * booking invoice. The invoice it sent is kept: a replay's export manifest
 * (#4525, M13) reads those lines, never rebuilt ones, and a send overwrites them.
 */
export function cardRefundReversalInvoiceRequeuePayload(
  operation: RetryableOperation,
): Record<string, unknown> | null {
  if (
    operation.direction !== "OUTBOUND" ||
    operation.entityType !== "INVOICE" ||
    operation.operationType !== "CREATE" ||
    operation.localModel !== "Payment"
  ) {
    return null;
  }
  const queued = readQueuedOutboxPayload(operation.requestPayload);
  const sent = asArray(asRecord(operation.requestPayload)?.invoices);
  return queued?.queueType === XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE
    ? {
        queueType: queued.queueType,
        bookingId: queued.bookingId,
        paymentId: queued.paymentId,
        closeTaskId: queued.closeTaskId,
        amountCents: queued.amountCents,
        closedOn: queued.closedOn,
        ...(sent.length > 0 ? { invoices: sent } : {}),
      }
    : null;
}

export function keptLateCaptureInvoiceRequeuePayload(
  operation: RetryableOperation,
): Record<string, unknown> | null {
  if (
    operation.direction !== "OUTBOUND" ||
    operation.entityType !== "INVOICE" ||
    operation.operationType !== "CREATE" ||
    operation.localModel !== "ManualRefundTask"
  ) {
    return null;
  }
  const queued = readQueuedOutboxPayload(operation.requestPayload);
  return queued?.queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE
    ? {
        queueType: queued.queueType,
        bookingId: queued.bookingId,
        manualRefundTaskId: queued.manualRefundTaskId,
        paymentIntentId: queued.paymentIntentId,
        capturedCents: queued.capturedCents,
        capturedOn: queued.capturedOn,
      }
    : null;
}

/**
 * #3924 round 9 (`INV-PAY-122`; owner, 8 Oct 2026: "Raise a refund note for
 * all"): a FAILED change invoice RELEASED FOR A LATE CAPTURE - its queued
 * payload names the capture (`paymentIntentId`) - goes back to the outbox on
 * its own row, with the payload it was queued with, never through the inline
 * replay. The inline replay mints a new row that does not name the capture, so
 * the capture's receipt (`readLateCaptureXeroReceipt`) never sees the invoice,
 * and the worker's note step, which reads the capture off its own row, never
 * queues the bank-transfer note a "Paid another way" close waits for. Run from
 * this row, the worker sends under the same Xero idempotency key, records the
 * invoice on this row, and queues that note. A second ask is left to its own
 * branch.
 *
 * Round 10: only for an approval task's capture, and never one already
 * linked in Xero (`late-capture-change-invoice-retry.ts`).
 */
export function releasedLateCaptureChangeInvoiceRequeuePayload(
  operation: RetryableOperation,
): Record<string, unknown> | null {
  if (
    operation.status !== "FAILED" ||
    operation.direction !== "OUTBOUND" ||
    operation.entityType !== "INVOICE" ||
    operation.operationType !== "CREATE" ||
    operation.localModel !== "BookingModification"
  ) {
    return null;
  }
  const queued = readQueuedOutboxPayload(operation.requestPayload);
  if (
    queued?.queueType !== XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE ||
    !queued.paymentIntentId ||
    queued.shortfallReviewTaskId
  ) {
    return null;
  }
  // The whole stored payload: the charge day it already read
  // (`keptLateCaptureDay`) rides with it, so the retry's document date never drifts.
  return asRecord(operation.requestPayload);
}

/**
 * #3971 (`INV-INT-026`): a FAILED membership subscription invoice goes back to
 * the outbox as its bare queue type - the charge is `localId`, and a pre-fix
 * row holds a blanked `chargeId`. It keeps its correlation key, so the
 * active-key index refuses it while another attempt for the charge is live.
 */
export function subscriptionInvoiceRequeuePayload(operation: RetryableOperation) {
  const queueType = operation.queueType ?? readQueueType(operation.requestPayload);
  return operation.direction === "OUTBOUND" && operation.entityType === "INVOICE" &&
    operation.operationType === "CREATE" && subscriptionInvoiceChargeId(operation) &&
    queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE
    ? { queueType }
    : null;
}
