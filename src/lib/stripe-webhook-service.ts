import { prisma } from "@/lib/prisma";
import { listRefundsForCharge, processRefund } from "@/lib/stripe";
import { markBookingPaymentSucceeded, markBookingSetupIntentSucceeded } from "@/lib/payment-reconciliation";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroRefundCreditNoteOperation,
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  kickQueuedXeroOutboxOperationsIfConnected,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import { reportWebhookError } from "@/lib/observability-bridge";
import {
  sendBookingConfirmedEmail,
  sendAdminPaymentFailureAlert,
  sendSetupIntentFailedEmail,
} from "@/lib/email";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import { recordWebhookLog } from "@/lib/webhook-log";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { findCompletedHandBackForLateCapture } from "@/lib/deleted-booking-modification-payment";
import {
  announceAutomaticLateCaptureRefund,
  recordAutomaticLateCaptureRefund,
  reportWithheldLateCaptureRefund,
  type CancelledBookingLateCapture,
} from "@/lib/cancelled-booking-late-capture";
import Stripe from "stripe";
import logger from "@/lib/logger";
import { logAudit } from "@/lib/audit";
import {
  findPaymentTransactionByIntentId,
  markPaymentIntentTransactionFailed,
  markPaymentIntentTransactionSucceeded,
  refundPaymentTransactions,
  syncRefundsFromStripeCharge,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  completeCanceledSupersededPaymentIntentRecovery,
  getStripePaymentMethodId,
  queueSupersededPaymentIntentRefundRecovery,
} from "@/lib/payment-recovery";
import {
  applyGroupSettlementSucceeded,
  markGroupSettlementIntentFailed,
  markGroupSettlementIntentRefunded,
} from "@/lib/group-settlement";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

function isCapturedAdditionalPaymentTransaction(status: PaymentStatus) {
  return (
    status === PaymentStatus.SUCCEEDED ||
    status === PaymentStatus.PARTIALLY_REFUNDED ||
    status === PaymentStatus.REFUNDED
  );
}

// F16 (#1887): the ProcessedWebhookEvent claim is a processing LEASE. A
// PROCESSING claim older than this window is treated as a crashed prior
// attempt and taken over; a fresher one forces a provider retry. Sized well
// above real handler runtime (seconds) and far below Stripe's redelivery
// backoff, so a live handler is never pre-empted by a concurrent redelivery.
export const STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES = 15;
const PROCESSED_WEBHOOK_STATUS_PROCESSING = "PROCESSING";
const PROCESSED_WEBHOOK_STATUS_COMPLETED = "COMPLETED";

/**
 * The result of a claim attempt. When `outcome === "claimed"`, `leaseToken` is
 * the `processingStartedAt` we wrote for THIS attempt (fresh insert or takeover)
 * — the fencing token the caller MUST use to guard both the COMPLETED stamp and
 * the failure release, so an attempt only ever completes or releases the lease
 * it owns (F16 fence, #1887). Any other outcome carries no token.
 */
type WebhookClaimResult =
  | { outcome: "claimed"; leaseToken: Date }
  | { outcome: "duplicate_completed" }
  | { outcome: "in_progress" };

/**
 * Claim the event for processing under a lease (F16, #1887).
 *
 * - "claimed": we own a fresh claim (insert won) or took over an expired one;
 *   the caller must process the event and mark it COMPLETED on success. The
 *   returned `leaseToken` fences that completion/release to this exact claim.
 * - "duplicate_completed": a prior delivery already finished this event; ACK
 *   with 200 and do nothing.
 * - "in_progress": a sibling attempt holds the lease (or the claim was raced
 *   away between our failed insert and the read); the caller must return 500 so
 *   the provider redelivers, because we must never ACK an event we did not
 *   finish processing.
 */
