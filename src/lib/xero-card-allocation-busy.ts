import type { Prisma } from "@prisma/client";

import { XERO_OUTBOX_BOOKING_INVOICE_TYPE } from "./xero-operation-outbox-payload";
import { XeroAppliedCreditOperationBusyError } from "./xero-applied-credit-operation-serialization";

/**
 * #3809 (review M1): a card booking's applied credit is allocated inside its
 * invoice operation (#1641), which commits the slices before the provider call
 * and records their provenance after it. A deallocation that reaches them in
 * between finds a slice with no provenance yet: that is the invoice operation
 * still running, so it waits (a busy error returns it to PENDING) rather than
 * failing for good and fencing the cancel, the notes and the invoice's own
 * retry. Any other provenance gap stays terminal, as for a bank transfer.
 */
export async function busyWhileCardAllocationUnfinished(
  error: unknown,
  payment: { id: string; source: string },
  tx: Prisma.TransactionClient,
): Promise<unknown> {
  if (payment.source === "INTERNET_BANKING" || !(error instanceof Error) || !/has no active Xero provenance/.test(error.message)) {
    return error;
  }
  const invoiceOperation = await tx.xeroSyncOperation.findFirst({
    where: {
      localModel: "Payment",
      localId: payment.id,
      entityType: "INVOICE",
      queueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
      status: { in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"] },
    },
    select: { id: true },
  });
  return invoiceOperation
    ? new XeroAppliedCreditOperationBusyError(
        `Card applied-credit allocation for payment ${payment.id} is unfinished in invoice operation ${invoiceOperation.id}; retrying deallocation`,
      )
    : error;
}
