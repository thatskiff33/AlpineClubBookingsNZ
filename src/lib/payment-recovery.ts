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
import {
  attachPaymentIntentToWaitingSupplementaryInvoiceOperations,
  findWaitingSupplementaryInvoiceOperationForPaymentIntent,
  // Type-only, so it adds nothing to this module's runtime import graph.
  type XeroSupplementaryInvoiceEnqueueOutcome,
} from "@/lib/xero-operation-outbox";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { recordDuplicateCaptureRefundEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";
import { createAuditLog } from "@/lib/audit";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { claimAlertCooldown } from "@/lib/alert-cooldown";

type PaymentRecoveryStore = Prisma.TransactionClient | typeof prisma;

const STALE_PROCESSING_MINUTES = 30;
/**
 * How many stale `PROCESSING` rows one sweep hands back (#3220 fix round). See
 * `resetStaleProcessingOperations`: each row now costs an alert and possibly a
 * Stripe round trip, and the sweep runs in front of the main queue. Generous
 * against any real backlog - a sweep this size means thirty minutes of workers
 * died - and the remainder is taken by the next run.
 */
const STALE_PROCESSING_SWEEP_LIMIT = 50;
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

/**
 * THE THREE STATUS SETS THIS MODULE READS, EACH SPELLED ONCE (#3220,
 * `INV-SSOT`).
 *
 * `FAILED` is not one state here, it is two readings of one column, and the
 * distinction is the whole reason #3220 exists. A `FAILED` row with attempts
 * left is a RETRY waiting its turn; a `FAILED` row with none is DEAD. The
 * `attempts < MAX` filter beside each use of
 * `CLAIMABLE_PAYMENT_RECOVERY_STATUSES` is what separates them, so it belongs to
 * the query rather than to the constant.
 *
 * BEWARE: THAT IS THIS MODULE'S DISTINCTION, AND ONLY THIS MODULE'S. The
 * booking-vs-Xero repair tool defers on `OPEN_PAYMENT_RECOVERY_STATUSES`
 * (`xero-booking-repair-load.ts`), which is `[PENDING, PROCESSING]` and carries
 * no `attempts` filter at all - so it stops deferring at the FIRST failure, not
 * at death. Do not read the two-readings rule into that query: a retry waiting
 * its turn already looks dead to it. The consequence is bounded and is stated
 * with `INV-PAY-053` rather than papered over - a retry that later succeeds
 * raises the ask and its invoice together, and a retry that runs out reaches the
 * terminal branch below, which withdraws the ask.
 *
 * They were three inline `in: [...]` literals, and the pre-decision review on
 * #3220 counted them among the module's six mentions of
 * `PaymentRecoveryOperationStatus.FAILED`. They are reads, so they can never be
 * the transition anything hangs off - but a reader looking for "where does this
 * module decide a recovery is dead" had six candidates to eliminate, and
 * `payment-recovery-terminal-failure-census.test.ts` now pins that there are
 * exactly these two plus the one write.
 */
const CLAIMABLE_PAYMENT_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PENDING,
  PaymentRecoveryOperationStatus.FAILED,
] as const;

/** Everything a live operation can be. Excludes only the terminal SUCCEEDED. */
const NON_TERMINAL_PAYMENT_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PENDING,
  PaymentRecoveryOperationStatus.PROCESSING,
  PaymentRecoveryOperationStatus.FAILED,
] as const;

