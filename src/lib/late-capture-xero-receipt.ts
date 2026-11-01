import { ManualRefundTaskStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { KEPT_LATE_CAPTURE_INVOICE_ROLE, xeroCreateCallAttempted } from "@/lib/late-capture-kept-xero-rules";
import { asRecord } from "@/lib/xero-json";
import { readAdditionalCaptureReceiptLinkedInvoiceId } from "@/lib/additional-capture-receipt-link";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
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
 *    until an officer retries it - rather than being queued or sending, and
 *    `invoiceMayBeInXero` (round 10) that the failed row attempted
 *    `createInvoices` (`xeroCreateCallAttempted`), so Xero may hold it and an
 *    officer checks Xero before retrying. A kept row still queued or sending
 *    is not yet a receipt: its worker credits back any refund once it has
 *    sent (`createXeroKeptLateCaptureInvoice`).
 *  - `resolved-by-hand`: an officer resolved its row (`INV-INT-025`). The app
 *    raises no note for its refunds - the officer records those by hand too,
 *    and the repair tool says so.
 *  - `none`: nothing in Xero; a refund of it needs no note.
 *
 * #4324 (`INV-PAY-144`): a kept change capture whose primary invoice bills its
 * change is recorded by its own receipt (`ADDITIONAL_CAPTURE_RECEIPT`), a
 * payment on that invoice: `recorded` naming the invoice its payment link
 * records, or with no id while a row that stored its decision has not linked
 * one (FAILED: `invoiceFailed` and `invoiceMayBeInXero`, since the decision is
 * stored before the Xero call). One resolved by hand is `resolved-by-hand`. A
 * row still undecided is not yet a receipt: its worker credits back any
 * refund once it has recorded.
 *
 * TWO VERDICTS, ONE BODY (#3924 round 11). `readLateCaptureXeroReceipt` is the
 * verdict every card-refund path reads - the refund note's eligible cash
 * (`resolveRefundNoteEligibleCash`), the card note itself
 * (`createXeroCreditNote`), the late-capture refund repair
 * (`recordAndNoteRepairedLateCaptureRefunds`) and the card-note gap
 * (`readRefundCreditNoteGap`) - and a resolved row is
 * `resolved-by-hand` there, as before #3924.
 * `readPaidAnotherWayLateCaptureXeroReceipt` is the verdict of a refund
 * closed as paid another way only: the close's plan, its note step (the
 * receipt's worker and the nightly credit check), and the repair tool's
 * finding. There a receipt is recorded against the invoice Xero holds
 * wherever the app knows its id (round 10): a row an officer resolved AFTER
 * the app had sent it (its `xeroObjectId`), or a released change's active
 * `SUPPLEMENTARY_INVOICE` link (`findActiveSupplementaryInvoiceLink`), since
 * that invoice is the app's own document in Xero. Both run `readReceipt`, so
 * they differ only where `widenToKnownInvoice` says.
 */
export type LateCaptureXeroReceipt =
  | { kind: "none" }
  | { kind: "resolved-by-hand" }
  | { kind: "recorded"; invoiceId: string | null; invoiceFailed?: true; invoiceMayBeInXero?: true };

export async function readLateCaptureXeroReceipt(
  paymentIntentId: string,
  store: ReceiptStore = prisma,
): Promise<LateCaptureXeroReceipt> {
  return readReceipt(paymentIntentId, store, { widenToKnownInvoice: false });
}

/** The paid-another-way verdict: a resolved row's or a linked change's invoice is recorded (see above). */
export async function readPaidAnotherWayLateCaptureXeroReceipt(
  paymentIntentId: string,
  store: ReceiptStore = prisma,
): Promise<LateCaptureXeroReceipt> {
  return readReceipt(paymentIntentId, store, { widenToKnownInvoice: true });
}

async function readReceipt(
  paymentIntentId: string,
  store: ReceiptStore,
  { widenToKnownInvoice }: { widenToKnownInvoice: boolean },
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
    const resolvedKept = await store.xeroSyncOperation.findMany({
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
      select: { xeroObjectId: true },
    });
    // Paid another way only: resolved after the app had sent it.
    const keptSent = widenToKnownInvoice ? resolvedKept.find((row) => row.xeroObjectId) : undefined;
    if (keptSent?.xeroObjectId) return { kind: "recorded", invoiceId: keptSent.xeroObjectId };
    resolvedByHand = resolvedKept.length > 0;
  }
  const receipt = await readKeptCaptureReceipt(paymentIntentId, store);
  if (receipt.kind === "recorded") return receipt;
  resolvedByHand ||= receipt.kind === "resolved-by-hand";
  const released = await store.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: {
      status: true,
      xeroObjectId: true,
      manuallyResolvedAt: true,
      localModel: true,
      localId: true,
      requestPayload: true,
    },
  });
  const live = released.filter((row) => !row.manuallyResolvedAt);
  const sent =
    live.find((row) => row.xeroObjectId) ??
    (widenToKnownInvoice ? released.find((row) => row.xeroObjectId) : undefined);
  if (sent?.xeroObjectId) return { kind: "recorded", invoiceId: sent.xeroObjectId };
  // Paid another way only: a change whose invoice is linked in Xero though
  // its row FAILED after the link (or was resolved by hand after it).
  const linked = widenToKnownInvoice ? await findActiveSupplementaryInvoiceLink(released, store) : null;
  if (linked) return { kind: "recorded", invoiceId: linked };
  if (live.length > 0) {
    if (!live.every((row) => row.status === "FAILED")) return { kind: "recorded", invoiceId: null };
    return live.some((row) => xeroCreateCallAttempted(row.requestPayload))
      ? { kind: "recorded", invoiceId: null, invoiceFailed: true, invoiceMayBeInXero: true }
      : { kind: "recorded", invoiceId: null, invoiceFailed: true };
  }
  if (resolvedByHand || released.length > 0) return { kind: "resolved-by-hand" };
  return { kind: "none" };
}

