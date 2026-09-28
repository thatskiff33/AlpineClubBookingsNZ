import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import type { ClubTimeZone } from "@/lib/club-time";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
} from "@/lib/xero-kept-late-capture-invoice";
import { creditBackLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import {
  decideLateCapture,
  bookingHasPrimaryXeroInvoice,
  keptLateCaptureRecordRoute,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * A LATE CAPTURE A TREASURER KEPT IS RECORDED IN XERO BY THE APP (#3635, owner
 * decision 29 Sep 2026, `INV-PAY-110`): "When a treasurer keeps a late card
 * capture on a cancelled booking, the app raises a Xero invoice for the kept
 * amount and marks it paid from the Stripe account, the same way a normal card
 * payment is recorded."
 *
 * Keeping is DISMISSING the #3639 approval task (`lateCaptureApprovalIntentId`).
 * The receipt is recorded GROSS, dated the capture day, and every refund of it
 * is answered by its own refund credit note (orchestrator decision 29 Sep
 * 2026). Which document records it is `keptLateCaptureRecordRoute`:
 *
 * - A CHANGE payment on a booking Xero invoiced already has its document: the
 *   change's supplementary invoice, parked WAITING_PAYMENT on the intent (or
 *   retired by the reaper before #3635 stopped it retiring an undecided one).
 *   The dismissal releases it after commit, or re-queues the retired row, then
 *   credits back any refund already taken.
 * - The booking's OWN payment, and a change payment on a booking Xero never
 *   invoiced, get the kept-capture invoice (`xero-kept-late-capture-invoice.ts`),
 *   queued INSIDE the dismissal's claim so it commits with the decision.
 */

/** What the post-commit half of a keep must do. */
export type KeptLateCaptureXeroPlan =
  | { kind: "none" }
  | { kind: "change-payment"; paymentIntentId: string }
  | { kind: "kept-invoice-queued"; queueOperationId: string | null };

/**
 * THE IN-TRANSACTION HALF of a keep, run by `resolveManualRefundTask` after its
 * status-fenced DISMISSED claim won, on the claim's own transaction (which
 * therefore holds the task row). A replayed dismissal loses that claim and
 * never reaches here; a keep after a reopen finds the task's live row and
 * queues nothing more. `clubZone` is read before the transaction
 * (`INV-LOCK-004`).
 */
export async function planKeptLateCaptureXeroRecord(params: {
  manualRefundTaskId: string;
  bookingId: string;
  paymentIntentId: string;
  actingMemberId: string;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<KeptLateCaptureXeroPlan> {
  const { store } = params;
  const [transaction, task] = await Promise.all([
    store.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: params.paymentIntentId },
      select: { kind: true, status: true, amountCents: true, paymentId: true },
    }),
    store.manualRefundTask.findUnique({
      where: { id: params.manualRefundTaskId },
      select: { createdAt: true },
    }),
  ]);
  const decision = decideLateCapture({
    taskStatus: "DISMISSED",
    bookingStatus: "CANCELLED",
    superseded: false,
    capture: transaction,
  });
  if (!transaction || !task || decision.recordCents === 0) return { kind: "none" };

  const payment = await store.payment.findUnique({
    where: { id: transaction.paymentId },
    select: { xeroInvoiceId: true },
  });
  const paymentLinks = await store.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: transaction.paymentId,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { role: true, xeroObjectType: true, active: true },
  });
  const route = keptLateCaptureRecordRoute({
    captureKind: transaction.kind,
    bookingHasPrimaryInvoice: bookingHasPrimaryXeroInvoice({
      paymentXeroInvoiceId: payment?.xeroInvoiceId,
      paymentLinks,
    }),
  });
  if (route === "change-invoice") {
    return { kind: "change-payment", paymentIntentId: params.paymentIntentId };
  }
  const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: params.manualRefundTaskId,
    bookingId: params.bookingId,
    paymentIntentId: params.paymentIntentId,
    capturedCents: decision.recordCents,
    capturedOn: keptLateCaptureDocumentDate(task.createdAt, params.clubZone),
    createdByMemberId: params.actingMemberId,
    store,
  });
  return { kind: "kept-invoice-queued", queueOperationId: queued.queueOperationId };
}

/**
 * THE POST-COMMIT HALF. Never throws: the decision has committed, and a Xero
 * outage must not turn a recorded keep into a failed request. Whatever this
 * misses the reaper (a waiting change invoice whose capture is kept), the
 * outbox (a queued kept invoice) or the repair tool picks up.
 */
export async function finishKeptLateCaptureXeroRecord(
  plan: KeptLateCaptureXeroPlan,
): Promise<void> {
  try {
    if (plan.kind === "change-payment") {
      const result = await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
        plan.paymentIntentId,
      );
      // A dashboard refund taken before the keep found no receipt then.
      await creditBackLateCaptureRefunds(plan.paymentIntentId);
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
      "Failed to finish recording a kept late capture in Xero; the reaper, the outbox or the repair tool picks it up",
    );
  }
}