async function claimStripeWebhookEvent(
  event: Stripe.Event,
  now: Date,
): Promise<WebhookClaimResult> {
  try {
    await prisma.processedWebhookEvent.create({
      data: {
        eventId: event.id,
        source: "stripe",
        eventType: event.type,
        status: PROCESSED_WEBHOOK_STATUS_PROCESSING,
        processingStartedAt: now,
      },
    });
    return { outcome: "claimed", leaseToken: now };
  } catch (err: unknown) {
    // Anything other than the unique-constraint collision is a real failure.
    if (
      !(
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002"
      )
    ) {
      throw err;
    }
  }

  // A claim row already exists; decide on its status and lease age.
  const existing = await prisma.processedWebhookEvent.findFirst({
    where: { source: "stripe", eventId: event.id },
    select: { status: true, processingStartedAt: true },
  });

  // Raced release between our failed insert and this read (a sibling attempt
  // failed and deleted its claim): let the provider retry rather than guess.
  if (!existing) {
    return { outcome: "in_progress" };
  }

  if (existing.status === PROCESSED_WEBHOOK_STATUS_COMPLETED) {
    return { outcome: "duplicate_completed" };
  }

  const leaseExpiryThreshold = new Date(
    now.getTime() - STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES * 60_000,
  );
  if (existing.processingStartedAt > leaseExpiryThreshold) {
    // A sibling attempt is still within its lease. Force a provider retry so
    // the event is never ACKed while an in-flight (possibly-doomed) attempt
    // owns it — closing the concurrent-redelivery lost-event window.
    return { outcome: "in_progress" };
  }

  // The lease expired: a prior attempt crashed without completing or releasing
  // its claim. Take it over atomically — the conditional guards
  // (status + processingStartedAt) make exactly one concurrent racer win; the
  // loser gets an "in_progress" retry. The takeover stamps `now`, which becomes
  // our fencing token so the original (crashed-but-maybe-alive) attempt can
  // neither complete nor release the lease we now own.
  const takeover = await prisma.processedWebhookEvent.updateMany({
    where: {
      source: "stripe",
      eventId: event.id,
      status: PROCESSED_WEBHOOK_STATUS_PROCESSING,
      processingStartedAt: { lt: leaseExpiryThreshold },
    },
    data: {
      processingStartedAt: now,
      eventType: event.type,
    },
  });
  return takeover.count === 1
    ? { outcome: "claimed", leaseToken: now }
    : { outcome: "in_progress" };
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<JsonRouteResult> {
  const webhookStart = Date.now();
  let claimedEvent = false;
  // F16 fence (#1887): the processingStartedAt we claimed. Both the COMPLETED
  // stamp and the failure release key on it so we only ever complete/release the
  // lease WE own — a slow original that outlived its lease cannot clobber a
  // takeover successor's fresh claim, and vice versa.
  let leaseToken: Date | null = null;

  try {
    // Idempotency: claim this event under a processing lease (F16, #1887).
    const claim = await claimStripeWebhookEvent(event, new Date(webhookStart));
    if (claim.outcome === "duplicate_completed") {
      // A prior delivery already finished this event; a bare ACK is safe.
      return jsonResult({ received: true });
    }
    if (claim.outcome === "in_progress") {
      // A sibling attempt holds the lease (or its claim was raced away). Force
      // the provider to redeliver rather than ACK an unfinished event.
      // Telemetry (F16 LOW, #1887): this legitimate concurrent-redelivery 500
      // would otherwise be invisible — it returns before the success/failure
      // recordWebhookLog paths — so log it explicitly. Best-effort; a logging
      // failure must not change the 500.
      try {
        await recordWebhookLog({
          source: "stripe",
          eventType: event.type,
          eventId: event.id,
          status: "failure",
          durationMs: Date.now() - webhookStart,
          error: "Concurrent delivery already in progress (lease held); forcing provider retry",
        });
      } catch (logError) {
        logger.error(
          { err: logError, eventId: event.id, eventType: event.type },
          "Failed to record in-progress Stripe webhook lease contention",
        );
      }
      return jsonResult(
        { error: "Webhook processing already in progress" },
        { status: 500 },
      );
    }
    claimedEvent = true;
    leaseToken = claim.leaseToken;

    // Every handler below MUST be idempotent: the lease permits a concurrent
    // reprocess on lease expiry (a crashed attempt is taken over and replayed),
    // so a handler may legitimately run more than once for the same event.
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "payment_intent.canceled":
        await handlePaymentIntentCanceled(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "payment_intent.requires_action":
        await handlePaymentIntentRequiresAction(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "payment_intent.processing":
        await handlePaymentIntentProcessing(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case "setup_intent.succeeded":
        await handleSetupIntentSucceeded(
          event.data.object as Stripe.SetupIntent
        );
        break;

      case "setup_intent.setup_failed":
        await handleSetupIntentFailed(
          event.data.object as Stripe.SetupIntent
        );
        break;

      case "setup_intent.canceled":
        await handleSetupIntentCanceled(
          event.data.object as Stripe.SetupIntent
        );
        break;

      case "charge.refunded":
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      default:
        // Unhandled event type - log but don't error
        logger.info({ eventType: event.type }, "Unhandled Stripe event type");
    }

    // F16 (#1887): mark the lease COMPLETED so a later redelivery is ACKed as a
    // true duplicate instead of being reprocessed. Done only after every
    // handler above returned, so a crash before here leaves the claim
    // PROCESSING and the event recoverable via lease takeover.
    // Fenced (F16 fence, #1887) on status + our leaseToken: if our lease expired
    // and a successor took it over, this matches 0 rows and does NOT flip the
    // successor's in-flight claim to COMPLETED (which would let a redelivery be
    // ACKed while that successor might still fail). It also refuses to re-flip a
    // row we already completed. Handlers are idempotent, so a no-op here after a
    // takeover is safe — the successor completes its own lease.
    await prisma.processedWebhookEvent.updateMany({
      where: {
        source: "stripe",
        eventId: event.id,
        status: PROCESSED_WEBHOOK_STATUS_PROCESSING,
        processingStartedAt: leaseToken,
      },
      data: {
        status: PROCESSED_WEBHOOK_STATUS_COMPLETED,
        processedAt: new Date(),
      },
    });

    // OBS-08: Record successful webhook processing
    await recordWebhookLog({
      source: "stripe",
      eventType: event.type,
      eventId: event.id,
      status: "success",
      durationMs: Date.now() - webhookStart,
    });

    return jsonResult({ received: true });
  } catch (error) {
    // `leaseToken` is set iff we claimed (claimedEvent), so guarding on it both
    // satisfies the type narrowing and preserves the "only release what we
    // claimed" contract.
    if (claimedEvent && leaseToken) {
      try {
        // Fenced (F16 fence, #1887) on status + our leaseToken: release ONLY the
        // lease we still own. If a successor took over our expired lease (fresh
        // processingStartedAt), this matches 0 rows and cannot delete their live
        // claim; if we already marked it COMPLETED, this cannot delete a
        // completed event either.
        await prisma.processedWebhookEvent.deleteMany({
          where: {
            eventId: event.id,
            source: "stripe",
            status: PROCESSED_WEBHOOK_STATUS_PROCESSING,
            processingStartedAt: leaseToken,
          },
        });
      } catch (cleanupError) {
        logger.error(
          { err: cleanupError, eventId: event.id, eventType: event.type },
          "Failed to release processed Stripe webhook event claim after handler failure"
        );
      }
    }

    reportWebhookError({
      tag: `stripe:${event.type}`,
      err: error,
      message: "Error processing webhook event",
      context: { eventType: event.type },
    });

    // OBS-08: Record failed webhook processing
    try {
      await recordWebhookLog({
        source: "stripe",
        eventType: event.type,
        eventId: event.id,
        status: "failure",
        durationMs: Date.now() - webhookStart,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (logError) {
      logger.error(
        { err: logError, eventId: event.id, eventType: event.type },
        "Failed to record failed Stripe webhook delivery"
      );
    }

    return jsonResult({ error: "Webhook handler failed" }, { status: 500 });
  }
}

/**
 * Handle successful payment - confirm the booking or record additional modification payment.
 */
async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent
) {
  // Group ORGANISER_PAYS settlement: one combined intent settles many child
  // bookings, so it carries groupBookingId (not bookingId) and is reconciled by
  // its own handler before the per-booking path below.
  if (paymentIntent.metadata?.type === "group_settlement") {
    const applied = await applyGroupSettlementSucceeded({
      id: paymentIntent.id,
      amount: paymentIntent.amount,
    });
    if (
      applied.outcome === "not_found" ||
      applied.outcome === "amount_mismatch" ||
      applied.outcome === "cancelled"
    ) {
      await refundSupersededGroupSettlementIntent(paymentIntent, applied.outcome);
    }
    return;
  }

  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) {
    logger.warn({ paymentIntentId: paymentIntent.id }, "PaymentIntent succeeded but no bookingId in metadata");
    return;
  }

  if (
    await queueSupersededPaymentIntentRefundRecovery({
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      paymentMethodId: getStripePaymentMethodId(paymentIntent),
    })
  ) {
    logger.warn(
      { bookingId, paymentIntentId: paymentIntent.id },
      "Superseded PaymentIntent succeeded; queued refund recovery instead of confirming booking"
    );
    return;
  }

  // Check if this is an additional modification payment
  if (paymentIntent.metadata?.type === "modification_additional") {
    await handleAdditionalModificationPaymentSucceeded(paymentIntent, bookingId);
    return;
  }

  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });

  if (!paymentTransaction || paymentTransaction.kind !== PaymentTransactionKind.PRIMARY) {
    logger.warn(
      { paymentIntentId: paymentIntent.id, bookingId },
      "No primary payment transaction found for PaymentIntent"
    );
    return;
  }

  const bookingRecord = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      payment: true,
    },
  });

  if (bookingRecord?.status === "CANCELLED") {
    await handleCancelledBookingPaymentSucceeded(
      bookingRecord,
      paymentIntent
    );
    return;
  }

  // Validate webhook amount matches expected booking amount
  if (paymentTransaction.amountCents !== paymentIntent.amount) {
    logger.error(
      {
        bookingId,
        expectedCents: paymentTransaction.amountCents,
        receivedCents: paymentIntent.amount,
        paymentIntentId: paymentIntent.id,
      },
      "Stripe webhook amount mismatch - refusing to auto-apply payment"
    );
    await alertPaymentAmountMismatch(
      bookingId,
      paymentIntent.id,
      paymentTransaction.amountCents,
      paymentIntent.amount,
      "Primary booking payment"
    );
    throw new Error(`Stripe payment amount mismatch for booking ${bookingId}`);
  }

  // The transaction row mirrors the intent, so the check above cannot catch
  // a *stale* intent: one minted before an unpaid-booking modification moved
  // finalPriceCents (#1161). Without this guard the capture would loop
  // forever in markBookingPaymentSucceeded's mismatch throw with no alert.
  //
  //
  // #1641 — a booking with applied account credit is charged the credit-reduced
  // EFFECTIVE amount, so accept that too (and the full price for legacy in-flight
  // intents). A stale intent from a since-changed price matches neither and is
  // still rejected. The ledger read is skipped for a full-price capture.
  if (
    bookingRecord &&
    paymentIntent.amount !== bookingRecord.finalPriceCents &&
    paymentIntent.amount !==
      bookingRecord.finalPriceCents -
        (await deriveBookingAppliedCreditCents(bookingRecord.id, prisma))
  ) {
    logger.error(
      {
        bookingId,
        bookingFinalPriceCents: bookingRecord.finalPriceCents,
        receivedCents: paymentIntent.amount,
        paymentIntentId: paymentIntent.id,
      },
      "Stripe capture does not match the booking's current total - refusing to auto-apply payment"
    );
    await alertPaymentAmountMismatch(
      bookingId,
      paymentIntent.id,
      bookingRecord.finalPriceCents,
      paymentIntent.amount,
      "Primary booking payment (stale intent: booking was modified after the intent was created)"
    );
    throw new Error(
      `Stripe capture amount does not match current booking total for ${bookingId}`
    );
  }

  const reconciliation = await markBookingPaymentSucceeded({
    bookingId,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    paymentMethodId:
      typeof paymentIntent.payment_method === "string"
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id ?? null,
  });

  if (
    reconciliation.outcome === "cancelled_refunded" ||
    reconciliation.outcome === "cancelled_refund_failed"
  ) {
    logger.warn(
      {
        bookingId,
        paymentIntentId: paymentIntent.id,
        outcome: reconciliation.outcome,
      },
      "Payment succeeded but final capacity claim failed; booking cancelled"
    );
    return;
  }

  logger.info({ bookingId, paymentIntentId: paymentIntent.id }, "Booking paid via PaymentIntent");

  // Send confirmation email only on a fresh transition to PAID. An
  // "already_paid" outcome means the synchronous confirm-payment route (or a
  // prior delivery) already reconciled this payment and sent the email, so we
  // skip here to keep the send exactly-once across both paths (issue #772).
  if (reconciliation.outcome === "paid") {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
      });
      if (booking) {
        // Split-booking parent (#738): describe the provisional non-member
        // child so the confirmation explains the separate later charge.
        const provisionalGuests = await getProvisionalNonMemberChildSummary({
          id: booking.id,
          memberId: booking.memberId,
        });
        await sendBookingConfirmedEmail(
          { bookingId: booking.id, recipientMemberId: booking.memberId },
          booking.member.email,
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut,
          booking.guests.length,
          booking.finalPriceCents,
          {
            lodgeId: booking.lodgeId,
            ...(provisionalGuests ? { provisionalGuests } : {}),
            ...(booking.promoRedemption?.promoCode
              ? {
                  discountCents: booking.discountCents,
                  promoAdjustmentCents: booking.promoAdjustmentCents,
                  promoCode: booking.promoRedemption.promoCode.code,
                }
              : {}),
          }
        );
      }
    } catch (emailErr) {
      logger.error({ err: emailErr, bookingId }, "Failed to send confirmation email");
    }
  }

  await queueXeroInvoiceForPaidBooking({ bookingId });
}

