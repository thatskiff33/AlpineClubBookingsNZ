/**
 * #4324 (owner decision 25 Oct 2026; `INV-PAY-144`): A KEPT CHANGE CAPTURE'S
 * OWN RECEIPT on a cancelled booking. Where a treasurer keeps a late card
 * payment for a booking change whose primary invoice bills that change, the
 * keep's decision (`planKeptLateCaptureXeroRecord`) queues the capture's own
 * receipt (`INV-PAY-139`, `additional-capture-xero-receipt.ts`), a payment on
 * that invoice capped at what Xero shows due. These are the receipt's
 * kept-capture rules, read by its worker and the approval's settlement:
 *
 *  - the worker records a capture on a cancelled booking only where a #3639
 *    approval task owns it ({@link hasLateCaptureApprovalTask}) and, read again
 *    under the change's anchor lock where its decision is stored, still keeps
 *    it ({@link lateCaptureStillKept}); it raises no #3980 gap invoice there;
 *  - once recorded, any refund of it already taken is credited back and a
 *    paid-another-way close's waiting note queued
 *    ({@link answerKeptLateCaptureRefunds}), as the kept-capture invoice's
 *    worker does;
 *  - an approval after a reopen withdraws a receipt that has decided nothing
 *    yet ({@link withdrawUndecidedKeptCaptureReceipt}).
 *
 * A leaf: the outbox dispatches to the receipt's worker and the kept-capture
 * invoice's, both of which import this, so it reaches the outbox only lazily.
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { captureChangeId } from "@/lib/additional-capture-receipt-link";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE } from "@/lib/additional-capture-receipt-gate";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

/** Whether a #3639 approval task owns this capture - a late capture on a cancelled booking. */
export async function hasLateCaptureApprovalTask(paymentIntentId: string): Promise<boolean> {
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true },
  });
  return task !== null;
}

/** Under the change's anchor lock: whether the capture's approval task still keeps it. */
export async function lateCaptureStillKept(
  tx: Pick<Prisma.TransactionClient, "manualRefundTask">,
  paymentIntentId: string,
): Promise<boolean> {
  const task = await tx.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { status: true },
  });
  return task?.status === "DISMISSED";
}

/**
 * #4324 (review C1): THE WORKER'S "NO LONGER KEPT" IS FINAL in the transaction
 * that read it under the change's anchor (`tx`, which holds it): the receipt
 * row is CANCELLED there, guarded on its RUNNING claim, so a re-keep queued
 * behind that lock finds no live receipt and queues a fresh one - it never
 * takes this row, about to close, as the capture's record.
 */
export async function closeKeptReceiptNotKept(
  tx: Prisma.TransactionClient,
  claim: XeroOperationClaim,
  details: Record<string, unknown>,
): Promise<void> {
  const operationId = claim.id;
  // #4373 (`INV-INT-029`): only on this worker's own claim - never a retry's,
  // after a stale reset, that holds the row RUNNING under another `startedAt`.
  const closed = await tx.xeroSyncOperation.updateMany({
    where: { id: operationId, status: "RUNNING", startedAt: claim.startedAt, manuallyResolvedAt: null },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      responsePayload: { skipped: "capture-not-kept", decidedAgainUnderLock: true, ...details },
    },
  });
  if (closed.count === 0) return;
  // As the worker's stand-down: the planning stamp is not an error.
  await tx.xeroSyncOperation.updateMany({
    where: { id: operationId, lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
    data: { lastErrorCode: null },
  });
}

/**
 * C1, before the worker reads Xero: on a transaction of its own under the
 * anchor, whether the approval task still keeps the capture; if not, the row
 * is closed there ({@link closeKeptReceiptNotKept}). Holds no other key.
 */
export async function keptReceiptStillKeptElseClosed(
  input: { claim: XeroOperationClaim; anchorId: string; paymentIntentId: string },
  details: Record<string, unknown>,
): Promise<boolean> {
  // Imported here: the outbox dispatches to the workers that import this.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, input.anchorId);
    if (await lateCaptureStillKept(tx, input.paymentIntentId)) return true;
    await closeKeptReceiptNotKept(tx, input.claim, details);
    return false;
  });
}

/**
 * Once a kept capture's receipt is in Xero: any refund of it already taken
 * gets its note (`creditBackLateCaptureRefunds`), and a close of its approved
 * refund as paid another way gets its waiting bank note
 * (`queueWaitingPaidAnotherWayNote`). Each is a no-op for a capture no
 * approval task owns. Never throws: the payment is recorded, and the nightly
 * credit check retries the note step.
 */
