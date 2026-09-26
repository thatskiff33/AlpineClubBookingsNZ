/**
 * Has an invoice-clearing credit note already been issued (or queued) for this
 * booking's invoice? (#3535)
 *
 * Two shapes answer yes. Before #3535 the internet-banking hold-expiry release
 * raised a payment-anchored refund note, recorded on
 * `payment.xeroRefundCreditNoteId`. Since #3535 it — like the never-captured
 * cancel path and the repair tool's re-queue — raises the booking-anchored
 * `MODIFICATION_CREDIT_NOTE`, which never touches that field; it is known by
 * its active link, or by a clearing operation still in flight or finished.
 * Reading only the payment field silently dropped the "a clearing note was
 * ALREADY issued" warning for every hold released on the new path.
 *
 * Read with the caller's transaction client so the answer is consistent with
 * the lock it holds.
 */
import type { Prisma } from "@prisma/client";
import { XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

export async function hasInvoiceClearingNote(
  db: Prisma.TransactionClient,
  payment: { bookingId: string; xeroRefundCreditNoteId: string | null },
): Promise<boolean> {
  if (payment.xeroRefundCreditNoteId) return true;
  const link = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Booking",
      localId: payment.bookingId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MODIFICATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });
  if (link) return true;
  const operation = await db.xeroSyncOperation.findFirst({
    where: {
      localModel: "Booking",
      localId: payment.bookingId,
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      status: { in: ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL"] },
    },
    select: { id: true },
  });
  return Boolean(operation);
}