/**
 * Handle failed payment - mark payment as failed.
 */
async function handlePaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent
) {
  // Group settlement intents have no per-booking payment transaction; the
  // children stay CONFIRMED (beds held) so the organiser can retry.
  if (paymentIntent.metadata?.type === "group_settlement") {
    await markGroupSettlementIntentFailed(paymentIntent.id, PaymentStatus.FAILED);
    logger.info(
      { paymentIntentId: paymentIntent.id, groupBookingId: paymentIntent.metadata?.groupBookingId },
      "Group settlement payment failed; children remain confirmed for retry"
    );
    return;
  }

  const bookingId = paymentIntent.metadata?.bookingId;
  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });
  if (!paymentTransaction) {
    logger.warn(
      { paymentIntentId: paymentIntent.id, bookingId },
      "Could not find payment transaction for failed intent"
    );
    return;
  }

  const isAdditionalPayment =
    paymentTransaction.kind === PaymentTransactionKind.ADDITIONAL;
  const failureMessage =
    paymentIntent.last_payment_error?.message || "Unknown payment error";

  await markPaymentIntentTransactionFailed({
    paymentIntentId: paymentIntent.id,
  });

  logAudit({
    action: isAdditionalPayment
      ? "booking.modification.payment.failed"
      : "booking.payment.failed",
    category: "payment",
    entityType: "Booking",
    entityId: bookingId ?? undefined,
    targetId: bookingId ?? undefined,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      errorMessage: failureMessage,
    }),
  });

  logger.info({ bookingId, paymentIntentId: paymentIntent.id }, "Payment failed for booking");

  // N-04: Send admin alert for payment failure
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true },
    });
    if (booking) {
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: paymentIntent.amount,
        errorMessage: failureMessage,
        paymentIntentId: paymentIntent.id,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send admin payment failure alert")
      );
    }
  } catch (err) {
    logger.error({ err, bookingId }, "Error fetching booking for payment failure alert");
  }
}

