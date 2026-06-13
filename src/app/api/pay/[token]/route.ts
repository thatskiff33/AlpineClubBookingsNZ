import { NextRequest, NextResponse } from "next/server";
import { getPaymentLinkContext, PaymentLinkError } from "@/lib/payment-link";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public payment link lookup. Returns the booking summary, amount due and
 * internet banking reference for a token-authenticated payment page.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.paymentLinkToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;

  try {
    const context = await getPaymentLinkContext(token);
    return NextResponse.json(context);
  } catch (err) {
    if (err instanceof PaymentLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
