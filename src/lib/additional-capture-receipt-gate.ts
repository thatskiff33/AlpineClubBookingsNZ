/**
 * #3953 (`INV-PAY-139`): WHEN A CHANGE CAPTURE'S RECEIPT MAY PLAN - its waits
 * and the planning gate (review rounds 1, 3 and 4), split from the worker
 * (`additional-capture-xero-receipt.ts`) so the outbox's scan reads the wait
 * spacing without the worker's import graph.
 */
import { prisma } from "@/lib/prisma";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { liveRunningXeroOperationFilter } from "@/lib/xero-stale-operations";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { asRecord, responseNamesXeroInvoice } from "@/lib/xero-json";
import { sanitizeForJson } from "@/lib/xero-sync";

/** The `lastErrorCode` a receipt carries while it waits (busy) and goes back to PENDING. */
export const ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE = "ADDITIONAL_CAPTURE_RECEIPT_WAITING";

/**
 * A wait: the applied-credit busy error, so the outbox returns the row to
 * PENDING with this code rather than failing it. Built at the throw, never
 * subclassed at module load.
 */
export function waitFor(message: string): XeroAppliedCreditOperationBusyError {
  return new XeroAppliedCreditOperationBusyError(message, null, ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE);
}

/** Round 4: stamped on a RUNNING receipt that has passed the planning gate, until it finishes or waits. */
export const ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE = "ADDITIONAL_CAPTURE_RECEIPT_PLANNING";

/**
 * Review round 1 (D), round 4: ONE RECEIPT PLANS PER BOOKING AT A TIME, and
 * none while the booking's invoice create runs - its link save queues
 * receipts and its gap check decides what the gap invoice pays itself from.
 *
 * THE GATE. Under the per-anchor supplementary-invoice lock on the booking
 * (`lockSupplementaryInvoiceAnchor`, an anchor that lock already serialises;
 * no new key), the receipt looks for another LIVE receipt on the booking that
 * has passed the gate (`ADDITIONAL_CAPTURE_RECEIPT_PLANNING`), and either
 * waits for it or stamps its own row with that code, guarded on its status,
 * and goes on. Whichever takes the lock second sees the first's stamp, so
 * exactly one passes - whatever order the outbox's claims committed in, and
 * with no both-wait to break (round 3's `(startedAt, id)` order read the
 * app's clock, not commit order). The lock is held for the milliseconds of
 * that check and stamp; no provider call runs under it (`INV-LOCK-004`).
 * The stamp ends with the row: a wait, a failure or a refusal writes its own
 * code, a success clears it, and a dead row stops counting once it is past
 * the staleness threshold (`liveRunningXeroOperationFilter`).
 */
export async function passPlanningGate(operationId: string, bookingId: string): Promise<void> {
  const live = liveRunningXeroOperationFilter();
  const runningCreate = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      ...live,
    },
    select: { id: true },
  });
  if (runningCreate) {
    throw waitFor(`The booking's Xero invoice is still being raised (operation ${runningCreate.id}); this card payment is recorded once it is done`);
  }
  // Imported here: the outbox dispatches to this worker.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  const otherId = await prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, bookingId);
    const other = await tx.xeroSyncOperation.findFirst({
      where: {
        id: { not: operationId },
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        requestPayload: { path: ["bookingId"], equals: bookingId },
        lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE,
        ...live,
      },
      select: { id: true },
    });
    if (other) return other.id;
    await tx.xeroSyncOperation.updateMany({
      where: { id: operationId, status: "RUNNING" },
      data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
    });
    return null;
  });
  if (otherId) {
    throw waitFor(`Another card payment receipt for this booking (operation ${otherId}) is being recorded; this one waits for it`);
  }
}

/** Round 3: how long a waiting receipt is left out of the outbox scan before it is looked at again. */
export const ADDITIONAL_CAPTURE_RECEIPT_RECHECK_MS = 60 * 1000;

/**
 * Round 3: the outbox scan's filter - leave out a receipt returned to wait
 * until its recheck is due, so it does not take the head of every kick, as
 * `outboxScanLeavesAwaitingOwnNote` does for a waiting note. Every other row,
 * a null code included, is scanned as before.
 */
export function outboxScanSpacesWaitingReceipts(now: Date) {
  return {
    OR: [
      { lastErrorCode: null },
      { lastErrorCode: { not: ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE } },
      { updatedAt: { lte: new Date(now.getTime() - ADDITIONAL_CAPTURE_RECEIPT_RECHECK_MS) } },
    ],
  };
}

/**
 * #3953 review round 6 (item 2), narrowed in round 9: a receipt whose own
 * payment is in Xero found another supplementary invoice that would record
 * the same capture. Only the change's OWN invoice or one NAMING the capture
 * is switched - never a #3980 gap invoice, which may pay for other captures
 * too. Where it has not sent - PENDING, WAITING_PAYMENT, or FAILED with no
 * Xero invoice in its response or on its row, and no active
 * `SUPPLEMENTARY_INVOICE` link - it is set to raise UNPAID, under its
 * anchor's lock, decided on the row read there and guarded on that status;
 * a lost guard re-reads once (a waiting invoice released meanwhile is still
 * unsent). Returns whether it was switched; the caller tells an officer to
 * check Xero either way. Its own transaction, holding no other key; no Xero
 * call.
 */
