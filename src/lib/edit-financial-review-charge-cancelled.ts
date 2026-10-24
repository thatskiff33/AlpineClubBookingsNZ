import "server-only";

import { PaymentStatus, type PaymentRecoveryOperation } from "@prisma/client";

import { refusesReviewChargeForCancellation } from "@/lib/booking-payment-state";
import type { ClubFormat } from "@/lib/club-format";
import {
  findEditReviewChargeRequest,
  recordUncollectedEditReviewChargeShare,
  sumEditReviewChargeSharesCents,
} from "@/lib/edit-financial-review-charge-request";
import {
  claimEditReviewChargeRaise,
  releaseEditReviewChargeRaise,
} from "@/lib/edit-financial-review-charge-raise-claim";
import {
  completeEditFinancialReviewChargeRecovery,
  holdEditFinancialReviewChargeRecovery,
} from "@/lib/edit-financial-review-charge-recovery";
import type { EditReviewChargeSyncResult } from "@/lib/edit-financial-review-charge-sync";
import logger from "@/lib/logger";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #4272: what a caller of `recordUncollectedEditReviewChargeShare` supplies in
 * place of the leg's own prose and figures. The record's action, category and
 * severity stay that function's. A caller passing this gets the audit insert's
 * failure THROWN rather than logged, so the durable row behind it retries
 * instead of closing with no record.
 */
export type UncollectedShareOverride = {
  log: string;
  summary: string;
  details: string;
  metadata: Record<string, unknown>;
};

/**
 * #4272: the edit's request, or a refund of it, is still moving at Stripe, so
 * what the member paid and kept is not known yet. Thrown rather than guessed;
 * the replay waits without spending an attempt
 * (`holdEditFinancialReviewChargeRecovery`), and an inline caller's catch makes
 * the debt durable on the recovery row.
 */
export class EditReviewChargeStillMovingError extends Error {}

/** How long the replay waits before looking again at a request still moving. */
const STILL_MOVING_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * #4272: a review charge whose booking was cancelled after the completion
 * committed - the race behind the chooser's refusal, which refuses a booking
 * already cancelled. Nothing is asked of the member (a request on a cancelled
 * booking is one they cannot pay, `INV-ADDPAY-023`); what the edit's settled
 * shares leave uncollected is recorded for an officer to collect another way.
 *
 * MUST be called holding this edit's raise claim (`INV-PAY-112`): the sync calls
 * it under its own claim, and the replay takes the claim first
 * (`closeCancelledEditReviewChargeReplay`). The claim is what makes the read of
 * earlier records and the write below one step, so two runs cannot both write.
 *
 * THE FIGURE. Owed is the edit's settled shares. Collected is what the member
 * paid on this edit's card request NET of refunds (`refundedAmountCents`) and of
 * any balance carried in from another edit - a refund is counted against this
 * edit first, because the owner's decision is that the charge is still owed and
 * collected another way. A request that covers the shares answers `already-paid`
 * and records nothing.
 *
 * IDEMPOTENT. A replay can run again - a reaper re-claim, a failed close, a later
 * share re-arming the row - so what earlier records for this edit already told
 * an officer to collect is subtracted, and only the rest is written
 * (`sumRecordedShortfallCents`).
 *
 * A request still PROCESSING, or with a refund Stripe has not settled, throws
 * `EditReviewChargeStillMovingError`: what the member kept is not known yet.
 * The figure is otherwise measured at the refunds recorded at that moment, and
 * the record says so.
 *
 * `recordedUncollected` on the result says whether a record was written.
 */