/** What the stale-worker reaper is allowed to move a row out of. */
const STALE_PROCESSING_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PROCESSING,
] as const;

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
 * failed transiently (#1096). One row per charge debt (unique idempotency key),
 * replayable by the recovery cron. `paymentIntentId` holds the Stripe
 * idempotency key until the intent exists — Stripe answers a repeated key with
 * the same intent, so a retry can never mint a second collectable instrument —
 * and is updated to the real intent id once created.
 *
 * #3170: `idempotencyKey` is now a REQUIRED argument rather than derived from
 * `bookingModificationId` inside. The ordinary edit path still passes the
 * modification-scoped key and behaves identically; the review-completion charge
 * passes its own EDIT-scoped key from `payment-recovery-keys.ts`. Both are keyed
 * on the same `BookingModification` in different namespaces, so the two paths'
 * debts are separate rows - while the two review tasks of ONE edit deliberately
 * share a row, because the owner's 30 Aug 2026 decision makes their two shares
 * one debt against one request. (An earlier draft of this paragraph said the
 * review key was TASK-scoped. It was, for one round, and that scoping is what
 * let a second share mint a second intent and cancel the first.) Passing the key
 * rather than a flag is what stops a future caller getting the scoping wrong by
 * omission (`INV-SSOT`: a required argument beats a rule).
 *
 * #3170 ALSO STOPPED THE UPSERT REWRITING `amountCents`. An `update` clause
 * carrying the amount means a colliding second caller silently rewrites a debt
 * the cron may already be part way through — the exact hazard
 * `buildEditFinancialReviewRefundRecoveryIdempotencyKey` was task-scoped to avoid
 * on the refund side, sitting unremarked on the charge side. Under a correct key
 * a repeat carries the SAME amount, so dropping it from the update changes
 * nothing that is right and makes the wrong thing unrepresentable. `bookingId`
 * and `paymentId` stay, because a repeat cannot change either and refreshing them
 * costs nothing.
 *
 * #3181: `hadIssuedXeroInvoice` IS REQUIRED, AND IT IS THE EDIT'S ANSWER, NOT THE
 * REPLAY'S. The replay raises the supplementary invoice the edit deferred, and
 * whether an edit had a primary invoice to supplement is a fact about the moment
 * it dispatched - a booking whose primary invoice is minted AFTER the edit gets
 * billed for the edit by that invoice, so a replay re-deriving `true` hours later
 * would queue a second ask for the same money. A required argument rather than an
 * optional one because every caller already holds the value it fed
 * `queueXeroBookingEditSettlement`, and an omission would be indistinguishable
 * from a recorded `false` (`INV-SSOT`: unrepresentable beats policed). It is
 * written on `create` ONLY, for the same reason `amountCents` is: a colliding
 * second caller for one debt must not rewrite a fact the cron may already be
 * acting on, and first-writer-wins keeps the EARLIEST edit-time answer, which is
 * the conservative one.
 */
export async function enqueueAdditionalPaymentIntentRecovery({
  bookingId,
  paymentId,
  idempotencyKey,
  amountCents,
  stripeIdempotencyKey,
  hadIssuedXeroInvoice,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  /**
   * The recovery-operation dedup key. Build it with
   * `buildAdditionalIntentRecoveryIdempotencyKey` (an ordinary edit) or
   * `buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey` (a review
   * completion). Both are scoped to the `BookingModification` and neither is
   * scoped to a task: one edit raises one request, so its two review shares are
   * one debt and share one recovery row.
   */
  idempotencyKey: string;
  amountCents: number;
  stripeIdempotencyKey: string;
  /**
   * Whether this booking's PRIMARY Xero invoice had already been issued when the
   * edit dispatched - `hasIssuedPrimaryXeroInvoice`, as the edit itself read it.
   * `null` only from the recovery replay's own re-entry, where the row already
   * exists and this value is therefore never written.
   */
  hadIssuedXeroInvoice: boolean | null;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentIntentId: stripeIdempotencyKey,
      amountCents,
      hadIssuedXeroInvoice,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
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
  buildEditFinancialReviewRefundRecoveryIdempotencyKey,
  buildEditFinancialReviewRefundStripeKeyPrefix,
  buildRefundRequestRefundMetadata,
  bookingModificationIdForAdditionalIntentRecoveryKey,
  bookingModificationRefundReasonForKeyPrefix,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "./payment-recovery-keys";
export {
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
};

/**
 * #3032 (epic #2797): the refund debt for a COMPLETED edit-financial-review task,
 * persisted inside the completion's own transaction BEFORE the Stripe call -
 * booking-cancel's #1349 pattern, on the same infrastructure, for the same
 * reason.
 *
 * The completion holds no advisory lock (deliberately: the locking guide's
 * bounded-exception rule forbids holding `lock(1)` across a provider round trip),
 * so its only single-flight guarantee is the status-guarded claim, which has
 * already committed by the time the refund is sent. Without this row a crash
 * between the commit and the Stripe call would leave a COMPLETED task, an
 * untouched `refundedAmountCents` and no trace at all that money was owed - a
 * worse state than the booking-edit path's, because the Stripe route writes
 * nothing in-transaction. With it, the cron replays the frozen plan under the
 * stored task-scoped prefix and Stripe answers a repeat with the original refund.
 *
 * One row per TASK, never per `BookingModification`: two review tasks can share
 * one modification anchor, and this upsert overwrites `amountCents` and
 * `stripeKeyPrefix` on its update branch.
 */
export async function enqueueEditFinancialReviewRefundRecovery({
  bookingId,
  paymentId,
  taskId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  taskId: string;
  amountCents: number;
  /** Slices frozen inside the completion transaction, before any Stripe call. */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey:
      buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId),
    stripeKeyPrefix: buildEditFinancialReviewRefundStripeKeyPrefix(taskId),
    allocationPlan,
    store,
  });
}

/**
 * Happy-path close of the edit-financial-review refund recovery operation after
 * the inline refund completed. Best-effort, exactly as #1349's is: a lost close
 * leaves a PENDING operation whose replay re-requests the identical frozen slices
 * under the identical Stripe keys, so Stripe answers with the original refunds
 * and the ledger dedupes on refund id. No second movement of money is possible.
 */
export async function markEditFinancialReviewRefundRecoverySucceeded({
  taskId,
  store = prisma,
}: {
  taskId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey:
        buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId),
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

/**
 * THE ONE PLACE A `PaymentRecoveryOperation` BECOMES `FAILED` (#3220,
 * `INV-PAY-052`, `INV-SSOT`).
 *
 * Before this function there were three of them - the worker's own catch, and
 * the stale-`PROCESSING` reaper's two arms - each spelling out its own status
 * write, its own `nextRetryAt` policy and its own idea of whether the row was
 * finished. The pre-decision review on #3220 counted the module's references to
 * `PaymentRecoveryOperationStatus.FAILED` and found six, which is why the issue
 * says six; three of those are `where` filters that READ the status and cannot
 * be a transition (they are named constants now, immediately below). What
 * mattered is the same either way: "this recovery is dead" was expressed in more
 * than one place, so anything that has to happen when a recovery dies had to be
 * bolted onto each of them and would silently miss the ones nobody remembered.
 *
 * TERMINAL IS AN ARGUMENT, NOT A DERIVATION. The two callers know different
 * things - the worker knows it has just burnt an attempt, the reaper knows the
 * row never came back - and a shared re-derivation from `attempts` would be a
 * fourth opinion. `nextRetryAt` is forced to `null` when terminal rather than
 * trusted from the caller, because a terminal row that keeps a retry time is
 * re-claimable and is therefore not terminal at all.
 *
 * STATUS-FENCED, like `completePaymentRecoveryOperation` and for the same
 * reason. The worker's arm used `update` by id, which throws `P2025` when a
 * manual mark-paid reversal has DELETED the row mid-flight - and it is called
 * from inside the loop's `catch`, so that throw escaped the loop and abandoned
 * every remaining operation in the batch. `updateMany` matches nothing instead,
 * and the fence also stops a `SUCCEEDED` row being dragged back to `FAILED` by a
 * worker holding a stale in-memory copy.
 */
type PaymentRecoveryFailureOutcome = "failed" | "retry" | "gone";

async function markPaymentRecoveryOperationFailed({
  operation,
  message,
  terminal,
  nextRetryAt,
  fromStatuses,
  fromProcessingStartedAt,
}: {
  operation: PaymentRecoveryOperation;
  /** Recorded verbatim on `lastError`, and quoted in the exhaustion alert. */
  message: string;
  /** Whether this failure ENDS the operation: nothing will replay it again. */
  terminal: boolean;
  /** When the next attempt is due. Ignored - and forced `null` - when terminal. */
  nextRetryAt: Date;
  /** The statuses this transition may move FROM. Anything else is left alone. */
  fromStatuses: readonly PaymentRecoveryOperationStatus[];
  /**
   * When supplied, the transition ALSO requires `processingStartedAt` to be
   * unchanged - "still the exact attempt I read".
   *
   * #3220 fix round. The stale-worker reaper reads its rows and writes them one
   * by one, and status alone does not fence that gap. A row it read as stale can
   * legitimately be marked failed by a CONCURRENT reaper, re-armed with
   * `nextRetryAt` of now, and re-claimed straight back into `PROCESSING` before
   * this loop reaches it - whereupon a `status: PROCESSING` fence matches, and
   * the reaper kills a LIVE attempt that a worker is in the middle of, on the
   * strength of a timestamp that is no longer there. The bulk `updateMany` this
   * replaced could not do that: its own `where` carried
   * `processingStartedAt < staleBefore`, so a freshly re-claimed row fell out of
   * it. Pinning the exact value restores that and is stricter than restating the
   * threshold, because it also fences `attempts` - the only writer that
   * increments `attempts` is the claim, and the claim is what rewrites
   * `processingStartedAt`.
   */
  fromProcessingStartedAt?: Date | null;
}): Promise<PaymentRecoveryFailureOutcome> {
  const marked = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: { in: [...fromStatuses] },
      ...(fromProcessingStartedAt === undefined
        ? {}
        : { processingStartedAt: fromProcessingStartedAt }),
    },
    data: {
      status: PaymentRecoveryOperationStatus.FAILED,
      lastError: message,
      processingStartedAt: null,
      nextRetryAt: terminal ? null : nextRetryAt,
    },
  });

  if (marked.count === 0) {
    logger.warn(
      { operationId: operation.id, terminal },
      "Payment recovery failure matched no live operation (already succeeded, or deleted by a manual mark-paid reversal); nothing was marked failed"
    );
    return "gone";
  }

  if (!terminal) {
    return "retry";
  }

  await alertPaymentRecoveryFailure(operation, message).catch((alertError) =>
    logger.error(
      { err: alertError, operationId: operation.id },
      "Failed to send payment recovery failure alert"
    )
  );

  // AFTER the status write, and unable to prevent it. See this function's own
  // docblock and `cancelStrandedAdditionalIntentForDeadRecovery`.
  await cancelStrandedAdditionalIntentForDeadRecovery(operation);

  return "failed";
}

