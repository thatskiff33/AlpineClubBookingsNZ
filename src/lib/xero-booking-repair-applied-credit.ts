import type { Prisma } from "@prisma/client";

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
 * #3836: each booking's applied credit with no Xero note stamped - the
 * engine's own unallocated predicate (`unallocatedAppliedCents`).
 */
export async function loadUnallocatedAppliedCreditCents(
  db: { memberCredit: Pick<Prisma.TransactionClient["memberCredit"], "groupBy"> },
  bookingIds: string[],
): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.memberCredit.groupBy({
    by: ["appliedToBookingId"],
    where: { appliedToBookingId: { in: bookingIds }, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
    _sum: { amountCents: true },
  });
  return new Map(
    rows.flatMap((row) => (row.appliedToBookingId ? [[row.appliedToBookingId, Math.max(0, -(row._sum.amountCents ?? 0))] as const] : [])),
  );
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
    const action = addAction(actionMap, buildRetryAction(booking.id, blocking));
    addFinding(findings, {
      code: "BLOCKED_BY_XERO_OPERATION",
      severity: "warning",
      summary: "A failed or partial Xero operation is blocking the allocation of a credit-paid booking's applied credit.",
      safeToAutoApply: true,
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
