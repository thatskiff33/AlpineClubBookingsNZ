import {
  PaymentSource,
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
  refundPaymentTransactions,
  sumRecordedRefundsForTransaction,
} from "@/lib/payment-transactions";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";

type PaymentRecoveryStore = Prisma.TransactionClient | typeof prisma;

const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;
const STALE_PROCESSING_MINUTES = 30;
// One entry per attempt: nextRetryDate(attempts) reads RETRY_BACKOFF_MINUTES[attempts - 1].
const RETRY_BACKOFF_MINUTES: readonly number[] = [5, 15, 60, 240, 720];
if (RETRY_BACKOFF_MINUTES.length !== MAX_PAYMENT_RECOVERY_ATTEMPTS) {
  throw new Error(
    "RETRY_BACKOFF_MINUTES must have exactly MAX_PAYMENT_RECOVERY_ATTEMPTS entries",
  );
}

const CAPTURED_TRANSACTION_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

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

function buildBookingModificationRefundIdempotencyKey(
  bookingModificationId: string,
) {
  return `payment_recovery_modification_refund_${bookingModificationId}`;
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

export async function enqueueBookingModificationRefundRecovery({
  bookingId,
  paymentId,
  bookingModificationId,
  amountCents,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  amountCents: number;
  store?: PaymentRecoveryStore;
}) {
  const payment = await store.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  const capturedTransaction = payment?.transactions.find(
    (transaction) =>
      transaction.source === PaymentSource.STRIPE &&
      Boolean(transaction.stripePaymentIntentId) &&
      CAPTURED_TRANSACTION_STATUSES.has(transaction.status),
  );
  const representativePaymentIntentId =
    capturedTransaction?.stripePaymentIntentId ??
    payment?.stripePaymentIntentId ??
    null;

  if (!representativePaymentIntentId) {
    throw new Error(
      "Cannot enqueue booking modification refund recovery without a payment intent",
    );
  }

  const idempotencyKey =
    buildBookingModificationRefundIdempotencyKey(bookingModificationId);

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentIntentId: representativePaymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentIntentId: representativePaymentIntentId,
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
  operation: PaymentRecoveryOperation,
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
  operation: PaymentRecoveryOperation,
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
  operation: PaymentRecoveryOperation
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
  operation: PaymentRecoveryOperation;
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
  operation: PaymentRecoveryOperation;
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
  operation: PaymentRecoveryOperation
) {
  const result = await cancelPaymentIntentIfCancellableWithResult(
    operation.paymentIntentId
  );

  // Stripe can transition a PaymentIntent from a cancellable status to
  // "succeeded" between our retrieve and our cancel call, and the cancel
  // API can race with a parallel capture. Check the actual status before
  // treating this as a cancellation, otherwise we would mark a captured
  // payment FAILED and skip the refund handoff.
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

  if (result.canceled || result.paymentIntent.status === "canceled") {
    await markSupersededTransactionFailed(operation);
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  throw new Error(
    `PaymentIntent ${operation.paymentIntentId} could not be canceled from status ${result.paymentIntent.status}`
  );
}

async function processRefundSupersededPaymentOperation(
  operation: PaymentRecoveryOperation
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

  // Idempotency-by-ledger: read the refunded total from the ledger
  // (which is upserted on stripeRefundId) rather than incrementing the
  // pre-read row. If a previous attempt wrote the ledger entry but
  // failed before updating the transaction row, the ledger total is
  // still the truth.
  const ledgerRefundedTotal = await sumRecordedRefundsForTransaction(
    prisma,
    refreshedTransaction.id,
  );
  const nextRefundedAmountCents = Math.min(
    refreshedTransaction.amountCents,
    Math.max(refreshedTransaction.refundedAmountCents, ledgerRefundedTotal),
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

async function processBookingModificationRefundOperation(
  operation: PaymentRecoveryOperation,
) {
  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: { transactions: true },
  });

  if (!payment) {
    throw new Error(
      `Payment ${operation.paymentId} not found for booking modification refund recovery`,
    );
  }

  const refundableCents = payment.transactions
    .filter((transaction) =>
      CAPTURED_TRANSACTION_STATUSES.has(transaction.status),
    )
    .reduce(
      (sum, transaction) =>
        sum + (transaction.amountCents - transaction.refundedAmountCents),
      0,
    );

  const outstandingCents = Math.min(operation.amountCents, refundableCents);

  if (outstandingCents <= 0) {
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  await refundPaymentTransactions({
    paymentId: operation.paymentId,
    amountCents: outstandingCents,
    metadata: {
      bookingId: operation.bookingId,
      reason: "booking_modification_refund_recovery",
    },
    idempotencyKeyPrefix: `payment_recovery_modification_refund_${operation.id}`,
  });

  await completePaymentRecoveryOperation(operation.id);
}

async function processPaymentRecoveryOperation(
  operation: PaymentRecoveryOperation
) {
  if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
    await processCancelPaymentIntentOperation(operation);
    return;
  }

  if (
    operation.type ===
    PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION
  ) {
    await processBookingModificationRefundOperation(operation);
    return;
  }

  await processRefundSupersededPaymentOperation(operation);
}

const PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS = 30 * 60 * 1000;
const PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
let lastStalePaymentRecoveryAlertAt = 0;

async function alertStalePaymentRecoveryQueueIfNeeded() {
  if (
    Date.now() - lastStalePaymentRecoveryAlertAt <
    PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS
  ) {
    return;
  }
  const staleThreshold = new Date(
    Date.now() - PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS,
  );
  const oldest = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      status: PaymentRecoveryOperationStatus.PENDING,
      createdAt: { lt: staleThreshold },
    },
    orderBy: { createdAt: "asc" },
    include: { booking: { include: { member: true } } },
  });
  if (!oldest) return;
  lastStalePaymentRecoveryAlertAt = Date.now();
  await sendAdminPaymentFailureAlert({
    memberName: oldest.booking?.member
      ? `${oldest.booking.member.firstName} ${oldest.booking.member.lastName}`
      : "Unknown member",
    checkIn: oldest.booking?.checkIn ?? new Date(),
    checkOut: oldest.booking?.checkOut ?? new Date(),
    amountCents: oldest.amountCents,
    errorMessage:
      "Stripe payment recovery queue is stalled. Confirm that /api/cron/payments?task=recovery is running every 5 minutes.",
    paymentIntentId: oldest.paymentIntentId,
  }).catch((alertError) =>
    logger.error(
      { err: alertError, operationId: oldest.id },
      "Failed to send stale payment recovery queue alert",
    ),
  );
}

export async function processPaymentRecoveryOperations(options?: {
  limit?: number;
}): Promise<PaymentRecoveryProcessResult> {
  await resetStaleProcessingOperations();
  await alertStalePaymentRecoveryQueueIfNeeded();

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
