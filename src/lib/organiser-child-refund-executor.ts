/**
 * #3653 (`INV-PAY-113`): steps 2 and 3 of an organiser child's refund out of
 * the group's combined card payment - the provider call and its record. Step 1,
 * the debt, and the contract as a whole are in `organiser-child-refund.ts`.
 * Split out so the edit doors that only DECIDE a refund do not import Stripe.
 */
import {
  BookingEventType,
  PaymentRecoveryOperationStatus,
  PaymentStatus,
  type PaymentRecoveryOperation,
} from "@prisma/client";
import type Stripe from "stripe";

import { recordBookingEvent } from "@/lib/booking-events";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  findCombinedCardSettlementForChild,
  REFUNDABLE_SETTLEMENT_STATUSES,
} from "@/lib/organiser-child-refund";
import { isOrganiserChildRefundKey, organiserChildRefundReasonForKey } from "@/lib/payment-recovery-keys";
import { EXCLUDED_LEDGER_REFUND_STATUSES, isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { lockPaymentForRefundedTotal, recordStripeRefundLedgerEntry } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent, processRefund } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/** A refund Stripe already made under this key - read only on a replay. */
async function findProviderRefundForKey(
  stripe: { listRefundsForPaymentIntent: typeof listRefundsForPaymentIntent },
  paymentIntentId: string,
  key: string,
) {
  const refunds = await stripe.listRefundsForPaymentIntent(paymentIntentId);
  return refunds.find((refund) => refund.metadata?.organiserChildRefundKey === key) ?? null;
}

/**
 * Steps 2 and 3 for one claimed operation. Throws when the refund could not be
 * made or recorded, so the recovery machinery retries and alerts on
 * exhaustion; a lost race with another worker records nothing twice (the refund
 * row is unique on Stripe's id, the close is status-guarded).
 */
export async function processOrganiserChildRefundOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
  /** Test seam: the two Stripe calls, so the PostgreSQL proof can run without Stripe. */
  stripe: {
    processRefund: typeof processRefund;
    listRefundsForPaymentIntent: typeof listRefundsForPaymentIntent;
  } = { processRefund, listRefundsForPaymentIntent },
): Promise<string> {
  if (!isOrganiserChildRefundKey(operation.idempotencyKey)) {
    throw new Error(`Operation ${operation.id} is not an organiser child refund`);
  }
  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: { booking: { select: { id: true, organiserSettled: true, parentBookingId: true } } },
  });
  if (!payment || payment.bookingId !== operation.bookingId || !payment.booking.organiserSettled) {
    throw new Error(`Organiser child refund ${operation.id} has no organiser-settled child payment`);
  }
  const settlement = await findCombinedCardSettlementForChild(prisma, payment.booking);
  if (!settlement || settlement.stripePaymentIntentId !== operation.paymentIntentId) {
    throw new Error(`Organiser child refund ${operation.id} does not match its group's combined card payment`);
  }

  const key = operation.idempotencyKey;
  // Byte-identical on every attempt, built from the row alone: Stripe answers a
  // repeated key with the original refund only when the body matches.
  const metadata = {
    bookingId: operation.bookingId,
    groupBookingSettlementId: settlement.id,
    organiserChildRefundKey: key,
    reason: organiserChildRefundReasonForKey(key),
  };
  const refund: Stripe.Refund =
    (operation.attempts > 1 ? await findProviderRefundForKey(stripe, operation.paymentIntentId, key) : null) ??
    (await stripe.processRefund({
      paymentIntentId: operation.paymentIntentId,
      amountCents: operation.amountCents,
      metadata,
      idempotencyKey: key,
    }));
  if (!isRecordedRefundStatus(refund.status ?? "unknown")) {
    throw new Error(`Stripe reported organiser child refund ${refund.id} as ${refund.status}`);
  }

  const recorded = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lockPaymentForRefundedTotal(tx, payment.id);
    const entry = await recordStripeRefundLedgerEntry({
      paymentId: payment.id,
      paymentTransactionId: null,
      refund,
      fallbackPaymentIntentId: operation.paymentIntentId,
      store: tx,
    });
    let queuedCreditNoteId: string | null = null;
    if (entry.created) {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { amountCents: true, refundedAmountCents: true },
      });
      const next = Math.min(current.amountCents, current.refundedAmountCents + refund.amount);
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmountCents: next,
          status: next >= current.amountCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });
      // After the refund row, so the note's cash evidence already holds it.
      const queued = await enqueueXeroRefundCreditNoteOperation(payment.id, refund.amount, {
        store: tx,
        refundMethod: "card",
      });
      queuedCreditNoteId = queued.queueOperationId;
    }
    const combined = await tx.paymentRefund.aggregate({
      where: { stripePaymentIntentId: operation.paymentIntentId, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
      _sum: { amountCents: true },
    });
    const combinedRefundedCents = combined._sum.amountCents ?? 0;
    if (combinedRefundedCents > settlement.amountCents) {
      throw new Error(
        `Refunds recorded on the combined payment of settlement ${settlement.id} exceed what it captured`,
      );
    }
    await tx.groupBookingSettlement.updateMany({
      where: { id: settlement.id, status: { in: [...REFUNDABLE_SETTLEMENT_STATUSES] } },
      data: {
        status:
          combinedRefundedCents >= settlement.amountCents
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    await tx.paymentRecoveryOperation.updateMany({
      where: { id: operation.id, status: { not: PaymentRecoveryOperationStatus.SUCCEEDED } },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
        lastError: null,
        processingStartedAt: null,
        succeededAt: new Date(),
      },
    });
    return { created: entry.created, queuedCreditNoteId };
  });

  if (recorded.queuedCreditNoteId) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
      logger.error({ err, operationId: operation.id }, "Failed to kick the Xero refund note for an organiser child refund"),
    );
  }
  if (recorded.created) {
    const amount = formatCents(refund.amount, format);
    // The booking's own history carries the record; Stripe's refund id is logged.
    logger.info(
      { operationId: operation.id, settlementId: settlement.id, stripeRefundId: refund.id, refundCents: refund.amount },
      "Organiser child refund recorded against the combined payment (#3653)",
    );
    await recordBookingEvent({
      bookingId: operation.bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: null,
      amountCents: refund.amount,
      reason: `${amount} was refunded to the group organiser's card, who paid for this booking.`,
    }).catch((err) =>
      logger.error({ err, bookingId: operation.bookingId }, "Failed to record the organiser child refund event"),
    );
  }
  return refund.id;
}