export async function switchUnsentRecorderUnpaid(
  supplementaryOperationId: string,
  capture: { paymentIntentId: string; bookingModificationId: string | null },
): Promise<boolean> {
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: supplementaryOperationId },
    select: { localModel: true, localId: true },
  });
  if (!row?.localModel || !row.localId) return false;
  const { localModel, localId } = row;
  // Imported here: the outbox dispatches to the receipt's worker.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, localId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await tx.xeroSyncOperation.findUnique({
        where: { id: supplementaryOperationId },
        select: { status: true, requestPayload: true, responsePayload: true, xeroObjectId: true },
      });
      if (!current) return false;
      const payload = asRecord(current.requestPayload) ?? {};
      const own = localModel === "BookingModification" && localId === capture.bookingModificationId;
      const naming = payload.paymentIntentId === capture.paymentIntentId;
      if (payload.primaryInvoiceGap === true || (!own && !naming)) return false;
      const unsent =
        current.status === "PENDING" ||
        current.status === "WAITING_PAYMENT" ||
        (current.status === "FAILED" && !current.xeroObjectId && !responseNamesXeroInvoice(current.responsePayload));
      if (!unsent) return false;
      const linked = await tx.xeroObjectLink.findFirst({
        where: { localModel, localId, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true },
        select: { id: true },
      });
      if (linked) return false;
      const result = await tx.xeroSyncOperation.updateMany({
        where: { id: supplementaryOperationId, status: current.status },
        data: { requestPayload: sanitizeForJson({ ...payload, recordPayment: false }) },
      });
      if (result.count === 1) return true;
    }
    return false;
  });
}

/**
 * #3953 review round 9 (item 3): an officer's Retry of a change's
 * supplementary invoice replays it from a payload read before. Asked again
 * under the change's anchor lock just before that replay: whether the row now
 * says unpaid (a receipt's switch) or a capture it would record has a receipt
 * (`anchorCaptureHasReceipt`, the enqueue's own question). Round 11: where a
 * receipt does, the row itself is set unpaid there, guarded on the status read
 * (the switch's write), so the receipt reads it as the invoice it records
 * against rather than a second recorder. A #3980 gap invoice decides its own
 * cash and is left as asked, save (#4494) where its payment would overlap the
 * credit-release sweep's share: asked after the lock is released (the check
 * may alert), and set unpaid, guarded on FAILED or PARTIAL - naming nothing
 * only where its payment provably never reached Xero, otherwise still naming
 * its captures so the sweep keeps holding (`unpaidGapPayloadIfOverlapping`).
 * `raisedUnpaid` says this call turned it unpaid.
 */
export async function supplementaryReplayMayRecordPayment(input: {
  operationId: string;
  bookingId: string;
  bookingModificationId: string;
}): Promise<{ recordPayment: boolean; raisedUnpaid: boolean }> {
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  const { anchorCaptureHasReceipt } = await import("@/lib/additional-capture-receipt-link");
  const decided = await prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, input.bookingModificationId);
    const row = await tx.xeroSyncOperation.findUnique({
      where: { id: input.operationId },
      select: { status: true, requestPayload: true },
    });
    const payload = asRecord(row?.requestPayload);
    if (!row || payload?.recordPayment === false) return { recordPayment: false, raisedUnpaid: false };
    if (payload?.primaryInvoiceGap === true) return { recordPayment: true, raisedUnpaid: false, gapPayload: payload };
    // Round 12: a payment linked or a decision stored - never a bare running
    // receipt, which reads this row again before it decides.
    const recorded = await anchorCaptureHasReceipt(
      tx,
      {
        bookingId: input.bookingId,
        bookingModificationId: input.bookingModificationId,
        paymentIntentId: typeof payload?.paymentIntentId === "string" ? payload.paymentIntentId : null,
      },
      { decidedOnly: true },
    );
    if (!recorded) return { recordPayment: true, raisedUnpaid: false };
    // Only an unsent row - one the Retry may run - is set unpaid.
    if (row.status !== "FAILED" && row.status !== "PARTIAL") return { recordPayment: false, raisedUnpaid: false };
    const written = await tx.xeroSyncOperation.updateMany({
      where: { id: input.operationId, status: { in: ["FAILED", "PARTIAL"] } },
      data: { requestPayload: sanitizeForJson({ ...(payload ?? {}), recordPayment: false }) },
    });
    return { recordPayment: false, raisedUnpaid: written.count === 1 };
  });
  if (!("gapPayload" in decided) || !decided.gapPayload) return decided;
  const { unpaidGapPayloadIfOverlapping } = await import("@/lib/credit-release-xero-payment");
  const unpaid = await unpaidGapPayloadIfOverlapping({ operationId: input.operationId, bookingId: input.bookingId, payload: decided.gapPayload });
  if (!unpaid) return { recordPayment: true, raisedUnpaid: false };
  const written = await prisma.xeroSyncOperation.updateMany({
    where: { id: input.operationId, status: { in: ["FAILED", "PARTIAL"] } },
    data: { requestPayload: sanitizeForJson(unpaid) },
  });
  return { recordPayment: false, raisedUnpaid: written.count === 1 };
}
