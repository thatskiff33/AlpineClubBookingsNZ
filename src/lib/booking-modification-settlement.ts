import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import {
  queueSupersededAdditionalIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import logger from "@/lib/logger";
import {
  enqueueAdditionalPaymentIntentRecovery,
  enqueueBookingModificationRefundRecovery,
  processPaymentRecoveryOperations,
} from "@/lib/payment-recovery";
import { buildBookingModificationRefundMetadata } from "@/lib/payment-recovery-keys";
import {
  PartialRefundError,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  createPaymentIntent,
  findOrCreateCustomer,
} from "@/lib/stripe";

export type BookingModificationPaymentContext = {
  pendingRefundAmountCents: number;
  paymentId: string | null;
  additionalAmountCents: number;
  hasSucceededPayment: boolean;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  memberId: string;
  bookingModificationId: string;
};

export async function drainSupersededPrimaryIntents({
  bookingId,
  supersededPrimaryPaymentIntents,
}: {
  bookingId: string;
  supersededPrimaryPaymentIntents: { length: number };
}): Promise<void> {
  if (supersededPrimaryPaymentIntents.length === 0) return;
  try {
    await processPaymentRecoveryOperations({
      limit: supersededPrimaryPaymentIntents.length,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to immediately process queued Stripe payment recovery operations",
    );
  }
}

export async function executeBookingModificationRefund({
  bookingId,
  result,
  metadataReason,
  idempotencyKeyPrefix,
  failureMessage,
  recoveryFailureMessage,
}: {
  bookingId: string;
  result: BookingModificationPaymentContext;
  metadataReason: string;
  idempotencyKeyPrefix: string;
  failureMessage: string;
  recoveryFailureMessage: string;
}): Promise<string | undefined> {
  if (result.pendingRefundAmountCents <= 0 || !result.paymentId) {
    return undefined;
  }

  try {
    const refundResult = await refundPaymentTransactions({
      paymentId: result.paymentId,
      amountCents: result.pendingRefundAmountCents,
      // #1507: build the Stripe metadata from the shared helper so a recovery
      // replay (which reconstructs this same reason from the stored key prefix)
      // sends a byte-identical body and Stripe replays the original refund
      // instead of rejecting the reused idempotency key.
      metadata: buildBookingModificationRefundMetadata(bookingId, metadataReason),
      // Scope the Stripe idempotency key to this modification. Without it two
      // reductions on the same booking that resolve to the same refund amount
      // (e.g. removing two identically-priced guests) produce an identical key
      // and Stripe replays the first refund, silently under-refunding the
      // member while the ledger records a second refund that never happened.
      idempotencyKeyPrefix: `${idempotencyKeyPrefix}_${result.bookingModificationId}`,
    });
    return refundResult.refunds[0]?.refundId;
  } catch (refundErr) {
    logger.error(
      { err: refundErr, bookingId, amount: result.pendingRefundAmountCents },
      failureMessage,
    );
    // Enqueue only what is still owed (#1097): slices that already refunded
    // and recorded before the failure must not be requested again, or a
    // multi-transaction recovery would re-derive a shifted allocation over
    // the full amount and over-refund.
    const completedRefundCents =
      refundErr instanceof PartialRefundError
        ? refundErr.completedRefundCents
        : 0;
    const remainingRefundCents =
      result.pendingRefundAmountCents - completedRefundCents;
    if (remainingRefundCents > 0) {
      await enqueueBookingModificationRefundRecovery({
        bookingId,
        paymentId: result.paymentId,
        bookingModificationId: result.bookingModificationId,
        amountCents: remainingRefundCents,
        // The exact prefix this route just used (#1152): recovery retries
        // replay the identical Stripe keys, so a refund that succeeded on
        // Stripe without being recorded is replayed, never re-minted.
        stripeKeyPrefix: `${idempotencyKeyPrefix}_${result.bookingModificationId}`,
      }).catch((enqueueErr) =>
        logger.error(
          { err: enqueueErr, bookingId },
          recoveryFailureMessage,
        ),
      );
    }
    return undefined;
  }
}

export async function createModificationAdditionalPaymentIntent({
  bookingId,
  result,
  reason,
  idempotencyKey,
  failureMessage,
}: {
  bookingId: string;
  result: BookingModificationPaymentContext;
  reason: string;
  idempotencyKey: string;
  failureMessage: string;
}): Promise<{
  additionalPaymentClientSecret: string | undefined;
  additionalPaymentIntentId: string | undefined;
}> {
  if (
    result.additionalAmountCents <= 0 ||
    !result.hasSucceededPayment ||
    !result.paymentId
  ) {
    return {
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    };
  }

  try {
    let customerId = result.paymentCustomerId ?? undefined;
    if (!customerId) {
      const customer = await findOrCreateCustomer({
        email: result.memberEmail,
        name: result.memberName,
        memberId: result.memberId,
      });
      customerId = customer.id;
    }

    const pi = await createPaymentIntent({
      amountCents: result.additionalAmountCents,
      customerId,
      metadata: {
        bookingId,
        type: "modification_additional",
        reason,
      },
      idempotencyKey,
    });

    await queueSupersededAdditionalIntentCancellations({
      bookingId,
      paymentId: result.paymentId,
      newPaymentIntentId: pi.id,
    }).catch((err) =>
      logger.error(
        { err, bookingId, paymentIntentId: pi.id },
        "Failed to queue superseded additional intent cancellations",
      ),
    );

    await upsertPaymentIntentTransaction({
      paymentId: result.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: result.additionalAmountCents,
      status: PaymentStatus.PENDING,
      reason,
      stripeCustomerId: customerId,
    });

    return {
      additionalPaymentClientSecret: pi.client_secret ?? undefined,
      additionalPaymentIntentId: pi.id,
    };
  } catch (piErr) {
    logger.error({ err: piErr, bookingId }, failureMessage);
    // Durable retry (#1096): a transient Stripe failure must not leave the
    // recorded price increase with no instrument to collect it. The recovery
    // cron re-creates the intent with this same modification-scoped Stripe
    // idempotency key, so route retry and cron retry can never double-mint.
    await enqueueAdditionalPaymentIntentRecovery({
      bookingId,
      paymentId: result.paymentId,
      bookingModificationId: result.bookingModificationId,
      amountCents: result.additionalAmountCents,
      stripeIdempotencyKey: idempotencyKey,
    }).catch((enqueueErr) =>
      logger.error(
        { err: enqueueErr, bookingId },
        "Failed to enqueue additional PaymentIntent recovery",
      ),
    );
    return {
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    };
  }
}
