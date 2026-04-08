import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { constructWebhookEvent } from "@/lib/stripe";
import { isXeroConnected, createXeroInvoiceForBooking, createXeroCreditNote } from "@/lib/xero";
import { sendBookingConfirmedEmail, sendAdminPaymentFailureAlert, sendSetupIntentFailedEmail } from "@/lib/email";
import { recordWebhookLog } from "@/lib/webhook-log";
import Stripe from "stripe";
import logger from "@/lib/logger";

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

  try {
    // Idempotency: attempt to claim this event atomically
    try {
      await prisma.processedWebhookEvent.create({
        data: { eventId: event.id, source: "stripe", eventType: event.type },
      });
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
    logger.error({ err: error, eventType: event.type }, "Error processing webhook event");

    // OBS-08: Record failed webhook processing
    await recordWebhookLog({
      source: "stripe",
      eventType: event.type,
      eventId: event.id,
      status: "failure",
      durationMs: Date.now() - webhookStart,
      error: error instanceof Error ? error.message : String(error),
    });

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

  // Validate webhook amount matches expected booking amount
  const existingPayment = payment ?? await prisma.payment.findUnique({ where: { bookingId } });
  if (existingPayment && existingPayment.amountCents !== paymentIntent.amount) {
    logger.warn(
      {
        bookingId,
        expectedCents: existingPayment.amountCents,
        receivedCents: paymentIntent.amount,
        paymentIntentId: paymentIntent.id,
      },
      "Stripe webhook amount mismatch - using Stripe amount as authoritative"
    );
  }

  await prisma.$transaction([
    prisma.payment.update({
      where: { bookingId },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        stripePaymentMethodId:
          typeof paymentIntent.payment_method === "string"
            ? paymentIntent.payment_method
            : paymentIntent.payment_method?.id ?? null,
        status: "SUCCEEDED",
        amountCents: paymentIntent.amount,
      },
    }),
    prisma.booking.update({
      where: { id: bookingId },
      data: { status: "PAID" },
    }),
  ]);

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

  // Create Xero invoice if connected
  try {
    if (await isXeroConnected()) {
      await createXeroInvoiceForBooking(bookingId);
      logger.info({ bookingId }, "Xero invoice created for booking");
    }
  } catch (xeroErr) {
    logger.error({ err: xeroErr, bookingId }, "Failed to create Xero invoice for booking");
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

  await prisma.payment.update({
    where: { bookingId },
    data: { status: "FAILED" },
  }).catch(() => {
    // Payment record may not exist yet
    logger.warn({ paymentIntentId: paymentIntent.id, bookingId }, "Could not update payment for failed intent");
  });

  logger.info({ bookingId, paymentIntentId: paymentIntent.id }, "Payment failed for booking");

  // N-04: Send admin alert for payment failure
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true },
    });
    if (booking) {
      const errorMsg = paymentIntent.last_payment_error?.message || "Unknown payment error";
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: paymentIntent.amount,
        errorMessage: errorMsg,
        paymentIntentId: paymentIntent.id,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send admin payment failure alert")
      );
    }
  } catch (err) {
    logger.error({ err, bookingId }, "Error fetching booking for payment failure alert");
  }
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

  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntent.id,
    },
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

  const refundedAmount = charge.amount_refunded;
  const isFullRefund = refundedAmount >= payment.amountCents;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      refundedAmountCents: refundedAmount,
      status: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
    },
  });

  logger.info({ paymentId: payment.id, refundedAmount, isFullRefund }, "Refund processed for payment");

  // Create Xero credit note if connected (idempotency: createXeroCreditNote checks xeroRefundCreditNoteId)
  try {
    if (await isXeroConnected()) {
      const creditNoteId = await createXeroCreditNote(payment.id, refundedAmount);
      logger.info({ paymentId: payment.id, creditNoteId }, "Xero credit note processed for payment");
    }
  } catch (xeroErr) {
    logger.error({ err: xeroErr, paymentId: payment.id }, "Failed to create Xero credit note for payment");
  }
}
