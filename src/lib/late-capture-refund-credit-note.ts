// The token store, not the `@/lib/xero` facade: this module sits in the
// payment-recovery cron's import graph, and the facade drags the whole Xero SDK
// into every route that imports that cron.
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { hasXeroReceiptForLateCapture } from "@/lib/late-capture-xero-receipt";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { lateCaptureRefundPaymentIntentId } from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import type { Prisma } from "@prisma/client";
import type { ClubTimeZone } from "@/lib/club-time";
import { findLateCaptureRefundPaidAnotherWay } from "@/lib/late-capture-paid-another-way";
import { paidAnotherWayCloseXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import { paidAnotherWayCloseNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";

/**
 * #1350 / #3639 / #3635: the Xero correction that follows a refund of a late
 * capture on a cancelled booking, whoever issued the refund - the webhook
 * automatically, the treasurer's approval, the recovery cron replaying that
 * approval, a dashboard refund's `charge.refunded`, or the kept invoice's
 * credit-back once its receipt is in Xero.
 *
 * ONE SIZING, PER CAPTURE (round-3 R4): the capture's own succeeded refunds
 * (`PaymentRefund.stripePaymentIntentId`) less the refund notes already raised
 * for THIS capture (`sumLateCaptureNotedCents`, read from the `paymentIntentId`
 * each such note records). So a replay, a re-keep or a PARTIAL retry of the
 * receipt asks for nothing already noted, whatever else on the payment is
 * uncovered. The enqueue then caps it against the payment as a whole.
 *
 * Only when there is something to correct: THIS capture has a Xero receipt the
 * app recorded (`hasXeroReceiptForLateCapture`, review F2) - its kept-capture
 * invoice, or its change's released supplementary invoice. Never read from
 * `payment.xeroInvoiceId`: for a late capture that is the pre-cancel invoice the
 * cancel already cleared. Dated the day the latest refund left Stripe (R3), so
 * a refund credited back later lands in the period the payout does.
 *
 * NEVER THROWS. The money has already gone back to the member when this runs,
 * and a Xero outage must not undo or replay that. It says what it did (#3635
 * N4) so a caller reporting to an operator claims no note it did not queue:
 * `queued`, `nothing-owed` (no receipt, or every refunded cent already noted),
 * or `failed` (logged; the note must be raised by hand).
 */
export type LateCaptureNoteResult = "queued" | "nothing-owed" | "failed";

export async function noteLateCaptureRefunds(params: {
  paymentId: string;
  paymentIntentId: string;
}): Promise<LateCaptureNoteResult> {
  const { paymentId, paymentIntentId } = params;
  try {
    if (!(await hasXeroReceiptForLateCapture(paymentIntentId))) return "nothing-owed";
    const refunds = await prisma.paymentRefund.findMany({
      where: { paymentId, stripePaymentIntentId: paymentIntentId },
      select: { amountCents: true, status: true, stripeCreatedAt: true, createdAt: true },
    });
    const counted = refunds.filter((refund) => isRecordedRefundStatus(refund.status));
    const refundedCents = counted.reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0);
    const askCents = refundedCents - (await sumLateCaptureNotedCents(paymentId, paymentIntentId));
    if (askCents <= 0) return "nothing-owed";
    const latest = counted
      .map((refund) => refund.stripeCreatedAt ?? refund.createdAt)
      .reduce((max, at) => (at > max ? at : max));
    const documentDate = xeroDocumentDateFromInstant(latest, await readClubTimeZoneOutsideRequest());
    const queued = await enqueueXeroRefundCreditNoteOperation(paymentId, askCents, {
      refundMethod: "card",
      paymentIntentId,
      documentDate,
    });
    if (!queued.queueOperationId) {
      // A refusal over an unreadable hand-resolved note is logged by the
      // enqueue and wants the note raised by hand; anything else is covered.
      return "resolvedInXeroOperationId" in queued && queued.resolvedInXeroOperationId
        ? "failed"
        : "nothing-owed";
    }
    if (await isXeroConnected()) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
    return "queued";
  } catch (err) {
    logger.error(
      { err, paymentId, paymentIntentId },
      "Failed to queue the corrective Xero refund credit note for a late capture on a cancelled booking",
    );
    return "failed";
  }
}

/**
 * The refund cents already noted for ONE late capture (round-3 R4): every
 * refund-note create on the payment that records this `paymentIntentId`, at
 * the amount it recorded (`parsePaymentCreditNoteRetryInput`, both payload
 * shapes), in any state but withdrawn: a queued or failed one is not asked for
 * again, and one resolved by hand in Xero covers its amount. A row that
 * completed without raising a note (nothing uncovered, or skipped) covers
 * nothing.
 */
export async function sumLateCaptureNotedCents(
  paymentId: string,
  paymentIntentId: string,
): Promise<number> {
  const notes = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { status: true, xeroObjectId: true, requestPayload: true, manuallyResolvedAt: true },
  });
  let notedCents = 0;
  for (const note of notes ?? []) {
    if (note.status === "SUCCEEDED" && !note.xeroObjectId && !note.manuallyResolvedAt) continue;
    notedCents += parsePaymentCreditNoteRetryInput(note)?.amountCents ?? 0;
  }
  return notedCents;
}

