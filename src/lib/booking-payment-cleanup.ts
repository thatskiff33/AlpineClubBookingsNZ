import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  enqueuePaymentIntentCancellationRecovery,
  runPaymentRecoveryOperationNow,
} from "@/lib/payment-recovery";

export type SupersededPrimaryPaymentIntent = {
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
};

/**
 * When a booking modification drops a booking's final price to zero, any
 * primary Stripe PaymentIntents still in PENDING/PROCESSING are now
 * superseded and need to be cancelled.
 *
 * Both /modify and /modify-dates call this so a future change that adds
 * a zero-dollar path to modify-dates cannot leave intents accumulating.
 * No-op when newFinalPriceCents > 0.
 */
export async function queueSupersededPrimaryIntentCancellations(
  tx: Prisma.TransactionClient,
  options: {
    bookingId: string;
    paymentId: string;
    newFinalPriceCents: number;
  },
): Promise<SupersededPrimaryPaymentIntent[]> {
  const pendingPrimaryTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId: options.paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      stripePaymentIntentId: { not: null },
      // A pending intent is only reusable at exactly the current price:
      // any modification that moves finalPriceCents strands the old intent
      // at the old amount, and capturing it charges the member the wrong
      // total (#1161). Price->0 supersedes every positive pending intent,
      // which is the pre-#1161 behaviour unchanged.
      amountCents: { gt: 0, not: options.newFinalPriceCents },
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const superseded: SupersededPrimaryPaymentIntent[] = [];

  for (const transaction of pendingPrimaryTransactions) {
    if (!transaction.stripePaymentIntentId) {
      continue;
    }

    superseded.push({
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
    });

    await enqueuePaymentIntentCancellationRecovery({
      bookingId: options.bookingId,
      paymentId: options.paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      store: tx,
    });
  }

  return superseded;
}

/**
 * Before issuing a new ADDITIONAL PaymentIntent for a booking
 * modification, cancel any existing PENDING/PROCESSING ADDITIONAL
 * transactions on the same payment whose PaymentIntent id differs from
 * the new one. Without this, an abandoned previous additional intent
 * (member closed the browser before confirming) lingers as PENDING
 * locally until Stripe's 24h auto-cancel and the webhook delivery hit,
 * which leaves a stale PaymentTransaction if delivery fails or is
 * delayed. The cancellation runs through the durable recovery queue.
 *
 * #3340 - IT NOW CANCELS SYNCHRONOUSLY AS WELL, and the order matters. The
 * durable row is enqueued FIRST and is still the guarantee; the immediate
 * attempt that follows only closes the window in which the old client secret is
 * confirmable. Before this, "queued" meant "up to five minutes" - measured at 4
 * minutes 5 seconds in the live case, long enough for a member to be charged $65
 * against the superseded intent while the page read $300.
 *
 * The caller awaits this BEFORE it returns the new client secret, so an intent a
 * browser may still be holding is dead by the time the replacement exists.
 * Best-effort throughout: a Stripe outage leaves exactly the pre-#3340
 * behaviour, a queued operation the recovery cron completes.
 */
export async function queueSupersededAdditionalIntentCancellations(options: {
  bookingId: string;
  paymentId: string;
  newPaymentIntentId: string;
}): Promise<{ paymentTransactionId: string; paymentIntentId: string }[]> {
  const pendingAdditional = await prisma.paymentTransaction.findMany({
    where: {
      paymentId: options.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      stripePaymentIntentId: { not: options.newPaymentIntentId },
      amountCents: { gt: 0 },
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const queued: { paymentTransactionId: string; paymentIntentId: string }[] =
    [];
  for (const transaction of pendingAdditional) {
    if (!transaction.stripePaymentIntentId) {
      continue;
    }

    const operation = await enqueuePaymentIntentCancellationRecovery({
      bookingId: options.bookingId,
      paymentId: options.paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
    });
    queued.push({
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
    });

    // The durable row above is the guarantee; this is latency only (#3340).
    // `runPaymentRecoveryOperationNow` never throws, so a Stripe failure here
    // leaves precisely the pre-#3340 arrangement.
    await runPaymentRecoveryOperationNow(operation.id).catch((err) =>
      logger.error(
        {
          err,
          bookingId: options.bookingId,
          paymentIntentId: transaction.stripePaymentIntentId,
        },
        "Immediate cancellation of a superseded additional PaymentIntent did not run; the queued recovery operation stands",
      ),
    );
  }

  return queued;
}
