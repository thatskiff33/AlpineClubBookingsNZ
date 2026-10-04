import { isCreditOnlyCardPayment } from "@/lib/credit-only-card-payment";
import {
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  MutableFinding,
} from "./xero-booking-repair-types";
import { getBlockingOperation, isStuckOperation } from "./xero-booking-repair-object-resolution";
import { addAction, addFinding, addResolvedInXeroFinding, buildRetryAction } from "./xero-booking-repair-findings";

/**
 * #3836 (M2): Xero REFUSED this operation (a 4xx other than 408 or 429: the
 * invoice voided, or settled by hand). Re-running it changes nothing until someone fixes the cause in
 * Xero, so its retry is offered but never auto-applied.
 */
function refusedByXero(operation: { status: string; lastErrorCode: string | null }): boolean {
  const code = operation.lastErrorCode ?? "";
  // 408 (timeout) and 429 (rate limit) are transient, not refusals: still auto-retried.
  return ["FAILED", "PARTIAL"].includes(operation.status) && /^4\d\d$/.test(code) && code !== "408" && code !== "429";
}

/** A retry action, auto-applied only where Xero did not refuse the operation. */
function retryUnlessRefused(bookingId: string, match: Parameters<typeof buildRetryAction>[1]) {
  const action = buildRetryAction(bookingId, match);
  return refusedByXero(match.operation) ? { ...action, safeToAutoApply: false } : action;
}

/**
 * #3836 (`INV-PAY-024`): a booking paid entirely by account credit on the card
 * path, invoiced at full price before #3836 with its applied credit never
 * allocated, so Xero shows the invoice outstanding. Queues the one allocation
 * engine (`allocateAppliedCreditForBooking`), which allocates only what the
 * ledger still holds unallocated and stamps it, so a re-run finds nothing.
 *
 * Not on a cancelled booking: the cancelled-open-invoice arm
 * (`CANCELLED_BOOKING_OPEN_INVOICE`) clears that invoice with a note, and an
 * allocation beside it would over-credit. While the booking's invoice
 * operation is unfinished its own replay allocates, so that operation is
 * retried rather than a second engine run queued beside it.
 */
export function addUnallocatedCardAppliedCreditFindings(
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>,
  context: BookingClassificationContext,
): void {
  const { booking } = context;
  const payment = booking.payment;
  if (
    !payment?.xeroInvoiceId ||
    booking.status === "CANCELLED" ||
    !isCreditOnlyCardPayment(payment) ||
    context.unallocatedAppliedCreditCents <= 0
  ) {
    return;
  }
  const details = {
    paymentId: payment.id,
    xeroInvoiceId: payment.xeroInvoiceId,
    unallocatedAppliedCreditCents: context.unallocatedAppliedCreditCents,
  };
  const blocking =
    getBlockingOperation(context.paymentOperations, "INVOICE", "CREATE", {
      payloadQueueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
    }) ??
    getBlockingOperation(context.paymentOperations, "ALLOCATION", "ALLOCATE", {
      payloadQueueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
    });
  if (blocking?.kind === "resolved") {
    addResolvedInXeroFinding(findings, blocking.resolvedOperation, "applied-credit allocation", details);
    return;
  }
  if (blocking?.kind === "retryable") {
    const action = addAction(actionMap, retryUnlessRefused(booking.id, blocking));
    addFinding(findings, {
      code: "BLOCKED_BY_XERO_OPERATION",
      severity: "warning",
      summary: action.safeToAutoApply
        ? "A failed or partial Xero operation is blocking the allocation of a credit-paid booking's applied credit."
        : "Xero refused the allocation of a credit-paid booking's applied credit (the invoice may be voided or settled by hand); fix the cause in Xero before retrying it.",
      safeToAutoApply: action.safeToAutoApply,
      details: { ...details, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
      actionKeys: [action.key],
    });
    return;
  }
  if (blocking) {
    addFinding(findings, {
      code: "BLOCKED_BY_XERO_OPERATION",
      severity: "warning",
      summary: ["FAILED", "PARTIAL"].includes(blocking.operation.status)
        ? "A failed Xero operation for a credit-paid booking's applied credit cannot be auto-retried - resolve it by hand."
        : isStuckOperation(blocking.operation)
          ? "A pending or running Xero operation for a credit-paid booking's applied credit looks stuck."
          : "A Xero operation for a credit-paid booking's applied credit is already pending or running.",
      safeToAutoApply: false,
      details: { ...details, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
      actionKeys: [],
    });
    return;
  }
  const action = addAction(actionMap, {
    key: `queue:applied-credit-allocation:${booking.id}`,
    bookingId: booking.id,
    type: "QUEUE_APPLIED_CREDIT_ALLOCATION",
    description: "Queue the allocation of the member's applied credit against the booking's Xero invoice.",
    safeToAutoApply: true,
    payload: { bookingId: booking.id },
  });
  addFinding(findings, {
    code: "UNALLOCATED_APPLIED_CREDIT",
    severity: "critical",
    summary: "The booking was paid with account credit, but the credit is not allocated against its Xero invoice, so Xero shows it owing.",
    safeToAutoApply: true,
    details,
    actionKeys: [action.key],
  });
}

/**
 * #3836 (H1): the cancelled-open-invoice arm sizes its clearing note net of the
 * allocations already committed. While the booking's invoice operation or an
 * applied-credit allocation operation is unfinished, that figure can still
 * move - the engine finishes committed slices on a cancelled booking - so the
 * arm waits: it offers that operation's retry, or reports the wait, and queues
 * no clearing note beside it. A failed or partial row that cannot be retried
 * will not run again, so it is not waited for. Returns whether it is waiting.
 */
export function waitForAppliedCreditWorkBeforeClearing(
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>,
  context: BookingClassificationContext,
): boolean {
  const blocking = [
    getBlockingOperation(context.paymentOperations, "INVOICE", "CREATE", { payloadQueueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE }),
    getBlockingOperation(context.paymentOperations, "ALLOCATION", "ALLOCATE", { payloadQueueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE }),
  ].find((match) => match !== null && match.kind !== "resolved");
  if (!blocking) return false;
  // A failed or partial row nothing can retry will never run again: not waited for.
  if (blocking.kind === "blocked" && ["FAILED", "PARTIAL"].includes(blocking.operation.status)) return false;
  const retry = blocking.kind === "retryable" ? addAction(actionMap, retryUnlessRefused(context.booking.id, blocking)) : null;
  addFinding(findings, {
    code: "BLOCKED_BY_XERO_OPERATION",
    severity: "warning",
    summary:
      "A cancelled booking's invoice-clearing note waits for its unfinished invoice or applied-credit allocation operation, which may still finish allocations the note must not repeat.",
    safeToAutoApply: retry?.safeToAutoApply ?? false,
    details: { operationId: blocking.operation.id, operationStatus: blocking.operation.status },
    actionKeys: retry ? [retry.key] : [],
  });
  return true;
}
