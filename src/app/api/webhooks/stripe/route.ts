import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { constructWebhookEvent, processRefund } from "@/lib/stripe";
import { markBookingPaymentSucceeded, markBookingSetupIntentSucceeded } from "@/lib/payment-reconciliation";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail, sendAdminPaymentFailureAlert, sendSetupIntentFailedEmail } from "@/lib/email";
import { recordWebhookLog } from "@/lib/webhook-log";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import Stripe from "stripe";
import logger from "@/lib/logger";
import { logAudit } from "@/lib/audit";

/**
 * Stripe webhook handler.
 * Handles payment_intent and setup_intent lifecycle events.
 *
 * IMPORTANT: Always verify webhook signature before processing.
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const body = await request.text();
    event = constructWebhookEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "Webhook signature verification failed");
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

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
        return NextResponse.json({ received: true });
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

    return NextResponse.json({ received: true });
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

    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
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

  // Check if this is an additional modification payment
  if (paymentIntent.metadata?.type === "modification_additional") {
    await handleAdditionalModificationPaymentSucceeded(paymentIntent, bookingId);
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
  });

  if (!payment) {
    // Try to find by bookingId as fallback
    const paymentByBooking = await prisma.payment.findUnique({
      where: { bookingId },
    });

    if (!paymentByBooking) {
      logger.warn({ paymentIntentId: paymentIntent.id, bookingId }, "No payment record found for PaymentIntent");
      return;
    }
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
  const existingPayment = payment ?? await prisma.payment.findUnique({ where: { bookingId } });
  if (existingPayment && existingPayment.amountCents !== paymentIntent.amount) {
    logger.error(
      {
        bookingId,
        expectedCents: existingPayment.amountCents,
        receivedCents: paymentIntent.amount,
        paymentIntentId: paymentIntent.id,
      },
      "Stripe webhook amount mismatch - refusing to auto-apply payment"
    );
    await alertPaymentAmountMismatch(
      bookingId,
      paymentIntent.id,
      existingPayment.amountCents,
      paymentIntent.amount,
      "Primary booking payment"
    );
    throw new Error(`Stripe payment amount mismatch for booking ${bookingId}`);
  }

  await markBookingPaymentSucceeded({
    bookingId,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    paymentMethodId:
      typeof paymentIntent.payment_method === "string"
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id ?? null,
  });

  logger.info({ bookingId, paymentIntentId: paymentIntent.id }, "Booking paid via PaymentIntent");

  // Send confirmation email
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
        booking.discountCents > 0
          ? { discountCents: booking.discountCents, promoCode: booking.promoRedemption?.promoCode?.code }
          : undefined
      );
    }
  } catch (emailErr) {
    logger.error({ err: emailErr, bookingId }, "Failed to send confirmation email");
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
  if (!bookingId) return;

  const isAdditionalPayment =
    paymentIntent.metadata?.type === "modification_additional";
  const failureMessage =
    paymentIntent.last_payment_error?.message || "Unknown payment error";

  await prisma.payment
    .update({
      where: { bookingId },
      data: isAdditionalPayment
        ? { additionalPaymentStatus: "FAILED" }
        : { status: "FAILED" },
    })
    .catch(() => {
      // Payment record may not exist yet
      logger.warn(
        { paymentIntentId: paymentIntent.id, bookingId, isAdditionalPayment },
        "Could not update payment for failed intent"
      );
    });

  logAudit({
    action: isAdditionalPayment
      ? "booking.modification.payment.failed"
      : "booking.payment.failed",
    targetId: bookingId,
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
  if (!bookingId) return;

  const isAdditionalPayment =
    paymentIntent.metadata?.type === "modification_additional";
  const cancellationReason =
    paymentIntent.cancellation_reason || "requested_by_customer";

  await prisma.payment
    .update({
      where: { bookingId },
      data: isAdditionalPayment
        ? { additionalPaymentStatus: "FAILED" }
        : { status: "FAILED" },
    })
    .catch(() => {
      logger.warn(
        { paymentIntentId: paymentIntent.id, bookingId, isAdditionalPayment },
        "Could not update payment for canceled intent"
      );
    });

  logAudit({
    action: isAdditionalPayment
      ? "booking.modification.payment.canceled"
      : "booking.payment.canceled",
    targetId: bookingId,
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
 * Handle successful additional modification payment.
 * Updates additionalPaymentStatus and adds amount to Payment.amountCents.
 */
