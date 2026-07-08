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
import { sendBookingConfirmedEmail, sendAdminPaymentFailureAlert, sendSetupIntentFailedEmail } from "@/lib/email";
import { recordWebhookLog } from "@/lib/webhook-log";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
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

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<JsonRouteResult> {
  const webhookStart = Date.now();
  let claimedEvent = false;

  try {
    // Idempotency: attempt to claim this event atomically
    try {
      await prisma.processedWebhookEvent.create({
        data: { eventId: event.id, source: "stripe", eventType: event.type },
      });
      claimedEvent = true;
    } catch (err: unknown) {
      // Unique constraint violation (P2002) = already processed
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002"
      ) {
        return jsonResult({ received: true });
      }
      throw err; // Re-throw unexpected errors
    }

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
    if (claimedEvent) {
      try {
        await prisma.processedWebhookEvent.deleteMany({
          where: { eventId: event.id, source: "stripe" },
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
      applied.outcome === "amount_mismatch"
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
        await sendBookingConfirmedEmail(
          booking.member.email,
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut,
          booking.guests.length,
          booking.finalPriceCents,
          {
            lodgeId: booking.lodgeId,
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
  // and was never refunded or alerted. Route it through the same
  // refund-and-alert treatment as the primary late-capture path instead.
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
  outcome: "not_found" | "amount_mismatch"
) {
  const groupBookingId = paymentIntent.metadata?.groupBookingId ?? null;
  const failureDescription =
    outcome === "not_found"
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

  logAudit({
    action: "group.settlement.superseded_intent_refunded",
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
 */
async function handleCancelledBookingAdditionalPaymentSucceeded(
  booking: {
    id: string;
    checkIn: Date;
    checkOut: Date;
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

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    targetId: booking.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId,
      amountCents: paymentIntent.amount,
      kind: "modification_additional",
    }),
  });

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents: paymentIntent.amount,
    errorMessage:
      "Stripe captured an additional modification payment after the booking had already been cancelled. TAC Bookings auto-refunded the capture and did not release the supplementary Xero invoice.",
    paymentIntentId: paymentIntent.id,
  }).catch((err) =>
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

async function handleCancelledBookingPaymentSucceeded(
  booking: {
    id: string;
    checkIn: Date;
    checkOut: Date;
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

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    targetId: booking.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId,
      amountCents: paymentIntent.amount,
    }),
  });

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents: paymentIntent.amount,
    errorMessage:
      "Stripe captured payment after the booking had already been cancelled. TAC Bookings auto-refunded the payment and skipped Xero invoice creation.",
    paymentIntentId: paymentIntent.id,
  }).catch((err) =>
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
