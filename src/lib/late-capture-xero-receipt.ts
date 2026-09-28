import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { KEPT_LATE_CAPTURE_INVOICE_ROLE } from "@/lib/late-capture-kept-xero-rules";
import {
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";

type ReceiptStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation"
>;

/**
 * WAS THIS LATE CAPTURE EVER RECORDED IN XERO? (#3635 review F2, orchestrator
 * decision 29 Sep 2026.) Only a refund of money Xero holds a receipt for gets
 * a refund credit note - the note is settled by a Stripe-account refund
 * payment, so one for a capture Xero never received would take money out of
 * the Stripe account that was never put in.
 *
 * Asked of the capture's OWN invoice rows, never of `payment.xeroInvoiceId`:
 * for a late capture that is the booking's pre-cancel invoice, which the cancel
 * has already cleared with its own note. The capture's own rows are:
 *  - its kept-capture invoice, once Xero has it (the task's active link; a
 *    queued or sending one is not yet a receipt, and its worker credits back
 *    any refund once it has sent - `createXeroKeptLateCaptureInvoice`), or
 *    one an officer recorded by hand and resolved in Xero (`INV-INT-025`);
 *  - its change's supplementary invoice released for this intent (queued,
 *    sending or sent), the rule `hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent`
 *    applied before #3635.
 */
export async function hasXeroReceiptForLateCapture(
  paymentIntentId: string,
  store: ReceiptStore = prisma,
): Promise<boolean> {
  const task = await store.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true },
  });
  if (task) {
    const kept = await store.xeroObjectLink.count({
      where: {
        localModel: "ManualRefundTask",
        localId: task.id,
        xeroObjectType: "INVOICE",
        role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
        active: true,
      },
    });
    if (kept > 0) return true;
    // `INV-INT-025`: an officer who resolved the kept invoice's failed row
    // recorded the receipt by hand in Xero, so a refund of it needs its note.
    const resolvedByHand = await store.xeroSyncOperation.count({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "ManualRefundTask",
        localId: task.id,
        queueType: XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
        status: { not: "CANCELLED" },
        manuallyResolvedAt: { not: null },
      },
    });
    if (resolvedByHand > 0) return true;
  }
  const released = await store.xeroSyncOperation.count({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
  });
  return released > 0;
}

/**
 * Does a Stripe refund of this intent need its own Xero refund credit note now?
 * Yes for every capture a #3639 task does not own (unchanged). For one a task
 * owns, only once it has a Xero receipt; a refund taken before then is credited
 * back by the kept invoice's worker when it records the receipt, so the order
 * of the two never matters.
 */
export async function stripeRefundNeedsXeroNoteNow(paymentIntentId: string): Promise<boolean> {
  const owned = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true },
  });
  return owned ? hasXeroReceiptForLateCapture(paymentIntentId) : true;
}

/**
 * The kept-capture invoice of a payment, when one was sent: the refund note
 * names it as the document it answers (`createXeroCreditNote`).
 */
export async function findKeptLateCaptureInvoiceIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { paymentId, lateCaptureApprovalIntentId: { not: null } },
    select: { id: true },
  });
  if (tasks.length === 0) return null;
  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "ManualRefundTask",
      localId: { in: tasks.map((task) => task.id) },
      xeroObjectType: "INVOICE",
      role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
      active: true,
    },
    orderBy: { createdAt: "desc" },
    select: { xeroObjectId: true },
  });
  return link?.xeroObjectId ?? null;
}
