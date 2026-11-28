import logger from "@/lib/logger";
import { XERO_INVOICE_EMAIL_ASKED_BY_EDIT } from "@/lib/xero-invoice-email-instruction";
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
 * (#5288, `INV-PAY-163`) the applied-credit allocation after it - queued
 * second, so the older invoice operation runs first, as the switch to Internet
 * Banking queues them (`queueSwitchInvoiceAfterCommit`).
 *
 * That increase's invoice is created UNEMAILED (`XERO_INVOICE_EMAIL_ASKED_BY_EDIT`).
 * Xero emails an Internet Banking invoice inside the create, before the
 * allocation operation has run, so its email would show the booking's whole
 * worth as due. The booking-changed email has already asked for what is due
 * after the credit, and is the only ask.
 *
 * The allocation is queued only behind an invoice operation: the one just
 * queued, or one already waiting. A refused enqueue - a linked or externally
 * settled invoice, or a create an officer resolved by hand in Xero (#3635) -
 * returns no operation, and an allocation queued then would retry "no Xero
 * invoice yet" until it failed. So a replay queues nothing new. Nothing is
 * queued while the Xero module is off: the outbox skips its work then, and it
 * would go out unchecked the day Xero came back (`INV-INT-040`), as
 * booking-create's own $0 invoice is gated.
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
    invoiceEmailDelivery: allocateAppliedCredit ? XERO_INVOICE_EMAIL_ASKED_BY_EDIT : null,
  });
  await kickQueuedXeroOperation(queued);
  if (!allocateAppliedCredit || !queued.queueOperationId) return;
  const allocation = await enqueueXeroAppliedCreditAllocationOperation(input.bookingId, {
    createdByMemberId: input.createdByMemberId,
  });
  await kickQueuedXeroOperation(allocation);
}
