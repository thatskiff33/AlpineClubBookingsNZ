import type { PaymentStatus } from "@prisma/client";

import {
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
  keptReceiptMayHaveReachedXero,
} from "@/lib/late-capture-kept-xero-rules";
import type {
  BlockingOperationMatch,
  BookingClassificationContext,
  BookingXeroRepairAction,
  MutableFinding,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";

/**
 * #3924 round 7 (money M2, `INV-PAY-122`; owner, 8 Oct 2026: "Record receipt,
 * then credit"): THE REPAIR TOOL'S HALF OF A LATE CAPTURE'S REFUND PAID ANOTHER
 * WAY. Adds the finding and its action, and says whether it did, so the caller
 * looks no further at this capture.
 */
export function addPaidAnotherWayReceiptFinding({
  findings,
  actionMap,
  booking,
  paymentId,
  transaction,
  lateTask,
  keptInvoice,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  booking: { id: string; status: string };
  paymentId: string;
  transaction: { stripePaymentIntentId: string | null; status: PaymentStatus; amountCents: number };
  lateTask: BookingClassificationContext["lateCaptureTasks"] extends Map<string, infer Task> ? Task : never;
  keptInvoice: BlockingOperationMatch | null;
}): boolean {
  // An APPROVED capture whose card refund was closed as paid another way, with
  // its note waiting for the receipt. The charge is still in the Stripe account
  // and the close's bank-transfer note follows the receipt, so a receipt that
  // failed, or was never queued, leaves both undone. Retried or queued
  // automatically only where that cannot raise a second receipt: the worker
  // and the enqueue both re-read the task and the close under the task's row
  // lock before anything is sent.
  const close = lateTask.status === "COMPLETED" ? lateTask.paidAnotherWayClose : undefined;
  if (close?.xeroRefundNote !== "after-receipt") return false;
  const receiptCents = decideLateCapture({
    taskStatus: "COMPLETED",
    bookingStatus: booking.status,
    superseded: false,
    capture: transaction,
    refundClosedPaidAnotherWay: true,
  }).recordCents;
  if (receiptCents <= 0) return false;
  const state = close.receiptState;
  if (!state) return false;
  const details = {
    paymentId,
    manualRefundTaskId: lateTask.taskId,
    paymentIntentId: transaction.stripePaymentIntentId,
  };
  const failed =
    keptInvoice?.kind === "retryable" && keptInvoice.operation.status === "FAILED" ? keptInvoice : null;

  // Round 8 (money review, wording by the invoice link): the receipt's invoice
  // is in Xero and linked, and its row failed after that - the note step, most
  // likely. Its retry sends nothing again: it finishes the row and queues the
  // note.
  if (failed && state.invoiceLinked) {
    const action = addAction(actionMap, buildRetryAction(booking.id, failed));
    addFinding(findings, {
      code: "PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT",
      severity: "critical",
      summary:
        "A late card payment whose refund was paid another way has its Xero receipt in Xero, but the receipt's operation failed after it was recorded; retrying it finishes the operation and queues the bank-transfer refund note.",
      safeToAutoApply: action.safeToAutoApply,
      details: { ...details, operationId: failed.operation.id, operationStatus: "FAILED", receiptInXero: true },
      actionKeys: [action.key],
    });
    return true;
  }

  // Round 8 (owner, 8 Oct 2026: "Raise a refund note for all"): the receipt is
  // in Xero - a change's invoice sent after the close, whose own note step
  // failed - and the close's note was never asked for. The one note step
  // queues it.
  if (state.receipt.kind === "recorded" && state.receipt.invoiceId !== null) {
    if (state.noteAsked) return false;
    const action = addAction(actionMap, {
      key: `queue:paid-another-way-refund-note:${lateTask.taskId}`,
      bookingId: booking.id,
      type: "QUEUE_PAID_ANOTHER_WAY_REFUND_NOTE",
      description:
        "Queue the bank-transfer Xero refund note of a late card payment's refund paid another way, against its receipt now in Xero.",
      safeToAutoApply: true,
      payload: { paymentIntentId: transaction.stripePaymentIntentId },
    });
    addFinding(findings, {
      code: "PAID_ANOTHER_WAY_REFUND_NOTE_NOT_QUEUED",
      severity: "critical",
      summary:
        "A late card payment whose refund was paid another way has its Xero receipt in Xero, but the bank-transfer refund note that waits for it was never queued.",
      safeToAutoApply: true,
      details: { ...details, receiptInvoiceId: state.receipt.invoiceId },
      actionKeys: [action.key],
    });
    return true;
  }
  // On its way to Xero (a change's invoice queued, sending or failed, which is
  // its own operation to retry): the note follows it, and no second receipt
  // is queued beside it. Resolved by hand: the officer records the refund too.
  if (state.receipt.kind === "recorded") return true;
  if (state.receipt.kind === "resolved-by-hand") return false;

  if (!failed && keptLateCaptureInvoiceAsked(lateTask.operations)) return false;
  // Round 8 (money review): a FAILED receipt row that may have reached Xero -
  // its Stripe payment linked, or `createInvoices` attempted - is never retried
  // automatically, or Xero could hold two receipts. An officer checks Xero first.
  const mayHaveReachedXero =
    failed !== null &&
    keptReceiptMayHaveReachedXero({ requestPayload: failed.operation.requestPayload, paymentLinked: state.paymentLinked });
  const action = failed
    ? addAction(
        actionMap,
        mayHaveReachedXero
          ? { ...buildRetryAction(booking.id, failed), safeToAutoApply: false }
          : buildRetryAction(booking.id, failed),
      )
    : addAction(actionMap, {
        key: `queue:kept-late-capture-invoice:${lateTask.taskId}`,
        bookingId: booking.id,
        type: "QUEUE_KEPT_LATE_CAPTURE_INVOICE",
        description:
          "Queue the Xero receipt, paid from the Stripe account on the capture day, of a late card payment whose refund was paid another way; the refund note follows it.",
        safeToAutoApply: true,
        payload: {
          manualRefundTaskId: lateTask.taskId,
          bookingId: booking.id,
          paymentIntentId: transaction.stripePaymentIntentId,
          capturedCents: receiptCents,
          capturedAt: close.raisedAt.toISOString(),
        },
      });
  addFinding(findings, {
    code: "PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT",
    severity: "critical",
    summary: !failed
      ? "A late card payment whose refund was paid another way has no Xero receipt queued; its bank-transfer refund note waits for it."
      : mayHaveReachedXero
        ? "A late card payment whose refund was paid another way has a Xero receipt that failed after it may have reached Xero. Check Xero for the receipt before retrying it; its bank-transfer refund note waits for it."
        : "A late card payment whose refund was paid another way has a Xero receipt that failed before reaching Xero; its bank-transfer refund note waits for it.",
    safeToAutoApply: action.safeToAutoApply,
    details: {
      ...details,
      ...(failed ? { operationId: failed.operation.id, operationStatus: "FAILED" } : {}),
    },
    actionKeys: [action.key],
  });
  return true;
}