/**
 * THE ASK DIES WITH THE RECOVERY THAT OWED IT (#3220, `INV-PAY-053`).
 *
 * A `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery exists because a booking edit
 * raised money the member has not been asked for yet. While it is PENDING or
 * PROCESSING the booking-vs-Xero repair tool DEFERS - it must not raise the
 * edit's supplementary invoice, because the replay is going to raise the ask and
 * the invoice belongs to that ask. Once the row leaves those two statuses that
 * deferral stops (`OPEN_PAYMENT_RECOVERY_STATUSES`, the #3202 control), and the
 * repair tool raises the invoice UNPAID.
 *
 * NOTE THE ASYMMETRY, because it decides what this function can and cannot fix.
 * The repair tool stops deferring at the FIRST failure; this withdrawal fires
 * only at the LAST one. Between them a retrying row can meet an unpaid invoice
 * while its ask is still live - the same two-instrument shape, but transient and
 * self-healing, because the retry either raises ask and invoice together or runs
 * out and lands here. Cancelling on a non-terminal failure would be wrong: the
 * replay still intends to collect against that very ask.
 *
 * So if an ask DOES exist at that moment, the club now has two live instruments
 * for one debt: an unpaid Xero invoice, and a Stripe PaymentIntent the member
 * can still pay. Pay the intent and the two records describe the same money
 * differently, and an officer has to work out which is right - #3187 accepted
 * that as visible-but-unfixed, and #3220 is the decision to fix it.
 *
 * HOW AN ASK CAN EXIST ON A PATH THAT FAILED TO MAKE ONE. The replay's later
 * steps can fail after the mint succeeded - the intent is written to the ledger
 * by the minter, and raising the deferred supplementary invoice afterwards can
 * throw. The next attempt then finds the existing ask and returns `raised`, so
 * the intent survives every remaining attempt and is still standing when the
 * last one is spent.
 *
 * THIS REMOVES THE DUPLICATE INSTRUMENT. IT DOES NOT WRITE OFF THE DEBT. The
 * unpaid invoice still stands and is collected the ordinary way; what goes away
 * is the second way to pay it.
 *
 * AND IT ONLY REMOVES A DUPLICATE WHEN THERE IS ONE (#3220 fix round). The same
 * replay path that leaves an ask standing can also have ATTACHED this change's
 * supplementary invoice operation to it, parked `WAITING_PAYMENT`. That row
 * blocks the repair pass from raising the invoice at all, so nothing is
 * duplicated - and cancelling the intent underneath it would take away the only
 * live route to the money and strand the row until the fourteen-day reaper. So
 * the withdrawal steps around that one case, in the branch below.
 *
 * IDEMPOTENT BY CONSTRUCTION, NOT BY CARE. `cancelPaymentIntentIfCancellable-
 * WithResult` reads the intent first and returns `canceled: false` WITHOUT
 * calling Stripe unless the status is one it can cancel. A replay therefore sees
 * `canceled` (not a cancellable status) and makes no provider call at all, and
 * an intent the member paid in the meantime sees `succeeded` and is left
 * strictly alone - which is also why a paid ask can never be cancelled by this.
 *
 * A REFUSAL LEAVES THE RECOVERY EXACTLY AS NOT TRYING WOULD. Everything here is
 * best-effort and after the fact:
 *
 *   * it runs AFTER the status write, so a Stripe outage cannot stop a recovery
 *     being marked dead - which would re-block the repair tool for ever and
 *     break the #3202 control this issue is required to keep;
 *   * it NEVER throws. `failPaymentRecoveryOperation` is called from inside the
 *     worker loop's own `catch`, and a throw there abandons every remaining
 *     operation in the batch - the exact bug the chokepoint fixed. A rejection
 *     is logged and recorded, never propagated;
 *   * `processing` is in Stripe's cancellable set and Stripe routinely REFUSES
 *     to cancel a processing intent, so the refusal branch is a live path rather
 *     than a theoretical one. It leaves today's state - a live intent against an
 *     invoice raised unpaid - which is what #3187 already makes visible.
 *
 * A refusal is written to the audit log rather than only logged, because a
 * `logger.error` is not a record an officer can find, and this one asks them to
 * do something: check the ask by hand before the member pays it.
 */