async function handleAdditionalModificationPaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  bookingId: string
) {
  const payment = await prisma.payment.findUnique({
    where: { additionalPaymentIntentId: paymentIntent.id },
  });

  if (!payment) {
    // Fallback: look up by bookingId and verify the PI matches
    const paymentByBooking = await prisma.payment.findUnique({
      where: { bookingId },
    });
    if (!paymentByBooking || paymentByBooking.additionalPaymentIntentId !== paymentIntent.id) {
      logger.warn(
        { paymentIntentId: paymentIntent.id, bookingId },
        "No payment record found for additional modification PaymentIntent"
      );
      return;
    }

    if (paymentByBooking.additionalPaymentStatus === "SUCCEEDED") {
      logger.info({ paymentIntentId: paymentIntent.id, bookingId }, "Additional modification payment already recorded");
      return;
    }

    if (paymentByBooking.additionalAmountCents !== paymentIntent.amount) {
      logger.error(
        {
          bookingId,
          paymentIntentId: paymentIntent.id,
          expectedCents: paymentByBooking.additionalAmountCents,
          receivedCents: paymentIntent.amount,
        },
        "Stripe webhook additional payment amount mismatch - refusing to auto-apply payment"
      );
      await alertPaymentAmountMismatch(
        bookingId,
        paymentIntent.id,
        paymentByBooking.additionalAmountCents,
        paymentIntent.amount,
        "Booking modification payment"
      );
      throw new Error(`Stripe modification payment amount mismatch for booking ${bookingId}`);
    }

    await prisma.payment.update({
      where: { id: paymentByBooking.id },
      data: {
        additionalPaymentStatus: "SUCCEEDED",
        amountCents: paymentByBooking.amountCents + paymentByBooking.additionalAmountCents,
      },
    });
    logger.info({ bookingId, paymentIntentId: paymentIntent.id }, "Additional modification payment confirmed via webhook (fallback)");
    return;
  }

  if (payment.additionalPaymentStatus === "SUCCEEDED") {
    logger.info({ paymentIntentId: paymentIntent.id, bookingId }, "Additional modification payment already recorded");
    return;
  }

  if (payment.additionalAmountCents !== paymentIntent.amount) {
    logger.error(
      {
        bookingId,
        paymentIntentId: paymentIntent.id,
        expectedCents: payment.additionalAmountCents,
        receivedCents: paymentIntent.amount,
      },
      "Stripe webhook additional payment amount mismatch - refusing to auto-apply payment"
    );
    await alertPaymentAmountMismatch(
      bookingId,
      paymentIntent.id,
      payment.additionalAmountCents,
      paymentIntent.amount,
      "Booking modification payment"
    );
    throw new Error(`Stripe modification payment amount mismatch for booking ${bookingId}`);
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      additionalPaymentStatus: "SUCCEEDED",
      amountCents: payment.amountCents + payment.additionalAmountCents,
    },
  });

  logger.info(
    { bookingId, paymentIntentId: paymentIntent.id, additionalAmountCents: payment.additionalAmountCents },
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

/**
 * Handle charge refund events (from Stripe dashboard or API refunds).
 */
async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!paymentIntentId) return;

  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });

  if (!payment) {
    logger.warn({ paymentIntentId }, "No payment record found for refunded charge");
    return;
  }

  const stripeRefundedAmount = charge.amount_refunded;
  const refundedAmount = Math.max(payment.refundedAmountCents, stripeRefundedAmount);
  const refundDeltaCents = Math.max(refundedAmount - payment.refundedAmountCents, 0);
  const isFullRefund = refundedAmount >= payment.amountCents;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      refundedAmountCents: refundedAmount,
      status: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
    },
  });

  logger.info(
    {
      paymentId: payment.id,
      refundedAmount,
      refundDeltaCents,
      previousRefundedAmountCents: payment.refundedAmountCents,
      stripeRefundedAmount,
      isFullRefund,
    },
    "Refund processed for payment"
  );

  if (refundDeltaCents > 0) {
    // Queue only the newly-observed refund delta from Stripe. charge.amount_refunded is cumulative.
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        payment.id,
        refundDeltaCents
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
        logger.info(
          { paymentId: payment.id, queueOperationId: queuedCreditNote.queueOperationId },
          "Xero refund credit note queued for payment"
        );
      }
    } catch (xeroErr) {
      logger.error({ err: xeroErr, paymentId: payment.id }, "Failed to queue Xero credit note for payment");
      notifyXeroSyncError({
        errorType: "CREDIT_NOTE_CREATION",
        operation: `Queue refund credit note for payment ${payment.id}`,
        errorMessage: xeroErr instanceof Error ? xeroErr.message : String(xeroErr),
      }).catch(() => {});
    }
  } else {
    logger.info(
      { paymentId: payment.id, refundedAmount, stripeRefundedAmount },
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

  await prisma.payment.update({
    where: { id: booking.payment.id },
    data: {
      stripePaymentIntentId: paymentIntent.id,
      stripePaymentMethodId: paymentMethodId,
      amountCents: paymentIntent.amount,
      status: "SUCCEEDED",
    },
  });

  const refund = await processRefund({
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    metadata: {
      bookingId: booking.id,
      reason: "cancelled_booking_late_capture",
    },
    idempotencyKey: `late_cancel_refund_${booking.id}_${paymentIntent.id}`,
  });

  await prisma.payment.update({
    where: { id: booking.payment.id },
    data: {
      refundedAmountCents: paymentIntent.amount,
      status: "REFUNDED",
    },
  });

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    targetId: booking.id,
    details: JSON.stringify({
      paymentIntentId: paymentIntent.id,
      refundId: refund.id,
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
    { bookingId: booking.id, paymentIntentId: paymentIntent.id, refundId: refund.id },
    "Automatically refunded payment that succeeded after booking cancellation"
  );
}
