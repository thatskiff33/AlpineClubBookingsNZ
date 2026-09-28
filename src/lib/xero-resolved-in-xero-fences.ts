// #3635 (`INV-INT-025`): the enqueue-side fences for an operation an officer
// resolved in Xero. The retry machinery refuses a resolved ROW; these stop a
// fresh enqueue minting a new document beside the one the officer made by
// hand, because a new row does not carry the old row's mark.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

type OperationReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

export interface ResolvedInXeroOperation {
  id: string;
  manuallyResolvedAt: Date;
}

function toResolved(
  row: { id: string; manuallyResolvedAt: Date | null } | null,
): ResolvedInXeroOperation | null {
  return row?.manuallyResolvedAt
    ? { id: row.id, manuallyResolvedAt: row.manuallyResolvedAt }
    : null;
}

/**
 * A refund credit-note create on this payment that an officer resolved in
 * Xero, or null. ANY such row, not only one with the same correlation key: the
 * hand-made note has no local link, so coverage still reads it as missing and
 * every later delta's watermark would size a note that re-covers it. A person
 * places the rest (`MAINTENANCE.md`). A legacy row with no recorded queue type
 * counts too, conservative in the safe direction.
 */
export async function findResolvedRefundCreditNoteCreate(
  paymentId: string,
  db: OperationReader = prisma,
): Promise<ResolvedInXeroOperation | null> {
  const row = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      manuallyResolvedAt: { not: null },
      OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, manuallyResolvedAt: true },
  });
  return toResolved(row);
}

/**
 * The payment's LATEST booking-invoice create, when an officer resolved it in
 * Xero; null otherwise. The latest, not any: a newer create means someone chose
 * to raise the invoice again (the force-sync override), and a resolved row never
 * outranks a live one.
 */
export async function findResolvedBookingInvoiceCreate(
  paymentId: string,
  db: OperationReader = prisma,
): Promise<ResolvedInXeroOperation | null> {
  const row = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, manuallyResolvedAt: true },
  });
  return toResolved(row);
}