async function handlePaymentIntentCanceled(
  paymentIntent: Stripe.PaymentIntent
) {
  // Group settlement intents have no per-booking payment transaction; record the
  // canceled state and leave the children CONFIRMED for a fresh settlement.
  if (paymentIntent.metadata?.type === "group_settlement") {
    await markGroupSettlementIntentFailed(paymentIntent.id, PaymentStatus.FAILED);
    return;
  }

  const bookingId = paymentIntent.metadata?.bookingId;
  if (
    await completeCanceledSupersededPaymentIntentRecovery({
      paymentIntentId: paymentIntent.id,
    })
  ) {
    logger.info(
      { bookingId, paymentIntentId: paymentIntent.id },
      "Completed superseded PaymentIntent cancellation recovery from Stripe webhook"
    );
    return;
  }

  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });
  if (!paymentTransaction) {
    logger.warn(
      { paymentIntentId: paymentIntent.id, bookingId },
      "Could not find payment transaction for canceled intent"
    );
    return;
  }

  const isAdditionalPayment =
    paymentTransaction.kind === PaymentTransactionKind.ADDITIONAL;
  const cancellationReason =
    paymentIntent.cancellation_reason || "requested_by_customer";

  await markPaymentIntentTransactionFailed({
    paymentIntentId: paymentIntent.id,
  });

  logAudit({
    action: isAdditionalPayment
      ? "booking.modification.payment.canceled"
      : "booking.payment.canceled",
    category: "payment",
    entityType: "Booking",
    entityId: bookingId ?? undefined,
    targetId: bookingId ?? undefined,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      cancellationReason,
    }),
  });

  logger.info(
    { bookingId, paymentIntentId: paymentIntent.id },
    "Payment intent canceled for booking"
  );
}

/**
 * Observability-only handlers for intermediate PaymentIntent states.
 * The customer-facing payment flow eventually reconciles via
 * payment_intent.succeeded / payment_intent.canceled or via
 * confirm-modification-payment, so we do not mutate state here -- we
 * just emit structured logs so dashboards can track 3DS step-ups and
 * async funding (e.g. bank debits) without manual Stripe lookups.
 */
async function handlePaymentIntentRequiresAction(
  paymentIntent: Stripe.PaymentIntent
) {
  const bookingId = paymentIntent.metadata?.bookingId;
  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });
  logger.info(
    {
      bookingId,
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      transactionKind: paymentTransaction?.kind ?? null,
      transactionId: paymentTransaction?.id ?? null,
      nextActionType: paymentIntent.next_action?.type ?? null,
    },
    "Payment intent requires action"
  );
}

async function handlePaymentIntentProcessing(
  paymentIntent: Stripe.PaymentIntent
) {
  const bookingId = paymentIntent.metadata?.bookingId;
  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });
  logger.info(
    {
      bookingId,
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      transactionKind: paymentTransaction?.kind ?? null,
      transactionId: paymentTransaction?.id ?? null,
    },
    "Payment intent processing"
  );
}

/**
 * Handle successful additional modification payment.
 * Updates additionalPaymentStatus and adds amount to Payment.amountCents.
 */
async function handleAdditionalModificationPaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  bookingId: string
) {
  const paymentTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId: paymentIntent.id,
  });
  if (!paymentTransaction || paymentTransaction.kind !== PaymentTransactionKind.ADDITIONAL) {
    logger.warn(
      { paymentIntentId: paymentIntent.id, bookingId },
      "No payment transaction found for additional modification PaymentIntent"
    );
    return;
  }

  // F1 (#1350): the CANCELLED-booking guard must run BEFORE the
  // already-captured replay guard and the mark/release below — this dispatch
  // sits ahead of the primary path's cancelled-booking check, so without it a
  // stale-tab confirm of the additional payment racing (or following) a
  // cancel was recorded as paid, released the supplementary Xero invoice,
  // and was never refunded or alerted. Route it through the same REFUND
  // treatment as the primary late-capture path instead.
  //
  // The ALERT treatment stopped being shared at #2761: this path sends the
  // unmuteable `admin-late-capture-auto-refund` mail and writes a DISMISSED
  // `ManualRefundTask` (#2760), while `handleCancelledBookingPaymentSucceeded`
  // still sends the generic muteable "Payment Failed" mail and writes no record.
  // That gap is deliberate scope, not an oversight — see #2773.
  const bookingRecord = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      payment: true,
    },
  });

  if (bookingRecord?.status === "CANCELLED") {
    await handleCancelledBookingAdditionalPaymentSucceeded(
      bookingRecord,
      paymentIntent,
      paymentTransaction
    );
    return;
  }

  if (isCapturedAdditionalPaymentTransaction(paymentTransaction.status)) {
    const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
      paymentIntent.id
    );
    if (released.released > 0) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
    }
    logger.info({ paymentIntentId: paymentIntent.id, bookingId }, "Additional modification payment already recorded");
    return;
  }

  if (paymentTransaction.amountCents !== paymentIntent.amount) {
    logger.error(
      {
        bookingId,
        paymentIntentId: paymentIntent.id,
        expectedCents: paymentTransaction.amountCents,
        receivedCents: paymentIntent.amount,
      },
      "Stripe webhook additional payment amount mismatch - refusing to auto-apply payment"
    );
    await alertPaymentAmountMismatch(
      bookingId,
      paymentIntent.id,
      paymentTransaction.amountCents,
      paymentIntent.amount,
      "Booking modification payment"
    );
    throw new Error(`Stripe modification payment amount mismatch for booking ${bookingId}`);
  }

  await markPaymentIntentTransactionSucceeded({
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    paymentMethodId:
      typeof paymentIntent.payment_method === "string"
        ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null,
  });

  const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
    paymentIntent.id
  );
  if (released.released > 0) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
  }

  logger.info(
    { bookingId, paymentIntentId: paymentIntent.id, additionalAmountCents: paymentTransaction.amountCents },
    "Additional modification payment confirmed via webhook"
  );
}

/**
 * Handle successful SetupIntent - save the payment method for later charging.
 * This is for pending bookings with non-member guests.
 */
async function handleSetupIntentSucceeded(
  setupIntent: Stripe.SetupIntent
) {
  const bookingId = setupIntent.metadata?.bookingId;
  if (!bookingId) {
    logger.warn({ setupIntentId: setupIntent.id }, "SetupIntent succeeded but no bookingId in metadata");
    return;
  }

  const paymentMethodId =
    typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id ?? null;

  if (!paymentMethodId) {
    logger.warn({ setupIntentId: setupIntent.id, bookingId }, "SetupIntent succeeded but no payment_method");
    return;
  }

  await markBookingSetupIntentSucceeded({
    bookingId,
    setupIntentId: setupIntent.id,
    paymentMethodId,
  });

  logger.info({ bookingId, setupIntentId: setupIntent.id }, "Payment method saved for booking via SetupIntent");
}