async function cancelStrandedAdditionalIntentForDeadRecovery(
  operation: PaymentRecoveryOperation
) {
  if (
    operation.type !==
    PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT
  ) {
    return;
  }

  /**
   * Scoped to the completed-financial-review shape, which is the one the repair
   * tool's deferral covers (`xero-booking-repair-load.ts` queries exactly these
   * rows) and therefore the only shape that can reach the two-instrument state
   * this function exists to prevent. Fail-closed on an unrecognised key, like
   * every other reader of it.
   */
  const bookingModificationId =
    bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey
    );
  if (
    !bookingModificationId ||
    !isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)
  ) {
    return;
  }

  try {
    // Dynamic import for the reason every other cross-import in this module is
    // dynamic: `edit-financial-review-charge` imports this module.
    const { findEditReviewChargeRequest } = await import(
      "@/lib/edit-financial-review-charge-request"
    );
    const request = await findEditReviewChargeRequest({
      paymentId: operation.paymentId,
      bookingModificationId,
    });

    // THE ORDINARY ENDING. The mint never produced anything, which is why the
    // recovery existed at all, so there is no second instrument and nothing to
    // do. No provider call is made on this path.
    if (!request?.stripePaymentIntentId) {
      return;
    }

    /**
     * A captured ask is money the member has already paid. The Stripe helper
     * would leave it alone anyway (`succeeded` is not a cancellable status), so
     * this is a second lock on the same door rather than the only one - but it
     * also saves a provider round trip on the one case where getting it wrong
     * would take money back off a member who paid.
     */
    if (CAPTURED_TRANSACTION_STATUSES.has(request.status)) {
      logger.info(
        {
          operationId: operation.id,
          bookingModificationId,
          paymentIntentId: request.stripePaymentIntentId,
        },
        "Dead additional-payment recovery left its ask alone: the member has already paid it"
      );
      return;
    }

    /**
     * THE ONE ASK THIS WITHDRAWAL LEAVES ALONE (#3220 fix round).
     *
     * A supplementary invoice parked `WAITING_PAYMENT` on this very intent is
     * released by a CONFIRMED payment on it and by nothing else. While it sits
     * there the repair pass reports the change as `BLOCKED_BY_XERO_OPERATION`
     * and does NOT raise the invoice - so the premise of this whole function is
     * absent: there is no unpaid invoice, and therefore no second instrument to
     * remove. Cancelling anyway would destroy the only live route to collecting
     * the debt AND strand the outbox row, leaving the change with no invoice at
     * all until the fourteen-day reaper retires it, while the operator's signal
     * says the club is waiting for a payment that can never arrive. That is
     * verbatim the harm the already-paid branch of the review-charge replay
     * refuses to create, and this is the same rule read from the other end.
     *
     * The window is real rather than theoretical: the replay attaches the
     * waiting operation to the intent it just minted and can then throw while
     * raising the deferred invoice, so every remaining attempt finds the ask
     * standing and the last one arrives here.
     */
    const blockingWaitingOperation =
      await findWaitingSupplementaryInvoiceOperationForPaymentIntent({
        bookingModificationId,
        paymentIntentId: request.stripePaymentIntentId,
      });
    if (blockingWaitingOperation) {
      logger.info(
        {
          operationId: operation.id,
          bookingId: operation.bookingId,
          bookingModificationId,
          paymentIntentId: request.stripePaymentIntentId,
          xeroOperationId: blockingWaitingOperation.id,
        },
        "Dead additional-payment recovery left its ask alone: this booking change's supplementary invoice is still waiting on that very payment, so no invoice has been raised against it"
      );
      return;
    }

    const result = await cancelPaymentIntentIfCancellableWithResult(
      request.stripePaymentIntentId,
      // NOT `requested_by_customer`. The member never declined this; the club
      // ran out of attempts to raise it.
      { cancellationReason: "abandoned" }
    );

    logger.info(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        bookingModificationId,
        paymentIntentId: request.stripePaymentIntentId,
        canceled: result.canceled,
        intentStatus: result.paymentIntent.status,
      },
      result.canceled
        ? "Cancelled the stranded additional PaymentIntent of a dead payment recovery"
        : "Dead additional-payment recovery left its ask alone: it is no longer in a cancellable state"
    );
  } catch (err) {
    logger.error(
      { err, operationId: operation.id, bookingModificationId },
      "Failed to cancel the stranded additional PaymentIntent of a dead payment recovery"
    );
    await recordRefusedStrandedIntentCancellation({
      operation,
      bookingModificationId,
      err,
    }).catch((auditError) =>
      logger.error(
        { err: auditError, operationId: operation.id },
        "Failed to record the audit trace for a refused stranded-intent cancellation"
      )
    );
  }
}

/**
 * The durable, officer-findable record that a dead recovery's ask could NOT be
 * withdrawn (#3220). Written on the refusal path only - a successful cancel
 * needs no officer.
 *
 * `payment` category: this is a fact about a money instrument on a booking, and
 * it asks an officer to act before the member pays something the club has
 * already invoiced.
 */
async function recordRefusedStrandedIntentCancellation({
  operation,
  bookingModificationId,
  err,
}: {
  operation: PaymentRecoveryOperation;
  bookingModificationId: string;
  err: unknown;
}) {
  await createAuditLog({
    action: "payment.recovery.strandedIntentCancellationRefused",
    targetId: operation.bookingId,
    entityType: "Booking",
    entityId: operation.bookingId,
    category: "payment",
    // `important`, not `critical`: nothing is lost or mis-stated yet, and the
    // remedy is a reconciliation an officer does by hand. It matches the
    // severity `recordUncollectedEditReviewChargeShare` writes for the sibling
    // "a settled share met an ask it could not join" record. `critical` is also
    // the tier `audit-retention.ts` keeps for ever, which this does not need.
    severity: "important",
    outcome: "failure",
    summary:
      "A card request for a booking change could not be withdrawn after its retries ran out",
    details:
      "A booking change raised money the member owed, and the card request for it could not be set up at the time, so the system kept retrying in the background. Those retries have now run out. Because they have, the invoice for this change will be raised in Xero as unpaid and collected the ordinary way - but the card request that was already sitting against this change could NOT be withdrawn from the card provider, so the member may still be able to pay it. If they do, the club will hold a payment and an unpaid invoice for the same money. Check this booking change against Xero and against the card provider, and withdraw the card request by hand if it is still live. Nothing has been written off: the money is still owed and the invoice still stands.",
    metadata: {
      operationId: operation.id,
      bookingModificationId,
      idempotencyKey: operation.idempotencyKey,
      reason: errorMessage(err),
    },
  });
}

async function failPaymentRecoveryOperation(
  operation: PaymentRecoveryOperation,
  error: unknown
) {
  const message = errorMessage(error);
  const exhausted = operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;

  const outcome = await markPaymentRecoveryOperationFailed({
    operation,
    message,
    terminal: exhausted,
    nextRetryAt: nextRetryDate(operation.attempts),
    // Everything but SUCCEEDED, matching `completePaymentRecoveryOperation`'s
    // fence: the row was PROCESSING when this worker claimed it, but the
    // webhook-side closers can move it underneath us and a finished operation
    // must never be reopened as a failure.
    fromStatuses: NON_TERMINAL_PAYMENT_RECOVERY_STATUSES,
  });

  /**
   * A row that matched nothing was deleted by a manual mark-paid reversal or
   * had already finished, so there is no state left for this attempt to change.
   * It is still tallied as the outcome this attempt WOULD have had, and that is
   * a deliberate choice rather than parity with the old code: the worker's
   * `update` by id used to THROW `P2025` on the deleted row, from inside the
   * loop's own `catch`, abandoning every remaining operation in the batch - and
   * on the stale-copy path it counted a failure only after wrongly dragging a
   * `SUCCEEDED` row back to `FAILED`. So a row that turns out to have succeeded
   * now lands in `result.failed`. That number is a count of what this pass
   * attempted, not a claim about the row, and nothing downstream branches on
   * it; a fourth outcome for the caller to sum would buy a more precise figure
   * that no reader has asked for.
   */
  return outcome === "gone" ? (exhausted ? "failed" : "retry") : outcome;
}

