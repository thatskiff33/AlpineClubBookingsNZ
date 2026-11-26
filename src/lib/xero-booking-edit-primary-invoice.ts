import logger from "@/lib/logger";
import { isXeroInvoicingEnabled } from "@/lib/xero-invoicing-guard";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/** Runs the outbox now for an operation just queued; every Xero leg of an edit kicks through here. */
export async function kickQueuedXeroOperation(queued: { queueOperationId: string | null }) {
  if (queued.queueOperationId) {
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
  }
}

/**
 * The edit's primary booking invoice, and for an Internet Banking increase
 * (#5288) the applied-credit allocation after it - queued second, so the
 * older invoice operation runs first, as the switch to Internet Banking queues
 * them (`queueSwitchInvoiceAfterCommit`). Both enqueues refuse a linked,
 * queued, resolved-by-hand or externally settled invoice, so a replay queues
 * nothing new. Nothing is queued while the Xero module is off: the outbox
 * skips its work then, and it would go out unchecked the day Xero came back
 * (`INV-INT-040`), as booking-create's own $0 invoice is gated.
 */
export async function queueEditPrimaryInvoice(
  input: { bookingId: string; bookingModificationId: string; createdByMemberId?: string },
  allocateAppliedCredit: boolean,
) {
  if (!(await isXeroInvoicingEnabled())) {
    logger.info(
      { bookingId: input.bookingId, bookingModificationId: input.bookingModificationId },
      "Xero is off, so no primary invoice is queued for this booking edit",
    );
    return;
  }
  const queued = await enqueueXeroBookingInvoiceOperation(input.bookingId, {
    createdByMemberId: input.createdByMemberId,
    invoiceEmailDelivery: null,
  });
  await kickQueuedXeroOperation(queued);
  if (!allocateAppliedCredit) return;
  const allocation = await enqueueXeroAppliedCreditAllocationOperation(input.bookingId, {
    createdByMemberId: input.createdByMemberId,
  });
  await kickQueuedXeroOperation(allocation);
}