export async function answerKeptLateCaptureRefunds(paymentIntentId: string): Promise<void> {
  try {
    if (!(await hasLateCaptureApprovalTask(paymentIntentId))) return;
    // Imported here: those modules reach the outbox, which dispatches to the receipt's worker.
    const { creditBackLateCaptureRefunds } = await import("@/lib/late-capture-refund-credit-note");
    await creditBackLateCaptureRefunds(paymentIntentId);
    const { queueWaitingPaidAnotherWayNote } = await import("@/lib/paid-another-way-receipt-note");
    await queueWaitingPaidAnotherWayNote(paymentIntentId);
  } catch (err) {
    logger.error(
      { err, paymentIntentId },
      "Failed to follow up refund notes after a kept capture's receipt; the nightly credit check retries them",
    );
  }
}

/**
 * #4324 review F4 (`INV-SSOT`): THE ANCHOR A CHANGE CAPTURE'S RECORDS ARE
 * DECIDED UNDER - its change (`captureChangeId`), else its booking. The one
 * spelling of the per-anchor supplementary-invoice key the keep's decision,
 * the receipt's enqueue and its worker, and {@link lockKeptCaptureAnchor} lock.
 */
export function keptCaptureAnchorId(
  capture: { bookingModificationId: string | null; reason: string | null },
  bookingId: string,
): string {
  return captureChangeId(capture) ?? bookingId;
}

/**
 * #4324: THE ANCHOR A KEPT CAPTURE'S RECORDS ARE DECIDED UNDER - the per-anchor
 * supplementary-invoice lock on its change (`captureChangeId`), else its
 * booking ({@link keptCaptureAnchorId}) - taken by a caller already holding the approval task's row, so the
 * order is task row -> anchor. The approval's settlement takes it before its
 * first outbox write (review C2), and a paid-another-way close before it
 * queues the kept-capture invoice of a change capture (review C4,
 * `additionalOnly`). False, taking nothing, where the capture or task is gone
 * (or, with `additionalOnly`, the capture is the booking's own payment).
 */
export async function lockKeptCaptureAnchor(
  db: Prisma.TransactionClient,
  params: { manualRefundTaskId: string; paymentIntentId: string },
  options?: { additionalOnly?: boolean },
): Promise<boolean> {
  const [capture, task] = await Promise.all([
    db.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: params.paymentIntentId },
      select: { kind: true, bookingModificationId: true, reason: true },
    }),
    db.manualRefundTask.findUnique({ where: { id: params.manualRefundTaskId }, select: { bookingId: true } }),
  ]);
  if (!capture || !task || (options?.additionalOnly && capture.kind !== "ADDITIONAL")) return false;
  // Imported here: the outbox dispatches to the workers that import this.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  await lockSupplementaryInvoiceAnchor(db, keptCaptureAnchorId(capture, task.bookingId));
  return true;
}

/**
 * THE APPROVAL'S WITHDRAWAL (`settleKeptLateCaptureRecordOnApproval`, inside
 * the approval's claim, which holds the task row): the capture's receipt where
 * it has decided nothing yet - PENDING, or FAILED before it stored its
 * decision, never resolved in Xero - under the change's anchor lock (else the
 * booking's; {@link lockKeptCaptureAnchor}, which the settlement already
 * took), after the task row: the one order. One that stored its decision
 * may already be in Xero, so it stands, its worker sends it and the refund
 * note answers it; a RUNNING one that has not stored it reads the task again
 * under that lock and stands down.
 */
export async function withdrawUndecidedKeptCaptureReceipt(
  db: Prisma.TransactionClient,
  params: { manualRefundTaskId: string; paymentIntentId: string },
  stamp: { lastErrorCode: string; lastErrorMessage: string },
): Promise<void> {
  const { paymentIntentId } = params;
  if (!(await lockKeptCaptureAnchor(db, params))) return;
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { in: ["PENDING", "FAILED"] },
      manuallyResolvedAt: null,
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { id: true, status: true, requestPayload: true },
  });
  for (const row of rows) {
    if (asRecord(row.requestPayload)?.plan != null) continue;
    await db.xeroSyncOperation.updateMany({
      where: { id: row.id, status: row.status, manuallyResolvedAt: null },
      data: { status: "CANCELLED", completedAt: new Date(), ...stamp },
    });
  }
}
