/**
 * THE WAITING-INVOICE REAPER (#3641, `INV-PAY-105`, `INV-PAY-029`), run by the
 * payments cron every 15 minutes. Split from `xero-operation-outbox.ts` so it
 * can hand a waiting invoice whose payment already arrived to the late-capture
 * release, which itself imports the outbox.
 *
 * A supplementary invoice parked WAITING_PAYMENT on a PaymentIntent is released
 * by a captured payment on that intent. This sweep decides what happens to one
 * that is still waiting:
 *   - its payment has been CAPTURED: released now (or, where the capture does
 *     not cover it, cancelled unsent with an alert), never retired;
 *   - the member can still pay the ask: kept, however old, however many cards
 *     were declined against it;
 *   - the member can no longer pay it: retired (CANCELLED,
 *     `STALE_WAITING_PAYMENT`), the one state a later capture can revive.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  payableAdditionalPaymentIntentId,
  resolveAdditionalPaymentDoor,
  type AdditionalPaymentDoorInput,
} from "@/lib/additional-payment-chase";
import { getPaymentIntent } from "@/lib/stripe";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import {
  STALE_WAITING_PAYMENT_ERROR_CODE,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
} from "@/lib/xero-supplementary-invoice-late-capture";

const STALE_WAITING_PAYMENT_AGE_DAYS = 14;

// F19 (#1887): a FAILED Stripe payment does not reap its WAITING_PAYMENT Xero
// op immediately. A failed PaymentIntent can be retried and SUCCEED on the same
// intent id, so cancelling the moment the transaction flips FAILED races that
// retry. Only a transaction that has stayed FAILED past this grace window is a
// candidate. #3641 corrected what this comment used to claim, that "Stripe
// intents do not stay retriable this long": a declined additional intent stays
// confirmable with another card indefinitely. So the grace only decides WHEN a
// failed ask is looked at; whether it is retired is the pay door's question.
const FAILED_TRANSACTION_REAP_GRACE_HOURS = 24;

/**
 * At most this many Stripe reads per run. A kept ask is read again on a later
 * run, and the rows read are touched (`updatedAt`) so the next run starts with
 * the ones read longest ago: a large backlog rotates through the cap instead of
 * the same rows being read every 15 minutes for ever.
 */
const STRIPE_READS_PER_RUN = 25;

/** A background sweep's Stripe read gives up quickly and keeps the invoice. */
const STRIPE_READ_TIMEOUT_MS = 10_000;

type WaitingOperationVerdict = "retire" | "keep" | "keep-deferred" | "captured";

export async function reapStaleWaitingPaymentXeroOutboxOperations(options?: {
  /** Override the staleness threshold in days. Defaults to 14. */
  ageInDays?: number;
  /**
   * Override the FAILED-transaction grace window in hours. Defaults to 24. A
   * FAILED Stripe transaction only reaps its WAITING_PAYMENT op once it has been
   * FAILED for at least this long (F19, #1887).
   */
  failedTransactionGraceHours?: number;
}): Promise<{ reaped: number; released: number; queueOperationIds: string[] }> {
  const ageInDays = options?.ageInDays ?? STALE_WAITING_PAYMENT_AGE_DAYS;
  const ageThreshold = new Date(Date.now() - ageInDays * 24 * 60 * 60 * 1000);
  const failedGraceHours =
    options?.failedTransactionGraceHours ?? FAILED_TRANSACTION_REAP_GRACE_HOURS;
  const failedGraceThreshold = new Date(
    Date.now() - failedGraceHours * 60 * 60 * 1000,
  );

  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: { status: "WAITING_PAYMENT", direction: "OUTBOUND" },
    select: { id: true, createdAt: true, requestPayload: true },
    orderBy: { updatedAt: "asc" },
  });

  const reapableIds: string[] = [];
  const capturedIntentIds = new Set<string>();
  const stripeReadIds: string[] = [];
  let kept = 0;
  let deferred = 0;
  for (const operation of waitingOperations) {
    const payload = operation.requestPayload as
      | { paymentIntentId?: string | null }
      | null;
    const paymentIntentId = payload?.paymentIntentId ?? null;
    const pastAge = operation.createdAt <= ageThreshold;

    // No intent: nothing a member pays can release this row, so the age
    // backstop retires it. A failed mint's recovery attaches the intent it
    // finally mints (`INV-PAY-057`), and a failed attach now alerts
    // (`attachRecoveredIntentToWaitingSupplementaryInvoice`) rather than
    // leaving the row here to be retired while the member pays.
    if (!paymentIntentId) {
      if (pastAge) reapableIds.push(operation.id);
      continue;
    }

    const verdict = await decideWaitingOperation({
      paymentIntentId,
      pastAge,
      failedGraceThreshold,
      stripeReadsLeft: STRIPE_READS_PER_RUN - stripeReadIds.length,
      onStripeRead: () => stripeReadIds.push(operation.id),
    });
    if (verdict === "retire") reapableIds.push(operation.id);
    else if (verdict === "captured") capturedIntentIds.add(paymentIntentId);
    else if (verdict === "keep") kept += 1;
    else deferred += 1;
  }

  // Rotate the Stripe cap: rows read this run go to the back of the next one.
  const keptAfterRead = stripeReadIds.filter((id) => !reapableIds.includes(id));
  if (keptAfterRead.length > 0) {
    await prisma.xeroSyncOperation.updateMany({
      where: { id: { in: keptAfterRead }, status: "WAITING_PAYMENT" },
      data: { updatedAt: new Date() },
    });
  }

  let released = 0;
  const releasedIds: string[] = [];
  for (const paymentIntentId of capturedIntentIds) {
    try {
      const result =
        await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
          paymentIntentId,
        );
      released += result.released;
      releasedIds.push(...result.queueOperationIds);
    } catch (err) {
      logger.error(
        { err, paymentIntentId },
        "Failed to release a waiting Xero supplementary invoice whose payment was already captured",
      );
    }
  }

  if (kept > 0 || deferred > 0 || released > 0) {
    logger.info(
      { kept, deferredStripeReads: deferred, released },
      "Kept WAITING_PAYMENT Xero outbox operations the member can still pay, and released those already paid",
    );
  }

  let reaped = 0;
  if (reapableIds.length > 0) {
    const updateResult = await prisma.xeroSyncOperation.updateMany({
      where: { id: { in: reapableIds }, status: "WAITING_PAYMENT" },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
        lastErrorMessage: "Reaped: the linked payment request can no longer be paid.",
      },
    });
    reaped = updateResult.count;
    if (reaped > 0) {
      logger.info(
        { reaped, ageInDays },
        "Reaped stale WAITING_PAYMENT Xero outbox operations",
      );
    }
  }

  return {
    reaped,
    released,
    queueOperationIds: [...new Set([...reapableIds, ...releasedIds])],
  };
}