/**
 * #4324: the capture's own receipt (`ADDITIONAL_CAPTURE_RECEIPT`), as the
 * verdict above reads it: its payment link on the capture's
 * `PaymentTransaction` (`readAdditionalCaptureReceiptLinkedInvoiceId`, the one
 * read of it; every receipt row is keyed on that row), else how its rows stand.
 */
async function readKeptCaptureReceipt(paymentIntentId: string, store: ReceiptStore): Promise<LateCaptureXeroReceipt> {
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { localId: true, status: true, manuallyResolvedAt: true, requestPayload: true },
  });
  const transactionId = rows.find((row) => row.localId)?.localId;
  if (!transactionId) return { kind: "none" };
  const linkedInvoiceId = await readAdditionalCaptureReceiptLinkedInvoiceId(transactionId, store);
  if (linkedInvoiceId) return { kind: "recorded", invoiceId: linkedInvoiceId };
  const live = rows.filter((row) => row.status !== "CANCELLED");
  if (live.some((row) => row.manuallyResolvedAt !== null)) return { kind: "resolved-by-hand" };
  const decided = live.filter((row) => asRecord(row.requestPayload)?.plan != null && row.status !== "SUCCEEDED");
  if (decided.length === 0) return { kind: "none" };
  return decided.every((row) => row.status === "FAILED")
    ? { kind: "recorded", invoiceId: null, invoiceFailed: true, invoiceMayBeInXero: true }
    : { kind: "recorded", invoiceId: null };
}

/**
 * #3924 round 10: the Xero invoice of a change released for the capture, as
 * its active `SUPPLEMENTARY_INVOICE` link names it - the link
 * `createXeroSupplementaryInvoice` writes on the change (`localModel`,
 * `localId`) once Xero has returned the invoice. Null without one. Round 11:
 * also the change-invoice retry's refusal (`linkedChangeInvoiceRetryRefusal`).
 */
