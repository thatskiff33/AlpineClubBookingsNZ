import "server-only";

import type { Prisma } from "@prisma/client";
import { paidAnotherWayCaptureReceiptRefusal } from "@/lib/additional-capture-receipt-enqueue";
import { RECORDED_BY_ANOTHER_WRITER_PREFIX } from "@/lib/additional-capture-receipt-payload";
import { readKeptCaptureRecord } from "@/lib/late-capture-kept-xero";
import { readLateCaptureRecordedElsewhere } from "@/lib/late-capture-recorded-elsewhere";

/** The document a close's `after-receipt` plan queues (#4381). */
export type PaidAnotherWayReceiptDocument = "kept-invoice" | "capture-receipt";

/**
 * #4381 (owner, 25 Oct 2026 on #4324, applied to this door on #4381;
 * `INV-PAY-144`, `INV-SSOT`): WHICH DOCUMENT RECORDS A LATE CAPTURE WHOSE
 * APPROVED REFUND IS CLOSED AS PAID ANOTHER WAY, and that nothing in Xero has
 * recorded yet - the keep's split, from the keep's own reading
 * (`readKeptCaptureRecord`), so the two doors never record the same money
 * twice:
 *
 * - the booking's own payment, a change on a booking Xero never invoiced, or
 *   a kept-capture invoice already asked for: that invoice, for the gross
 *   capture, as before #4381;
 * - the capture's own receipt row still undecided: that receipt;
 * - otherwise by the change's evidence (`keptChangeCaptureRoute`):
 *   `change-invoice` the kept-capture invoice, as before; `change-unknown`
 *   nothing (the repair tool names it); `kept-invoice` that invoice for the
 *   capture less what other writers record; `receipt` the capture's own
 *   receipt on the invoice that bills the change, capped at what Xero shows
 *   due (`INV-PAY-139`), where its enqueue would queue it
 *   (`paidAnotherWayCaptureReceiptRefusal`);
 * - where another writer records all of it (#4381, owner decision 28 Nov
 *   2026): the credit-release sweep, nothing to queue and the plan stays
 *   `after-receipt` (`recorded-elsewhere`, accepted until #4380); any other
 *   writer, nothing (`none`), so the dialog says to record the refund by
 *   hand. One invoice in Xero that records the whole capture never reaches
 *   here: the paid-another-way verdict reads it as the receipt, and the note
 *   credits it (`readLateCaptureRecordedElsewhere`).
 *
 * Read under the task row and the change's anchor for the close
 * (`lockAnchor`), and without either for the dialog's promise.
 */
export async function paidAnotherWayReceiptDocument(
  db: Prisma.TransactionClient,
  input: {
    task: { id: string; bookingId: string };
    paymentIntentId: string;
    capture: { kind: "PRIMARY" | "ADDITIONAL"; paymentId: string; bookingModificationId: string | null; reason: string | null };
    recordCents: number;
    lockAnchor: boolean;
  },
): Promise<{ kind: PaidAnotherWayReceiptDocument; capturedCents: number } | { kind: "recorded-elsewhere" } | { kind: "none" }> {
  const keptInvoice = { kind: "kept-invoice" as const, capturedCents: input.recordCents };
  const reading = await readKeptCaptureRecord(db, {
    bookingId: input.task.bookingId,
    paymentIntentId: input.paymentIntentId,
    manualRefundTaskId: input.task.id,
    capture: input.capture,
    lockAnchor: input.lockAnchor,
  });
  if (reading.firstCut === "kept-invoice" || reading.liveKeptInvoice) return keptInvoice;
  if (reading.receiptRow) {
    // One that stored its decision reads as recorded above. One that stood
    // down for another writer (`stoodDown`) is that writer's, as a refused
    // enqueue is; any other finished row with nothing sent promises nothing.
    if (reading.receiptRow.stoodDown) return recordedByAnotherWriter(db, input.paymentIntentId);
    return reading.receiptRow.status === "SUCCEEDED" ? { kind: "none" } : { kind: "capture-receipt", capturedCents: input.recordCents };
  }
  const { route, elsewhere } = reading.decided;
  if (route === "change-invoice") return keptInvoice;
  if (route === "change-unknown") return { kind: "none" };
  if (route === "kept-invoice") {
    if (elsewhere === "all" || elsewhere >= input.recordCents) return recordedByAnotherWriter(db, input.paymentIntentId);
    return { kind: "kept-invoice", capturedCents: input.recordCents - elsewhere };
  }
  const refused = await paidAnotherWayCaptureReceiptRefusal(db, input.paymentIntentId);
  if (refused === null) return { kind: "capture-receipt", capturedCents: input.recordCents };
  return refused.startsWith(RECORDED_BY_ANOTHER_WRITER_PREFIX) ? recordedByAnotherWriter(db, input.paymentIntentId) : { kind: "none" };
}

/**
 * #4381 (owner decision 28 Nov 2026 on #4381): another writer records the
 * whole capture and the verdict found no one invoice in Xero to credit. The
 * credit-release sweep's hold keeps its `after-receipt` plan (accepted until
 * #4380); anything else cannot be credited for certain, so nothing is
 * promised and the treasurer records the refund by hand.
 */
async function recordedByAnotherWriter(
  db: Prisma.TransactionClient,
  paymentIntentId: string,
): Promise<{ kind: "recorded-elsewhere" } | { kind: "none" }> {
  const elsewhere = await readLateCaptureRecordedElsewhere(db, paymentIntentId);
  return elsewhere.kind === "credit-release-sweep" ? { kind: "recorded-elsewhere" } : { kind: "none" };
}
