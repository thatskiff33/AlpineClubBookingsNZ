/**
 * #4531 (PR #4596 finding 11, delta review D1/D2): which Xero operation, if
 * any, holds back the retire of a payment link whose payment Xero deleted. Its
 * own module so the retire (`deleted-payment-links.ts`) stays within budget;
 * the retire asks it immediately before each guarded write.
 */
import { prisma } from "@/lib/prisma";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { rerunnableOperationWhere } from "@/lib/xero-active-operation-statuses";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/** The record a payment link belongs to. */
type LinkRecord = { localModel: string; localId: string };

/** A Xero operation on a link's local row that may still run. */
export type RerunnableOperation = { id: string; status: string; entityType: string; operationType: string };

const RERUNNABLE_OPERATION_SELECT = { id: true, status: true, entityType: true, operationType: true } as const;

/**
 * #4531 (PR #4596 review, finding 11 and D1/D2): a Xero operation that may run
 * again (`rerunnableOperationWhere`: live, or FAILED/PARTIAL and replayable,
 * not resolved in Xero) and would read this link's absence as "not recorded"
 * and pay again.
 *
 * - On the link's own record (`localModel`/`localId`): the booking change's
 *   card receipt, the primary invoice's PARTIAL payment repair and the kept
 *   late capture's invoice skip re-sending a payment while an active link
 *   records it, and their payment is made by a separate operation that writes
 *   the link before the parent completes.
 * - Across records, on the same booking: a card receipt (on a
 *   `PaymentTransaction`) refuses while a supplementary invoice's payment link
 *   (on a `BookingModification`) is active (`bookingHasPaidUnnamedSupplementary`),
 *   and a supplementary invoice reads the receipts' links the other way
 *   (`anchorCaptureHasReceipt`). So a supplementary payment link waits for the
 *   booking's open receipts, and a receipt's link for its open supplementary
 *   invoices.
 */
export async function findRerunnableOperation(
  link: LinkRecord,
): Promise<RerunnableOperation | null> {
  const own = await prisma.xeroSyncOperation.findFirst({
    where: { localModel: link.localModel, localId: link.localId, ...rerunnableOperationWhere() },
    select: RERUNNABLE_OPERATION_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return own ?? findRerunnableOperationOnSameBooking(link);
}

async function findRerunnableOperationOnSameBooking(
  link: LinkRecord,
): Promise<RerunnableOperation | null> {
  if (link.localModel === "BookingModification") {
    const modification = await prisma.bookingModification.findUnique({ where: { id: link.localId }, select: { bookingId: true } });
    if (!modification) return null;
    const captures = await prisma.paymentTransaction.findMany({
      where: { payment: { bookingId: modification.bookingId } },
      orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
      select: { id: true },
    });
    if (captures.length === 0) return null;
    return prisma.xeroSyncOperation.findFirst({
      where: {
        localModel: "PaymentTransaction",
        localId: { in: captures.map((capture) => capture.id) },
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        ...rerunnableOperationWhere(),
      },
      select: RERUNNABLE_OPERATION_SELECT,
      orderBy: { createdAt: "asc" },
    });
  }
  if (link.localModel === "PaymentTransaction") {
    const capture = await prisma.paymentTransaction.findUnique({
      where: { id: link.localId },
      select: { payment: { select: { bookingId: true } } },
    });
    if (!capture?.payment) return null;
    return prisma.xeroSyncOperation.findFirst({
      where: {
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        requestPayload: { path: ["bookingId"], equals: capture.payment.bookingId },
        ...rerunnableOperationWhere(),
      },
      select: RERUNNABLE_OPERATION_SELECT,
      orderBy: { createdAt: "asc" },
    });
  }
  return null;
}
