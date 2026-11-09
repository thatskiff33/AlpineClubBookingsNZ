import type { PaymentRecoveryOperation } from "@prisma/client";

import logger from "@/lib/logger";
import { isRefundReservationOpen } from "@/lib/member-money";
import { isBookingJournalInactive, postCardRefundCash, resolveBookingMoneyPostingContext } from "@/lib/member-money/doors";
import { carriesCardRefundOperationMetadata } from "@/lib/open-card-refund-owed";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";

type SupersededRow = Pick<PaymentRecoveryOperation, "id" | "type" | "idempotencyKey" | "stripeKeyPrefix" | "bookingId" | "paymentId" | "paymentIntentId">;

/** The refunds Stripe lists that this row's first request made: its metadata, no slice key. Every status. */
function ownFirstRequestRefunds(operation: SupersededRow, refunds: Awaited<ReturnType<typeof listRefundsForPaymentIntent>>) {
  return refunds.filter((refund) =>
    (!refund.payment_intent || stripeReferenceId(refund.payment_intent) === operation.paymentIntentId) &&
    carriesCardRefundOperationMetadata(operation, refund.metadata) && !refund.metadata?.[REFUND_SLICE_KEY_METADATA]);
}

/**
 * #4516 (round-2 review C): may this row's one request be reserved again at another amount? Only where its key
 * holds an open reservation and Stripe lists no refund the request made, in any state: the attempt that reserved
 * it died before Stripe was asked, so the key was never used and its outstanding amount (moved since, say by a
 * refund made in the Stripe dashboard) is what it now asks. A key with no open reservation needs nothing; one
 * Stripe cannot be read for, or that made a refund, keeps the refusal (`reserveCardRefundSlice`, review L1).
 */
export async function supersededFirstRequestUnsent(operation: SupersededRow): Promise<boolean> {
  if (!(await isRefundReservationOpen(prisma, operation.idempotencyKey))) return false;
  try {
    return ownFirstRequestRefunds(operation, await listRefundsForPaymentIntent(operation.paymentIntentId, { timeoutMs: 10_000, singlePage: true })).length === 0;
  } catch (err) {
    logger.warn({ operationId: operation.id, paymentIntentId: operation.paymentIntentId, err },
      "A superseded refund row's open reservation was not resized: Stripe's refunds could not be read (#4516)");
    return false;
  }
}

/**
 * #4516 review L1: A SUPERSEDED INTENT'S FIRST REQUEST, MADE AND NEVER ANSWERED. A superseded intent's refund row
 * asks Stripe once under its own key (`idempotencyKey`, with no slice evidence, so its body stays the one #4103
 * replays), reserving its debt under that key first. An attempt that dies after Stripe made the refund leaves the
 * reservation open, and the refund's R12 posts unapplied when a webhook records it: nothing on the refund names the
 * key. When the row next finds nothing outstanding, this answers that refund to the reservation through the one
 * cash writer: the refund is the row's own exactly when it carries the row's metadata and no slice key (only this
 * request is sent without one), and is the only such refund. Anything else leaves the reservation for the census
 * (`STRANDED_RESERVATION`) and the owner's OPERATOR release. A read Stripe refuses decides nothing here.
 */
export async function answerSupersededFirstRequest(operation: SupersededRow): Promise<void> {
  const journal = await resolveBookingMoneyPostingContext();
  if (isBookingJournalInactive(journal) || !(await isRefundReservationOpen(prisma, operation.idempotencyKey))) return;
  const logContext = { operationId: operation.id, bookingId: operation.bookingId, paymentIntentId: operation.paymentIntentId };
  let refunds: Awaited<ReturnType<typeof listRefundsForPaymentIntent>>;
  try {
    refunds = await listRefundsForPaymentIntent(operation.paymentIntentId, { timeoutMs: 10_000, singlePage: true });
  } catch (err) {
    logger.warn({ ...logContext, err }, "A superseded refund row's open reservation was not answered: Stripe's refunds could not be read (#4516)");
    return;
  }
  const own = ownFirstRequestRefunds(operation, refunds).filter((refund) => isRecordedRefundStatus(refund.status ?? "unknown"));
  if (own.length !== 1) {
    logger.warn({ ...logContext, ownRefundIds: own.map((refund) => refund.id) },
      "A superseded refund row's open reservation was not answered: no single refund is its first request's (#4516)");
    return;
  }
  await prisma.$transaction((tx) => postCardRefundCash(tx, journal, { paymentId: operation.paymentId, attemptKeys: new Map([[own[0]!.id, operation.idempotencyKey]]) }),
    PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
}
