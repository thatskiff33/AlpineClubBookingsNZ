import { NextRequest, NextResponse } from "next/server";
import { PaymentLinkError } from "@/lib/payment-link";
import { reissuePaymentLinkForToken } from "@/lib/payment-link-reissue";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Self-service "email me a fresh link" action for an expired-but-payable
 * booking (issue #740). Re-issues a payment link for the same booking and
 * emails the requester a new one. Never reveals whether a token, booking, or
 * request exists beyond the polite PaymentLinkError messages.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.paymentLinkToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;

  try {
    const result = await reissuePaymentLinkForToken(token);
    return NextResponse.json({ emailed: result.emailed });
  } catch (err) {
    if (err instanceof PaymentLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
