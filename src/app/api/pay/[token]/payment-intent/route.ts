import { NextRequest, NextResponse } from "next/server";
import { PaymentLinkError } from "@/lib/payment-link";
import {
  createPaymentIntentForPaymentLink,
  PaymentLinkPaymentRecoveryError,
} from "@/lib/payment-link-intent";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { HOSTING_COVERAGE_RETRY_BODY } from "@/lib/adult-member-hosting-queue-participants";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
} from "@/lib/payment-recovery-contract";

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
  const rateLimited = await applyRateLimit(rateLimiters.paymentLinkToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;

  try {
    const result = await createPaymentIntentForPaymentLink(token);

    if (result.type === "alreadyPaid") {
      return NextResponse.json({ alreadyPaid: true });
    }

    return NextResponse.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
    });
  } catch (err) {
    if (err instanceof PaymentLinkPaymentRecoveryError) {
      if (err.kind === "payment_received_finalisation_pending") {
        return NextResponse.json(
          {
            paymentReceived: true,
            finalisationPending: true,
            ...HOSTING_COVERAGE_RETRY_BODY,
          },
          { status: 409 },
        );
      }
      if (err.kind === "payment_received_status_unconfirmed") {
        return NextResponse.json(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY, {
          status: 409,
        });
      }
      if (err.kind === "existing_card_status_unconfirmed") {
        return NextResponse.json(
          EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Payment succeeded, but lodge capacity is no longer available for this booking.",
          status: "CANCELLED",
          refunded: err.kind === "cancelled_refunded",
        },
        { status: 409 },
      );
    }
    if (err instanceof PaymentLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