/** The approval's and the webhook's name for the one sizing above. */
export async function queueLateCaptureRefundCreditNote(params: {
  paymentId: string;
  paymentIntentId: string;
}): Promise<void> {
  await noteLateCaptureRefunds(params);
}

/**
 * #3639: the record and the Xero correction of a treasurer-approved late-capture
 * refund, written wherever that refund actually went out - inline after the
 * approval, or by the recovery cron replaying it (review F4). The audit entry is
 * the one the automatic refund writes, naming who approved it.
 */
export async function finishApprovedLateCaptureRefund(refund: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  refundId: string | null;
  captureKind: "primary" | "modification" | null;
  approvedByMemberId: string | null;
  manualRefundTaskId: string | null;
}): Promise<void> {
  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    category: "payment",
    memberId: refund.approvedByMemberId ?? undefined,
    entityType: "Booking",
    entityId: refund.bookingId,
    targetId: refund.bookingId,
    details: JSON.stringify({
      paymentIntentId: refund.paymentIntentId,
      refundId: refund.refundId,
      amountCents: refund.amountCents,
      kind:
        refund.captureKind === null
          ? null
          : refund.captureKind === "primary"
            ? "primary"
            : "modification_additional",
      approvedByMemberId: refund.approvedByMemberId,
      manualRefundTaskId: refund.manualRefundTaskId,
    }),
  });
  await queueLateCaptureRefundCreditNote({
    paymentId: refund.paymentId,
    paymentIntentId: refund.paymentIntentId,
  });
}

/**
 * #3635 (orchestrator decision 29 Sep 2026): a kept capture's refunds, whenever
 * they were taken, are answered by the ordinary refund credit note against its
 * receipt. Called once the receipt exists - by the kept-capture invoice's
 * worker after it sends, and by the keep of a change payment after its invoice
 * is released - so a dashboard refund taken before the keep (which found no
 * receipt then, `stripeRefundNeedsXeroNoteNow`) or an approval that landed
 * while the invoice was sending is credited back. Sized per capture and dated
 * the refund's day (`noteLateCaptureRefunds`), so a refund already noted is
 * never noted twice. Never throws.
 */
export async function creditBackLateCaptureRefunds(paymentIntentId: string): Promise<void> {
  try {
    const capture = await prisma.paymentTransaction.findFirst({
      where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
      select: { paymentId: true },
    });
    if (!capture) return;
    await noteLateCaptureRefunds({ paymentId: capture.paymentId, paymentIntentId });
  } catch (err) {
    logger.error(
      { err, paymentIntentId },
      "Failed to queue the Xero refund credit note for a kept late capture's refunds",
    );
  }
}

