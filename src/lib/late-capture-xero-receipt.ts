import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { KEPT_LATE_CAPTURE_INVOICE_ROLE } from "@/lib/late-capture-kept-xero-rules";
import { automaticCancelledBookingRefundTaskReasons } from "@/lib/deleted-booking-modification-payment";
import {
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";

type ReceiptStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation"
>;

/**
 * WAS THIS LATE CAPTURE EVER RECORDED IN XERO, AND BY WHOM? (#3635 review F2,
 * round-3 R1/R5, orchestrator decision 29 Sep 2026.) Only a refund of money the
 * APP recorded in Xero gets an automatic refund credit note - the note is
 * settled by a Stripe-account refund payment, so one for a capture Xero never
 * received would take money out of the Stripe account that was never put in.
 *
 * Asked of the capture's OWN invoice rows, never of `payment.xeroInvoiceId`:
 * for a late capture that is the booking's pre-cancel invoice, which the cancel
 * has already cleared with its own note. Three answers:
 *  - `recorded`: its kept-capture invoice is in Xero (the task's active link),
 *    or its change's supplementary invoice was released for this intent
 *    (queued, sending or sent - the rule
 *    `hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent` applied
 *    before #3635). `invoiceId` is the document a refund note names; null
 *    while the released invoice has not reached Xero yet, and then
 *    `invoiceFailed` (#3924 round 9) says its row FAILED - nothing sends it
 *    until an officer retries it - rather than being queued or sending. A kept row still
 *    queued or sending is not yet a receipt: its worker credits back any
 *    refund once it has sent (`createXeroKeptLateCaptureInvoice`).
 *  - `resolved-by-hand`: an officer recorded the receipt by hand and resolved
 *    its row in Xero (`INV-INT-025`). The app raises no note for its refunds -
 *    the officer records those by hand too, and the repair tool says so.
 *  - `none`: nothing in Xero; a refund of it needs no note.
 */
export type LateCaptureXeroReceipt =
  | { kind: "none" }
  | { kind: "resolved-by-hand" }
  | { kind: "recorded"; invoiceId: string | null; invoiceFailed?: true };

export async function readLateCaptureXeroReceipt(
  paymentIntentId: string,
  store: ReceiptStore = prisma,
): Promise<LateCaptureXeroReceipt> {
  const task = await store.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true },
  });
  let resolvedByHand = false;
  if (task) {
    const kept = await store.xeroObjectLink.findFirst({
      where: {
        localModel: "ManualRefundTask",
        localId: task.id,
        xeroObjectType: "INVOICE",
        role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
        active: true,
      },
      select: { xeroObjectId: true },
    });
    if (kept) return { kind: "recorded", invoiceId: kept.xeroObjectId };
    const resolvedKept = await store.xeroSyncOperation.count({
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
    resolvedByHand = resolvedKept > 0;
  }
  const released = await store.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { status: true, xeroObjectId: true, manuallyResolvedAt: true },
  });
  const live = released.filter((row) => !row.manuallyResolvedAt);
  if (live.length > 0) {
    const sent = live.find((row) => row.xeroObjectId);
    if (sent?.xeroObjectId) return { kind: "recorded", invoiceId: sent.xeroObjectId };
    return live.every((row) => row.status === "FAILED")
      ? { kind: "recorded", invoiceId: null, invoiceFailed: true }
      : { kind: "recorded", invoiceId: null };
  }
  if (resolvedByHand || released.length > 0) return { kind: "resolved-by-hand" };
  return { kind: "none" };
}

/** A receipt the app recorded, so a refund of it gets the app's own note. */
export async function hasXeroReceiptForLateCapture(
  paymentIntentId: string,
  store: ReceiptStore = prisma,
): Promise<boolean> {
  return (await readLateCaptureXeroReceipt(paymentIntentId, store)).kind === "recorded";
}

/**
 * Which of these payment intents are LATE CAPTURES on a cancelled or deleted
 * booking (#3635 round-3 R1): one a #3639 approval task owns
 * (`lateCaptureApprovalIntentId`), or one the webhook refunded automatically,
 * recorded by the #2760/#2773 row whose frozen `reason` names the intent
 * (`automaticCancelledBookingRefundTaskReasons`). A capture the webhook refunded
 * whose record write FAILED (audited `booking.payment.auto_refund_record_failed`)
 * leaves no row and cannot be told apart here - a stated limit.
 */
export async function findLateCapturePaymentIntents(
  paymentIntentIds: readonly string[],
  store: Pick<Prisma.TransactionClient, "manualRefundTask"> = prisma,
): Promise<Set<string>> {
  const ids = [...new Set(paymentIntentIds)];
  if (ids.length === 0) return new Set();
  const byReason = new Map<string, string>();
  for (const id of ids) {
    for (const reason of automaticCancelledBookingRefundTaskReasons(id)) byReason.set(reason, id);
  }
  const tasks = await store.manualRefundTask.findMany({
    where: {
      OR: [
        { lateCaptureApprovalIntentId: { in: ids } },
        { reason: { in: [...byReason.keys()] } },
      ],
    },
    select: { lateCaptureApprovalIntentId: true, reason: true },
  });
  const found = new Set<string>();
  for (const task of tasks ?? []) {
    if (task.lateCaptureApprovalIntentId && ids.includes(task.lateCaptureApprovalIntentId)) {
      found.add(task.lateCaptureApprovalIntentId);
    }
    const byTaskReason = task.reason ? byReason.get(task.reason) : undefined;
    if (byTaskReason) found.add(byTaskReason);
  }
  return found;
}

/**
 * The kept-capture invoice of a payment, when one was sent: the refund note
 * names it as the document it answers (`createXeroCreditNote`).
 */
export async function findKeptLateCaptureInvoiceIdForPayment(
  paymentId: string,
  store: Pick<Prisma.TransactionClient, "manualRefundTask" | "xeroObjectLink"> = prisma,
): Promise<string | null> {
  const tasks = await store.manualRefundTask.findMany({
    where: { paymentId, lateCaptureApprovalIntentId: { not: null } },
    select: { id: true },
  });
  if (tasks.length === 0) return null;
  const link = await store.xeroObjectLink.findFirst({
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