export async function settleCancelledEditReviewCharge({
  bookingId,
  paymentId,
  bookingModificationId,
  memberId,
  format,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  memberId: string | null;
  format: ClubFormat;
}): Promise<EditReviewChargeSyncResult> {
  const totalCents = await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId });
  if (totalCents <= 0) {
    return { outcome: "nothing-owed", paymentIntentId: null, totalCents: 0, carriedCents: 0 };
  }
  const request = await findEditReviewChargeRequest({ paymentId, bookingModificationId });
  if (request?.status === PaymentStatus.PROCESSING) {
    throw new EditReviewChargeStillMovingError(
      `The charge request for booking modification ${bookingModificationId} is still processing at Stripe on a cancelled booking`,
    );
  }
  const paid = request && isCapturedTransactionStatus(request.status) ? request : null;
  const paidRow = paid
    ? await prisma.paymentTransaction.findUnique({
        where: { id: paid.paymentTransactionId },
        select: { refundedAmountCents: true, refunds: { select: { status: true } } },
      })
    : null;
  // A refund Stripe accepted but has not settled can still fail and put the
  // money back, so the figure waits for it rather than overstating what is owed.
  if (paidRow?.refunds.some((refund) => refund.status !== "succeeded" && isRecordedRefundStatus(refund.status))) {
    throw new EditReviewChargeStillMovingError(
      `A refund of the charge request for booking modification ${bookingModificationId} is still settling at Stripe`,
    );
  }
  const refundedCents = paidRow?.refundedAmountCents ?? 0;
  const paidForEditCents = paid ? paid.amountCents - paid.carriedAskCents : 0;
  const netPaidCents = Math.max(paidForEditCents - refundedCents, 0);
  if (paid && netPaidCents >= totalCents) {
    return {
      outcome: "already-paid",
      paymentIntentId: paid.stripePaymentIntentId,
      totalCents,
      carriedCents: paid.carriedAskCents,
    };
  }
  const owedCents = totalCents - netPaidCents;
  const recordedCents = await sumRecordedShortfallCents({ bookingId, bookingModificationId });
  const newCents = owedCents - recordedCents;
  if (newCents > 0) {
    const money = (cents: number) => formatCents(cents, format);
    const paidSentence = !paid
      ? "Nothing was collected towards it."
      : refundedCents > 0
        ? `The member paid ${money(paidForEditCents)} towards it by card and ${money(refundedCents)} of that had been refunded when this was recorded, so ${money(netPaidCents)} counts as collected.`
        : `The member paid ${money(paidForEditCents)} towards it by card.`;
    const carriedSentence = paid && paid.carriedAskCents > 0
      ? ` A further ${money(paid.carriedAskCents)} on that payment was an earlier change's unpaid extra and is not counted here.`
      : "";
    const earlierSentence = recordedCents > 0
      ? ` An earlier record already covers ${money(recordedCents)} of the ${money(owedCents)} still owed; this one is the rest.`
      : "";
    await recordUncollectedEditReviewChargeShare({
      format,
      leg: "payment-request",
      cause: "booking-cancelled",
      // The card leg's remedy is collecting by hand, never a second Xero invoice.
      secondAsk: null,
      bookingId,
      bookingModificationId,
      memberId,
      derivedTotalCents: totalCents,
      requestedTotalCents: paid?.amountCents ?? 0,
      carriedAskCents: paid?.carriedAskCents ?? 0,
      override: {
        log: "Edit-financial-review charge share was not asked for because the booking was cancelled - it must be collected by hand",
        summary: `A settled review share of ${money(newCents)} was not asked for because this booking was cancelled`,
        details: `An admin settled a booking-change review as money the member owes the club, but the booking was cancelled before the member could be asked for it, and a payment request on a cancelled booking is one the member has no way to pay. The reviews for that change total ${money(totalCents)}. ${paidSentence}${carriedSentence}${earlierSentence} Collect ${money(newCents)} another way and record what was collected.`,
        metadata: {
          uncollectedCents: newCents,
          owedCents,
          netPaidCents,
          refundedCents,
          alreadyRecordedCents: recordedCents,
        },
      },
    });
    return { outcome: "booking-cancelled", paymentIntentId: null, totalCents, carriedCents: 0, recordedUncollected: true };
  }
  return { outcome: "booking-cancelled", paymentIntentId: null, totalCents, carriedCents: 0, recordedUncollected: false };
}

