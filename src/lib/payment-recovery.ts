import {
  BookingStatus,
  PaymentSource,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import {
  cancelPaymentIntentIfCancellableWithResult,
  createPaymentIntent,
  findOrCreateCustomer,
  processRefund,
} from "@/lib/stripe";
import {
  reconcilePaymentAggregates,
  recordStripeRefundLedgerEntry,
  refundPaymentTransactions,
  sumRecordedRefundsForTransaction,
  upsertPaymentIntentTransaction,
  type RefundAllocationSlice,
} from "@/lib/payment-transactions";
import { attachPaymentIntentToWaitingSupplementaryInvoiceOperations } from "@/lib/xero-operation-outbox";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { recordDuplicateCaptureRefundEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { claimAlertCooldown } from "@/lib/alert-cooldown";

type PaymentRecoveryStore = Prisma.TransactionClient | typeof prisma;

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

function buildAdditionalIntentRecoveryIdempotencyKey(
  bookingModificationId: string,
) {
  return `payment_recovery_additional_intent_${bookingModificationId}`;
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

async function enqueueLedgerRefundRecovery({
  bookingId,
  paymentId,
  amountCents,
  idempotencyKey,
  stripeKeyPrefix,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  stripeKeyPrefix?: string | null;
  amountCents: number;
  idempotencyKey: string;
  /**
   * Per-transaction slices frozen by the caller BEFORE any Stripe call
   * (#1349). When present, the processor replays exactly these slices with
   * their `${prefix}_${transactionId}_${amount}` Stripe keys instead of
   * deriving an allocation from whatever progress happens to be recorded, so
   * an enqueue-then-execute caller (booking cancel) is exactly-once even when
   * the recovery cron races or resumes the inline refund.
   */
  allocationPlan?: RefundAllocationSlice[];
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
      "Cannot enqueue ledger refund recovery without a payment intent",
    );
  }

  const allocationPlanJson =
    allocationPlan && allocationPlan.length > 0
      ? (allocationPlan as unknown as Prisma.InputJsonValue)
      : undefined;

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
      stripeKeyPrefix: stripeKeyPrefix ?? null,
      allocationPlan: allocationPlanJson,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentIntentId: representativePaymentIntentId,
      amountCents,
      stripeKeyPrefix: stripeKeyPrefix ?? null,
      // Only overwrite a frozen plan when the caller supplies a fresh one; an
      // update without a plan must not clobber slices a previous processing
      // pass already replayed against Stripe.
      ...(allocationPlanJson !== undefined
        ? { allocationPlan: allocationPlanJson }
        : {}),
    },
  });
}

export async function enqueueBookingModificationRefundRecovery({
  bookingId,
  paymentId,
  bookingModificationId,
  amountCents,
  stripeKeyPrefix,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  amountCents: number;
  /**
   * The exact Stripe idempotency key prefix the originating route used
   * (#1152). The recovery worker replays it so a refund that succeeded on
   * Stripe but was never recorded locally is replayed, not re-minted.
   */
  stripeKeyPrefix?: string | null;
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey:
      buildBookingModificationRefundIdempotencyKey(bookingModificationId),
    stripeKeyPrefix,
    store,
  });
}

/**
 * Durable retry for a booking edit's additional PaymentIntent whose creation
 * failed transiently (#1096). One row per booking modification (unique
 * idempotency key), replayable by the recovery cron. `paymentIntentId` holds
 * the modification-scoped Stripe idempotency key until the intent exists —
 * Stripe answers a repeated key with the same intent, so a retry can never
 * mint a second collectable instrument — and is updated to the real intent id
 * once created.
 */
export async function enqueueAdditionalPaymentIntentRecovery({
  bookingId,
  paymentId,
  bookingModificationId,
  amountCents,
  stripeIdempotencyKey,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  amountCents: number;
  stripeIdempotencyKey: string;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey =
    buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId);
  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentIntentId: stripeIdempotencyKey,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      amountCents,
    },
  });
}

