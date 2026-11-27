/**
 * #4324, #4381 (`INV-PAY-144`, `INV-SSOT`): WHAT THE REPAIR PASS KNOWS ABOUT
 * ONE KEPT CHANGE CAPTURE - a late card payment for a booking change, on a
 * cancelled booking whose primary Xero invoice exists, that a treasurer kept
 * or whose approved refund was closed as paid another way.
 *
 * Read by the keep's own reading (`readKeptCaptureRecord`, taking no lock),
 * the one the keep's decision and a paid-another-way close's plan take: the
 * task's live kept-capture invoice first, then the capture's receipt row, then
 * the route its change's evidence decides, with what other writers record.
 * So the dry run lists the document and the figure `--apply` records; the
 * apply reads it all again under the task row and the change's anchor.
 */
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE } from "@/lib/additional-capture-receipt-link";
import {
  readKeptCaptureRecord,
  readKeptCaptureRecordedElsewhere,
  readKeptChangeCaptureEvidence,
  type KeptCaptureRecordStore,
} from "@/lib/late-capture-kept-xero";
import { keptChangeCaptureRoute, type KeptChangeCaptureRoute } from "@/lib/late-capture-kept-xero-rules";
import { xeroOperationSelect, type XeroOperationRecord } from "./xero-booking-repair-types";

export type KeptChangeCaptureRepairEvidence = {
  /** The change the capture pays (`captureChangeId`), or null where none can be read from it. */
  changeId: string | null;
  /**
   * The route the change's evidence decides (`keptChangeCaptureRoute`). Where
   * a receipt row or a live kept-capture invoice is the capture's record, the
   * apply never reaches the route: it only words that row's finding.
   */
  route: KeptChangeCaptureRoute;
  /** The reading found the approval task's live kept-capture invoice first: that invoice records the capture. */
  liveKeptInvoice: boolean;
  /** The capture's receipt rows (`ADDITIONAL_CAPTURE_RECEIPT`), newest first. */
  receiptOperations: XeroOperationRecord[];
  /** The receipt's Xero payment is linked. */
  receiptLinked: boolean;
  /** Active links for checking each planned leg, rather than treating one as the whole receipt. */
  receiptLinks: readonly { metadata: unknown }[];
  /**
   * The reading's receipt row stood down for another writer
   * (`additionalCaptureReceiptStoodDown`): it sent nothing, so it is neither
   * the capture's record nor a receipt on its way.
   */
  receiptStoodDown: boolean;
  /** Another writer records the capture (`readKeptCaptureRecordedElsewhere`), read only where no live receipt row exists. */
  recordedElsewhere: boolean;
  /** Review MF2: the cents of it another writer records, so the dry run lists what the apply records. */
  alreadyRecordedCents: number;
  /** Review D-F3: the payment holds its primary invoice's id. */
  primaryInvoiceIdSynced: boolean;
};

type LoadBooking = {
  id: string;
  status: string;
  payment: {
    id: string;
    xeroInvoiceId: string | null;
    transactions: Array<{
      id: string | null;
      kind: string;
      stripePaymentIntentId: string | null;
      bookingModificationId?: string | null;
      reason?: string | null;
    }>;
  } | null;
};

/**
 * Read-only: the reading for every kept change capture on a cancelled booking,
 * by booking and then intent. `approvalTasksByBookingId` names each capture's
 * approval task, whose live kept-capture invoice the reading finds first. A
 * capture the first cut gives the kept-capture invoice (a booking Xero never
 * invoiced) has no entry: that invoice's own findings answer it.
 */
export async function loadKeptChangeCaptureEvidence(
  store: KeptCaptureRecordStore,
  bookings: readonly LoadBooking[],
  approvalTasksByBookingId: ReadonlyMap<string, ReadonlyMap<string, { id: string }>>,
): Promise<Map<string, Map<string, KeptChangeCaptureRepairEvidence>>> {
  const byBooking = new Map<string, Map<string, KeptChangeCaptureRepairEvidence>>();
  for (const booking of bookings) {
    const payment = booking.payment;
    const tasks = approvalTasksByBookingId.get(booking.id);
    if (booking.status !== "CANCELLED" || !payment || !tasks) continue;
    const found = new Map<string, KeptChangeCaptureRepairEvidence>();
    for (const capture of payment.transactions) {
      const paymentIntentId = capture.stripePaymentIntentId;
      const task = paymentIntentId ? tasks.get(paymentIntentId) : undefined;
      if (capture.kind !== "ADDITIONAL" || capture.id === null || !paymentIntentId || !task) continue;
      const reading = await readKeptCaptureRecord(store, {
        bookingId: booking.id,
        paymentIntentId,
        manualRefundTaskId: task.id,
        capture: {
          kind: "ADDITIONAL",
          paymentId: payment.id,
          bookingModificationId: capture.bookingModificationId ?? null,
          reason: capture.reason ?? null,
        },
        lockAnchor: false,
      });
      if (reading.firstCut === "kept-invoice") continue;
      const { changeId, primaryInvoiceId } = reading;
      const [receiptOperations, links] = await Promise.all([
        store.xeroSyncOperation.findMany({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
          },
          select: xeroOperationSelect,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        }) as Promise<XeroOperationRecord[]>,
        store.xeroObjectLink.findMany({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
            active: true,
          },
          select: { metadata: true },
        }),
      ]);
      const read = { paymentIntentId, changeId, bookingId: booking.id, primaryInvoiceId };
      const receiptStoodDown = reading.receiptRow?.stoodDown === true;
      const liveRecord = reading.liveKeptInvoice !== null || (reading.receiptRow !== null && !receiptStoodDown) || links.length > 0;
      const route = reading.decided?.route ?? keptChangeCaptureRoute(await readKeptChangeCaptureEvidence(store, read));
      // The reading sizes the other writers' part for the routes that net it; the receipt route's refusal
      // (`paidAnotherWayCaptureReceiptRefusal`) and a stood-down row read the same recorder.
      const elsewhere = liveRecord
        ? 0
        : reading.decided && route !== "receipt"
          ? route === "change-invoice" ? 0 : reading.decided.elsewhere
          : await readKeptCaptureRecordedElsewhere(store, read);
      found.set(paymentIntentId, {
        changeId,
        route,
        liveKeptInvoice: reading.liveKeptInvoice !== null,
        receiptOperations,
        receiptLinked: links.length > 0,
        receiptLinks: links,
        receiptStoodDown,
        recordedElsewhere: elsewhere === "all",
        alreadyRecordedCents: elsewhere === "all" ? 0 : elsewhere,
        primaryInvoiceIdSynced: payment.xeroInvoiceId !== null,
      });
    }
    if (found.size > 0) byBooking.set(booking.id, found);
  }
  return byBooking;
}
