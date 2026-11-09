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
export async function answerSupersededFirstRequest(
  operation: Pick<PaymentRecoveryOperation, "id" | "type" | "idempotencyKey" | "stripeKeyPrefix" | "bookingId" | "paymentId" | "paymentIntentId">,
): Promise<void> {
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
  const own = refunds.filter((refund) =>
    (!refund.payment_intent || stripeReferenceId(refund.payment_intent) === operation.paymentIntentId) &&
    carriesCardRefundOperationMetadata(operation, refund.metadata) && !refund.metadata?.[REFUND_SLICE_KEY_METADATA] &&
    isRecordedRefundStatus(refund.status ?? "unknown"));
  if (own.length !== 1) {
    logger.warn({ ...logContext, ownRefundIds: own.map((refund) => refund.id) },
      "A superseded refund row's open reservation was not answered: no single refund is its first request's (#4516)");
    return;
  }
  await prisma.$transaction((tx) => postCardRefundCash(tx, journal, { paymentId: operation.paymentId, attemptKeys: new Map([[own[0]!.id, operation.idempotencyKey]]) }),
    PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
}