/**
 * Durable recovery for an approved refund appeal whose Stripe refund failed
 * (#1039 item 1, PR #846 residual). The approval claim stands and the refund
 * completes through the recovery cron. When the approve route passes the
 * `allocationPlan` it froze BEFORE the inline Stripe call (#1510), the processor
 * replays exactly those per-transaction slices under their original
 * `refund_request_<id>_<txn>_<amount>` Stripe keys — so a multi-transaction
 * partial-progress replay is answered by Stripe with the original refunds and
 * the `PaymentRefund` ledger dedupes on refund id, instead of a re-derived,
 * shifted allocation minting fresh keys. Operations enqueued before #1510 carry
 * no frozen plan and fall back to the processor's derive-at-replay behaviour
 * (unchanged; post-#1507 single-transaction payments — the dominant case —
 * already share slice keys with the inline refund).
 */
export async function enqueueRefundRequestRefundRecovery({
  bookingId,
  paymentId,
  refundRequestId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  refundRequestId: string;
  amountCents: number;
  /** Slices frozen by the approve route BEFORE the inline Stripe refund (#1510). */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: `refund_request_refund_${refundRequestId}`,
    allocationPlan,
    store,
  });
}

import {
  buildBookingCancellationRefundIdempotencyKey,
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildCapacityClaimFailedRefundRecoveryIdempotencyKey,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking,
  buildDuplicateCaptureRefundStripeKeyPrefix,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
} from "./payment-recovery-keys";
export {
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
};

/**
 * Durable recovery for a booking cancellation whose inline Stripe card refund
 * failed (#1160). The cancellation CLAIM (status -> CANCELLED) already stands;
 * the outstanding refund completes through the recovery cron. The processor
 * reuses the inline cancel Stripe key prefix (`booking_cancel_refund_<id>`) so
 * a refund that succeeded on Stripe but was never recorded is replayed by
 * Stripe, not issued a second time. One row per booking (unique key).
 */
export async function enqueueBookingCancellationRefundRecovery({
  bookingId,
  paymentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  amountCents: number;
  /** Slices frozen inside the cancellation claim transaction (#1349). */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId),
    allocationPlan,
    store,
  });
}

/**
 * Mark the booking-cancellation refund recovery operation SUCCEEDED after the
 * inline refund completed (#1349). The operation is persisted inside the
 * claim transaction BEFORE the Stripe call; this is the happy-path close. If
 * this update is lost (crash, DB blip) the operation stays PENDING and the
 * recovery cron replays the frozen plan — Stripe answers the replayed keys
 * with the original refunds and the ledger dedupes on refund id, so the close
 * being best-effort is safe.
 */
