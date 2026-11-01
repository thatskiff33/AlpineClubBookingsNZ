/**
 * #3403 review (M1; `INV-PAY-140`): A CAPTURE OF A SUPERSEDED ASK TAKES ITS
 * INVOICE BACK.
 *
 * A superseded card change's waiting invoice moves onto the request carrying
 * its balance (`followSupersededAskInvoicesToCarrier`). Since #4422 a supersede
 * cancels a declined ask too, and a stale tab's capture racing that cancel is
 * refunded. A capture no live cancel row owns is kept like any other: a declined
 * ask superseded before #4422, one whose row a manual mark-paid reversal
 * deleted.
 * Its change's invoice must then record THAT capture:
 * left on the carrier, the capture's release would find nothing parked on it,
 * and if the carrier were never paid the invoice would be retired.
 *
 * So the late-capture release, for a capture the club KEEPS, first returns
 * every invoice still `WAITING_PAYMENT` that was first parked on this intent
 * (`SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY`) to wait on it again, then releases
 * as it always has. Per change, under that change's supplementary-invoice key
 * (`lockSupplementaryInvoiceAnchor`) - the key this capture's receipt decides
 * under too, since a member ask is stamped with its change - with a write
 * guarded on the status, the intent it was moved to and the correlation key.
 * Whether it records a payment is decided again there for THIS capture (review
 * 2, F2): paid, unless this capture's own receipt already records it - the
 * unpaid a move onto a carrier with its own receipt wrote
 * (`SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY`) was about the carrier's capture.
 *
 * WHEN BOTH ARE PAID AND KEPT (review 2, F3) the change was paid twice - by
 * its own ask and inside the carrier's capture - and no answer records both
 * automatically:
 * - the CARRIER first: its release issued the change's invoice recording the
 *   carrier's capture, and nothing is waiting to take back. The ask's own
 *   capture is then recorded by its own receipt: a change's invoice naming
 *   another capture is never this one's recorder (`readCaptureRecorder`).
 * - the ASK first: the invoice comes back here and records the ask's
 *   capture, and the carrier's own invoice records only its own amount, so
 *   the part of the carrier's capture that paid this change again is billed
 *   by nothing. The return marks the invoice with the carrier it was taken
 *   from (`SUPPLEMENTARY_INVOICE_TAKEN_BACK_FROM_KEY`), and the carrier's
 *   kept release tells an officer, once ever per invoice
 *   ({@link alertTakenBackInvoicesPaidAgain}), rather than record that money
 *   anywhere.
 */
import type { Prisma } from "@prisma/client";

import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { anchorCaptureHasReceipt } from "@/lib/additional-capture-receipt-link";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import {
  SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY,
  SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY,
  SUPPLEMENTARY_INVOICE_TAKEN_BACK_FROM_KEY,
  supplementaryInvoicesMovedOffIntentWhere,
} from "@/lib/supplementary-invoice-parked-from";
import { asRecord, readString } from "@/lib/xero-json";
import { lockSupplementaryInvoiceAnchor } from "@/lib/xero-operation-outbox";
import { SUPPLEMENTARY_INVOICE_CREATE_WHERE } from "@/lib/xero-supplementary-invoice-statuses";

/** Return this captured intent's moved, still-waiting invoices to it. Answers how many moved back. */
export async function returnMovedInvoicesToCapturedIntent(paymentIntentId: string): Promise<number> {
  const moved = await prisma.xeroSyncOperation.findMany({
    where: supplementaryInvoicesMovedOffIntentWhere(paymentIntentId),
    select: { localId: true },
  });
  const anchors = [...new Set(moved.flatMap((row) => (row.localId ? [row.localId] : [])))].sort();
  let returned = 0;
  for (const anchorId of anchors) {
    returned += await prisma.$transaction(async (tx) => {
      await lockSupplementaryInvoiceAnchor(tx, anchorId);
      const rows = await tx.xeroSyncOperation.findMany({
        where: { ...supplementaryInvoicesMovedOffIntentWhere(paymentIntentId), localId: anchorId },
        select: { id: true, requestPayload: true, correlationKey: true },
      });
      let count = 0;
      for (const row of rows) {
        const payload = asRecord(row.requestPayload) ?? {};
        if (typeof payload.paymentIntentId !== "string" || payload.paymentIntentId === paymentIntentId) continue;
        // Paid as it was before any move made it unpaid, unless this capture's own receipt records it.
        const paid = payload[SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY] === true || payload.recordPayment !== false;
        const recordPayment =
          paid &&
          !(await anchorCaptureHasReceipt(tx, {
            bookingId: readString(payload.bookingId) ?? "",
            bookingModificationId: anchorId,
            paymentIntentId,
          }));
        const unmoved: Record<string, unknown> = { ...payload, ...(paid ? { recordPayment } : {}) };
        delete unmoved[SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY];
        delete unmoved[SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY];
        const written = await tx.xeroSyncOperation.updateMany({
          where: {
            id: row.id,
            status: "WAITING_PAYMENT",
            correlationKey: row.correlationKey,
            requestPayload: { path: ["paymentIntentId"], equals: payload.paymentIntentId },
          },
          data: {
            requestPayload: {
              ...unmoved,
              paymentIntentId,
              [SUPPLEMENTARY_INVOICE_TAKEN_BACK_FROM_KEY]: payload.paymentIntentId,
            } as Prisma.InputJsonObject,
          },
        });
        count += written.count;
      }
      return count;
    });
  }
  return returned;
}

/**
 * Review 2 (F3): a kept capture of a request that an invoice was taken back
 * from paid that change a second time; nothing bills that part of it. One
 * officer alert per invoice, ever (`sendAdminAlertOnceEver`): the webhook, the
 * confirm route, the reaper and a treasurer's keep may all release this capture.
 */
export async function alertTakenBackInvoicesPaidAgain(paymentIntentId: string): Promise<number> {
  const takenBack = await prisma.xeroSyncOperation.findMany({
    where: {
      ...SUPPLEMENTARY_INVOICE_CREATE_WHERE,
      status: { not: "CANCELLED" },
      requestPayload: { path: [SUPPLEMENTARY_INVOICE_TAKEN_BACK_FROM_KEY], equals: paymentIntentId },
    },
    select: { id: true, localId: true, requestPayload: true },
  });
  for (const operation of takenBack) {
    const payload = asRecord(operation.requestPayload) ?? {};
    await sendAdminAlertOnceEver({
      key: `supplementary-invoice-paid-twice:${readString(payload.bookingId) ?? "booking"}:${operation.id}`,
      label: "change-paid-twice alert",
      context: { operationId: operation.id, paymentIntentId },
      send: () =>
        sendAdminXeroSyncErrorAlert({
          errorType: "SUPPLEMENTARY_INVOICE_CHANGE_PAID_TWICE",
          operation: `Supplementary invoice for booking change ${operation.localId ?? "unknown"}`,
          errorMessage: `Booking change ${operation.localId ?? "unknown"} was paid twice by card: by its own payment request ${readString(payload.paymentIntentId) ?? "unknown"}, and again inside the later request ${paymentIntentId}, which carried its unpaid balance. Both payments were kept. The change's Xero supplementary invoice (outbox operation ${operation.id}) records the first; nothing in Xero bills that part of the second. Refund or credit the member the change's amount, or record it in Xero by hand.`,
          timestamp: new Date(),
        }),
    });
  }
  return takenBack.length;
}
