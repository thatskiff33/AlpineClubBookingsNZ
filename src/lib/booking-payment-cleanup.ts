import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueuePaymentIntentCancellationRecovery } from "@/lib/payment-recovery";

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
  if (options.newFinalPriceCents > 0) {
    return [];
  }

  const pendingPrimaryTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId: options.paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      stripePaymentIntentId: { not: null },
      amountCents: { gt: 0 },
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

    await enqueuePaymentIntentCancellationRecovery({
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
  }

  return queued;
}