/**
 * The recovery cron's replay of a treasurer-approved refund the inline attempt
 * did not finish. The operation's own `paymentIntentId` is the payment's
 * representative intent, so the late capture's is read back off its prefix, and
 * the approving officer off the task that owns it.
 */
export async function finishApprovedLateCaptureRefundAfterReplay(operation: {
  bookingId: string;
  paymentId: string;
  stripeKeyPrefix: string | null;
  amountCents: number;
}): Promise<void> {
  const paymentIntentId = lateCaptureRefundPaymentIntentId(
    operation.stripeKeyPrefix ?? "",
    operation.bookingId,
  );
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true, completedByMemberId: true },
  });
  await finishApprovedLateCaptureRefund({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId,
    amountCents: operation.amountCents,
    refundId: null,
    captureKind: null,
    approvedByMemberId: task?.completedByMemberId ?? null,
    manualRefundTaskId: task?.id ?? null,
  });
}

/**
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit";
 * `INV-PAY-122`): THE SECOND STEP for a late capture whose approved refund
 * Stripe gave up on and the treasurer closed as paid another way. The close
 * queued the capture's receipt; this queues the close's bank-transfer refund
 * note against it (`INV-PAY-101`), for exactly the amount paid back, keyed on
 * the close's record (`paidAnotherWayTaskId`), dated the day it closed, and
 * naming the receipt's invoice (`creditsInvoiceId`, round 7, money M5) - never
 * its `paymentIntentId`, which would count it as the capture's card note.
 *
 * Run ONLY once the receipt is in Xero, under the approval task's row lock
 * (`queueWaitingPaidAnotherWayNote`): by the receipt's worker once its link is
 * written, or (round 8) by a change's supplementary invoice for the capture
 * once it is sent. Until then the close's bank cash is outside what any refund
 * note may answer (`readPaidAnotherWayCash`), so the note cannot be sized
 * earlier by anyone.
 *
 * Only a close whose key says its note waits for the receipt
 * (`after-receipt`): one that queued its note itself, or raises none, is left
 * alone. AT MOST ONCE (round 7, C9): the worker runs this on every run of the
 * receipt's row, so a note row already asked for this record - in any state
 * but withdrawn; a failed one is retried as its own row - is returned, never a
 * second. Returns the queued row's id, or null when none is. Throws: the
 * worker then fails its row with the link standing, and the row's retry runs
 * this again.
 */
export async function notePaidAnotherWayCloseOnReceipt(params: {
  paymentIntentId: string;
  /** The receipt's Xero invoice, which the note credits. */
  receiptInvoiceId: string;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<string | null> {
  const close = await findLateCaptureRefundPaidAnotherWay(params.paymentIntentId, params.store);
  if (!close || paidAnotherWayCloseXeroNote(close) !== "after-receipt" || close.paymentId === null) return null;
  const amountCents = Math.max(0, close.amountCents ?? 0);
  if (amountCents === 0) return null;
  // Round 8 (`INV-SSOT`): the close's rows, found the one way they are.
  const asked = await params.store.xeroSyncOperation.findFirst({
    where: { ...paidAnotherWayCloseNoteRowsWhere(close.paymentId, close.id), status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (asked) return asked.id;
  const queued = await enqueueXeroRefundCreditNoteOperation(close.paymentId, amountCents, {
    refundMethod: "internet-banking",
    paidAnotherWayTaskId: close.id,
    creditsInvoiceId: params.receiptInvoiceId,
    ...(close.completedAt
      ? { documentDate: xeroDocumentDateFromInstant(close.completedAt, params.clubZone) }
      : {}),
    ...(close.completedByMemberId ? { createdByMemberId: close.completedByMemberId } : {}),
    store: params.store,
  });
  return queued.queueOperationId;
}
