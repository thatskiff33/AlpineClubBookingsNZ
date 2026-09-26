// The token store, not the `@/lib/xero` facade: this module sits in the
// payment-recovery cron's import graph, and the facade drags the whole Xero SDK
// into every route that imports that cron.
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  enqueueXeroRefundCreditNoteOperation,
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";
import { lateCaptureRefundPaymentIntentId } from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";

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

/**
 * The recovery cron's replay of a treasurer-approved refund the inline attempt
 * did not finish. The operation's own `paymentIntentId` is the payment's
 * representative intent, so the late capture's is read back off its prefix.
 */
export async function queueLateCaptureRefundCreditNoteAfterReplay(operation: {
  bookingId: string;
  paymentId: string;
  stripeKeyPrefix: string | null;
  amountCents: number;
}): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    select: { xeroInvoiceId: true },
  });
  await queueLateCaptureRefundCreditNote({
    paymentId: operation.paymentId,
    paymentXeroInvoiceId: payment?.xeroInvoiceId ?? null,
    paymentIntentId: lateCaptureRefundPaymentIntentId(
      operation.stripeKeyPrefix ?? "",
      operation.bookingId,
    ),
    amountCents: operation.amountCents,
  });
}
