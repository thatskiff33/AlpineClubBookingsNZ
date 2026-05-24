import {
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
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
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      amountCents: { gt: 0 },
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const superseded: SupersededPrimaryPaymentIntent[] =
    pendingPrimaryTransactions.map((transaction) => ({
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
    }));

  for (const transaction of pendingPrimaryTransactions) {
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