async function claimPaymentRecoveryOperation(operationId: string) {
  const now = new Date();
  const claim = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operationId,
      status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
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

/**
 * A worker that died mid-attempt leaves its row `PROCESSING` for ever, because
 * nothing else moves it and no exception fires from this process. This reaper
 * hands those rows back.
 *
 * ONE READ, TWO ENDINGS (#3220). It used to be a bulk `updateMany` for the rows
 * with attempts left plus a separate `findMany`/loop for the exhausted ones, and
 * the two spelled the same transition differently: only the second was fenced,
 * only the second alerted, and each carried its own copy of the status write.
 * Both endings now go through `markPaymentRecoveryOperationFailed`, which is
 * what decides what "dead" costs.
 *
 * THE READ AND THE WRITE ARE FENCED TOGETHER (#3220 fix round). Splitting the
 * old bulk `updateMany` into read-then-write opened a gap the bulk form did not
 * have: its `where` carried `processingStartedAt < staleBefore`, so a row that
 * had been re-claimed since could not match, while a fence of `status:
 * PROCESSING` alone matches a row that left `PROCESSING` and came straight back.
 * That path is real - a concurrent reaper marks the row failed with a
 * `nextRetryAt` of NOW, and the very next queue read claims it - and taking it
 * would kill a live attempt and leave the terminality this loop read one attempt
 * out of date. `fromProcessingStartedAt` pins the exact attempt, which fences
 * `attempts` too: the claim is the only writer that increments `attempts`, and
 * it is the same write that replaces `processingStartedAt`.
 */
async function resetStaleProcessingOperations() {
  const staleBefore = new Date(
    Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000
  );

  const stale = await prisma.paymentRecoveryOperation.findMany({
    where: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    // OLDEST FIRST, AND BOUNDED (#3220 fix round). This sweep runs BEFORE the
    // main queue and each row it takes now costs an alert and, on a dead
    // additional-payment recovery, a Stripe read and possibly a cancel - where
    // the bulk `updateMany` it replaced made no provider call at all. A backlog
    // is self-draining, because every row it touches leaves `PROCESSING` for
    // good, so an unbounded read could only ever stall ONE run - but that run is
    // every queued recovery waiting behind a provider that has gone slow, and
    // there is no reason to accept that when the leftovers are handled by the
    // next sweep a minute later. Oldest first so the cap cannot starve a row.
    orderBy: { processingStartedAt: "asc" },
    take: STALE_PROCESSING_SWEEP_LIMIT,
  });

  for (const operation of stale) {
    const terminal = operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;

    await markPaymentRecoveryOperationFailed({
      operation,
      message: terminal
        ? "Payment recovery worker timed out on the final attempt before completion."
        : "Payment recovery worker timed out before completion.",
      terminal,
      nextRetryAt: new Date(),
      fromStatuses: STALE_PROCESSING_RECOVERY_STATUSES,
      // The exact attempt this loop read. See the parameter's docblock: without
      // it, a row re-claimed between the read and this write is killed mid-flight
      // by a fence that only looks at status.
      fromProcessingStartedAt: operation.processingStartedAt,
    });
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
      status: { in: [...NON_TERMINAL_PAYMENT_RECOVERY_STATUSES] },
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
 * WHAT THE DEFERRED SUPPLEMENTARY INVOICE ATTEMPT DID (#3181).
 *
 * Three answers rather than a nullable outcome, because the caller has to tell
 * "the enqueue answered" from "there was nothing to ask" from "the ask failed" -
 * and on the review fork those three lead to three different records.
 */
type DeferredSupplementaryInvoiceAttempt =
  | { status: "queued"; outcome: XeroSupplementaryInvoiceEnqueueOutcome }
  | { status: "not-recorded" }
  | { status: "failed" };

/**
 * RAISE THE SUPPLEMENTARY INVOICE THE EDIT PATH DEFERRED, now that the intent it
 * was waiting for exists (#3181, epic #2797).
 *
 * The defect this closes is one assumption held in two halves. The inline edit
 * path SKIPS the supplementary invoice when an additional Stripe payment is
 * required and its intent could not be minted - correctly, because there is
 * nothing to invoice against - and defers to "the intent's recovery replay". The
 * replay, until now, only ever ATTACHED a recovered intent to an operation
 * already waiting for one, and there was no such operation precisely because the
 * inline attempt had skipped it. The member got a collectable payment request and
 * the club's accounts got no record of the charge.
 *
 * BOTH FORKS OF THE REPLAY NEED THIS, which is why it is a function rather than
 * two spellings. The processor below splits on the recovery key: an ordinary
 * booking edit bills the `BookingModification`'s own signed components, and a
 * completed edit-financial-review charge bills the combined total re-derived from
 * its settled shares. Everything after "which figure" is identical.
 *
 * `hadIssuedXeroInvoice` IS THE EDIT'S ANSWER, READ BACK - NEVER THIS MOMENT'S.
 * The two differ, and the difference double-bills. A booking whose primary Xero
 * invoice had not been minted when the edit committed has NOTHING to supplement,
 * so the edit queued nothing; the primary invoice, minted later by its own
 * outbox operation from the booking's CURRENT state, then bills the edit itself.
 * A replay re-reading `payment.xeroInvoiceId` hours later would find it set,
 * classify a supplementary invoice, and raise a second ask for money the primary
 * invoice already carries. So the value is frozen on the recovery row at enqueue
 * time and read back here - which is also what makes the convergence claim below
 * true rather than merely asserted.
 *
 * `null` means the row predates that column: not recorded, therefore not
 * answerable, therefore NOT RAISED. The asymmetry is the argument - an invoice
 * this pass fails to raise is surfaced by the booking-vs-Xero repair pass as a
 * `MISSING_SUPPLEMENTARY_INVOICE`, while a duplicate invoice it raises in error
 * is surfaced by nobody and lands on the member. Since #3199 that finding is the
 * critical, one-click kind only where that pass can establish from the Xero
 * operation history that the primary invoice went out FIRST; where it cannot, it
 * still names the booking, at `manual_review` and without an action. Surfaced
 * either way, which is all this asymmetry rests on.
 *
 * BEST-EFFORT, AND NOT A RETRY, which is the one thing here that is not obvious.
 * Throwing would hand the row to `failPaymentRecoveryOperation` and buy a retry -
 * except that on the ordinary fork the retry cannot work: the replay has by then
 * written this edit's `ADDITIONAL` PaymentTransaction, and the processor's own
 * "a LATER edit superseded this one" check tests for an additional transaction
 * created after the operation, which that row now is. A second pass would find
 * its own transaction, read it as a supersession, and complete having done
 * nothing at all. So a throw here does not retry the invoice; it converts a
 * missing invoice into a missing invoice plus a spurious FAILED recovery row.
 *
 * The failure is therefore recorded rather than retried, and it is recoverable
 * where it lands: the booking-vs-Xero repair pass classifies a positive-net
 * modification with a primary invoice and no supplementary invoice as a finding
 * and offers `QUEUE_SUPPLEMENTARY_INVOICE`, built from the same two components
 * this function passes. The log line names the anchor an operator needs to run
 * it. THAT ARGUMENT COVERS THE ORDINARY FORK ONLY - a parked review charge's
 * `BookingModification` can carry a zero net, which the repair pass's
 * `netAmountCents > 0` gate never looks at - so the review fork writes its own
 * durable record and does not rely on this one.
 */
async function raiseDeferredSupplementaryInvoiceForRecoveredIntent(params: {
  operationId: string;
  bookingId: string;
  bookingModificationId: string;
  paymentIntentId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  hadIssuedXeroInvoice: boolean | null;
  originalPaymentStatus: PaymentStatus | string | null;
}): Promise<DeferredSupplementaryInvoiceAttempt> {
  if (params.hadIssuedXeroInvoice === null) {
    logger.warn(
      {
        operationId: params.operationId,
        bookingId: params.bookingId,
        bookingModificationId: params.bookingModificationId,
        paymentIntentId: params.paymentIntentId,
      },
      "Recovered additional payment carries no record of whether its edit had an issued Xero invoice - no supplementary invoice was raised, and the booking-vs-Xero repair pass can queue it for this booking modification",
    );
    return { status: "not-recorded" };
  }
  try {
    // Dynamic import: keeps the Xero outbox's provider-client import graph out of
    // every module that imports this worker, exactly as the two dynamic imports
    // below it do for their own modules.
    //
    // INSIDE the try, and that is load-bearing rather than tidy (#3181 fix
    // round). A module that fails to load throws exactly like a call that fails,
    // and this function's whole contract is that it does not throw - the docblock
    // above argues at length that a throw from here cannot retry, because the
    // ordinary fork's replay has already written its ADDITIONAL transaction and
    // the next pass would read that row as a supersession and complete having
    // done nothing. An `await import` sitting outside the catch is precisely the
    // throw that argument does not cover.
    const { completeDeferredXeroSupplementaryInvoice } = await import(
      "@/lib/xero-booking-edit-settlement"
    );
    const outcome = await completeDeferredXeroSupplementaryInvoice({
      bookingId: params.bookingId,
      bookingModificationId: params.bookingModificationId,
      paymentIntentId: params.paymentIntentId,
      priceDiffCents: params.priceDiffCents,
      changeFeeCents: params.changeFeeCents,
      hasIssuedXeroInvoice: params.hadIssuedXeroInvoice,
      originalPaymentStatus: params.originalPaymentStatus,
    });
    return { status: "queued", outcome };
  } catch (err) {
    logger.error(
      {
        err,
        operationId: params.operationId,
        bookingId: params.bookingId,
        bookingModificationId: params.bookingModificationId,
        paymentIntentId: params.paymentIntentId,
        priceDiffCents: params.priceDiffCents,
        changeFeeCents: params.changeFeeCents,
      },
      "Failed to queue the Xero supplementary invoice a recovered additional payment was deferring - the booking-vs-Xero repair pass can queue it for this booking modification",
    );
    return { status: "failed" };
  }
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
  /**
   * #3170 (epic #2797): the `BookingModification` this operation belongs to, read
   * back through the ONE parser rather than by slicing a prefix off the key
   * inline. The inline slice assumed the ordinary edit key's shape and produced a
   * fragment (`"tent_recovery_<id>"`) for the review-charge key, because the
   * builder had been moved into `payment-recovery-keys.ts` and made a required
   * argument while the parser was left here. Fail-closed: null means "not a shape
   * this knows", and every use below tests for it.
   */
  const bookingModificationId =
    bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey,
    );

  /**
   * #3170: a completed EDIT_FINANCIAL_REVIEW charge replays DIFFERENTLY, and must
   * not fall through to the ordinary path below.
   *
   * Two reasons, both of which cost money if ignored. First, its debt is not the
   * amount frozen on this row - one booking edit can raise two review tasks and
   * the request asks for their SUM, so the replay re-derives the total from the
   * settled shares. Second, the "a newer additional supersedes this one" check
   * below would see the request THIS EDIT ALREADY MINTED, treat it as a later
   * edit's collectable and complete the operation having minted nothing - which
   * is precisely how the first round's second share was dropped.
   */
  if (
    bookingModificationId &&
    isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)
  ) {
    // Dynamic import: edit-financial-review-charge imports this module.
    const { syncEditFinancialReviewChargeRequest } = await import(
      "@/lib/edit-financial-review-charge"
    );
    const booking = await prisma.booking.findUnique({
      where: { id: operation.bookingId },
      select: {
        status: true,
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        // #3181: `status` joins the select because the deferred supplementary
        // invoice this replay now raises is classified partly from it (the
        // primary invoice's local paid/refunded state). Whether an invoice
        // EXISTS to supplement is deliberately NOT read here: that is the edit's
        // answer, frozen on the recovery row.
        payment: {
          select: {
            stripeCustomerId: true,
            status: true,
          },
        },
      },
    });
    if (!booking) {
      throw new Error(
        `Booking ${operation.bookingId} not found for edit-financial-review charge recovery`,
      );
    }
    if (booking.status === BookingStatus.CANCELLED) {
      // Same reasoning as the ordinary path's cancelled-booking skip (#1358):
      // the cancel flow retired this booking's additional intents, so minting a
      // live one here would resurrect a collectable that must never be captured.
      logger.info(
        { operationId: operation.id, bookingId: operation.bookingId },
        "Skipping edit-financial-review charge recovery for cancelled booking",
      );
      await completePaymentRecoveryOperation(operation.id);
      return;
    }
    const synced = await syncEditFinancialReviewChargeRequest({
      bookingId: operation.bookingId,
      bookingModificationId,
      paymentId: operation.paymentId,
      member: booking.member
        ? {
            id: booking.member.id,
            email: booking.member.email,
            name: `${booking.member.firstName} ${booking.member.lastName}`,
            stripeCustomerId: booking.payment?.stripeCustomerId ?? null,
          }
        : null,
      // #3181: the settlement's own answer, read back off this row. The sync
      // writes it onward only into an enqueue that cannot fire (this row already
      // exists), so passing it is honesty rather than plumbing - but a re-derived
      // value here would be a second, disagreeing answer in the one place the
      // frozen one exists to prevent.
      hasIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
    });
    if (synced.paymentIntentId) {
      await attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
        bookingModificationId,
        paymentIntentId: synced.paymentIntentId,
      }).catch((err) =>
        logger.error(
          { err, operationId: operation.id, paymentIntentId: synced.paymentIntentId },
          "Failed to attach recovered additional intent to waiting Xero operations",
        ),
      );
      await prisma.paymentRecoveryOperation.update({
        where: { id: operation.id },
        data: { paymentIntentId: synced.paymentIntentId },
      });
      /**
       * #3181: the review charge re-enters the ordinary price-increase path, so
       * it deferred its supplementary invoice for the same reason and the replay
       * has to complete it for the same reason. What differs is the figure: a
       * review charge bills the edit's COMBINED total, re-derived from the
       * settled shares by the sync above, because one booking edit raises one
       * ask (#3170's owner decision) - never this replay's own `amountCents`,
       * which that same decision demoted to advisory. No change fee: the fee, if
       * any, belongs to the structural edit that raised the review, and its own
       * dispatch billed it.
       *
       * NOT ON AN ALREADY-PAID ASK. `already-paid` is the sync saying this edit's
       * request was captured before the replay reached it - its webhook has fired
       * and cannot fire again. A supplementary invoice queued WAITING_PAYMENT
       * against that intent is a row nothing will ever release, cancelled by the
       * 14-day reaper with no invoice raised at all - and while it sits there it
       * makes the operator's signal WORSE, not better: the repair pass reads an
       * anchor carrying a live-but-unretryable operation as
       * `BLOCKED_BY_XERO_OPERATION` (warning, not auto-appliable, no action
       * offered, reported as waiting for a Stripe payment that has already
       * happened) instead of the critical, one-click
       * `MISSING_SUPPLEMENTARY_INVOICE` it would otherwise raise. The share that
       * could not join the ask already has its durable record, written by the
       * sync on the `payment-request` leg.
       */
      if (synced.outcome === "already-paid") {
        logger.warn(
          {
            operationId: operation.id,
            bookingId: operation.bookingId,
            bookingModificationId,
            paymentIntentId: synced.paymentIntentId,
          },
          "Recovered edit-financial-review charge was already paid - no supplementary Xero invoice was queued against it, and the booking-vs-Xero repair pass can queue one for this booking modification",
        );
      } else {
        const attempt =
          await raiseDeferredSupplementaryInvoiceForRecoveredIntent({
            operationId: operation.id,
            bookingId: operation.bookingId,
            bookingModificationId,
            paymentIntentId: synced.paymentIntentId,
            priceDiffCents: synced.totalCents,
            changeFeeCents: 0,
            hadIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
            originalPaymentStatus: booking.payment?.status ?? null,
          });
        const {
          recordShortEditReviewChargeInvoice,
          recordUncollectedEditReviewChargeShare,
        } = await import("@/lib/edit-financial-review-charge-request");
        if (attempt.status === "queued") {
          // The same record the inline dispatch writes, through the same
          // function: a short outcome is the enqueue saying this edit's invoice
          // had left the queue and could not be raised to the settled total.
          // What counts as short - and, since #3193, whether the difference can
          // be billed on its own invoice - belongs there, not to two callers.
          await recordShortEditReviewChargeInvoice({
            outcome: attempt.outcome,
            bookingId: operation.bookingId,
            bookingModificationId,
            /**
             * #3193: NO SECOND ASK FROM THIS FORK, and that is a refusal rather
             * than an omission.
             *
             * The second ask bills ONE settled share, anchored on the task that
             * settled it, which is what makes it safe: that share is provably
             * absent from the invoice that went out, so billing it adds exactly
             * what is missing. This replay holds no task. It re-derives the
             * edit's COMBINED total across every share and cannot say which part
             * of it the sent invoice already carries - so the only figure it
             * could raise an invoice for is the whole total, and that would
             * charge the member a second time for money they have already been
             * asked for. Strictly worse than the shortfall.
             *
             * Nulls here therefore reach `raiseSecondEditReviewChargeInvoice` as
             * `unavailable`, which is a named outcome with its own officer
             * instruction naming the booking-vs-Xero repair pass - not a silent
             * skip and not `failed`, which would tell an officer to bill a
             * difference by hand that nothing here can state.
             */
            reviewTaskId: null,
            shareCents: null,
            memberId: booking.member?.id ?? null,
            totalCents: synced.totalCents,
          }).catch((err) =>
            logger.error(
              { err, operationId: operation.id, bookingModificationId },
              "Failed to record a short Xero supplementary invoice for a recovered edit-financial-review charge",
            ),
          );
        } else {
          /**
           * #3181 fix round: THE REVIEW FORK CANNOT FALL BACK ON THE REPAIR PASS,
           * so it leaves its own record.
           *
           * A parked edit's `BookingModification` carries only the readable
           * strands' money, so an edit whose ONLY money-affecting strand was the
           * parked one has `priceDiffCents + changeFeeCents == 0` - and the
           * booking-vs-Xero repair pass gates its missing-supplementary finding
           * on `netAmountCents > 0`, so it never looks. Without this an officer
           * settles at $230, the member pays it, and the club's only account of
           * the charge is a `logger.error` in a stream nobody reads. `INV-PAY`:
           * every path that settles a share without producing a request leaves a
           * durable trace, and a log line is not one.
           */
          await recordUncollectedEditReviewChargeShare({
            leg: "xero-invoice",
            /**
             * #3181 fix round: THE TWO NON-QUEUED OUTCOMES ARE DIFFERENT FACTS,
             * and filing them under one cause tells an officer to do something
             * that can bill the member twice.
             *
             * `failed` is "an invoice was owed and the queue refused it" - raise
             * it by hand. `not-recorded` is the row predating
             * `hadIssuedXeroInvoice`, where the whole position taken above is
             * that the club CANNOT TELL whether one was owed: if this booking's
             * primary Xero invoice had not been minted when the edit committed,
             * that invoice bills the charge itself and a hand-raised
             * supplementary is a second ask for the same money. Only the
             * booking-vs-Xero repair pass can answer it, and
             * `ask-owed-unknown`'s officer text says exactly that.
             */
            cause:
              attempt.status === "not-recorded"
                ? "ask-owed-unknown"
                : "ask-not-raised",
            // #3193: no ask exists here for a second one to follow, so the
            // second-ask question does not arise. `null`, not `unavailable`,
            // which is specifically "an ask exists and the difference cannot be
            // worked out".
            secondAsk: null,
            bookingId: operation.bookingId,
            bookingModificationId,
            memberId: booking.member?.id ?? null,
            derivedTotalCents: synced.totalCents,
            // No ask exists to be short of, so there is no figure to compare
            // against - the same refusal to invent one the shortfall record makes.
            requestedTotalCents: null,
          }).catch((err) =>
            logger.error(
              { err, operationId: operation.id, bookingModificationId },
              "Failed to record an unraised Xero supplementary invoice for a recovered edit-financial-review charge",
            ),
          );
        }
      }
    }
    /**
     * #3170 fix round: THE REPLAY CLOSES THE DEBT ONLY IF THE ASK NOW EXISTS.
     *
     * This used to complete unconditionally, and the reason that lost money is
     * worth stating exactly, because nothing about it looks wrong at the call
     * site. The mint below the sync is
     * `createModificationAdditionalPaymentIntent`, which SWALLOWS its provider
     * failure and re-enqueues a recovery row - and the row it re-enqueues is
     * THIS row, whose upsert `update` branch deliberately does not reset
     * `status`. So on a replay while the provider is still down the re-enqueue
     * was a no-op on a PROCESSING row, and the next line marked the operation
     * SUCCEEDED with nothing minted. Two shares of $200 and $30 both read
     * COMPLETED and the club collected nothing.
     *
     * Throwing hands the row to `failPaymentRecoveryOperation`, which is the
     * machinery that already exists for exactly this: back off, retry, and on
     * exhaustion mark the operation FAILED and raise the admin payment-failure
     * alert. So the debt stays visible and recoverable instead of being closed.
     *
     * Deliberately NOT the two other shapes considered. Not "stop swallowing in
     * the minter": that function is shared with the ordinary edit path, where
     * swallowing is correct - the member's saved change must still return, and
     * the recovery row IS the retry. Not "enqueue a fresh recovery row": the row
     * being processed is already this debt's durable retry, and a second row for
     * one debt is a second debt.
     */
    if (synced.outcome === "not-raised") {
      throw new Error(
        `Edit financial review charge request for booking modification ${bookingModificationId} was not raised (${synced.totalCents} cents still owed); leaving the recovery operation open to retry`,
      );
    }
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

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

  /**
   * #3181: THE EDIT'S SIGNED COMPONENTS, READ BEFORE ANYTHING IS WRITTEN.
   *
   * They are only needed at the very bottom of this function, to bill the
   * supplementary invoice the inline dispatch deferred - but the read has to
   * happen HERE, and the position is the point (#3181 fix round). Below the
   * `upsertPaymentIntentTransaction` this replay is about to perform, a transient
   * database error on this one query throws into `failPaymentRecoveryOperation`,
   * and the retry it buys cannot work: the ADDITIONAL transaction now exists, so
   * the "a LATER edit superseded this one" check above would find the row THIS
   * replay wrote, read it as a supersession, and complete the operation having
   * done nothing at all. A $50 guest add would be collected with no invoice
   * behind it and the recovery row would read SUCCEEDED.
   *
   * Read here instead and a throw costs nothing: no intent has been minted, no
   * transaction row written, and the next attempt re-runs the whole replay -
   * which is a real retry, not a self-supersession. Nothing between here and the
   * bill writes these two columns, so the value is the same one the old position
   * read. Wrapping the late read in its own `catch` was the alternative; it
   * degrades a transient blip to a manual repair, where this recovers by itself.
   */
  const modificationToBill = bookingModificationId
    ? await prisma.bookingModification.findUnique({
        where: { id: bookingModificationId },
        select: { priceDiffCents: true, changeFeeCents: true },
      })
    : null;

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
  // payment webhook can release it. The anchor comes from the shared parser at
  // the top of this function, never from a prefix slice spelled here (#3170).
  if (bookingModificationId) {
    await attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
      bookingModificationId,
      paymentIntentId: pi.id,
    }).catch((err) =>
      logger.error(
        { err, operationId: operation.id, paymentIntentId: pi.id },
        "Failed to attach recovered additional intent to waiting Xero operations",
      ),
    );
  }

  await prisma.paymentRecoveryOperation.update({
    where: { id: operation.id },
    data: { paymentIntentId: pi.id },
  });

  /**
   * #3181: and now raise the invoice the edit deferred. The attach above only
   * ever points an EXISTING waiting operation at the recovered intent; where the
   * inline dispatch skipped the queue entirely there is nothing for it to point
   * at, which is the whole defect.
   *
   * The figure comes from the `BookingModification` itself rather than from
   * `operation.amountCents`. They are different quantities: the recovery row
   * carries what Stripe is collecting, and the invoice bills the edit's SIGNED
   * components, which a mixed-sign edit (a price reduction plus a larger
   * late-change fee) separates - the pair is what `INV-MONEY`/#1356 requires and
   * what the booking-vs-Xero repair pass reads for the same invoice.
   */
  if (bookingModificationId) {
    // Read above the mint, deliberately: see the hoist's own comment.
    if (modificationToBill) {
      await raiseDeferredSupplementaryInvoiceForRecoveredIntent({
        operationId: operation.id,
        bookingId: operation.bookingId,
        bookingModificationId,
        paymentIntentId: pi.id,
        priceDiffCents: modificationToBill.priceDiffCents,
        changeFeeCents: modificationToBill.changeFeeCents,
        // The EDIT's answer, frozen on this row when the mint failed. Re-reading
        // `payment.xeroInvoiceId` here is the double-bill the helper describes.
        hadIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
        originalPaymentStatus: payment.status,
      });
    } else {
      logger.error(
        {
          operationId: operation.id,
          bookingId: operation.bookingId,
          bookingModificationId,
        },
        "Recovered additional intent has no booking modification to bill - no Xero supplementary invoice was raised",
      );
    }
  }

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
      status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
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