export async function findActiveSupplementaryInvoiceLink(
  rows: readonly { localModel: string | null; localId: string | null }[],
  store: Pick<Prisma.TransactionClient, "xeroObjectLink"> = prisma,
): Promise<string | null> {
  const anchors = rows.filter(
    (row): row is { localModel: string; localId: string } => row.localModel !== null && row.localId !== null,
  );
  if (anchors.length === 0) return null;
  const link = await store.xeroObjectLink.findFirst({
    where: {
      OR: anchors.map((row) => ({ localModel: row.localModel, localId: row.localId })),
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    orderBy: { createdAt: "desc" },
    select: { xeroObjectId: true },
  });
  return link?.xeroObjectId ?? null;
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
 * whose record was lost (a crash, or a write audited
 * `booking.payment.auto_refund_record_failed`) has no row until Stripe's
 * redelivery or the nightly self-heal writes it (#4149,
 * `late-capture-record-recovery.ts`); until then it cannot be told apart here.
 */
export async function findLateCapturePaymentIntents(
  paymentIntentIds: readonly string[],
  store: Pick<Prisma.TransactionClient, "manualRefundTask"> = prisma,
): Promise<Set<string>> {
  return findLateCaptureTaskIntents(paymentIntentIds, store);
}

/**
 * #4149: the intents whose late capture already HAS its record - an approval
 * task in any status, or an automatic-refund row no longer `OPEN` - and which
 * kind. An `OPEN` row under the same `reason` is the confirm route's #2700
 * question, which the automatic refund answers by closing it: while it is still
 * `OPEN` after the refund, the record was lost, so the lost-record recovery
 * treats the capture as unrecorded and the record writer closes the row.
 *
 * `"hand-completed"` is a `COMPLETED` automatic-reason row that carries NO
 * approval marker: the record writer never completes a row, so an operator
 * handed the capture back by hand - beside a refund the late-capture door sent,
 * #2774's residual double payment. The approval-marked row itself is #3639's
 * treasurer task (`holdLateCaptureForTreasurerIfRequired` puts the marker on the
 * confirm route's own `OPEN` row, which the approval completes), so it is
 * `"record"` whatever its status; a SEPARATE unmarked hand-`COMPLETED` row on
 * the same capture still makes it `"hand-completed"`, because the treasurer's
 * refund and an operator's hand-back are then two payments.
 */
export async function findClosedLateCaptureRecords(
  paymentIntentIds: readonly string[],
): Promise<Map<string, "record" | "hand-completed">> {
  const found = new Map<string, "record" | "hand-completed">();
  for (const task of await findLateCaptureTaskRows(paymentIntentIds, prisma)) {
    if (task.approvalIntentId) {
      if (!found.has(task.approvalIntentId)) found.set(task.approvalIntentId, "record");
      continue;
    }
    if (!task.reasonIntentId || task.status === ManualRefundTaskStatus.OPEN) continue;
    if (task.status === ManualRefundTaskStatus.COMPLETED) found.set(task.reasonIntentId, "hand-completed");
    else if (!found.has(task.reasonIntentId)) found.set(task.reasonIntentId, "record");
  }
  return found;
}

async function findLateCaptureTaskIntents(
  paymentIntentIds: readonly string[],
  store: Pick<Prisma.TransactionClient, "manualRefundTask">,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const task of await findLateCaptureTaskRows(paymentIntentIds, store)) {
    if (task.approvalIntentId) found.add(task.approvalIntentId);
    if (task.reasonIntentId) found.add(task.reasonIntentId);
  }
  return found;
}

/** Every task row naming one of these intents: by approval marker, or by an automatic-refund `reason`. */
async function findLateCaptureTaskRows(
  paymentIntentIds: readonly string[],
  store: Pick<Prisma.TransactionClient, "manualRefundTask">,
): Promise<{ approvalIntentId: string | null; reasonIntentId: string | null; status: ManualRefundTaskStatus }[]> {
  const ids = [...new Set(paymentIntentIds)];
  if (ids.length === 0) return [];
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
    select: { lateCaptureApprovalIntentId: true, reason: true, status: true },
  });
  return (tasks ?? []).map((task) => ({
    approvalIntentId:
      task.lateCaptureApprovalIntentId && ids.includes(task.lateCaptureApprovalIntentId)
        ? task.lateCaptureApprovalIntentId
        : null,
    reasonIntentId: (task.reason ? byReason.get(task.reason) : undefined) ?? null,
    status: task.status,
  }));
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