/**
 * Handle failed SetupIntent.
 */
async function handleSetupIntentFailed(
  setupIntent: Stripe.SetupIntent
) {
  const bookingId = setupIntent.metadata?.bookingId;
  if (!bookingId) return;

  logger.info({ bookingId, setupIntentId: setupIntent.id }, "SetupIntent failed for booking");

  // Notify member that card setup failed
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: { select: { email: true, firstName: true } } },
  });

  if (booking?.member?.email) {
    sendSetupIntentFailedEmail({
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
      email: booking.member.email,
      firstName: booking.member.firstName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send setup intent failed email")
    );
  }
}

async function handleSetupIntentCanceled(
  setupIntent: Stripe.SetupIntent
) {
  const bookingId = setupIntent.metadata?.bookingId;
  if (!bookingId) {
    return;
  }

  await prisma.payment.updateMany({
    where: {
      bookingId,
      stripeSetupIntentId: setupIntent.id,
    },
    data: {
      stripeSetupIntentId: null,
    },
  });

  logger.info(
    { bookingId, setupIntentId: setupIntent.id },
    "SetupIntent canceled for booking"
  );
}

/**
 * Handle charge refund events (from Stripe dashboard or API refunds).
 */
async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!paymentIntentId) return;

  const stripeRefunds = await listRefundsForCharge(charge.id);
  const refunds =
    stripeRefunds.length > 0
      ? stripeRefunds
      : charge.refunds?.data ?? [];

  const refundSync = await syncRefundsFromStripeCharge({
    paymentIntentId,
    stripeChargeId: charge.id,
    refundedAmountCents: charge.amount_refunded,
    refunds,
  });

  if (!refundSync?.payment) {
    logger.warn({ paymentIntentId }, "No payment record found for refunded charge");
    return;
  }

  logger.info(
    {
      paymentId: refundSync.paymentId,
      refundedAmount: refundSync.payment.refundedAmountCents,
      refundDeltaCents: refundSync.refundDeltaCents,
      stripeRefundedAmount: charge.amount_refunded,
      isFullRefund:
        refundSync.payment.refundedAmountCents >= refundSync.payment.amountCents,
    },
    "Refund processed for payment"
  );

  if (refundSync.refundDeltaCents > 0) {
    // Queue only the newly-observed refund delta from Stripe. charge.amount_refunded is cumulative.
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        refundSync.paymentId,
        refundSync.refundDeltaCents
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
        logger.info(
          {
            paymentId: refundSync.paymentId,
            queueOperationId: queuedCreditNote.queueOperationId,
          },
          "Xero refund credit note queued for payment"
        );
      }
    } catch (xeroErr) {
      logger.error({ err: xeroErr, paymentId: refundSync.paymentId }, "Failed to queue Xero credit note for payment");
      notifyXeroSyncError({
        errorType: "CREDIT_NOTE_CREATION",
        operation: `Queue refund credit note for payment ${refundSync.paymentId}`,
        errorMessage: xeroErr instanceof Error ? xeroErr.message : String(xeroErr),
      }).catch(() => {});
    }
  } else {
    logger.info(
      {
        paymentId: refundSync.paymentId,
        refundedAmount: refundSync.payment.refundedAmountCents,
        stripeRefundedAmount: charge.amount_refunded,
      },
      "Stripe refund webhook did not increase the local refunded total; skipping Xero refund credit note queue"
    );
  }
}

async function alertPaymentAmountMismatch(
  bookingId: string,
  paymentIntentId: string,
  expectedCents: number,
  receivedCents: number,
  paymentType: string
) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true },
    });

    if (!booking) {
      return;
    }

    await sendAdminPaymentFailureAlert({
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: receivedCents,
      errorMessage: `${paymentType} amount mismatch. Expected ${expectedCents} cents but Stripe reported ${receivedCents} cents. The booking was not auto-updated and needs manual review.`,
      paymentIntentId,
    });
  } catch (err) {
    logger.error(
      { err, bookingId, paymentIntentId },
      "Failed to send admin alert for payment amount mismatch"
    );
  }
}

/**
 * Safety net for a captured group-settlement PaymentIntent that no longer
 * matches a PENDING settlement. The settlement's stripePaymentIntentId is
 * legitimately superseded by ordinary flows (a switch to Internet Banking
 * nulls it; a card re-attempt after the party/total changes overwrites it), so
 * a stale intent confirmed off a retained client_secret captures money that
 * settles nothing. Mirror the single-booking superseded/late-capture paths:
 * refund the intent in full and alert admins.
 *
 * Idempotency: the ProcessedWebhookEvent claim stops repeated delivery of the
 * same event from re-running this at all, and the refund carries a
 * deterministic per-intent idempotency key so a redelivery after a mid-handler
 * failure can never double-refund. A refund failure rethrows so the event
 * claim is released and Stripe redelivers, retrying the refund.
 */
async function refundSupersededGroupSettlementIntent(
  paymentIntent: Stripe.PaymentIntent,
  outcome: "not_found" | "amount_mismatch" | "cancelled"
) {
  const groupBookingId = paymentIntent.metadata?.groupBookingId ?? null;
  const failureDescription =
    outcome === "cancelled"
      ? "belonged to a group whose organiser cancellation was already fenced"
      : outcome === "not_found"
      ? "matched no group settlement record (the settlement switched payment method or was re-attempted)"
      : "did not match the group settlement total at apply time (the recorded amount, or a child booking changed while the intent was open)";

  let refundId: string | null = null;
  try {
    const refund = await processRefund({
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      reason: "requested_by_customer",
      metadata: {
        ...(groupBookingId ? { groupBookingId } : {}),
        reason: "group_settlement_superseded",
      },
      idempotencyKey: `group_settlement_superseded_refund_${paymentIntent.id}`,
    });
    refundId = refund.id;
  } catch (refundErr) {
    logger.error(
      { err: refundErr, paymentIntentId: paymentIntent.id, groupBookingId, outcome },
      "Failed to refund superseded group settlement PaymentIntent; rethrowing so Stripe redelivers"
    );
    await alertSupersededGroupSettlementIntent(
      paymentIntent,
      groupBookingId,
      `Group settlement payment ${failureDescription} and the automatic refund failed. The organiser has been charged with nothing settled; refund PaymentIntent ${paymentIntent.id} manually in Stripe.`
    );
    throw refundErr;
  }

  // #1883 — close the re-admit window: the refunded intent keeps status
  // "succeeded" in Stripe forever, so mark the settlement row REFUNDED (a
  // no-op when no settlement references this intent, i.e. "not_found").
  // Marked ONLY after the refund succeeds; a failure here rethrows so the
  // released event claim retries both (the deterministic refund idempotency
  // key makes the redelivered refund a no-op).
  await markGroupSettlementIntentRefunded(paymentIntent.id);

  logAudit({
    action: "group.settlement.superseded_intent_refunded",
    category: "payment",
    entityType: "GroupBooking",
    entityId: groupBookingId ?? undefined,
    targetId: groupBookingId ?? paymentIntent.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId,
      amountCents: paymentIntent.amount,
      outcome,
    }),
  });

  logger.warn(
    { paymentIntentId: paymentIntent.id, groupBookingId, refundId, outcome },
    "Refunded superseded group settlement PaymentIntent that succeeded"
  );

  await alertSupersededGroupSettlementIntent(
    paymentIntent,
    groupBookingId,
    `Group settlement payment ${failureDescription}. TAC Bookings auto-refunded the charge; no bookings were settled and the organiser can retry.`
  );
}