/**
 * What earlier records for this edit already told an officer to collect by
 * hand. Both kinds of card-leg record count, read off each row's metadata under
 * the one action `recordUncollectedEditReviewChargeShare` writes:
 *
 *   * `ask-closed` - the sync's paid-request record. Each states the edit's
 *     whole shortfall at that moment, a RUNNING total, so the largest is taken.
 *   * `booking-cancelled` - this path's own records. Each states only what the
 *     ones before it did not cover, an INCREMENT, so they are summed.
 */
async function sumRecordedShortfallCents({
  bookingId,
  bookingModificationId,
}: {
  bookingId: string;
  bookingModificationId: string;
}): Promise<number> {
  const rows = await prisma.auditLog.findMany({
    where: { action: "booking.editFinancialReview.chargeShareUncollected", targetId: bookingId },
    select: { metadata: true },
  });
  let closedMax = 0;
  let cancelledSum = 0;
  for (const { metadata } of rows) {
    const fields = (metadata ?? {}) as Record<string, unknown>;
    if (
      fields.leg !== "payment-request" ||
      fields.bookingModificationId !== bookingModificationId ||
      typeof fields.uncollectedCents !== "number"
    ) {
      continue;
    }
    if (fields.cause === "ask-closed") closedMax = Math.max(closedMax, fields.uncollectedCents);
    if (fields.cause === "booking-cancelled") cancelledSum += fields.uncollectedCents;
  }
  return closedMax + cancelledSum;
}

/**
 * #4272: the recovery replay's path for a review charge on a cancelled booking -
 * before it calls the sync, and again when a sync answered `not-raised` because
 * the cancellation landed mid-replay (so that run does not burn an attempt).
 *
 * False when the booking is not cancelled, and the replay carries on. Otherwise
 * it takes the edit's raise claim, settles (`settleCancelledEditReviewCharge`:
 * records what is uncollected, idempotently), and closes the row. A request or
 * refund still moving at Stripe hands the row back to wait, without spending an
 * attempt. A held claim or a failed audit insert THROWS, so the row retries
 * rather than closing with no record.
 */
export async function closeCancelledEditReviewChargeReplay({
  format,
  operation,
  bookingModificationId,
  memberId,
  status,
}: {
  format: ClubFormat;
  operation: Pick<PaymentRecoveryOperation, "id" | "bookingId" | "paymentId" | "attempts" | "nextRetryAt" | "processingStartedAt">;
  bookingModificationId: string;
  memberId: string | null;
  /** The booking's status as the caller read it; re-read here when absent. */
  status?: string;
}): Promise<boolean> {
  const bookingStatus =
    status ??
    (await prisma.booking.findUnique({ where: { id: operation.bookingId }, select: { status: true } }))?.status;
  if (!bookingStatus || !refusesReviewChargeForCancellation({ status: bookingStatus })) return false;
  const claim = await claimEditReviewChargeRaise(bookingModificationId);
  if (!claim) {
    throw new Error(
      `Another run holds the charge raise claim for booking modification ${bookingModificationId}; leaving the cancelled booking's recovery open to retry`,
    );
  }
  try {
    await settleCancelledEditReviewCharge({
      format,
      bookingId: operation.bookingId,
      paymentId: operation.paymentId,
      bookingModificationId,
      memberId,
    });
  } catch (err) {
    if (!(err instanceof EditReviewChargeStillMovingError)) throw err;
    // Wait without spending an attempt: the row stays open, and alive.
    await holdEditFinancialReviewChargeRecovery(operation, new Date(Date.now() + STILL_MOVING_RECHECK_MS), err.message);
    return true;
  } finally {
    await releaseEditReviewChargeRaise(claim).catch((err) =>
      logger.error(
        { err, bookingModificationId },
        "Failed to release an edit financial review charge raise claim - it will expire with its lease",
      ),
    );
  }
  await completeEditFinancialReviewChargeRecovery(operation);
  return true;
}
