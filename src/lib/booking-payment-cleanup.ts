import {
  PaymentSource,
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
 * Before issuing a new ADDITIONAL PaymentIntent for a booking
 * modification, cancel any existing PENDING/PROCESSING ADDITIONAL
 * transactions on the same payment whose PaymentIntent id differs from
 * the new one. Without this, an abandoned previous additional intent
 * (member closed the browser before confirming) lingers as PENDING
 * locally until Stripe's 24h auto-cancel and the webhook delivery hit,
 * which leaves a stale PaymentTransaction if delivery fails or is
 * delayed. The cancellation runs through the durable recovery queue.
 *
 * #3340 - IT NOW CANCELS SYNCHRONOUSLY AS WELL, and the order matters. The
 * durable row is enqueued FIRST and is still the guarantee; the immediate
 * attempt that follows only closes the window in which the old client secret is
 * confirmable. Before this, "queued" meant "up to five minutes" - measured at 4
 * minutes 5 seconds in the live case, long enough for a member to be charged $65
 * against the superseded intent while the page read $300.
 *
 * The caller awaits this BEFORE it returns the new client secret, so an intent a
 * browser may still be holding is dead by the time the replacement exists.
 * Best-effort throughout: a Stripe outage leaves exactly the pre-#3340
 * behaviour, a queued operation the recovery cron completes.
 */
export async function queueSupersededAdditionalIntentCancellations(options: {
  bookingId: string;
  paymentId: string;
  newPaymentIntentId: string;
  /** The club's format (#3565), resolved once by the caller and handed to each immediate run. */
  format: ClubFormat;
}): Promise<{ paymentTransactionId: string; paymentIntentId: string }[]> {
  const queued = await queueSupersededAdditionalIntentCancellationRows(options);
  await cancelSupersededAdditionalIntentsNow({ ...options, queued });
  return queued.map(({ paymentTransactionId, paymentIntentId }) => ({ paymentTransactionId, paymentIntentId }));
}

/** One superseded intent's durable cancellation, queued and not yet run. */
export type QueuedSupersededIntentCancellation = {
  paymentTransactionId: string;
  paymentIntentId: string;
  operationId: string;
};

/**
 * The DURABLE half of `queueSupersededAdditionalIntentCancellations`: find the
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
      status: { in: [...OPEN_INTENT_TRANSACTION_STATUS_LIST] },
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
 */
export async function cancelSupersededAdditionalIntentsNow(options: {
  bookingId: string;
  paymentId: string;
  queued: readonly QueuedSupersededIntentCancellation[];
  format: ClubFormat;
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
}

/** The `Payment` mirror columns that name a booking's outstanding additional ask. */
export type AdditionalAskMirror = {
  id: string;
  additionalPaymentIntentId?: string | null;
  additionalPaymentStatus?: string | null;
};

/**
 * Does the mirror name an additional intent that is still OUTSTANDING - neither
 * paid nor already failed? An intent that already failed (a declined card) is
 * left alone: it is not cancelled again (`INV-ADDPAY-023`).
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
