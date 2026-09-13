import logger from "@/lib/logger";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

export interface QueueXeroInvoiceForPaidBookingOptions {
  bookingId: string;
  createdByMemberId?: string | null;
}

export async function queueXeroInvoiceForPaidBooking({
  bookingId,
  createdByMemberId,
}: QueueXeroInvoiceForPaidBookingOptions) {
  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(bookingId, {
      ...(createdByMemberId ? { createdByMemberId } : {}),
      invoiceEmailDelivery: null,
    });

    if (queuedInvoice.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      logger.info(
        { bookingId, queueOperationId: queuedInvoice.queueOperationId },
        "Xero invoice queued for booking"
      );
    }

    return queuedInvoice;
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, bookingId },
      "Failed to queue Xero invoice for booking"
    );
    notifyXeroSyncError({
      errorType: "INVOICE_CREATION",
      operation: `Queue invoice for booking ${bookingId}`,
      errorMessage: xeroErr instanceof Error ? xeroErr.message : String(xeroErr),
    }).catch(() => {});

    return {
      queueOperationId: null,
      message:
        xeroErr instanceof Error
          ? xeroErr.message
          : "Failed to queue Xero invoice for booking.",
    };
  }
}
