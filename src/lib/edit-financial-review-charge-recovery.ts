import {
  PaymentRecoveryOperationStatus,
  type PaymentRecoveryOperation,
} from "@prisma/client";

import type { EditReviewChargeSyncOutcome } from "@/lib/edit-financial-review-charge-sync";
import logger from "@/lib/logger";
import { rearmedPaymentRecoveryOperationData } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";

/**
 * #3402 (`INV-PAY-112`): the review-charge recovery row's own lifecycle rules -
 * when a replay may close it, how it closes, and how a later share reopens it.
 * Kept apart from `payment-recovery.ts`, which calls all three, because none of
 * them needs anything from it but the row; no other recovery's semantics move.
 */

/**
 * Whether a review-charge replay that ended on this outcome may close its
 * operation. A Record rather than a chain of string compares, so a NEW outcome
 * is a type error here until somebody decides it - a forgotten one used to fall
 * through to "close", which is how a debt the club never asked for gets marked
 * done (#3170).
 */
export const EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY: Record<EditReviewChargeSyncOutcome, boolean> = {
  "nothing-owed": true,
  raised: true,
  "already-paid": true,
  "not-raised": false,
  // #4272: terminal - nothing may be asked on a cancelled booking, and the
  // uncollected share is already on record.
  "booking-cancelled": true,
  deferred: false,
};

/**
 * Make sure the edit's ONE recovery row will actually run again, after
 * `enqueueEditFinancialReviewChargeRecovery` has upserted it.
 *
 * WHY, WHEN THE SHARED ENQUEUE DELIBERATELY DOES NOT. Its update branch leaves
 * `status` alone. Once an earlier replay had closed the row SUCCEEDED - which
 * the raise claim makes routine, since every deferral it resolves creates the
 * row and the replay then finds the holder already raised - a later deferral or
 * refused raise for a NEW share wrote nothing that would ever run, and that share
 * was never asked for. The replay is a pure re-derivation from the settled
 * shares (a covering ask writes nothing), so reopening a finished row costs one
 * idempotent pass.
 *
 *   * SUCCEEDED -> PENDING, due now, attempts reset: a new debt on the edit.
 *   * PROCESSING is NEVER reopened - a second worker could then claim a row the
 *     first is still running. Only its `nextRetryAt` moves, which no claim reads
 *     while the row is PROCESSING, and which the replay's close is fenced on
 *     (`completeEditFinancialReviewChargeRecovery`).
 *   * A terminal FAILED row is NOT reopened. Its death already handed the edit to
 *     the booking-vs-Xero repair pass, which raises the invoice unpaid, and
 *     withdrew any live card request (`INV-PAY-057`); minting a card request
 *     again on top would be the two-instrument state that rule removes.
 *   * PENDING and retryable FAILED rows will run anyway; nothing changes.
 */
export async function rearmEditFinancialReviewChargeRecovery(idempotencyKey: string) {
  const now = new Date();
  // ORDER MATTERS: the PROCESSING move FIRST, then the SUCCEEDED reopen. Against
  // a running replay's fenced close C, every interleaving leaves the row armed:
  //   * move, C, reopen - C's fence misses, so C hands the row back to PENDING;
  //   * C, move, reopen - the move matches nothing, the reopen catches C's close;
  //   * move, reopen, C - C's fence misses (the reopen matched nothing).
  // The other order loses one: reopen (row still PROCESSING, no match), then C
  // closes on an unmoved fence, then the move finds no PROCESSING row - left
  // SUCCEEDED with this share never asked for.
  await prisma.paymentRecoveryOperation.updateMany({
    where: { idempotencyKey, status: PaymentRecoveryOperationStatus.PROCESSING },
    data: { nextRetryAt: now },
  });
  await prisma.paymentRecoveryOperation.updateMany({
    where: { idempotencyKey, status: PaymentRecoveryOperationStatus.SUCCEEDED },
    data: rearmedPaymentRecoveryOperationData(now),
  });
}

/**
 * Close a review-charge replay, FENCED on the `nextRetryAt` it was claimed with
 * AND on its `processingStartedAt` - the exact attempt.
 * The re-arm above moves that value on a PROCESSING row when a share is deferred
 * or refused onto this edit while the replay runs - after the replay's own last
 * re-derivation, so the replay cannot have raised for it. Closing over that
 * would lose the share; instead the row goes straight back to PENDING, due at
 * once, and the next pass raises for it. Otherwise it closes as
 * `completePaymentRecoveryOperation` does, on its own fence (not SUCCEEDED,
 * plus the exact attempt below) rather than that one's held claim (#4675).
 *
 * THE ATTEMPT FENCE, on both writes (the stale-worker reaper's
 * `fromProcessingStartedAt` pattern). A worker that stalls past the reaper's
 * threshold has its row failed and re-claimed by worker B, which rewrites
 * `processingStartedAt`. The stalled worker's late close must not mark B's row
 * SUCCEEDED, and its hand-back must not reset B's live claim to PENDING with
 * `attempts` zeroed - a third worker would then run the same debt alongside B,
 * and the row would escape `MAX_PAYMENT_RECOVERY_ATTEMPTS`. Both are no-ops then.
 */
export async function completeEditFinancialReviewChargeRecovery(
  operation: Pick<PaymentRecoveryOperation, "id" | "nextRetryAt" | "processingStartedAt">,
): Promise<void> {
  const closed = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      nextRetryAt: operation.nextRetryAt,
      processingStartedAt: operation.processingStartedAt,
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
  if (closed.count === 1) return;
  const handedBack = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: {
      status: PaymentRecoveryOperationStatus.PENDING,
      attempts: 0,
      processingStartedAt: null,
      lastError: null,
    },
  });
  logger.warn(
    { operationId: operation.id },
    handedBack.count === 1
      ? "Edit financial review charge recovery was not closed: a share was deferred onto it while it ran, so it stays open to raise for that share"
      : "Edit financial review charge recovery completion matched no live attempt (already succeeded, re-claimed by another worker after this one stalled, or deleted by a manual mark-paid reversal); nothing was resurrected",
  );
}

/**
 * #4272: hand a cancelled booking's review-charge row back to PENDING, due at
 * `retryAt`, WITHOUT spending the attempt this claim took. The cancelled path
 * waits this way while the edit's request, or a refund of it, is still moving
 * at Stripe: a bank debit can sit PROCESSING for days, and five ordinary
 * retries would kill the row - whose death hands the edit to the repair pass
 * and withdraws its request (`INV-PAY-057`), the wrong ending for a booking
 * that only needs its uncollected share recorded. Fenced on the exact attempt,
 * as the close above is, so a stalled worker cannot rewind a live claim.
 */
export async function holdEditFinancialReviewChargeRecovery(
  operation: Pick<PaymentRecoveryOperation, "id" | "attempts" | "processingStartedAt">,
  retryAt: Date,
  reason: string,
): Promise<void> {
  await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: {
      status: PaymentRecoveryOperationStatus.PENDING,
      attempts: Math.max(operation.attempts - 1, 0),
      nextRetryAt: retryAt,
      processingStartedAt: null,
      lastError: reason,
    },
  });
}