/** Best-effort admin alert for a superseded group-settlement capture; never throws. */
async function alertSupersededGroupSettlementIntent(
  paymentIntent: Stripe.PaymentIntent,
  groupBookingId: string | null,
  errorMessage: string
) {
  try {
    const group = groupBookingId
      ? await prisma.groupBooking.findUnique({
          where: { id: groupBookingId },
          select: {
            organiserMember: { select: { firstName: true, lastName: true } },
            organiserBooking: { select: { checkIn: true, checkOut: true } },
          },
        })
      : null;

    await sendAdminPaymentFailureAlert({
      memberName: group
        ? `${group.organiserMember.firstName} ${group.organiserMember.lastName}`
        : "Unknown group organiser",
      checkIn: group?.organiserBooking.checkIn ?? new Date(),
      checkOut: group?.organiserBooking.checkOut ?? new Date(),
      amountCents: paymentIntent.amount,
      errorMessage,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    logger.error(
      { err, paymentIntentId: paymentIntent.id, groupBookingId },
      "Failed to send admin alert for superseded group settlement PaymentIntent"
    );
  }
}

/**
 * Late Stripe capture of an outstanding ADDITIONAL modification payment on a
 * booking that is already CANCELLED (F1, #1350). Mirrors
 * handleCancelledBookingPaymentSucceeded: record the capture truthfully
 * (Stripe holds the money; an unrecorded capture would break money
 * conservation), refund it in full under an idempotent per-intent key, alert
 * the admins, and NEVER release the supplementary Xero invoice — the
 * modification was voided by the cancellation, so releasing it would post a
 * paid invoice for a refunded charge. If a race already released the invoice
 * operation, enqueue the corrective refund credit note (delta-capped against
 * the payment's recorded refunds).
 *
 * A refund failure is deliberately NOT swallowed: the webhook returns 500,
 * the processed-event marker is cleared, and Stripe's retry replays the same
 * refund keys (already-completed slices are answered by Stripe, not
 * repeated).
 *
 * TWO BOOKKEEPING SIDE EFFECTS, NEITHER MOVING MONEY (#2760 / #2761, owner
 * decisions 10 Aug 2026). After the refund has returned this handler records it as
 * an already-DISMISSED `ManualRefundTask` so the finance card is a complete record
 * of automatic refunds, for a deleted AND a merely cancelled booking; and it sends
 * its own accurate, unmuteable alert instead of the generic payment-failure mail.
 * The refund itself — whether, when, and how much — is unchanged. Both live in
 * `cancelled-booking-late-capture.ts` since #2773, SHARED with the sibling handler
 * rather than copied into it.
 *
 * ONE THING THAT CAN NOW STOP THE REFUND, AND IT IS NOT A GATE (#2774 D2 — the
 * orchestrator's call on that issue's Recommended option; the owner has not ruled,
 * and it is reversible. `INV-ADDPAY-039`'s authority line has the full statement).
 * If a `ManualRefundTask` for this capture is already
 * `COMPLETED`, an operator has paid the member back by hand and the ledger holds
 * their allocation — so Stripe's refund on top of it pays the member TWICE. The
 * refund is withheld, a `critical` audit row is written and the club is told the
 * money did NOT go out, so a person reconciles it. This is not the gating
 * `INV-ADDPAY-037` rules out: that would withhold a refund the member is owed,
 * whereas this withholds a second copy of one they have already had.
 */
async function handleCancelledBookingAdditionalPaymentSucceeded(
  booking: {
    id: string;
    checkIn: Date;
    checkOut: Date;
    /**
     * #2760: which population this capture belongs to. A soft-deleted booking is
     * always CANCELLED (`INV-ADDPAY-030`) so both kinds reach this handler, and
     * the record and the alert both name which one it was. Read from the same
     * booking row the dispatch above already loaded — no extra query on the
     * webhook path.
     */
    deletedAt: Date | null;
    member: {
      firstName: string;
      lastName: string;
    };
    payment: {
      id: string;
      xeroInvoiceId: string | null;
    } | null;
  },
  paymentIntent: Stripe.PaymentIntent,
  paymentTransaction: { id: string; status: PaymentStatus }
) {
  if (!booking.payment) {
    logger.error(
      { bookingId: booking.id, paymentIntentId: paymentIntent.id },
      "Cancelled booking received a successful additional Stripe payment without a local payment record"
    );
    return;
  }

  // The cancel claim marked this transaction FAILED; Stripe has now proven it
  // captured. Record the capture before refunding (the refund allocates
  // against a captured transaction). Skipped on replays where the row is
  // already captured/refunded so a completed refund is not flipped back.
  if (!isCapturedAdditionalPaymentTransaction(paymentTransaction.status)) {
    await markPaymentIntentTransactionSucceeded({
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      paymentMethodId: getStripePaymentMethodId(paymentIntent),
    });
  }

  // #2773: one shape carrying everything the fence, the record, the audit rows
  // and the alert need, so the row and the mail cannot disagree about which
  // capture this was.
  const lateCapture: CancelledBookingLateCapture = {
    bookingId: booking.id,
    paymentId: booking.payment.id,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    openingDeletedAt: booking.deletedAt,
    captureKind: "modification",
  };

  // #2774 — THE FENCE, and its position is deliberate on both sides. AFTER the
  // capture is recorded above, because withholding the refund must not also mean
  // losing the record that Stripe holds the money. BEFORE the refund, because
  // afterwards no check can help.
  //
  // A read failure is NOT caught: refunding twice and never refunding at all are
  // both bad, so a fence that cannot answer gives neither answer — the rejection
  // reaches this handler's caller, the webhook answers 500, the processed-event
  // marker is cleared, and Stripe redelivers against the same idempotent refund
  // keys. Full reasoning, and the interleaving it does NOT close, on
  // `findCompletedHandBackForLateCapture`.
  const blockingHandBack = await findCompletedHandBackForLateCapture({
    bookingId: booking.id,
    paymentId: booking.payment.id,
    paymentIntentId: paymentIntent.id,
  });
  if (blockingHandBack) {
    // No refund, no record row (the operator's COMPLETED row IS the record of this
    // capture, and a second row for one capture is the property every lookup on
    // this path protects), and no `refunded_after_cancellation` audit entry —
    // nothing was refunded, so claiming it was would put a false money movement in
    // the club's permanent record. The withheld report writes its own `critical`
    // entry and sends the event's ONE alert instead, saying the money did not go.
    //
    // The Xero corrective credit note is skipped with it: every step below exists
    // to mirror a refund this handler made, and it made none. The hand-back's own
    // accounting belongs to `resolveManualRefundTask`.
    await reportWithheldLateCaptureRefund({
      capture: lateCapture,
      handBack: blockingHandBack,
    });
    return;
  }

  const refundResult = await refundPaymentTransactions({
    paymentId: booking.payment.id,
    amountCents: paymentIntent.amount,
    // Pin the refund to THIS transaction so replays mint identical Stripe
    // keys regardless of the payment's other transactions.
    allocation: [
      {
        paymentTransactionId: paymentTransaction.id,
        amountCents: paymentIntent.amount,
      },
    ],
    metadata: {
      bookingId: booking.id,
      reason: "cancelled_booking_late_capture",
    },
    idempotencyKeyPrefix: `late_cancel_refund_${booking.id}_${paymentIntent.id}`,
  });
  const refundId = refundResult.refunds[0]?.refundId;

  // #2700 — if the browser confirm won the race to this capture, it recorded the
  // payment and raised an OPEN ManualRefundTask asking a human to decide whether
  // to refund. The refund above has just answered that question, so the task is
  // closed here rather than left for an operator to complete — completing it
  // would write a SECOND refund allocation through `resolveManualRefundTask` and
  // double-count one refund in the ledger.
  //
  // #2760 — and when nothing raised one, the row is WRITTEN here, already
  // DISMISSED. Three of the four orderings never reach the confirm route's raise
  // (webhook first, a member who closes the tab after paying, and the interleaved
  // ordering the raise's refund fence declines), and the raise never fires at all
  // for a booking that is cancelled but not deleted — so the automatic refund
  // used to leave no operator record on any of them. Never OPEN, no allocation,
  // no operator queued: the refund is already done and this is the bookkeeping
  // row for it.
  //
  // Matched on this exact payment intent, so the cash/manual cancellation task
  // `booking-cancel.ts` can raise on the same booking is never touched. Fenced on
  // OPEN for the close and idempotent on the intent for the write, so a webhook
  // replay neither re-dates nor duplicates. Never allowed to fail the webhook:
  // the money is already back with the member and a 500 here would replay the
  // whole refund path for a bookkeeping row.
  //
  // AFTER the refund, deliberately, and outside every provider call: it opens its
  // own short transaction holding pg_advisory_xact_lock(1), and no Stripe round
  // trip happens inside it.
  //
  // #2773: the record — `deletedAt` re-read after the Stripe round trip, the
  // already-DISMISSED row written, and a `critical`
  // `booking.payment.auto_refund_record_failed` audit entry if that write is lost
  // — is one shared implementation, called from here and from the sibling
  // primary-payment handler. It is deliberately NOT a copy in each: two
  // implementations of this rule drifting apart at the next change is the defect
  // class this repository keeps re-finding. Every "why" is on
  // `recordAutomaticLateCaptureRefund`.
  //
  // AWAITED, unlike the alert below. An un-awaited database write can be killed
  // when the handler's response is returned, and this row is the only operator
  // surface the refund appears on. It can never fail the webhook: the money is
  // already back with the member and a 500 would replay the whole refund path for
  // a bookkeeping row, so its failure is audited rather than thrown.
  const recordOutcome = await recordAutomaticLateCaptureRefund(lateCapture);

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    category: "payment",
    entityType: "Booking",
    entityId: booking.id,
    targetId: booking.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId,
      amountCents: paymentIntent.amount,
      kind: "modification_additional",
    }),
  });

  // #2761 — the one notification this event sends, and it now says what actually
  // happened. It used to be `sendAdminPaymentFailureAlert`, whose subject is the
  // generic "Payment Failed": nothing failed here, a payment was captured late
  // and handed straight back, and a subject that misdescribes it gets triaged as
  // noise. Its own template names the money movement AND which population it was
  // (booking already deleted, or cancelled but still on file), so an operator can
  // recognise and dismiss it at a glance. #2773 added which PAYMENT it was, since
  // the sibling handler now sends the same mail about the booking's own payment.
  //
  // It is also OFF the muteable `adminPaymentFailure` preference and delivery-
  // locked, because an automatic money movement should not be silenceable and the
  // recipient set must not be able to be silently empty. STILL EXACTLY ONE
  // notification for the event (`INV-ADDPAY-037`): the shared sender sends the
  // auto-refund alert OR, on #2774's double-payment detection, the hand-back
  // conflict alert — never both and never neither. Fire-and-forget with a `.catch`
  // that logs, unchanged: webhooks stay non-blocking, and the durable records are
  // the row and the audit entries.
  announceAutomaticLateCaptureRefund(lateCapture, recordOutcome).catch((err) =>
    logger.error(
      { err, bookingId: booking.id },
      "Failed to send late additional-capture cancellation alert"
    )
  );

  // The supplementary invoice operation for this intent is left in
  // WAITING_PAYMENT on purpose (the stale-WAITING_PAYMENT reaper retires it).
  // Only when a race already released it — or the payment carries a primary
  // Xero invoice — does the refund need a corrective credit note; the
  // enqueue is delta-capped against payment.refundedAmountCents, so replays
  // and already-covered states collapse to a no-op.
  try {
    const needsCorrectiveCreditNote =
      booking.payment.xeroInvoiceId !== null ||
      (await hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(
        paymentIntent.id
      ));
    if (needsCorrectiveCreditNote) {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        booking.payment.id,
        paymentIntent.amount
      );
      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    }
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, bookingId: booking.id, paymentId: booking.payment.id },
      "Failed to queue corrective Xero refund credit note after late additional capture on a cancelled booking"
    );
  }

  logger.warn(
    { bookingId: booking.id, paymentIntentId: paymentIntent.id, refundId },
    "Automatically refunded an additional modification payment captured after booking cancellation"
  );
}

