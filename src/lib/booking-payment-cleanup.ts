import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal, markPaymentIntentTransactionFailed } from "@/lib/payment-transactions";
import { OPEN_INTENT_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import {
  enqueuePaymentIntentCancellationRecovery,
  runPaymentRecoveryOperationNow,
} from "@/lib/payment-recovery";
import type { ClubFormat } from "@/lib/club-format";
import { followSupersededAskInvoicesSafely } from "@/lib/superseded-ask-invoice-carry";

export type SupersededPrimaryPaymentIntent = {
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
};

/**
 * When a booking modification drops a booking's final price to zero, any
 * primary Stripe PaymentIntents still in PENDING/PROCESSING are now
 * superseded and need to be cancelled.
 *
 * Both /modify and /modify-dates call this so a future change that adds
 * a zero-dollar path to modify-dates cannot leave intents accumulating.
 * No-op when newFinalPriceCents > 0.
 */
export async function queueSupersededPrimaryIntentCancellations(
  tx: Prisma.TransactionClient,
  options: {
    bookingId: string;
    paymentId: string;
    newFinalPriceCents: number;
    /**
     * #3567: a pending intent minted in a currency the club no longer charges
     * in. It is superseded whatever its amount — an equal amount is no reason to
     * keep an intent that would charge the old currency.
     */
    wrongCurrencyPaymentIntentId?: string | null;
    /**
     * #4320: only the rows this filter matches, so a caller can judge one
     * class of row against its own figure (a saved-card charge attempt's).
     */
    rows?: Prisma.PaymentTransactionWhereInput;
  },
): Promise<SupersededPrimaryPaymentIntent[]> {
  const pendingPrimaryTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId: options.paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      status: { in: [...OPEN_INTENT_TRANSACTION_STATUS_LIST] },
      stripePaymentIntentId: { not: null },
      // A pending intent is only reusable at exactly the current price:
      // any modification that moves finalPriceCents strands the old intent
      // at the old amount, and capturing it charges the member the wrong
      // total (#1161). Price->0 supersedes every positive pending intent,
      // which is the pre-#1161 behaviour unchanged.
      ...(options.wrongCurrencyPaymentIntentId
        ? {
            amountCents: { gt: 0 },
            OR: [
              { amountCents: { not: options.newFinalPriceCents } },
              { stripePaymentIntentId: options.wrongCurrencyPaymentIntentId },
            ],
          }
        : { amountCents: { gt: 0, not: options.newFinalPriceCents } }),
      ...(options.rows ? { AND: [options.rows] } : {}),
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const superseded: SupersededPrimaryPaymentIntent[] = [];

  for (const transaction of pendingPrimaryTransactions) {
    if (!transaction.stripePaymentIntentId) {
      continue;
    }

    superseded.push({
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
    });

    await enqueuePaymentIntentCancellationRecovery({
      bookingId: options.bookingId,
      paymentId: options.paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      store: tx,
    });
  }

  return superseded;
}

/**
 * THE SUPERSEDE, in two halves (#3340; split by #3954, the combined helper
 * removed by #4442). Before a new ADDITIONAL PaymentIntent is offered, every
 * other live one on the payment - open, or declined (#4422) - is cancelled:
 * `queueSupersededAdditionalIntentCancellationRows` writes each one's durable
 * cancel inside the minter's queue transaction, beside the new ask's row and
 * after its carried balance is re-read (`withAdditionalAskQueueTransaction`),
 * and `cancelSupersededAdditionalIntentsNow` runs those cancels at Stripe after
 * commit, before the new secret is returned. The durable row is the guarantee;
 * the immediate cancel closes the window in which the old client secret is
 * still confirmable - measured at 4 minutes 5 seconds in the live case, long
 * enough for a member to be charged $65 against the superseded intent while the
 * page read $300. A Stripe outage leaves the queued operation for the recovery
 * cron.
 */

/** One superseded intent's durable cancellation, queued and not yet run. */
export type QueuedSupersededIntentCancellation = {
  paymentTransactionId: string;
  paymentIntentId: string;
  operationId: string;
};

/**
 * WHICH OTHER ASKS A SUPERSEDE CANCELS AT STRIPE (#4422, `INV-ADDPAY-023`).
 *
 * An open ask, and a DECLINED one. A declined card fails the local row but
 * leaves the intent confirmable at Stripe (`requires_payment_method`), so a
 * stale tab could still pay it after a later request was paid - the member
 * charged twice, and once the later request's invoice was released, one of the
 * two captures recorded nowhere in Xero. The local row cannot tell a decline
 * from a cancel, so every FAILED ask is queued until a cancel of it has
 * SUCCEEDED; one already cancelled at Stripe costs the runner one retrieve,
 * which then completes its row and drops it from here. A capture that wins the
 * race takes the superseded-capture path, as an open ask's does.
 */
const SUPERSEDABLE_ADDITIONAL_ASK_STATUS_WHERE = [
  { status: { in: [...OPEN_INTENT_TRANSACTION_STATUS_LIST] } },
  {
    status: PaymentStatus.FAILED,
    recoveryOperations: {
      none: {
        type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
      },
    },
  },
] as const satisfies readonly Prisma.PaymentTransactionWhereInput[];

/**
 * The DURABLE half of the supersede: find the
 * other outstanding ADDITIONAL intents and queue each one's cancellation - no
 * provider call. On `store` so a minter that must decide "write my row and
 * supersede the rest" atomically against a price reduction can do both in one
 * transaction (#3954 review round 4, `holdAdditionalIntentRecoveryClaim`), then
 * run the cancellations after commit.
 */
export async function queueSupersededAdditionalIntentCancellationRows(options: {
  bookingId: string;
  paymentId: string;
  /**
   * The one ADDITIONAL intent to keep. Null keeps none: a manual mark-paid's
   * reversal re-applying this rule to a payment with no live ask (#4320).
   */
  newPaymentIntentId: string | null;
  store?: Prisma.TransactionClient;
}): Promise<QueuedSupersededIntentCancellation[]> {
  const store = options.store ?? prisma;
  const pendingAdditional = await store.paymentTransaction.findMany({
    where: {
      paymentId: options.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      OR: [...SUPERSEDABLE_ADDITIONAL_ASK_STATUS_WHERE],
      stripePaymentIntentId: { not: options.newPaymentIntentId },
      amountCents: { gt: 0 },
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const queued: QueuedSupersededIntentCancellation[] = [];
  for (const transaction of pendingAdditional) {
    if (!transaction.stripePaymentIntentId) {
      continue;
    }

    const operation = await enqueuePaymentIntentCancellationRecovery({
      bookingId: options.bookingId,
      paymentId: options.paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      ...(options.store ? { store: options.store } : {}),
    });
    queued.push({
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      operationId: operation.id,
    });
  }
  return queued;
}

/**
 * The LATENCY half: cancel each queued intent at Stripe now. The durable rows
 * are the guarantee; this closes the window in which an old client secret is
 * still confirmable (#3340).
 *
 * #3403 (`INV-PAY-140`): a minter names the intent it just wrote
 * (`newPaymentIntentId`), and the superseded asks' waiting Xero supplementary
 * invoices are then moved onto it, before the minter returns its secret. Here
 * as well as in the cancel step because an ask whose card was DECLINED is
 * carried at once, though its cancel (#4422) may not finish now (a Stripe
 * outage, a backoff) or finished at an earlier supersede. A writer that
 * retires an ask without replacing it (a booking cancel) names none.
 */
export async function cancelSupersededAdditionalIntentsNow(options: {
  bookingId: string;
  paymentId: string;
  queued: readonly QueuedSupersededIntentCancellation[];
  format: ClubFormat;
  /** The request that now carries the superseded asks' balance; absent, no invoice moves. */
  newPaymentIntentId?: string | null;
}): Promise<void> {
  for (const entry of options.queued) {
    // The durable row above is the guarantee; this is latency only (#3340).
    // `runPaymentRecoveryOperationNow` never throws, so a Stripe failure here
    // leaves precisely the pre-#3340 arrangement.
    const immediate = await runPaymentRecoveryOperationNow(entry.operationId, options.format).catch(
      (err) => {
        logger.error(
          {
            err,
            bookingId: options.bookingId,
            paymentIntentId: entry.paymentIntentId,
          },
          "Immediate cancellation of a superseded additional PaymentIntent did not run; the queued recovery operation stands",
        );
        return "failed" as const;
      },
    );
    if (immediate !== "succeeded") {
      /*
        #3340 fix round: SAY SO WHEN THE FAST PATH DECLINES.

        The headline claim of this change is that a superseded intent is dead
        before the replacement's secret is returned, and `not-claimed` is the
        outcome where that does not hold - most often because a FIRST cancel
        attempt failed and left this same row in a five-minute retry backoff,
        which the claim's `nextRetryAt <= now` cannot match. The old intent then
        stays confirmable for the rest of that window. The queued row still
        finishes the job; this is the record that the window was open, so a
        member charged inside it can be explained rather than investigated from
        scratch.
      */
      logger.warn(
        {
          bookingId: options.bookingId,
          paymentId: options.paymentId,
          paymentIntentId: entry.paymentIntentId,
          operationId: entry.operationId,
          outcome: immediate,
        },
        "A superseded additional PaymentIntent was not cancelled immediately; it stays confirmable until the queued recovery operation runs",
      );
    }
  }
  if (options.newPaymentIntentId) {
    await followSupersededAskInvoicesSafely({
      paymentId: options.paymentId,
      carrierPaymentIntentId: options.newPaymentIntentId,
    });
  }
}

/** The `Payment` mirror columns that name a booking's outstanding additional ask. */
export type AdditionalAskMirror = {
  id: string;
  additionalPaymentIntentId?: string | null;
  additionalPaymentStatus?: string | null;
};

/**
 * Does the mirror name an additional intent that is still OUTSTANDING - neither
 * paid nor already failed? A booking cancel leaves an intent that already
 * failed (a declined card) alone; a supersede cancels it (`INV-ADDPAY-023`).
 */
export function hasOutstandingAdditionalPaymentIntent(
  payment: Omit<AdditionalAskMirror, "id"> | null | undefined,
): boolean {
  return Boolean(
    payment?.additionalPaymentIntentId &&
      payment.additionalPaymentStatus !== "SUCCEEDED" &&
      payment.additionalPaymentStatus !== "FAILED",
  );
}

/**
 * RETIRE A CANCELLED BOOKING'S OUTSTANDING ADDITIONAL ASK, in the caller's
 * transaction (`INV-ADDPAY-044`). The one routine the writers that end an ask
 * with its booking run (#4316):
 *
 *  - both cancel claims (`booking-cancel.ts`: the paid path's tx1 and, review
 *    round 2, the never-captured branch's), on the mirror each reads under the
 *    `Payment` row lock, beside its CANCELLED flip;
 *  - the after-commit minters (`ended-booking-ask-guard.ts`: the edit doors,
 *    the recovery runner's replay and a currency re-issue), when a cancel
 *    committed before the minter wrote its new intent's row - that cancel read
 *    the mirror before the intent existed and could not retire it.
 *
 * The caller holds the `Payment` row lock and passes the mirror it read under
 * it. The mirror is marked FAILED, the intent's row FAILED (never over a
 * capture), and a durable `CANCEL_PAYMENT_INTENT` recovery is queued (F1,
 * #1350): the cron cancels the intent at Stripe, or hands a capture that won
 * the race to a full refund. Its key is the transaction and the intent, so the
 * two writers queue one row. Returns the queued cancellation, for the caller's
 * after-commit Stripe attempt, or null when nothing was outstanding.
 */
export async function failOutstandingAdditionalAskInClaim(
  tx: Prisma.TransactionClient,
  { bookingId, payment }: { bookingId: string; payment: AdditionalAskMirror },
): Promise<QueuedSupersededIntentCancellation | null> {
  if (!hasOutstandingAdditionalPaymentIntent(payment)) return null;
  await tx.payment.update({
    where: { id: payment.id },
    data: { additionalPaymentStatus: "FAILED" },
  });
  const paymentIntentId = payment.additionalPaymentIntentId;
  if (!paymentIntentId) return null;
  await markPaymentIntentTransactionFailed({ paymentIntentId, store: tx });
  const additionalTransaction = await tx.paymentTransaction.findFirst({
    where: { paymentId: payment.id, stripePaymentIntentId: paymentIntentId },
    select: { id: true, amountCents: true },
  });
  if (!additionalTransaction) {
    // No ledger row for the outstanding intent (legacy mirror-only payment):
    // the webhook status guard (#1350 part 1) remains the backstop for a late
    // capture.
    logger.warn(
      { bookingId, paymentId: payment.id, additionalPaymentIntentId: paymentIntentId },
      "No payment transaction row for outstanding additional intent; skipping durable cancellation recovery enqueue",
    );
    return null;
  }
  const operation = await enqueuePaymentIntentCancellationRecovery({
    bookingId,
    paymentId: payment.id,
    paymentTransactionId: additionalTransaction.id,
    paymentIntentId,
    amountCents: additionalTransaction.amountCents,
    store: tx,
  });
  return { paymentTransactionId: additionalTransaction.id, paymentIntentId, operationId: operation.id };
}

/**
 * `failOutstandingAdditionalAskInClaim` with its lock and its read: take the
 * `Payment` row (`INV-LOCK-002`; a re-lock where the caller holds it), read the
 * ask mirror under it, and retire what it names as outstanding. The one
 * spelling for a writer that has not read the mirror under the lock itself -
 * the never-captured cancel claim and the after-commit minters' retirement
 * (#4316 review round 3).
 */
export async function failOutstandingAdditionalAskUnderRowLock(
  tx: Prisma.TransactionClient,
  { bookingId, paymentId }: { bookingId: string; paymentId: string },
): Promise<QueuedSupersededIntentCancellation | null> {
  await lockPaymentForRefundedTotal(tx, paymentId);
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, additionalPaymentIntentId: true, additionalPaymentStatus: true },
  });
  return payment ? failOutstandingAdditionalAskInClaim(tx, { bookingId, payment }) : null;
}
