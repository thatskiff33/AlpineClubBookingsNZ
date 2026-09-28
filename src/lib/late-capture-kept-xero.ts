import { PaymentTransactionKind, type Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";
import { enqueueXeroKeptLateCaptureInvoiceOperation } from "@/lib/xero-kept-late-capture-invoice";
import { keptLateCaptureCents } from "@/lib/late-capture-kept-xero-rules";

/**
 * A LATE CAPTURE A TREASURER KEPT IS RECORDED IN XERO BY THE APP (#3635, owner
 * decision 29 Sep 2026, `INV-PAY-110`): "When a treasurer keeps a late card
 * capture on a cancelled booking, the app raises a Xero invoice for the kept
 * amount and marks it paid from the Stripe account, the same way a normal card
 * payment is recorded."
 *
 * Keeping is DISMISSING the #3639 approval task (`lateCaptureApprovalIntentId`).
 * What follows depends on which capture it was:
 *
 * - A CHANGE payment (an ADDITIONAL transaction) already has its document: the
 *   booking change's supplementary invoice, parked WAITING_PAYMENT on the
 *   intent (or retired by the reaper before #3635 stopped it retiring an
 *   undecided one). The dismissal releases it after commit through the one
 *   late-capture release, which issues it with the Stripe receipt, or re-queues
 *   the retired row.
 *
 * - The booking's OWN payment (a PRIMARY transaction) gets its own invoice for
 *   exactly the kept cents, paid from the Stripe account, anchored on the task
 *   (`xero-kept-late-capture-invoice.ts`), queued INSIDE the dismissal's claim
 *   so it commits with the decision. Every such capture is recorded: no primary
 *   invoice, a cleared one, credit used or a changed price make no difference,
 *   because the document bills the kept cash and nothing else.
 */

/** What the post-commit half of a keep must do. */
export type KeptLateCaptureXeroPlan =
  | { kind: "none" }
  | { kind: "change-payment"; paymentIntentId: string }
  | { kind: "kept-invoice-queued"; queueOperationId: string | null };

/**
 * THE IN-TRANSACTION HALF of a keep, run by `resolveManualRefundTask` after its
 * status-fenced DISMISSED claim won, on the claim's own transaction. A replayed
 * dismissal loses that claim and never reaches here; a keep after a reopen
 * finds the task's earlier row and queues nothing more.
 */
export async function planKeptLateCaptureXeroRecord(params: {
  manualRefundTaskId: string;
  bookingId: string;
  paymentIntentId: string;
  actingMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<KeptLateCaptureXeroPlan> {
  const transaction = await params.store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: params.paymentIntentId },
    select: { kind: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  const keptCents =
    transaction && isCapturedTransactionStatus(transaction.status)
      ? keptLateCaptureCents(transaction)
      : 0;
  if (!transaction || keptCents === 0) return { kind: "none" };
  if (transaction.kind !== PaymentTransactionKind.PRIMARY) {
    return { kind: "change-payment", paymentIntentId: params.paymentIntentId };
  }
  const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: params.manualRefundTaskId,
    bookingId: params.bookingId,
    paymentIntentId: params.paymentIntentId,
    keptCents,
    createdByMemberId: params.actingMemberId,
    store: params.store,
  });
  return { kind: "kept-invoice-queued", queueOperationId: queued.queueOperationId };
}

/**
 * THE POST-COMMIT HALF. Never throws: the decision has committed, and a Xero
 * outage must not turn a recorded keep into a failed request. Whatever this
 * misses the reaper (a waiting change invoice whose capture is kept) or the
 * outbox (a queued kept invoice) picks up.
 */
export async function finishKeptLateCaptureXeroRecord(
  plan: KeptLateCaptureXeroPlan,
): Promise<void> {
  try {
    if (plan.kind === "change-payment") {
      const result = await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
        plan.paymentIntentId,
      );
      if (result.queueOperationIds.length > 0) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
      return;
    }
    if (plan.kind === "kept-invoice-queued" && plan.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (err) {
    logger.error(
      { err, plan },
      "Failed to finish recording a kept late capture in Xero; the reaper or the outbox picks it up",
    );
  }
}
