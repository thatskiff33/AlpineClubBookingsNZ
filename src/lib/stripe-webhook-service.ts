import { prisma } from "@/lib/prisma";
import { listRefundsForCharge } from "@/lib/stripe";
import { markBookingPaymentSucceeded, markBookingSetupIntentSucceeded } from "@/lib/payment-reconciliation";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail, sendAdminPaymentFailureAlert, sendSetupIntentFailedEmail } from "@/lib/email";
import { recordWebhookLog } from "@/lib/webhook-log";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
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

    logger.error({ err: error, eventType: event.type }, "Error processing webhook event");

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
          booking.promoRedemption?.promoCode
            ? {
                discountCents: booking.discountCents,
                promoAdjustmentCents: booking.promoAdjustmentCents,
                promoCode: booking.promoRedemption.promoCode.code,
              }
            : undefined
        );
      }
    } catch (emailErr) {
      logger.error({ err: emailErr, bookingId }, "Failed to send confirmation email");
    }
  }

  // Queue the booking invoice durably, then opportunistically kick the worker.
  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(bookingId);
    if (queuedInvoice.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      logger.info({ bookingId }, "Xero invoice queued for booking");
    }
  } catch (xeroErr) {
    logger.error({ err: xeroErr, bookingId }, "Failed to queue Xero invoice for booking");
    // Alert admins through the deduplicated Xero notifier so repeated
    // webhook retries or repeated failures do not spam operators.
    notifyXeroSyncError({
      errorType: "INVOICE_CREATION",
      operation: `Queue invoice for booking ${bookingId}`,
      errorMessage: xeroErr instanceof Error ? xeroErr.message : String(xeroErr),
    }).catch(() => {});
  }
}

/**
 * Handle failed payment - mark payment as failed.
 */
async function handlePaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent
) {
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