export async function markBookingCancellationRefundRecoverySucceeded({
  bookingId,
  store = prisma,
}: {
  bookingId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/**
 * Record why the inline cancellation refund failed on the already-persisted
 * recovery operation (#1349), for operator visibility on the health surfaces.
 * Only touches a PENDING row: once the cron has claimed (PROCESSING) or
 * resolved the operation, its own lifecycle owns lastError.
 */
export async function recordBookingCancellationRefundRecoveryInlineError({
  bookingId,
  message,
  store = prisma,
}: {
  bookingId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

/**
 * Durable recovery for the capacity-race auto-refund: member A's
 * payment_intent.succeeded arrived after member B claimed the last beds, so
 * A's booking was cancelled inside the reconciliation transaction and A's full
 * charge must be handed back. Enqueued INSIDE that transaction — atomic with
 * the CANCELLED flip, with the refund allocation frozen from the same locked
 * read, BEFORE any Stripe call (the #1349 enqueue-then-execute pattern) — so a
 * transient inline refund failure, or a process death anywhere after the
 * commit, leaves a PENDING operation the recovery cron replays with backoff
 * and alerts only at exhaustion, instead of a stranded charge whose only
 * remediation was an admin reading a (best-effort) alert email. The processor
 * replays the frozen plan under the stored inline Stripe key prefix
 * (`capacity_claim_failed_<bookingId>_<paymentIntentId>`), so a refund that
 * succeeded on Stripe but was never recorded is replayed, never repeated.
 */
export async function enqueueCapacityClaimFailedRefundRecovery({
  bookingId,
  paymentId,
  paymentIntentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  /** Slices frozen inside the reconciliation claim transaction. */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
      bookingId,
      paymentIntentId,
    ),
    stripeKeyPrefix: buildCapacityClaimFailedRefundStripeKeyPrefix(
      bookingId,
      paymentIntentId,
    ),
    allocationPlan,
    store,
  });
}

/**
 * Happy-path close of the capacity-race refund recovery operation after the
 * inline refund completed. Best-effort (mirrors #1349): a lost close leaves a
 * PENDING operation whose replay re-requests the identical frozen slices under
 * the identical Stripe keys — Stripe answers with the original refunds and the
 * ledger dedupes on refund id, so no second money movement is possible.
 */
export async function markCapacityClaimFailedRefundRecoverySucceeded({
  bookingId,
  paymentIntentId,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/**
 * Record why the inline capacity-race refund failed on the already-persisted
 * recovery operation, for operator visibility on the health surfaces. Only
 * touches a PENDING row (mirrors the #1349 recorder): once the cron has
 * claimed or resolved the operation, its own lifecycle owns lastError.
 */
export async function recordCapacityClaimFailedRefundRecoveryInlineError({
  bookingId,
  paymentIntentId,
  message,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

/**
 * Durable recovery for the duplicate-capture auto-refund (#1992): a SECOND,
 * distinct Stripe capture arrived on an already-PAID booking — the residual
 * #1967 split-child window where an in-flight /pay link PaymentIntent (client
 * secret already in the member's browser) and the settlement cron's saved-card
 * charge both capture. Enqueued INSIDE the reconciliation transaction (under
 * lock(1), with the refund allocation pinned to exactly the duplicate
 * transaction's captured amount, BEFORE any Stripe call — the #1349
 * enqueue-then-execute pattern), so a transient inline refund failure or a
 * process death after the commit leaves a PENDING operation the recovery cron
 * replays with backoff. The processor replays the frozen plan under the stored
 * inline Stripe key prefix (`duplicate_capture_refund_<bookingId>_<pi>`), so a
 * refund that succeeded on Stripe but was never recorded is replayed, never
 * repeated. One operation per (booking, duplicate intent); the per-booking key
 * prefix is also the adjudication marker that keeps the refund direction
 * stable when BOTH captures' webhooks replay (see
 * findOtherDuplicateCaptureRefundOperation).
 */
export async function enqueueDuplicateCaptureRefundRecovery({
  bookingId,
  paymentId,
  paymentIntentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  paymentId: string;
  amountCents: number;
  /** The single slice pinned to the duplicate capture's own transaction. */
  allocationPlan: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
      bookingId,
      paymentIntentId,
    ),
    stripeKeyPrefix: buildDuplicateCaptureRefundStripeKeyPrefix(
      bookingId,
      paymentIntentId,
    ),
    allocationPlan,
    store,
  });
}

/**
 * The duplicate-capture adjudication lookup (#1992): returns the existing
 * duplicate-capture refund operation for this booking that targets a DIFFERENT
 * intent, or null. Callers run this under lock(1) BEFORE enqueueing a new
 * duplicate-capture refund: if some other intent's duplicate refund was already
 * adjudicated for the booking, the arriving intent is the SETTLEMENT side of
 * that pair and must not be refunded — otherwise interleaved webhook replays of
 * the two captures would refund both sides and settle the booking at zero net
 * cash.
 */
export async function findOtherDuplicateCaptureRefundOperation({
  bookingId,
  paymentIntentId,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.findFirst({
    where: {
      idempotencyKey: {
        startsWith:
          buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId),
        not: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId,
        ),
      },
    },
  });
}

/**
 * Happy-path close of the duplicate-capture refund recovery operation after
 * the inline refund completed (#1992). Best-effort (mirrors #1349): a lost
 * close leaves a PENDING operation whose replay re-requests the identical
 * frozen slice under the identical Stripe keys — Stripe answers with the
 * original refund and the ledger dedupes on refund id.
 */
export async function markDuplicateCaptureRefundRecoverySucceeded({
  bookingId,
  paymentIntentId,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/**
 * Record why the inline duplicate-capture refund failed on the
 * already-persisted recovery operation (#1992), for operator visibility on the
 * health surfaces. Only touches a PENDING row (mirrors the #1349 recorder):
 * once the cron has claimed or resolved the operation, its own lifecycle owns
 * lastError.
 */
export async function recordDuplicateCaptureRefundRecoveryInlineError({
  bookingId,
  paymentIntentId,
  message,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

const GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX =
  "group_settlement_refund_recovery_";

function buildGroupSettlementRefundRecoveryIdempotencyKey(
  settlementId: string,
) {
  return `${GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX}${settlementId}`;
}

/**
 * Durable retry for a group organiser-cancel settlement refund (F3, #1351,
 * owner-decided auto-retry). Enqueued BEFORE the inline Stripe refund (the
 * #1349 enqueue-then-execute pattern) with a short delay so the cron only
 * picks it up when the inline run failed or died; the inline happy path marks
 * it SUCCEEDED. The processor replays the settlement's PERSISTED refund plan
 * verbatim under the same `group_cancel_refund_<settlementId>` Stripe key —
 * a >24h retry never recomputes the cancellation tier, and an ambiguous
 * failure (Stripe refunded, response lost) is replayed, not repeated. The
 * recovery machinery supplies backoff and alerts ONLY on exhaustion.
 *
 * `paymentId` is an anchor row for the schema FK (the organiser's own
 * payment): the processor never reads it — the group-settlement branch
 * dispatches on the idempotency-key prefix before any payment lookup.
 */
export async function enqueueGroupSettlementRefundRecovery({
  organiserBookingId,
  paymentId,
  settlementId,
  paymentIntentId,
  amountCents,
  retryDelayMs = 0,
  lastError,
  store = prisma,
}: {
  organiserBookingId: string;
  paymentId: string;
  settlementId: string;
  paymentIntentId: string;
  amountCents: number;
  retryDelayMs?: number;
  lastError?: string;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey =
    buildGroupSettlementRefundRecoveryIdempotencyKey(settlementId);
  const nextRetryAt = new Date(Date.now() + retryDelayMs);

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId: organiserBookingId,
      paymentId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt,
      lastError: lastError ?? null,
    },
    update: {
      amountCents,
      // Re-arming after an inline failure pulls the retry forward; a FAILED
      // row keeps its status/attempts, so an exhausted operation stays
      // exhausted (alert already sent) until the retry itself succeeds.
      nextRetryAt,
      ...(lastError !== undefined ? { lastError } : {}),
    },
  });
}

/**
 * Happy-path close after the inline settlement refund + flip completed
 * (#1351). Best-effort: a lost close leaves a PENDING row whose replay is a
 * no-op (the settlement is no longer SUCCEEDED, so the processor only
 * re-applies any missing per-child mirrors idempotently).
 */
export async function markGroupSettlementRefundRecoverySucceeded({
  settlementId,
  store = prisma,
}: {
  settlementId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey:
        buildGroupSettlementRefundRecoveryIdempotencyKey(settlementId),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
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

/**
 * Terminal SUCCEEDED close, STATUS-FENCED (#2262 H2). `updateMany` rather than
 * update-by-id, so an operation the manual-mark-paid reversal DELETED mid-flight
 * simply matches nothing instead of throwing P2025 — a closed/deleted operation
 * can never be resurrected by a worker that still holds an in-memory copy. The
 * fence excludes only SUCCEEDED (already terminal): the webhook-side closers
 * (completeCanceledSupersededPaymentIntentRecovery and the succeeded-intent
 * handoff) legitimately close PENDING/FAILED rows whose work verifiably
 * finished, so fencing to PROCESSING-only would break them.
 */
async function completePaymentRecoveryOperation(operationId: string) {
  const closed = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operationId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
  if (closed.count === 0) {
    logger.warn(
      { operationId },
      "Payment recovery completion matched no live operation (already succeeded, or deleted by a manual mark-paid reversal); nothing was resurrected"
    );
  }
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

  // #2262 H2 — RE-CLAIM the operation immediately before the money-adjacent
  // writes. The worker's copy of this operation was read before its Stripe
  // call; a manual mark-paid reversal can DELETE the row in that window (its
  // disarm — see reverseManualBookingPayment), and without this fence the
  // stale copy would still flip the transaction SUCCEEDED and enqueue a fresh
  // superseded-refund operation the disarm never covered, netting a PAID
  // booking to zero cash. The claim is a status-fenced WRITE, not a read: a
  // deleted row matches nothing, a SUCCEEDED row is already terminal, and
  // PENDING/FAILED are included because the webhook-side handoff
  // (queueSupersededPaymentIntentRefundRecovery) legitimately hands off an
  // operation the cron has not claimed.
  const claimed = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: {
        in: [
          PaymentRecoveryOperationStatus.PENDING,
          PaymentRecoveryOperationStatus.PROCESSING,
          PaymentRecoveryOperationStatus.FAILED,
        ],
      },
    },
    data: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    logger.error(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        paymentIntentId: operation.paymentIntentId,
      },
      "Superseded-intent refund handoff ABANDONED: the operation is gone or already terminal (deleted by a manual mark-paid reversal, or completed elsewhere). No transaction flip, no refund enqueued."
    );
    return;
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

/** Parse a persisted allocation plan (#1097); null when absent or malformed. */
function parseRefundAllocationPlan(
  value: unknown,
): RefundAllocationSlice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const slices: RefundAllocationSlice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { paymentTransactionId, amountCents } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof paymentTransactionId !== "string" ||
      !paymentTransactionId ||
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents <= 0
    ) {
      return null;
    }
    slices.push({ paymentTransactionId, amountCents });
  }
  return slices;
}

async function processBookingModificationRefundOperation(
  operation: PaymentRecoveryOperation,
) {
  // Group settlement refund replay (F3, #1351): dispatch on the key prefix
  // BEFORE any payment lookup — these operations anchor paymentId to the
  // organiser's own payment purely for the schema FK, and deriving a refund
  // from that payment's transactions would refund the wrong money. The
  // executor replays the settlement's persisted plan under the inline
  // `group_cancel_refund_<settlementId>` Stripe key and applies the
  // per-child refundedAmountCents mirrors idempotently.
  if (
    operation.idempotencyKey.startsWith(
      GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX,
    )
  ) {
    const settlementId = operation.idempotencyKey.slice(
      GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX.length,
    );
    // Dynamic import: group-cancel imports this module for the enqueue/mark
    // helpers (same pattern as booking-payment-cleanup above).
    const { executeGroupSettlementRefundPlan } = await import(
      "@/lib/group-cancel"
    );
    await executeGroupSettlementRefundPlan(settlementId);
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: { transactions: true },
  });

  if (!payment) {
    throw new Error(
      `Payment ${operation.paymentId} not found for booking modification refund recovery`,
    );
  }

  // The allocation is frozen on the operation before its first Stripe call:
  // booking-cancellation (#1349) and refund-request (#1510) recoveries persist
  // the inline attempt's own slices at ENQUEUE time, while a booking-
  // modification recovery freezes them the first time it is processed (#1097).
  // A retry then re-requests exactly those per-transaction slices — with the
  // identical Stripe idempotency keys, which Stripe answers with the original
  // refunds and the ledger dedupes by refund id — never a re-derived allocation
  // whose shifted slice amounts would mint fresh keys (over-refunding) or
  // misread replayed refunds as new progress (under-refunding). Operations
  // enqueued before their freeze existed carry no plan and derive-at-replay
  // below (single-transaction payments, the dominant case, already share slice
  // keys — see #1510).
  let plan = parseRefundAllocationPlan(operation.allocationPlan);

  if (!plan) {
    const refundableTransactions = payment.transactions
      .filter((transaction) =>
        CAPTURED_TRANSACTION_STATUSES.has(transaction.status),
      )
      .filter(
        (transaction) =>
          transaction.amountCents - transaction.refundedAmountCents > 0,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const refundableCents = refundableTransactions.reduce(
      (sum, transaction) =>
        sum + (transaction.amountCents - transaction.refundedAmountCents),
      0,
    );

    const outstandingCents = Math.min(operation.amountCents, refundableCents);

    if (outstandingCents <= 0) {
      await completePaymentRecoveryOperation(operation.id);
      return;
    }

    let remainingCents = outstandingCents;
    plan = [];
    for (const transaction of refundableTransactions) {
      if (remainingCents <= 0) break;
      const sliceCents = Math.min(
        remainingCents,
        transaction.amountCents - transaction.refundedAmountCents,
      );
      plan.push({
        paymentTransactionId: transaction.id,
        amountCents: sliceCents,
      });
      remainingCents -= sliceCents;
    }

    // Persist the plan before any Stripe call: if the process dies mid-refund
    // the retry replays these exact slices instead of re-deriving.
    await prisma.paymentRecoveryOperation.update({
      where: { id: operation.id },
      data: { allocationPlan: plan as unknown as Prisma.InputJsonValue },
    });
  }

  // Recoveries reuse the route's original Stripe idempotency key prefix so a
  // retry after a refund that succeeded on Stripe but was never recorded
  // replays the same refund instead of issuing a new one: refund-request
  // recoveries reconstruct it (refund_request_<id>, #1039 item 1), booking
  // cancellation recoveries reconstruct the inline cancel prefix
  // (booking_cancel_refund_<bookingId>, #1160), and modification recoveries
  // read the prefix stored at enqueue time (#1152). Legacy modification rows
  // without a stored prefix keep their operation-scoped prefix.
  const refundRequestId = operation.idempotencyKey.startsWith(
    "refund_request_refund_",
  )
    ? operation.idempotencyKey.slice("refund_request_refund_".length)
    : null;
  const isBookingCancellationRecovery = operation.idempotencyKey.startsWith(
    "booking_cancel_refund_recovery_",
  );

  let metadata: Record<string, string>;
  let idempotencyKeyPrefix: string;
  if (refundRequestId) {
    // #1507: replay the inline appeal-refund body VERBATIM. The admin approve
    // route and this branch both build the metadata from
    // buildRefundRequestRefundMetadata, so under the shared
    // `refund_request_<id>` idempotency key Stripe replays the original refund
    // rather than rejecting the reused key with idempotency_error (which
    // previously sent the inline-succeeded-but-unrecorded scenario to
    // retry-exhaustion). The shape reconstructs purely from the persisted
    // bookingId + refundRequestId, so pre-fix rows replay through this same path
    // (the inline body — reason:"refund_appeal_approved" — is unchanged, so no
    // pre-deploy sliver).
    metadata = buildRefundRequestRefundMetadata(
      operation.bookingId,
      refundRequestId,
    );
    idempotencyKeyPrefix = `refund_request_${refundRequestId}`;
  } else if (isBookingCancellationRecovery) {
    // #1494: replay the inline cancel body VERBATIM. Both callers build the
    // metadata from the same buildBookingCancellationRefundMetadata helper, so
    // this replay's request body is byte-identical to the one the inline path
    // sent when it created the Stripe refund. Under the shared
    // `booking_cancel_refund_<bookingId>` idempotency key that makes Stripe
    // replay the original refund rather than reject the key with
    // idempotency_error (which previously sent this exact scenario — inline
    // refund succeeded, recording lost — to retry-exhaustion + a manual
    // reconcile). The metadata reconstructs purely from the persisted
    // bookingId, so an operation enqueued BEFORE this fix replays through the
    // same code path (there is no separate persisted-metadata to miss).
    metadata = buildBookingCancellationRefundMetadata(operation.bookingId);
    idempotencyKeyPrefix = `booking_cancel_refund_${operation.bookingId}`;
  } else {
    // #1507: replay the inline modification-refund body VERBATIM. The inline
    // settlement helper stamps a per-path reason (date change / batch / guest
    // removal); this branch reconstructs that exact reason from the persisted
    // Stripe key prefix (#1152) via bookingModificationRefundReasonForKeyPrefix
    // and builds the body from the same buildBookingModificationRefundMetadata
    // helper the inline path uses, so under the shared stored prefix Stripe
    // replays the original refund instead of rejecting the reused key with
    // idempotency_error. Legacy rows without a stored prefix fall back to the
    // historical recovery reason + operation-scoped key (they were never
    // shared-key with the inline refund).
    idempotencyKeyPrefix =
      operation.stripeKeyPrefix ??
      `payment_recovery_modification_refund_${operation.id}`;
    metadata = buildBookingModificationRefundMetadata(
      operation.bookingId,
      bookingModificationRefundReasonForKeyPrefix(operation.stripeKeyPrefix),
    );
  }

  await refundPaymentTransactions({
    paymentId: operation.paymentId,
    amountCents: plan.reduce((sum, slice) => sum + slice.amountCents, 0),
    allocation: plan,
    metadata,
    idempotencyKeyPrefix,
  });

  // #2008 — the #1992 duplicate-capture auto-refund replays through this generic
  // modification-refund executor (its durable operation is a
  // REFUND_BOOKING_MODIFICATION carrying a `duplicate_capture_<bookingId>_<pi>`
  // idempotency key). On this recovery-replay path record the admin-only
  // history event, gated on the terminal SUCCEEDED transition actually flipping
  // the operation (count > 0) so it lands EXACTLY ONCE across the inline and
  // cron paths: if the inline refund already closed the operation and recorded
  // the event, this replay sees count 0 and records nothing. The guarded
  // updateMany sets the identical terminal fields completePaymentRecoveryOperation
  // would.
  const duplicateCapturePrefix =
    buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(operation.bookingId);
  if (operation.idempotencyKey.startsWith(duplicateCapturePrefix)) {
    const transition = await prisma.paymentRecoveryOperation.updateMany({
      where: {
        id: operation.id,
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
        lastError: null,
        processingStartedAt: null,
        succeededAt: new Date(),
      },
    });
    if (transition.count > 0) {
      await recordDuplicateCaptureRefundEvent({
        bookingId: operation.bookingId,
        amountCents: operation.amountCents,
        // The duplicate intent id is the suffix of the operation's per-booking
        // idempotency key. The settling intent is not persisted on the
        // operation, so the replay records it as null (the inline path, which
        // owns the common case, carries the settling intent).
        duplicatePaymentIntentId: operation.idempotencyKey.slice(
          duplicateCapturePrefix.length,
        ),
        settledPaymentIntentId: null,
      });
    }
    return;
  }

  await completePaymentRecoveryOperation(operation.id);
}

/**
 * Re-create a booking edit's additional PaymentIntent whose original
 * post-transaction creation failed (#1096). Idempotent: the stored Stripe
 * idempotency key (`mod_*_{bookingModificationId}`) makes Stripe answer a
 * retry with the same intent, the ADDITIONAL transaction row is an upsert,
 * and an additional intent minted by a *later* edit supersedes this one — in
 * that case the operation completes without creating anything.
 */
async function processCreateAdditionalPaymentIntentOperation(
  operation: PaymentRecoveryOperation,
) {
  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: {
      transactions: true,
      booking: { include: { member: true } },
    },
  });

  if (!payment || !payment.booking) {
    throw new Error(
      `Payment ${operation.paymentId} not found for additional intent recovery`,
    );
  }

  // A later edit already created a fresh additional intent: it superseded
  // this modification's collectable, so resurrecting ours would offer the
  // member two instruments for overlapping money. The later edit repriced
  // from current state, so its intent is the whole truth.
  const newerAdditionalTransaction = payment.transactions.find(
    (transaction) =>
      transaction.kind === PaymentTransactionKind.ADDITIONAL &&
      transaction.createdAt > operation.createdAt,
  );
  if (newerAdditionalTransaction || operation.amountCents <= 0) {
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  // A booking cancelled after the modification has no increase left to
  // collect (#1358): the cancel flow already tore down its additional
  // intents, so minting a live intent here would resurrect a collectable the
  // cancel retired and re-arm the WAITING_PAYMENT supplementary Xero
  // operation for money that must never be captured. Complete without
  // creating anything — the parked Xero op is retired by the
  // stale-WAITING_PAYMENT reaper.
  if (payment.booking.status === BookingStatus.CANCELLED) {
    logger.info(
      { operationId: operation.id, bookingId: operation.bookingId },
      "Skipping additional intent recovery for cancelled booking",
    );
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  const member = payment.booking.member;
  let customerId = payment.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await findOrCreateCustomer({
      email: member.email,
      name: `${member.firstName} ${member.lastName}`,
      memberId: member.id,
    });
    customerId = customer.id;
  }

  const stripeIdempotencyKey = operation.paymentIntentId;
  const pi = await createPaymentIntent({
    amountCents: operation.amountCents,
    customerId,
    metadata: {
      bookingId: operation.bookingId,
      type: "modification_additional",
      reason: "modification_additional_recovery",
    },
    idempotencyKey: stripeIdempotencyKey,
  });

  // Dynamic import: booking-payment-cleanup imports this module.
  const { queueSupersededAdditionalIntentCancellations } = await import(
    "@/lib/booking-payment-cleanup"
  );
  await queueSupersededAdditionalIntentCancellations({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    newPaymentIntentId: pi.id,
  }).catch((err) =>
    logger.error(
      { err, bookingId: operation.bookingId, paymentIntentId: pi.id },
      "Failed to queue superseded additional intent cancellations during recovery",
    ),
  );

  await upsertPaymentIntentTransaction({
    paymentId: operation.paymentId,
    kind: PaymentTransactionKind.ADDITIONAL,
    paymentIntentId: pi.id,
    amountCents: operation.amountCents,
    status: PaymentStatus.PENDING,
    reason: "modification_additional_recovery",
    stripeCustomerId: customerId,
  });

  // A supplementary Xero invoice op enqueued at modification time waited on
  // an intent that never existed; point it at the recovered one so the
  // payment webhook can release it.
  const bookingModificationId = operation.idempotencyKey.slice(
    "payment_recovery_additional_intent_".length,
  );
  await attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
    bookingModificationId,
    paymentIntentId: pi.id,
  }).catch((err) =>
    logger.error(
      { err, operationId: operation.id, paymentIntentId: pi.id },
      "Failed to attach recovered additional intent to waiting Xero operations",
    ),
  );

  await prisma.paymentRecoveryOperation.update({
    where: { id: operation.id },
    data: { paymentIntentId: pi.id },
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

  if (
    operation.type ===
    PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT
  ) {
    await processCreateAdditionalPaymentIntentOperation(operation);
    return;
  }

  if (
    operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT
  ) {
    await processRefundSupersededPaymentOperation(operation);
    return;
  }

  // #2262: the dispatch is EXHAUSTIVE, never a fall-through. The final arm
  // used to execute any unknown enum member as a superseded-payment REFUND —
  // which is why a "task a cron must never execute" (ManualRefundTask) was
  // modeled as its own table rather than a new PaymentRecoveryOperationType.
  // An unhandled member now fails its operation loudly (the worker's normal
  // failure path records it and alerts on exhaustion) instead of moving money.
  throw new Error(
    `Unhandled payment recovery operation type: ${operation.type}`
  );
}

const PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS = 30 * 60 * 1000;
const PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
// #1211: shared AlertCooldown key that all instances contend on so the stale
// payment-recovery-queue alert fires at most once per cooldown window across
// the whole fleet, not once per process.
const STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY = "payment-recovery:stale-queue";

async function alertStalePaymentRecoveryQueueIfNeeded() {
  const now = new Date();
  const staleThreshold = new Date(
    now.getTime() - PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS,
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

  // Shared cross-instance cooldown: atomically CLAIM the window before sending
  // so N instances raise at most one alert per
  // PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS (not one per instance). The
  // claim-before-send pattern was extracted verbatim to @/lib/alert-cooldown
  // under #2262 so the manual-settlement conflict alert can share it.
  const holdsClaim = await claimAlertCooldown({
    key: STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY,
    windowMs: PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS,
    now,
  });
  if (!holdsClaim) return;
  // We hold the claim → send exactly once cross-instance. The provider call is
  // claim-first and outside any DB transaction; the tiny residual double-send
  // window (two instances reading between claim attempts) is bounded and this
  // is a noise-only alert.
  await sendAdminPaymentFailureAlert({
    memberName: oldest.booking?.member
      ? `${oldest.booking.member.firstName} ${oldest.booking.member.lastName}`
      : "Unknown member",
    checkIn: oldest.booking?.checkIn ?? null,
    checkOut: oldest.booking?.checkOut ?? null,
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
