import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroRefundCreditNoteOperation,
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";

/**
 * #1350 / #3639: the Xero correction that follows a refund of a late capture on
 * a cancelled booking, whoever issued the refund — the webhook automatically,
 * the treasurer's approval, or the recovery cron replaying that approval.
 *
 * Only when there is something to correct: the payment carries a primary Xero
 * invoice, or a race already released this intent's supplementary invoice. The
 * supplementary operation otherwise stays WAITING_PAYMENT on purpose (the stale
 * reaper retires it). The enqueue is delta-capped against the payment's
 * recorded refunds, so a replay or an already-covered state is a no-op.
 *
 * NEVER THROWS. The money has already gone back to the member when this runs,
 * and a Xero outage must not undo or replay that.
 */
export async function queueLateCaptureRefundCreditNote(params: {
  paymentId: string;
  paymentXeroInvoiceId: string | null;
  paymentIntentId: string;
  amountCents: number;
}): Promise<void> {
  try {
    const needsCorrectiveCreditNote =
      params.paymentXeroInvoiceId !== null ||
      (await hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(
        params.paymentIntentId,
      ));
    if (!needsCorrectiveCreditNote) return;
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
