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
      // No queueType filter: only the modification-note builder anchors a
      // CREDIT_NOTE create on a Booking, and a retry row written before the
      // builder stamped the column carries none.
      OR: [
        { status: { in: ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL"] } },
        // #3635 (`INV-INT-025`): a failed note an officer then raised by hand
        // in Xero and resolved - the query-side spelling of `isResolvedInXero`.
        { status: "FAILED", manuallyResolvedAt: { not: null } },
      ],
    },
    select: { id: true },
  });
  return Boolean(operation);
}

/**
 * Real cash arrived for a cancelled booking, so a still-PENDING clearing note
 * (which would say the booking was not paid) is obsolete: retire it in the
 * caller's transaction. Only a pending one - a note already sent is the late
 * payment alert's to call out. The repair tool reads a CANCELLED clearing row
 * as "cash arrived; no note is owed" and does not propose another.
 */
export async function retirePendingClearingNote(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  await db.xeroSyncOperation.updateMany({
    where: {
      localModel: "Booking",
      localId: bookingId,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      status: "PENDING",
      queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
    },
    data: { status: "CANCELLED" },
  });
}
