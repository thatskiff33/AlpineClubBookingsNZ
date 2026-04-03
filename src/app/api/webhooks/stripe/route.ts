import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { constructWebhookEvent } from "@/lib/stripe";
import Stripe from "stripe";

/**
 * Stripe webhook handler.
 * Handles payment_intent and setup_intent lifecycle events.
 *
 * IMPORTANT: Always verify webhook signature before processing.
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
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
    console.error("Webhook signature verification failed:", message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  try {
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
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error(`Error processing webhook event ${event.type}:`, error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

/**
 * Handle successful payment - confirm the booking.
 */
async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent
) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) {
    console.warn("PaymentIntent succeeded but no bookingId in metadata:", paymentIntent.id);
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
      console.warn("No payment record found for PaymentIntent:", paymentIntent.id);
      return;
    }
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
      data: { status: "CONFIRMED" },
    }),
  ]);

  console.log(`Booking ${bookingId} confirmed via PaymentIntent ${paymentIntent.id}`);

  // TODO: Send confirmation email (Phase 1 email service)
  // TODO: Create Xero invoice (Phase 6)
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
    console.warn("Could not update payment for failed intent:", paymentIntent.id);
  });

  console.log(`Payment failed for booking ${bookingId}: ${paymentIntent.id}`);

  // TODO: Send payment failure notification email
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
    console.warn("SetupIntent succeeded but no bookingId in metadata:", setupIntent.id);
    return;
  }

  const paymentMethodId =
    typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id ?? null;

  if (!paymentMethodId) {
    console.warn("SetupIntent succeeded but no payment_method:", setupIntent.id);
    return;
  }

  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntent.id,
    },
  });

  console.log(
    `Payment method ${paymentMethodId} saved for booking ${bookingId} via SetupIntent ${setupIntent.id}`
  );
}

/**
 * Handle failed SetupIntent.
 */
async function handleSetupIntentFailed(
  setupIntent: Stripe.SetupIntent
) {
  const bookingId = setupIntent.metadata?.bookingId;
  if (!bookingId) return;

  console.log(`SetupIntent failed for booking ${bookingId}: ${setupIntent.id}`);

  // TODO: Notify member that card setup failed
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
    console.warn("No payment record found for refunded charge PI:", paymentIntentId);
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

  console.log(
    `Refund processed for payment ${payment.id}: ${refundedAmount} cents (${isFullRefund ? "full" : "partial"})`
  );

  // TODO: Create Xero credit note (Phase 6)
}