/**
 * Late Stripe capture of a booking's OWN (PRIMARY) payment on a booking that is
 * already CANCELLED (#1350). The sibling of
 * `handleCancelledBookingAdditionalPaymentSucceeded` above: record the capture
 * truthfully, refund it in full under an idempotent per-intent key, alert the
 * admins, and skip Xero invoice creation.
 *
 * WHAT #2773 CHANGED HERE (the orchestrator's call on that issue's Recommended
 * option; the owner has not ruled — `INV-ADDPAY-039`'s authority line), and why it
 * needed a decision at all. #2760/#2761 fixed the booking-CHANGE handler only, and scoped
 * `INV-ADDPAY-037` / `INV-ADDPAY-038` to it rather than letting them overclaim. So
 * this handler kept refunding with the same `cancelled_booking_late_capture`
 * reason and writing the same `booking.payment.refunded_after_cancellation` audit
 * entry, while leaving **no record an operator could find** and sending the generic
 * **muteable** "Payment Failed" mail — a subject describing nothing that happened
 * (a payment was captured late and handed straight back), on a preference any admin
 * could switch off. It now routes through the same shared machinery as its sibling:
 * the already-DISMISSED `ManualRefundTask` the finance card lists, and the
 * unmuteable alert that names the money movement. The two invariants lose their
 * scoping clause in the same change.
 *
 * NOT A NEW READ. `deletedAt` comes from the booking row the dispatch above already
 * loaded (`findUnique` with `include`), so the population that selects the row's
 * `reason` sentence and the alert's follow-up costs nothing here; it is re-read once
 * AFTER the Stripe round trip, inside the shared recorder, for the reason stated
 * there.
 *
 * #2774's FENCE APPLIES HERE TOO, and one thing about it is worth stating plainly
 * rather than left for a reader to assume: nothing in the tree currently raises an
 * `OPEN` `ManualRefundTask` for a PRIMARY payment intent — the confirm-modification
 * -payment route is the only raiser of one of these and it handles modification
 * intents — so today the fence cannot fire on this path. It is here anyway because
 * the fence is keyed on the payment intent rather than on the handler, so a reader
 * of one handler must not conclude the other is unfenced, and a future raiser is
 * covered by construction. `booking-cancel.ts`'s cash-settlement task sits on the
 * same booking and payment but carries a different `reason`, so it is correctly
 * never matched: it settles a different sum.
 *
 * A refund failure is deliberately NOT swallowed, as in the sibling handler: the
 * webhook returns 500, the processed-event marker is cleared, and Stripe's retry
 * replays the same idempotent refund keys.
 */
