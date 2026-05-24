import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import {
  cancelPaymentIntentIfCancellableWithResult,
  processRefund,
} from "@/lib/stripe";
import {
  reconcilePaymentAggregates,
  recordStripeRefundLedgerEntry,
} from "@/lib/payment-transactions";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";

type PaymentRecoveryStore = Prisma.TransactionClient | typeof prisma;

const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;
const STALE_PROCESSING_MINUTES = 30;
const RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720];

const CAPTURED_TRANSACTION_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

type PaymentRecoveryOperationRecord = PaymentRecoveryOperation;

export interface PaymentRecoveryProcessResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

function buildCancelIdempotencyKey(
  paymentTransactionId: string,
  paymentIntentId: string
) {
  return `payment_recovery_cancel_${paymentTransactionId}_${paymentIntentId}`;
}

function buildRefundIdempotencyKey(
  paymentTransactionId: string,
  paymentIntentId: string
) {
  return `payment_recovery_refund_${paymentTransactionId}_${paymentIntentId}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextRetryDate(attempts: number) {
  const delayMinutes =
    RETRY_BACKOFF_MINUTES[
      Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MINUTES.length - 1)
    ];
  return new Date(Date.now() + delayMinutes * 60 * 1000);
}

function refundStatusFor(amountCents: number, refundedAmountCents: number) {
  return refundedAmountCents >= amountCents
    ? PaymentStatus.REFUNDED
    : PaymentStatus.PARTIALLY_REFUNDED;
}

export async function enqueuePaymentIntentCancellationRecovery({
  bookingId,
  paymentId,
  paymentTransactionId,
  paymentIntentId,
  amountCents,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey = buildCancelIdempotencyKey(
    paymentTransactionId,
    paymentIntentId
  );

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
    },
  });
}

async function enqueueSupersededPaymentRefundRecovery({
  bookingId,
  paymentId,
  paymentTransactionId,
  paymentIntentId,
  amountCents,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey = buildRefundIdempotencyKey(
    paymentTransactionId,
    paymentIntentId
  );

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
    },
  });
}

async function completePaymentRecoveryOperation(operationId: string) {
  await prisma.paymentRecoveryOperation.update({
    where: { id: operationId },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

async function alertPaymentRecoveryFailure(
  operation: PaymentRecoveryOperationRecord,
  message: string
) {
  const booking = await prisma.booking.findUnique({
    where: { id: operation.bookingId },
    include: { member: true },
  });

  if (!booking) {
    logger.warn(
      { bookingId: operation.bookingId, operationId: operation.id },
      "Payment recovery failure alert skipped because booking no longer exists"
    );
    return;
  }

  await sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents: operation.amountCents,
    errorMessage: `Stripe payment recovery ${operation.type} failed after ${operation.attempts} attempts: ${message}`,
    paymentIntentId: operation.paymentIntentId,
  });
}

async function failPaymentRecoveryOperation(
  operation: PaymentRecoveryOperationRecord,
  error: unknown
) {
  const message = errorMessage(error);
  const exhausted = operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;

  await prisma.paymentRecoveryOperation.update({
    where: { id: operation.id },
    data: {
      status: PaymentRecoveryOperationStatus.FAILED,
      lastError: message,
      processingStartedAt: null,
      nextRetryAt: exhausted ? null : nextRetryDate(operation.attempts),
    },
  });

  if (exhausted) {
    await alertPaymentRecoveryFailure(operation, message).catch((alertError) =>
      logger.error(
        { err: alertError, operationId: operation.id },
        "Failed to send payment recovery failure alert"
      )
    );
  }

  return exhausted ? "failed" : "retry";
}

async function claimPaymentRecoveryOperation(operationId: string) {
  const now = new Date();
  const claim = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operationId,
      status: {
        in: [
          PaymentRecoveryOperationStatus.PENDING,
          PaymentRecoveryOperationStatus.FAILED,
        ],
      },
      attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      nextRetryAt: { lte: now },
    },
    data: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      attempts: { increment: 1 },
      processingStartedAt: now,
      lastError: null,
    },
  });

  if (claim.count !== 1) {
    return null;
  }

  return prisma.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
  });
}

async function resetStaleProcessingOperations() {
  const staleBefore = new Date(
    Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000
  );

  await prisma.paymentRecoveryOperation.updateMany({
    where: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
      attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
    },
    data: {
      status: PaymentRecoveryOperationStatus.FAILED,
      nextRetryAt: new Date(),
      processingStartedAt: null,
      lastError: "Payment recovery worker timed out before completion.",
    },
  });

  // If a worker died mid-processing on the final attempt the row never
  // moves out of PROCESSING because the `< MAX` guard above excludes it
  // and no exception fires from this process to drive the alert path.
  // Mark these terminally failed and alert.
  const exhaustedStale = await prisma.paymentRecoveryOperation.findMany({
    where: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
      attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
    },
  });

  for (const operation of exhaustedStale) {
    const claimed = await prisma.paymentRecoveryOperation.updateMany({
      where: {
        id: operation.id,
        status: PaymentRecoveryOperationStatus.PROCESSING,
      },
      data: {
        status: PaymentRecoveryOperationStatus.FAILED,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError:
          "Payment recovery worker timed out on the final attempt before completion.",
      },
    });

    if (claimed.count !== 1) continue;

    await alertPaymentRecoveryFailure(
      operation,
      "Payment recovery worker timed out on the final attempt before completion.",
    ).catch((alertError) =>
      logger.error(
        { err: alertError, operationId: operation.id },
        "Failed to send stale payment recovery failure alert",
      ),
    );
  }
}

async function markSupersededTransactionFailed(
  operation: PaymentRecoveryOperationRecord
) {
  if (!operation.paymentTransactionId) {
    return;
  }

  const updated = await prisma.paymentTransaction.updateMany({
    where: {
      id: operation.paymentTransactionId,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    data: {
      status: PaymentStatus.FAILED,
      reason: "zero_dollar_batch_modification_superseded",
    },
  });

  if (updated.count > 0) {
    await reconcilePaymentAggregates({ paymentId: operation.paymentId });
  }
}

async function markSupersededTransactionSucceeded({
  operation,
  amountCents,
  paymentMethodId,
}: {
  operation: PaymentRecoveryOperationRecord;
  amountCents: number;
  paymentMethodId?: string | null;
}) {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  await prisma.paymentTransaction.update({
    where: { id: operation.paymentTransactionId },
    data: {
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      ...(paymentMethodId !== undefined
        ? { paymentMethodId: paymentMethodId ?? null }
        : {}),
      reason: "zero_dollar_batch_modification_late_capture",
    },
  });

  await reconcilePaymentAggregates({ paymentId: operation.paymentId });
}

async function handoffSucceededSupersededIntentToRefund({
  operation,
  amountCents,
  paymentMethodId,
}: {
  operation: PaymentRecoveryOperationRecord;
  amountCents: number;
  paymentMethodId?: string | null;
}) {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  await markSupersededTransactionSucceeded({
    operation,
    amountCents,
    paymentMethodId,
  });

  await enqueueSupersededPaymentRefundRecovery({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentTransactionId: operation.paymentTransactionId,
    paymentIntentId: operation.paymentIntentId,
    amountCents,
  });

  await completePaymentRecoveryOperation(operation.id);
}

async function processCancelPaymentIntentOperation(
  operation: PaymentRecoveryOperationRecord
) {
  const result = await cancelPaymentIntentIfCancellableWithResult(
    operation.paymentIntentId
  );

  if (result.canceled || result.paymentIntent.status === "canceled") {
    await markSupersededTransactionFailed(operation);
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  if (result.paymentIntent.status === "succeeded") {
    await handoffSucceededSupersededIntentToRefund({
      operation,
      amountCents: result.paymentIntent.amount,
      paymentMethodId:
        typeof result.paymentIntent.payment_method === "string"
          ? result.paymentIntent.payment_method
          : result.paymentIntent.payment_method?.id ?? null,
    });
    return;
  }

  throw new Error(
    `PaymentIntent ${operation.paymentIntentId} could not be canceled from status ${result.paymentIntent.status}`
  );
}

async function processRefundSupersededPaymentOperation(
  operation: PaymentRecoveryOperationRecord
) {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id: operation.paymentTransactionId },
  });

  if (!transaction) {
    throw new Error("Payment transaction not found for refund recovery");
  }

  if (!CAPTURED_TRANSACTION_STATUSES.has(transaction.status)) {
    await markSupersededTransactionSucceeded({
      operation,
      amountCents: Math.max(transaction.amountCents, operation.amountCents),
    });
  }

  const refreshedTransaction = await prisma.paymentTransaction.findUnique({
    where: { id: operation.paymentTransactionId },
  });

  if (!refreshedTransaction) {
    throw new Error("Payment transaction not found for refund recovery");
  }

  const outstandingCents = Math.max(
    Math.min(
      operation.amountCents,
      refreshedTransaction.amountCents - refreshedTransaction.refundedAmountCents
    ),
    0
  );

  if (outstandingCents <= 0) {
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  const refund = await processRefund({
    paymentIntentId: operation.paymentIntentId,
    amountCents: outstandingCents,
    reason: "requested_by_customer",
    metadata: {
      bookingId: operation.bookingId,
      reason: "zero_dollar_batch_modification_superseded",
    },
    idempotencyKey: operation.idempotencyKey,
  });

  await recordStripeRefundLedgerEntry({
    paymentId: operation.paymentId,
    paymentTransactionId: refreshedTransaction.id,
    refund,
    fallbackPaymentIntentId: operation.paymentIntentId,
  });

  const nextRefundedAmountCents = Math.min(
    refreshedTransaction.amountCents,
    Math.max(
      refreshedTransaction.refundedAmountCents,
      refreshedTransaction.refundedAmountCents + refund.amount
    )
  );

  await prisma.paymentTransaction.update({
    where: { id: refreshedTransaction.id },
    data: {
      refundedAmountCents: nextRefundedAmountCents,
      status: refundStatusFor(
        refreshedTransaction.amountCents,
        nextRefundedAmountCents
      ),
    },
  });

  await reconcilePaymentAggregates({ paymentId: operation.paymentId });
  await completePaymentRecoveryOperation(operation.id);
}

async function processPaymentRecoveryOperation(
  operation: PaymentRecoveryOperationRecord
) {
  if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
    await processCancelPaymentIntentOperation(operation);
    return;
  }

  await processRefundSupersededPaymentOperation(operation);
}

export async function processPaymentRecoveryOperations(options?: {
  limit?: number;
}): Promise<PaymentRecoveryProcessResult> {
  await resetStaleProcessingOperations();

  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.paymentRecoveryOperation.findMany({
    where: {
      status: {
        in: [
          PaymentRecoveryOperationStatus.PENDING,
          PaymentRecoveryOperationStatus.FAILED,
        ],
      },
      attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      nextRetryAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const result: PaymentRecoveryProcessResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const operation = await claimPaymentRecoveryOperation(queuedOperation.id);
    if (!operation) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    try {
      await processPaymentRecoveryOperation(operation);
      result.succeeded += 1;
    } catch (error) {
      logger.error(
        { err: error, operationId: operation.id, type: operation.type },
        "Payment recovery operation failed"
      );
      const outcome = await failPaymentRecoveryOperation(operation, error);
      if (outcome === "failed") {
        result.failed += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}

export async function completeCanceledSupersededPaymentIntentRecovery({
  paymentIntentId,
}: {
  paymentIntentId: string;
}) {
  const operation = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      paymentIntentId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!operation) {
    return false;
  }

  await markSupersededTransactionFailed(operation);
  await completePaymentRecoveryOperation(operation.id);
  return true;
}

export async function queueSupersededPaymentIntentRefundRecovery({
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId?: string | null;
}) {
  const operation = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      paymentIntentId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!operation) {
    return false;
  }

  await handoffSucceededSupersededIntentToRefund({
    operation,
    amountCents,
    paymentMethodId,
  });

  return true;
}

export function getStripePaymentMethodId(
  paymentIntent: Pick<Stripe.PaymentIntent, "payment_method">
) {
  return typeof paymentIntent.payment_method === "string"
    ? paymentIntent.payment_method
    : paymentIntent.payment_method?.id ?? null;
}
