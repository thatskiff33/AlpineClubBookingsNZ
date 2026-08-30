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
import {
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildBookingModificationRefundMetadata,
} from "@/lib/payment-recovery-keys";
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
  /**
   * #3181: whether this booking's PRIMARY Xero invoice had already been issued
   * when this edit dispatched. Read only when the mint FAILS, to freeze the
   * edit's own answer on the recovery row - the replay that later raises the
   * deferred supplementary invoice must bill what the edit decided, not what is
   * true when the cron reaches it. Required rather than optional so a new caller
   * cannot omit it into a silent `false` (`INV-SSOT`).
   *
   * `null` ONLY from the recovery replay's own re-entry, where the recovery row
   * already exists and this value is therefore never written. It is not a third
   * answer to the question; it is "the row that carries the answer is already
   * there". Every ordinary edit path passes the boolean it fed
   * `queueXeroBookingEditSettlement`.
   */
  hasIssuedXeroInvoice: boolean | null;
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

/**
 * Mint the additional PaymentIntent that collects a booking edit's price
 * increase, and write the PENDING `ADDITIONAL` PaymentTransaction the club's
 * whole additional-payment machinery keys off - the chase reminders, the resend
 * service, the member's /pay link and the Xero supplementary invoice's
 * wait-for-payment.
 *
 * #3170 RE-ENTERS THIS RATHER THAN ADDING A COLLECTION PATH. A completed
 * `EDIT_FINANCIAL_REVIEW` task whose officer decided the MEMBER owes the club
 * comes through here, so a review charge and an ordinary price increase are the
 * same instrument, chased by the same cron and reconciled the same way. The epic
 * forbids a fourth settlement mechanism, and this is the third's charging half.
 *
 * IT PASSES EDIT-SCOPED KEYS, NOT TASK-SCOPED ONES, and an earlier draft of this
 * docblock said the opposite. The owner's 30 Aug 2026 decision is that one
 * booking edit raises ONE request, so both of a review's two tasks contribute
 * shares to a single ask anchored to the `BookingModification`. Task-scoping
 * these keys would mint a second intent for the second share, and minting queues
 * every other outstanding additional on that payment for cancellation - which is
 * how $230 of debt became a $30 ask. `payment-recovery-keys.ts` holds the full
 * reasoning and both builders.
 *
 * THE CALLER READS THE RESULT, and must. This function swallows a provider
 * failure by design - the ordinary edit path has to return the member's saved
 * change, and the recovery row it writes is the retry. A caller for whom
 * "minted nothing" is not an acceptable outcome (the review charge's recovery
 * replay is the one such caller) has to test `additionalPaymentIntentId` rather
 * than wait for an exception that never comes.
 */
export async function createModificationAdditionalPaymentIntent({
  bookingId,
  result,
  reason,
  idempotencyKey,
  recoveryIdempotencyKey,
  failureMessage,
}: {
  bookingId: string;
  result: BookingModificationPaymentContext;
  reason: string;
  idempotencyKey: string;
  /**
   * #3170: the dedup key for the durable retry, when it must not be the
   * modification-scoped default.
   *
   * The review-charge caller passes
   * `buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey`, which is
   * EDIT-scoped - a different namespace from the ordinary edit's key over the
   * same `BookingModification`, so the two paths' debts stay separate rows, but
   * deliberately the SAME row for both review tasks of one edit, because they
   * are two shares of one debt. Omitted by the ordinary edit paths, which are
   * one-per-modification by construction.
   */
  recoveryIdempotencyKey?: string;
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
      idempotencyKey:
        recoveryIdempotencyKey ??
        buildAdditionalIntentRecoveryIdempotencyKey(
          result.bookingModificationId,
        ),
      amountCents: result.additionalAmountCents,
      stripeIdempotencyKey: idempotencyKey,
      // #3181: the EDIT's answer, frozen here because this is the last moment it
      // is known. The replay reads it back rather than re-deriving one.
      hadIssuedXeroInvoice: result.hasIssuedXeroInvoice,
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
