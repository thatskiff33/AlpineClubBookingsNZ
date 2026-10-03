/**
 * #3653 (`INV-PAY-114`): steps 2 and 3 of an organiser child's refund out of
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

import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { bookingOwner } from "@/lib/booking-owner";
import { daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { ORGANISER_PAID_SETTLEMENT_STATUSES } from "@/lib/group-organiser-paid";
import {
  findCombinedCardSettlementForChild,
  organiserChildRefundedCents,
  planOrganiserCancelChildRefunds,
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
import { listRefundsForPaymentIntent, processRefund, retrieveRefund } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";
import { getNextRefundedPaymentStatus } from "@/lib/xero-inbound/amounts";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * A refund Stripe already made under this key - read only on a replay. One that
 * Stripe later reported failed or cancelled is not it: the debt was reopened
 * for exactly that refund (`reconcilePendingOrganiserChildRefunds`), so a
 * replay past Stripe's 24-hour key window asks again rather than re-reading the
 * failure for ever.
 */
async function findProviderRefundForKey(
  stripe: { listRefundsForPaymentIntent: typeof listRefundsForPaymentIntent },
  paymentIntentId: string,
  key: string,
) {
  const refunds = await stripe.listRefundsForPaymentIntent(paymentIntentId);
  return (
    refunds.find(
      (refund) =>
        refund.metadata?.organiserChildRefundKey === key && isRecordedRefundStatus(refund.status ?? "unknown"),
    ) ?? null
  );
}

/** The settlement status the counted refunds on its combined intent imply. */
function settlementStatusForRefunds(refundedCents: number, capturedCents: number): PaymentStatus {
  if (refundedCents <= 0) return PaymentStatus.SUCCEEDED;
  return refundedCents >= capturedCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
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
    include: { booking: { select: { id: true, memberId: true, organiserSettled: true, parentBookingId: true } } },
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
    if (!entry.created) {
      // Stripe answers a repeated key with its ORIGINAL response for 24 hours,
      // so a replay of a refund Stripe has since failed reads back `pending`.
      // The row knows better; the debt stays owed rather than closing on it.
      const known = await tx.paymentRefund.findUnique({
        where: { stripeRefundId: refund.id },
        select: { status: true },
      });
      if (known && !isRecordedRefundStatus(known.status)) {
        throw new Error(`Organiser child refund ${refund.id} is recorded as ${known.status}; the refund is still owed`);
      }
    }
    let queuedCreditNoteId: string | null = null;
    if (entry.created) {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { id: true, status: true, amountCents: true, refundedAmountCents: true },
      });
      // What had gone back BEFORE this refund (`organiserChildRefundedCents`,
      // which reads its refund rows - this one now among them - so a mirror a
      // reconcile zeroed cannot shrink the total), plus this refund.
      const before = Math.max(
        current.refundedAmountCents,
        (await organiserChildRefundedCents(tx, current)) - refund.amount,
      );
      const next = Math.min(current.amountCents, before + refund.amount);
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmountCents: next,
          status: getNextRefundedPaymentStatus(current.status, current.amountCents, next) ?? current.status,
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
      where: { id: settlement.id, status: { in: [...ORGANISER_PAID_SETTLEMENT_STATUSES] } },
      data: { status: settlementStatusForRefunds(combinedRefundedCents, settlement.amountCents) },
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
    // A refund an earlier attempt failed to make (the first claim is attempt
    // 1): the door that decided it wrote its audit row before the money moved -
    // a group cancel says it released the spot with the refund still owed - so
    // the recovery says, in the same trail, that the money has now gone back.
    if (operation.attempts > 1) {
      logAudit({
        action: "booking.payment.refund_recovered",
        targetId: operation.bookingId,
        subjectMemberId: bookingOwner(payment.booking).memberId,
        entityType: "Booking",
        entityId: operation.bookingId,
        category: "booking",
        severity: "critical",
        outcome: "success",
        summary: "Organiser child refund recovered",
        details: `Recovered the refund of ${amount} to the group organiser's card for this joiner's booking, after an earlier attempt failed.`,
        metadata: {
          settlementId: settlement.id,
          paymentId: payment.id,
          refundCents: refund.amount,
          stripeRefundId: refund.id,
          attempts: operation.attempts,
        },
      });
    }
  }
  return refund.id;
}

/**
 * #3653: a child refund Stripe answered `pending` was recorded as made (a
 * pending refund is counted money back, `isRecordedRefundStatus`), and Stripe
 * can still fail it. The combined intent has no `Payment` of its own, so the
 * `charge.refunded` webhook resolves nothing for it. The payments cron reads
 * each such refund back from Stripe by its id; one that has failed or been
 * cancelled is taken back out - the refund row, the child's mirror, the
 * settlement's status - and its debt is reopened, so the money stays owed (and
 * spoken for against the combined capture) and the recovery runner asks again,
 * alerting on exhaustion. One that succeeded just has its row brought up to
 * date. Never inside a transaction with the provider call.
 */
