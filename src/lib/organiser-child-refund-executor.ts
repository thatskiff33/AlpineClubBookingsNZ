/**
 * #3653 (`INV-PAY-113`): steps 2 and 3 of an organiser child's refund out of
 * the group's combined card payment - the provider call and its record. Step 1,
 * the debt, and the contract as a whole are in `organiser-child-refund.ts`.
 * Split out so the edit doors that only DECIDE a refund do not import Stripe.
 */
import {
  BookingEventType,
  type BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentStatus,
  type PaymentRecoveryOperation,
} from "@prisma/client";
import type Stripe from "stripe";

import { recordBookingEvent } from "@/lib/booking-events";
import { daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  findCombinedCardSettlementForChild,
  planOrganiserCancelChildRefunds,
  REFUNDABLE_SETTLEMENT_STATUSES,
} from "@/lib/organiser-child-refund";
import { runPaymentRecoveryOperationNow } from "@/lib/payment-recovery";
import {
  buildOrganiserChildCancellationRefundKey,
  isOrganiserChildRefundKey,
  organiserChildRefundReasonForKey,
} from "@/lib/payment-recovery-keys";
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

/**
 * #3653: plan (or read back) one refund per paid child and run each now. Returns
 * the cents each child's refund has ACTUALLY returned - a debt still owed after
 * this run (Stripe failed, or another worker holds it) reads as nothing yet,
 * exactly as the legacy path zeroes its view when its refund fails. The debts
 * stay owed; the recovery cron completes them and alerts on exhaustion.
 */
export async function refundOrganiserCancelChildren({
  settlementId,
  organiserBookingId,
  firstChild,
  activeChildStatuses,
  todayAtClub,
  format,
}: {
  settlementId: string;
  organiserBookingId: string;
  firstChild: { checkIn: Date; lodgeId: string } | null;
  activeChildStatuses: readonly BookingStatus[];
  todayAtClub: CalendarDate;
  format: ClubFormat;
}): Promise<Map<string, number>> {
  // All children share the organiser's lodge (one booking = one lodge,
  // ADR-001). Read OUTSIDE the plan's lock(1) transaction (`INV-LOCK-004`).
  const policy = firstChild
    ? await loadCancellationPolicy(firstChild.checkIn, firstChild.lodgeId)
    : [];
  const plan = await planOrganiserCancelChildRefunds({
    settlementId,
    organiserBookingId,
    activeChildStatuses,
    daysUntilCheckIn: firstChild ? daysUntilDate(firstChild.checkIn, todayAtClub) : 0,
    policy,
  });
  const refunded = new Map<string, number>();
  for (const [childId, cents] of plan) {
    const key = buildOrganiserChildCancellationRefundKey(settlementId, childId);
    const debt = await prisma.paymentRecoveryOperation.findUnique({ where: { idempotencyKey: key } });
    if (!debt) continue;
    if (debt.status !== PaymentRecoveryOperationStatus.SUCCEEDED) {
      await runPaymentRecoveryOperationNow(debt.id, format);
    }
    const after = await prisma.paymentRecoveryOperation.findUnique({
      where: { idempotencyKey: key },
      select: { status: true },
    });
    if (after?.status === PaymentRecoveryOperationStatus.SUCCEEDED) refunded.set(childId, cents);
  }
  return refunded;
}