async function handleCancelledBookingPaymentSucceeded(
  booking: {
    id: string;
    checkIn: Date;
    checkOut: Date;
    /**
     * #2773: which population this capture belongs to. A soft-deleted booking is
     * always CANCELLED (`INV-ADDPAY-030`) so both kinds reach this handler, and the
     * record and the alert both name which one it was. Read from the same booking
     * row the dispatch above already loaded — no extra query on the webhook path.
     */
    deletedAt: Date | null;
    member: {
      firstName: string;
      lastName: string;
    };
    payment: {
      id: string;
      xeroInvoiceId: string | null;
    } | null;
  },
  paymentIntent: Stripe.PaymentIntent
) {
  if (!booking.payment) {
    logger.error(
      { bookingId: booking.id, paymentIntentId: paymentIntent.id },
      "Cancelled booking received a successful Stripe payment without a local payment record"
    );
    return;
  }

  const paymentMethodId =
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null;

  await upsertPaymentIntentTransaction({
    paymentId: booking.payment.id,
    kind: PaymentTransactionKind.PRIMARY,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    status: PaymentStatus.SUCCEEDED,
    paymentMethodId,
    reason: "cancelled_booking_late_capture",
  });

  // #2773: the same shape the sibling handler builds, so the record, the audit
  // rows and the alert all read one description of this capture.
  const lateCapture: CancelledBookingLateCapture = {
    bookingId: booking.id,
    paymentId: booking.payment.id,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    openingDeletedAt: booking.deletedAt,
    captureKind: "primary",
  };

  // #2774 — the same fence as the sibling handler, in the same position: after the
  // capture is recorded, before the refund, and with a read failure left to
  // propagate so the webhook answers 500 and Stripe redelivers rather than this
  // path guessing between paying twice and never paying at all. See the handler
  // docblock for why it cannot currently fire on a primary intent, and
  // `findCompletedHandBackForLateCapture` for the interleaving it does not close.
  const blockingHandBack = await findCompletedHandBackForLateCapture({
    bookingId: booking.id,
    paymentId: booking.payment.id,
    paymentIntentId: paymentIntent.id,
  });
  if (blockingHandBack) {
    await reportWithheldLateCaptureRefund({
      capture: lateCapture,
      handBack: blockingHandBack,
    });
    return;
  }

  const refundResult = await refundPaymentTransactions({
    paymentId: booking.payment.id,
    amountCents: paymentIntent.amount,
    metadata: {
      bookingId: booking.id,
      reason: "cancelled_booking_late_capture",
    },
    idempotencyKeyPrefix: `late_cancel_refund_${booking.id}_${paymentIntent.id}`,
  });
  const refundId = refundResult.refunds[0]?.refundId;

  // #2773: the record this path never had. Awaited, and its failure audited rather
  // than thrown — see `recordAutomaticLateCaptureRefund`.
  const recordOutcome = await recordAutomaticLateCaptureRefund(lateCapture);

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    category: "payment",
    entityType: "Booking",
    entityId: booking.id,
    targetId: booking.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId,
      amountCents: paymentIntent.amount,
      // #2773: named on this handler too, so the two audit rows are told apart by
      // the row itself rather than by knowing which handler writes which shape.
      // The sibling has carried `kind: "modification_additional"` since #1350.
      kind: "primary",
    }),
  });

  // #2773: the same unmuteable alert its sibling sends, in place of the generic
  // muteable `sendAdminPaymentFailureAlert` this path used to send. Nothing failed
  // here — a payment was captured late and handed straight back — and that mail's
  // "Payment Failed" subject both misdescribed the event and could be switched off
  // per admin in Notification Recipients or club-wide in Delivery Rules, for an
  // automatic money movement. Still exactly ONE notification for the event
  // (`INV-ADDPAY-037`): this replaces the previous mail rather than joining it.
  announceAutomaticLateCaptureRefund(lateCapture, recordOutcome).catch((err) =>
    logger.error({ err, bookingId: booking.id }, "Failed to send late-capture cancellation alert")
  );

  if (booking.payment.xeroInvoiceId) {
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        booking.payment.id,
        paymentIntent.amount
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId: booking.id, paymentId: booking.payment.id },
        "Failed to queue Xero refund credit note after late cancelled-booking capture"
      );
    }
  }

  logger.warn(
    { bookingId: booking.id, paymentIntentId: paymentIntent.id, refundId },
    "Automatically refunded payment that succeeded after booking cancellation"
  );
}
