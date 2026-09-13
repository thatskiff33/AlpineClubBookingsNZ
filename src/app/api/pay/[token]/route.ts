import { NextRequest, NextResponse } from "next/server";
import { bookingHasOpenFinancialReview } from "@/lib/booking-financial-review-visibility";
import { PaymentLinkError } from "@/lib/payment-link";
import { getPaymentLinkContext } from "@/lib/payment-link-context";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public payment link lookup. Returns the booking summary, amount due and
 * internet banking reference for a token-authenticated payment page.
 *
 * ## Why the financial-review read is done HERE (#3194, epic #2797)
 *
 * `bookingHasOpenFinancialReview` is the one canonical answer to "is this
 * booking's money still with the office", and it carries `import "server-only"`.
 * `payment-link-context.ts` does not import it: that module is written to stay
 * importable outside a React server — it reads the club's timezone through
 * `readClubTimeZoneOutsideRequest` for exactly that reason, and
 * `cli-server-only-reach-census.test.ts` fails any operator script that gains
 * such an edge. This route handler has no such constraint, so it does the read
 * and hands the answer down.
 *
 * The alternative was a second `where` clause spelling the same predicate
 * somewhere importable, which is the drift that helper exists to prevent: the
 * booking page and this page would then each hold their own definition of
 * "under review", and a later narrowing would reach one of them (`INV-SSOT`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.paymentLinkToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;

  try {
    const context = await getPaymentLinkContext(token, {
      readOpenFinancialReview: bookingHasOpenFinancialReview,
    });
    return NextResponse.json(context);
  } catch (err) {
    if (err instanceof PaymentLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
