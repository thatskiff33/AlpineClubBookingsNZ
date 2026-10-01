import {
  PaymentRecoveryOperationStatus,
  type PaymentRecoveryOperation,
} from "@prisma/client";

import type { EditReviewChargeSyncOutcome } from "@/lib/edit-financial-review-charge-sync";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * #3402 (`INV-PAY-111`): the review-charge recovery row's own lifecycle rules -
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
  await prisma.paymentRecoveryOperation.updateMany({
    where: { idempotencyKey, status: PaymentRecoveryOperationStatus.SUCCEEDED },
    data: {
      status: PaymentRecoveryOperationStatus.PENDING,
      attempts: 0,
      nextRetryAt: now,
      lastError: null,
      processingStartedAt: null,
      succeededAt: null,
    },
  });
  await prisma.paymentRecoveryOperation.updateMany({
    where: { idempotencyKey, status: PaymentRecoveryOperationStatus.PROCESSING },
    data: { nextRetryAt: now },
  });
}

/**
 * Close a review-charge replay, FENCED on the `nextRetryAt` it was claimed with.
 * The re-arm above moves that value on a PROCESSING row when a share is deferred
 * or refused onto this edit while the replay runs - after the replay's own last
 * re-derivation, so the replay cannot have raised for it. Closing over that
 * would lose the share; instead the row goes straight back to PENDING, due at
 * once, and the next pass raises for it. Otherwise identical to
 * `completePaymentRecoveryOperation`, whose fence (not SUCCEEDED) it keeps.
 */
export async function completeEditFinancialReviewChargeRecovery(
  operation: Pick<PaymentRecoveryOperation, "id" | "nextRetryAt">,
): Promise<void> {
  const closed = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      nextRetryAt: operation.nextRetryAt,
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
    where: { id: operation.id, status: PaymentRecoveryOperationStatus.PROCESSING },
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
      : "Edit financial review charge recovery completion matched no live operation (already succeeded, or deleted by a manual mark-paid reversal); nothing was resurrected",
  );
}
