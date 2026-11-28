import type { Prisma } from "@prisma/client";
import { readCaptureRecorder } from "@/lib/additional-capture-recorder";
import { captureChangeId } from "@/lib/additional-capture-receipt-link";
import {
  GAP_COVERED_CENTS_KEY,
  XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
  additionalCaptureReceiptStoodDown,
} from "@/lib/additional-capture-receipt-payload";
import { bookingHasPrimaryXeroInvoice } from "@/lib/late-capture-kept-xero-rules";
import { asRecord } from "@/lib/xero-json";
import { supplementaryInvoiceBilledCents } from "@/lib/xero-operation-outbox-payload";

/** What the reading below needs: the recorder's tables, and the payment's primary invoice. */
export type RecordedElsewhereStore = Pick<
  Prisma.TransactionClient,
  "bookingModification" | "manualRefundTask" | "payment" | "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation"
>;

/**
 * #4381 (owner decision 28 Nov 2026 on #4381, "automate it now";
 * `INV-PAY-144`): WHICH ONE XERO DOCUMENT ALREADY RECORDS A LATE CHANGE
 * CAPTURE, where neither its own receipt nor a kept-capture invoice does.
 * Asked only for a refund closed as paid another way
 * (`readPaidAnotherWayLateCaptureXeroReceipt`), so its bank-transfer note
 * credits that document. Four answers:
 *
 * - `document`: one invoice in Xero records the whole capture: the booking's
 *   primary invoice, which recorded it when it was linked
 *   (`paymentIntentIdsRecordedAtLink`); or a supplementary invoice that covers
 *   the change without naming the payment (the #3980 gap invoice whose
 *   covered cents for this capture are the whole capture, or the change's
 *   own paying invoice billing at least the capture). `invoiceId` is its Xero
 *   id; `recordedCents` the gross capture.
 * - `credit-release-sweep`: the #4253 sweep records or holds it
 *   (`INV-ADDPAY-046`). Unchanged by #4381: the owner accepted that no note
 *   follows until #4380.
 * - `unidentified`: another writer records it, but not one document wholly
 *   in Xero: parts on two documents, a legacy gap row with no cents, an
 *   invoice not yet in Xero, or one whose figure cannot be read. The close
 *   stores `none` and the treasurer records the refund by hand.
 * - `not-elsewhere`: not a change capture on an invoiced booking, the capture
 *   has its own receipt or kept-capture invoice row, or nothing else records
 *   all of it. The other readings decide it. A receipt row that stood down
 *   for another writer is not the capture's own: that writer's document is
 *   read as above.
 *
 * Read-only, by the recorder's own reading (`readCaptureRecorder`, `INV-SSOT`),
 * so it agrees with the keep's split and the receipt's stand-down.
 */
export type LateCaptureRecordedElsewhere =
  | { kind: "document"; invoiceId: string; recordedCents: number }
  | { kind: "credit-release-sweep" }
  | { kind: "unidentified" }
  | { kind: "not-elsewhere" };

export async function readLateCaptureRecordedElsewhere(
  store: RecordedElsewhereStore,
  paymentIntentId: string,
): Promise<LateCaptureRecordedElsewhere> {
  const notElsewhere = { kind: "not-elsewhere" } as const;
  const unidentified = { kind: "unidentified" } as const;
  // Only a change capture on a booking Xero invoiced is split by another writer (`keptLateCaptureRecordRoute`).
  const capture = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { kind: true, amountCents: true, paymentId: true, bookingModificationId: true, reason: true },
  });
  if (!capture || capture.kind !== "ADDITIONAL" || !capture.paymentId || capture.amountCents <= 0) return notElsewhere;
  const [payment, paymentLinks] = await Promise.all([
    store.payment.findUnique({ where: { id: capture.paymentId }, select: { bookingId: true, xeroInvoiceId: true } }),
    store.xeroObjectLink.findMany({
      where: { localModel: "Payment", localId: capture.paymentId, xeroObjectType: "INVOICE", role: "PRIMARY_INVOICE", active: true },
      select: { role: true, xeroObjectType: true, active: true, xeroObjectId: true },
    }),
  ]);
  if (!payment || !bookingHasPrimaryXeroInvoice({ paymentXeroInvoiceId: payment.xeroInvoiceId, paymentLinks })) return notElsewhere;
  const primaryInvoiceId = payment.xeroInvoiceId ?? paymentLinks[0]?.xeroObjectId ?? null;
  if (!primaryInvoiceId) return notElsewhere;

  // The capture's own receipt row, in any state but withdrawn, is its record:
  // never another writer's. Not one that stood down for another writer
  // (`additionalCaptureReceiptStoodDown`): it sent nothing, and that writer's
  // document is read below.
  const ownReceipts = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { status: true, responsePayload: true },
  });
  if (ownReceipts.some((row) => !additionalCaptureReceiptStoodDown(row))) return notElsewhere;

  const recorder = await readCaptureRecorder(
    { bookingId: payment.bookingId, primaryInvoiceId, paymentIntentId, bookingModificationId: captureChangeId(capture) },
    store,
  );
  if (recorder.kind === "credit-release-sweep") return { kind: "credit-release-sweep" };
  if (recorder.kind === "receipt" || recorder.kind === "kept-late-capture-invoice") return notElsewhere;
  const whole = (invoiceId: string) => ({ kind: "document" as const, invoiceId, recordedCents: capture.amountCents });
  if (recorder.kind === "primary-invoice") return whole(primaryInvoiceId);
  if (recorder.operationId === null) return unidentified;

  const row = await store.xeroSyncOperation.findUnique({
    where: { id: recorder.operationId },
    select: { status: true, xeroObjectId: true, requestPayload: true, localModel: true, localId: true },
  });
  if (!row || row.status === "CANCELLED" || row.status === "WAITING_PAYMENT") return unidentified;
  if (supplementaryRecordedCents(row.requestPayload, paymentIntentId) < capture.amountCents) return unidentified;
  const invoiceId = row.xeroObjectId ?? (await supplementaryInvoiceXeroId(store, row));
  return invoiceId ? whole(invoiceId) : unidentified;
}

/**
 * What one supplementary invoice records of this capture: a gap invoice's
 * covered cents for it (`GAP_COVERED_CENTS_KEY`), else what the invoice bills
 * (`supplementaryInvoiceBilledCents`). Zero where the figure cannot be read,
 * so nothing is guessed.
 */
function supplementaryRecordedCents(requestPayload: Prisma.JsonValue | null, paymentIntentId: string): number {
  const payload = asRecord(requestPayload);
  const covered = asRecord(payload?.[GAP_COVERED_CENTS_KEY]);
  if (covered) {
    const cents = covered[paymentIntentId];
    return typeof cents === "number" && Number.isInteger(cents) ? cents : 0;
  }
  if (payload?.primaryInvoiceGap === true) return 0;
  const billed = supplementaryInvoiceBilledCents(requestPayload);
  return billed !== null && Number.isInteger(billed) ? billed : 0;
}

/** The invoice's Xero id from the active `SUPPLEMENTARY_INVOICE` link its worker writes, or null while it is not in Xero. */
async function supplementaryInvoiceXeroId(
  store: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  row: { localModel: string | null; localId: string | null },
): Promise<string | null> {
  if (!row.localModel || !row.localId) return null;
  const link = await store.xeroObjectLink.findFirst({
    where: { localModel: row.localModel, localId: row.localId, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true },
    orderBy: { createdAt: "desc" },
    select: { xeroObjectId: true },
  });
  return link?.xeroObjectId ?? null;
}
