import type { PaymentStatus } from "@prisma/client";

import { decideLateCapture, keptLateCaptureInvoiceAsked } from "@/lib/late-capture-kept-xero-rules";
import type {
  BlockingOperationMatch,
  BookingClassificationContext,
  BookingXeroRepairAction,
  MutableFinding,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";

/**
 * #3924 round 7 (money M2, `INV-PAY-121`; owner, 8 Oct 2026: "Record receipt,
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
  // FAILED before it reached Xero, or was never queued, leaves both undone.
  // Retried or queued automatically: the worker and the enqueue both re-read
  // the task and the close under the task's row lock before anything is sent.
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
  const failedUnsent =
    keptInvoice?.kind === "retryable" && keptInvoice.operation.status === "FAILED" ? keptInvoice : null;
  if (!failedUnsent && keptLateCaptureInvoiceAsked(lateTask.operations)) return false;
  const action = failedUnsent
    ? addAction(actionMap, buildRetryAction(booking.id, failedUnsent))
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
    summary: failedUnsent
      ? "A late card payment whose refund was paid another way has a Xero receipt that failed before reaching Xero; its bank-transfer refund note waits for it."
      : "A late card payment whose refund was paid another way has no Xero receipt queued; its bank-transfer refund note waits for it.",
    safeToAutoApply: true,
    details: {
      paymentId,
      manualRefundTaskId: lateTask.taskId,
      paymentIntentId: transaction.stripePaymentIntentId,
      ...(failedUnsent ? { operationId: failedUnsent.operation.id, operationStatus: "FAILED" } : {}),
    },
    actionKeys: [action.key],
  });
  return true;
}
