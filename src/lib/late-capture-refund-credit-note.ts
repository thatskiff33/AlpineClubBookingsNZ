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

/**
 * #1350 / #3639: the Xero correction that follows a refund of a late capture on
 * a cancelled booking, whoever issued the refund — the webhook automatically,
 * the treasurer's approval, or the recovery cron replaying that approval.
 *
 * Only when there is something to correct: THIS capture has a Xero receipt
 * (`hasXeroReceiptForLateCapture`, #3635 review F2) - its kept-capture invoice,
 * or its change's released supplementary invoice. Never read from
 * `payment.xeroInvoiceId`: for a late capture that is the pre-cancel invoice the
 * cancel already cleared, and a note against it would take money out of the
 * Stripe account that never went in. The enqueue is delta-capped against the
 * payment's recorded refunds, so a replay or an already-covered state is a no-op.
 *
 * NEVER THROWS. The money has already gone back to the member when this runs,
 * and a Xero outage must not undo or replay that.
 */
export async function queueLateCaptureRefundCreditNote(params: {
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}): Promise<void> {
  try {
    if (!(await hasXeroReceiptForLateCapture(params.paymentIntentId))) return;
    const queued = await enqueueXeroRefundCreditNoteOperation(
      params.paymentId,
      params.amountCents,
    );
    if (queued.queueOperationId && (await isXeroConnected())) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (err) {
    logger.error(
      { err, paymentId: params.paymentId, paymentIntentId: params.paymentIntentId },
      "Failed to queue the corrective Xero refund credit note after refunding a late capture on a cancelled booking",
    );
  }
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
    amountCents: refund.amountCents,
  });
}

/**
 * #3635 (orchestrator decision 29 Sep 2026): a kept capture's refunds, whenever
 * they were taken, are answered by the ordinary refund credit note against its
 * receipt. Called once the receipt exists - by the kept-capture invoice's
 * worker after it sends, and by the keep of a change payment after its invoice
 * is released - so a dashboard refund taken before the keep (which found no
 * receipt then, `stripeRefundNeedsXeroNoteNow`) or an approval that landed
 * while the invoice was sending is credited back. Sized at the capture's own
 * refunded cents and delta-capped by the enqueue against the payment's cash
 * refunds already covered by notes, so a refund already noted is never noted
 * twice. Never throws.
 */
export async function creditBackLateCaptureRefunds(paymentIntentId: string): Promise<void> {
  try {
    const capture = await prisma.paymentTransaction.findFirst({
      where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
      select: { paymentId: true, refundedAmountCents: true },
    });
    if (!capture || capture.refundedAmountCents <= 0) return;
    if (!(await hasXeroReceiptForLateCapture(paymentIntentId))) return;
    const queued = await enqueueXeroRefundCreditNoteOperation(
      capture.paymentId,
      capture.refundedAmountCents,
      { refundMethod: "card" },
    );
    if (queued.queueOperationId && (await isXeroConnected())) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
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