export async function reconcilePendingOrganiserChildRefunds(
  stripe: { retrieveRefund: typeof retrieveRefund } = { retrieveRefund },
  limit = 25,
): Promise<{ checked: number; reversed: number }> {
  const pending = await prisma.paymentRefund.findMany({
    where: {
      paymentTransactionId: null,
      status: { notIn: [...EXCLUDED_LEDGER_REFUND_STATUSES, "succeeded"] },
      payment: { booking: { organiserSettled: true } },
    },
    select: { stripeRefundId: true, paymentId: true, status: true, stripePaymentIntentId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let reversed = 0;
  for (const row of pending) {
    let refund: Stripe.Refund;
    try {
      refund = await stripe.retrieveRefund(row.stripeRefundId);
    } catch (err) {
      logger.error({ err, stripeRefundId: row.stripeRefundId }, "Could not read an organiser child refund back from Stripe");
      continue;
    }
    if ((refund.status ?? row.status) === row.status) continue;
    const key = refund.metadata?.organiserChildRefundKey ?? null;
    const reversedCents = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, row.paymentId);
      const entry = await recordStripeRefundLedgerEntry({
        paymentId: row.paymentId,
        paymentTransactionId: null,
        refund,
        fallbackPaymentIntentId: row.stripePaymentIntentId,
        store: tx,
      });
      if (entry.reversedCents <= 0) return 0;
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: row.paymentId },
        select: { id: true, status: true, amountCents: true, refundedAmountCents: true, booking: { select: { organiserSettled: true, parentBookingId: true } } },
      });
      const next = Math.max(0, current.refundedAmountCents - entry.reversedCents);
      await tx.payment.update({
        where: { id: current.id },
        data: {
          refundedAmountCents: next,
          status: getNextRefundedPaymentStatus(current.status, current.amountCents, next) ?? current.status,
        },
      });
      const settlement = await findCombinedCardSettlementForChild(tx, current.booking);
      if (settlement) {
        const combined = await tx.paymentRefund.aggregate({
          where: { stripePaymentIntentId: settlement.stripePaymentIntentId, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
          _sum: { amountCents: true },
        });
        await tx.groupBookingSettlement.updateMany({
          where: { id: settlement.id, status: { in: [...ORGANISER_PAID_SETTLEMENT_STATUSES, PaymentStatus.REFUNDED] } },
          data: { status: settlementStatusForRefunds(combined._sum.amountCents ?? 0, settlement.amountCents) },
        });
      }
      if (key && isOrganiserChildRefundKey(key)) {
        // Reopened as a fresh retry: owed again, and counted against the
        // combined capture again (`committedCents`), until it is made.
        await tx.paymentRecoveryOperation.updateMany({
          where: { idempotencyKey: key, status: PaymentRecoveryOperationStatus.SUCCEEDED },
          data: {
            // PENDING, not FAILED: owed and claimable again, not a terminal
            // failure (`INV-PAY-056` keeps that one route).
            status: PaymentRecoveryOperationStatus.PENDING,
            attempts: 1,
            nextRetryAt: new Date(),
            succeededAt: null,
            lastError: `Stripe reported refund ${refund.id} as ${refund.status} after it was recorded`,
          },
        });
      }
      return entry.reversedCents;
    });
    if (reversedCents > 0) {
      reversed += 1;
      logger.error(
        { stripeRefundId: refund.id, paymentId: row.paymentId, reversedCents, organiserChildRefundKey: key },
        "An organiser child refund Stripe had accepted then failed; the refund is owed again (#3653)",
      );
    }
  }
  return { checked: pending.length, reversed };
}

/**
 * #3653: plan (or read back) one refund per paid child and run each now. Returns
 * the cents each child's refund has ACTUALLY returned - a debt still owed after
 * this run (Stripe failed, or another worker holds it) reads as nothing yet,
 * exactly as the legacy path zeroes its view when its refund fails. The debts
 * stay owed; the recovery cron completes them and alerts on exhaustion.
 */
export type OrganiserCancelChildRefunds = {
  /** Cents each child's refund has actually returned. */
  refunded: Map<string, number>;
  /** Cents each child is owed by a debt this run could not complete. */
  owed: Map<string, number>;
};

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
}): Promise<OrganiserCancelChildRefunds> {
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
  const owed = new Map<string, number>();
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
    else owed.set(childId, cents);
  }
  return { refunded, owed };
}
