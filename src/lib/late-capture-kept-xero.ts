import { PaymentTransactionKind, type Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";
import {
  KEPT_PRIMARY_CAPTURE_REFUSAL_TEXT,
  keptPrimaryCaptureInvoiceRefusal,
  keptPrimaryCaptureInvoiceQueued,
  type KeptPrimaryCaptureInvoiceRefusal,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * A LATE CAPTURE A TREASURER KEPT IS RECORDED IN XERO BY THE APP (#3635, owner
 * decision 29 Sep 2026, `INV-PAY-106`): "When a treasurer keeps a late card
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
 *   the retired row. No new document is invented.
 *
 * - The booking's OWN payment (a PRIMARY transaction) never had one: a card
 *   booking is invoiced when its payment is captured, and this one was captured
 *   after the cancel. It gets the ordinary booking invoice
 *   (`enqueueXeroBookingInvoiceOperation`, `BOOKING_INVOICE`), whose worker
 *   bills the booking and records the net Stripe capture against it from the
 *   Stripe bank account - exactly what a normal card booking gets. Enqueued
 *   INSIDE the dismissal's transaction, keyed by the booking's one invoice key,
 *   so it commits with the decision and a replay finds it.
 *
 *   That invoice is only right when it bills EXACTLY the kept money, which
 *   `keptPrimaryCaptureInvoiceRefusal` checks. Where it does not (an invoice
 *   already exists for this payment, possibly cleared by a cancellation note;
 *   applied account credit; the booking was re-priced; the booking was settled
 *   by hand), nothing is queued, an officer is told, and the booking-vs-Xero
 *   repair tool reports it until Xero names the money
 *   (`KEPT_LATE_CAPTURE_WITHOUT_XERO_INVOICE`). A second invoice beside a
 *   cleared one, or a booking-priced invoice for a different sum, would put a
 *   figure in Xero that Stripe did not pay.
 */

/** What the post-commit half of a keep must do. */
export type KeptLateCaptureXeroPlan =
  | { kind: "none" }
  | { kind: "change-payment"; paymentIntentId: string }
  | {
      kind: "booking-invoice-queued";
      bookingId: string;
      paymentIntentId: string;
      queueOperationId: string | null;
    }
  | {
      kind: "booking-invoice-refused";
      bookingId: string;
      paymentIntentId: string;
      keptCents: number;
      refusal: KeptPrimaryCaptureInvoiceRefusal;
    };

/**
 * THE IN-TRANSACTION HALF of a keep, run by `resolveManualRefundTask` after its
 * status-fenced DISMISSED claim won, on the claim's own transaction. A replayed
 * dismissal loses that claim and never reaches here, so nothing is queued
 * twice; the booking invoice's own queued-check and active-link check make a
 * later caller (the repair tool) find this one too.
 */
export async function planKeptLateCaptureXeroRecord(params: {
  bookingId: string;
  paymentIntentId: string;
  actingMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<KeptLateCaptureXeroPlan> {
  const { store } = params;
  const transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: params.paymentIntentId },
    select: { kind: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  // Nothing kept: no capture, or one refunded in full since (a treasurer who
  // refunded it in the Stripe dashboard closes the task without refunding).
  if (!transaction || transaction.refundedAmountCents >= transaction.amountCents) {
    return { kind: "none" };
  }
  if (transaction.kind !== PaymentTransactionKind.PRIMARY) {
    return { kind: "change-payment", paymentIntentId: params.paymentIntentId };
  }

  const booking = await store.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      finalPriceCents: true,
      payment: {
        select: {
          id: true,
          source: true,
          xeroInvoiceId: true,
          manuallyMarkedPaidAt: true,
          creditAppliedCents: true,
          amountCents: true,
          refundedAmountCents: true,
        },
      },
    },
  });
  // Already asked for: a keep after a reopen, or the repair tool got there
  // first. Queue nothing more (a failed one is retried, never replaced).
  const task = await store.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: params.paymentIntentId },
    select: { createdAt: true },
  });
  if (booking?.payment && task) {
    const paymentOperations = await store.xeroSyncOperation.findMany({
      where: {
        localModel: "Payment",
        localId: booking.payment.id,
        entityType: "INVOICE",
        operationType: "CREATE",
      },
      select: {
        direction: true,
        entityType: true,
        operationType: true,
        queueType: true,
        status: true,
        createdAt: true,
      },
    });
    if (keptPrimaryCaptureInvoiceQueued({ raisedAt: task.createdAt, paymentOperations })) {
      return { kind: "none" };
    }
  }

  const keptCents = isCapturedTransactionStatus(transaction.status)
    ? transaction.amountCents - transaction.refundedAmountCents
    : 0;
  const hasPrimaryInvoiceLink = booking?.payment
    ? (await store.xeroObjectLink.count({
        where: {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          role: "PRIMARY_INVOICE",
          active: true,
        },
      })) > 0
    : false;
  const refusal = booking?.payment
    ? keptPrimaryCaptureInvoiceRefusal({
        keptCents,
        finalPriceCents: booking.finalPriceCents,
        payment: booking.payment,
        hasPrimaryInvoiceLink,
      })
    : "not-captured";
  if (refusal) {
    return {
      kind: "booking-invoice-refused",
      bookingId: params.bookingId,
      paymentIntentId: params.paymentIntentId,
      keptCents,
      refusal,
    };
  }

  const queued = await enqueueXeroBookingInvoiceOperation(params.bookingId, {
    createdByMemberId: params.actingMemberId,
    // A card booking's invoice is never emailed at creation (only an Internet
    // Banking one is), so there is no creation-time choice to express.
    invoiceEmailDelivery: null,
    store,
  });
  return {
    kind: "booking-invoice-queued",
    bookingId: params.bookingId,
    paymentIntentId: params.paymentIntentId,
    queueOperationId: queued.queueOperationId,
  };
}

/**
 * THE POST-COMMIT HALF. Never throws: the decision has committed, and a Xero
 * outage must not turn a recorded keep into a failed request. Whatever this
 * misses the reaper (a waiting change invoice whose capture is kept) or the
 * repair tool (a kept primary capture Xero does not name) picks up.
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
    if (plan.kind === "booking-invoice-queued") {
      if (plan.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
      return;
    }
    if (plan.kind === "booking-invoice-refused") {
      logger.error(
        { ...plan },
        "A kept late capture on a cancelled booking could not be invoiced in Xero automatically",
      );
      await sendAdminXeroSyncErrorAlert({
        errorType: "KEPT_LATE_CAPTURE_NOT_INVOICED",
        operation: `Kept late payment ${plan.paymentIntentId} on booking ${plan.bookingId}`,
        errorMessage: `A treasurer kept a card payment (${plan.paymentIntentId}) that went through after booking ${plan.bookingId} was cancelled. Stripe holds this money, and it was not invoiced in Xero automatically because ${KEPT_PRIMARY_CAPTURE_REFUSAL_TEXT[plan.refusal]}. Record it in Xero by hand: an invoice for the kept amount, paid from the Stripe bank account.`,
        timestamp: new Date(),
      });
    }
  } catch (err) {
    logger.error(
      { err, plan },
      "Failed to finish recording a kept late capture in Xero; the reaper or the repair tool picks it up",
    );
  }
}