/**
 * One waiting operation on an intent. The local rows first, and Stripe only
 * where they cannot answer: an ask whose transaction is FAILED might be a
 * decline (still payable with another card) or a provider cancel (never payable
 * again), and only Stripe can tell which. A PENDING or PROCESSING ask is kept on
 * the local rows alone.
 */
async function decideWaitingOperation(params: {
  paymentIntentId: string;
  pastAge: boolean;
  failedGraceThreshold: Date;
  stripeReadsLeft: number;
  onStripeRead: () => void;
}): Promise<WaitingOperationVerdict> {
  const transaction = await prisma.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: params.paymentIntentId },
    select: { status: true, updatedAt: true },
  });

  // Already paid: the capture's own release did not happen (the confirm route
  // failed and the webhook never arrived, or the intent was attached after the
  // capture). Release it; never retire an invoice whose money has arrived.
  if (transaction && isCapturedTransactionStatus(transaction.status)) {
    return "captured";
  }

  const failed = transaction?.status === "FAILED";
  // F19 (#1887): before 14 days, only a transaction FAILED since before the
  // grace window is looked at, so a not-yet-retried failure cannot be
  // cancelled out from under a same-intent retry about to succeed. A
  // redelivered failure re-writes FAILED and restarts the grace; that can only
  // DELAY a reap, and the 14-day arm bounds it.
  if (
    !params.pastAge &&
    !(failed && transaction.updatedAt <= params.failedGraceThreshold)
  ) {
    return "keep";
  }

  const payment = await prisma.payment.findUnique({
    where: { additionalPaymentIntentId: params.paymentIntentId },
    select: {
      additionalPaymentIntentId: true,
      additionalPaymentStatus: true,
      booking: { select: { status: true, deletedAt: true } },
    },
  });
  // Found BY the intent, so no row means the booking no longer names it: the
  // superseded or withdrawn case (#3403's trigger, deliberately unchanged).
  if (!payment) return "retire";
  const door: AdditionalPaymentDoorInput = {
    bookingStatus: payment.booking.status,
    bookingDeletedAt: payment.booking.deletedAt,
    payment,
  };
  if (payableAdditionalPaymentIntentId(door) !== params.paymentIntentId) {
    return "retire";
  }
  if (!failed) return "keep";
  if (params.stripeReadsLeft <= 0) return "keep-deferred";

  params.onStripeRead();
  try {
    const answer = await resolveAdditionalPaymentDoor(door, (id) =>
      getPaymentIntent(id, { timeoutMs: STRIPE_READ_TIMEOUT_MS }),
    );
    // `captured-at-provider` is kept: the capture's webhook releases it, and
    // the next run releases it if that webhook never comes.
    return answer.state === "closed" ? "retire" : "keep";
  } catch (err) {
    // Keeping costs a warning in the repair report; retiring a live ask is the
    // bug this rule removes.
    logger.warn(
      { err, paymentIntentId: params.paymentIntentId },
      "Could not read a waiting Xero invoice's PaymentIntent from Stripe; keeping the invoice waiting",
    );
    return "keep";
  }
}
