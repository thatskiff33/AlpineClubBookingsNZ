import { NextRequest, NextResponse } from "next/server";
import { createPaymentIntentForPaymentLink, PaymentLinkError } from "@/lib/payment-link";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Token-authenticated Stripe payment intent creation for a public payment
 * link. Runs the same status/capacity revalidation as the session-gated
 * /api/payments/create-payment-intent path before creating or reusing a
 * PaymentIntent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.paymentLinkToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;

  try {
    const result = await createPaymentIntentForPaymentLink(token);

    if (result.type === "alreadyPaid") {
      return NextResponse.json({ alreadyPaid: true, paymentIntentId: result.paymentIntentId });
    }

    return NextResponse.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
    });
  } catch (err) {
    if (err instanceof PaymentLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
