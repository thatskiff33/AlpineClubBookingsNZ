import type { Prisma } from "@prisma/client";
import {
  KEPT_LATE_CAPTURE_INVOICE_ROLE,
  KEPT_LATE_CAPTURE_PAYMENT_ROLE,
  keptLateCaptureInvoiceAsked,
  keptReceiptMayHaveReachedXero,
} from "@/lib/late-capture-kept-xero-rules";
import { XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * #3635 / #3924 round 9: THE ROWS OF A LATE CAPTURE'S RECEIPT - the one where
 * shape of its kept-capture invoice rows, which row counts as asked for, and
 * whether a FAILED one is held for an officer. Read by the receipt's enqueue
 * and worker (`xero-kept-late-capture-invoice.ts`) and by a paid-another-way
 * close's plan (`card-refund-paid-another-way-xero.ts`), so the dialog and the
 * close read one fact (`INV-SSOT`).
 */

/** The where shape of a kept late capture's invoice rows, anchored on its approval task. */
export const KEPT_INVOICE_CREATE = {
  direction: "OUTBOUND",
  entityType: "INVOICE",
  operationType: "CREATE",
  localModel: "ManualRefundTask",
  queueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
} as const;

type KeptReceiptRowStore = Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink">;

/** The task's receipt row that counts as asked for (`keptLateCaptureInvoiceAsked`), if any. */
export async function findLiveKeptReceiptRow(db: KeptReceiptRowStore, manualRefundTaskId: string) {
  const existing = await db.xeroSyncOperation.findMany({
    where: { ...KEPT_INVOICE_CREATE, localId: manualRefundTaskId },
    select: { id: true, queueType: true, status: true, manuallyResolvedAt: true, requestPayload: true },
  });
  return existing.find((row) => keptLateCaptureInvoiceAsked([row])) ?? null;
}

/** Which of the receipt's links the task carries, and so whether a FAILED row may have reached Xero. */
export async function readFailedKeptReceiptLinks(
  db: KeptReceiptRowStore,
  manualRefundTaskId: string,
  requestPayload: unknown,
): Promise<{ invoiceLinked: boolean; mayHaveReachedXero: boolean }> {
  const taskLinks = (
    await db.xeroObjectLink.findMany({
      where: {
        localModel: "ManualRefundTask",
        localId: manualRefundTaskId,
        role: { in: [KEPT_LATE_CAPTURE_INVOICE_ROLE, KEPT_LATE_CAPTURE_PAYMENT_ROLE] },
        active: true,
      },
      select: { role: true },
    })
  ).map((link) => link.role);
  return {
    invoiceLinked: taskLinks.includes(KEPT_LATE_CAPTURE_INVOICE_ROLE),
    mayHaveReachedXero: keptReceiptMayHaveReachedXero({
      requestPayload,
      paymentLinked: taskLinks.includes(KEPT_LATE_CAPTURE_PAYMENT_ROLE),
    }),
  };
}

/**
 * #3924 round 9: IS THIS TASK'S RECEIPT HELD FOR AN OFFICER? Its row FAILED,
 * unresolved, with no invoice link, after it may have reached Xero
 * (`keptReceiptMayHaveReachedXero`). A close never runs it again
 * (`requeueFailedUnsent` answers `awaitingOfficerRetry`): an officer checks
 * Xero, then retries it, and the close's note follows that retry. The close's
 * plan reads the same fact, so the dialog promises what the close does.
 */
export async function keptReceiptHeldForOfficer(db: KeptReceiptRowStore, manualRefundTaskId: string): Promise<boolean> {
  const live = await findLiveKeptReceiptRow(db, manualRefundTaskId);
  if (!live || live.status !== "FAILED" || live.manuallyResolvedAt !== null) return false;
  const { invoiceLinked, mayHaveReachedXero } = await readFailedKeptReceiptLinks(
    db,
    manualRefundTaskId,
    live.requestPayload,
  );
  return !invoiceLinked && mayHaveReachedXero;
}
