import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import { isActionTokenFormat } from "@/lib/action-tokens";
import {
  BookingRequestQuoteError,
  getBookingRequestQuoteContext,
  respondToBookingRequestQuote,
} from "@/lib/booking-request-quotes";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const responseSchema = z.object({
  action: z.enum(["ACCEPT", "CANCEL", "MODIFY", "QUERY"]),
  optionId: z.string().min(1).max(40).optional().nullable(),
  message: z.string().max(2000).optional().nullable(),
});

function invalidQuoteResponse() {
  return NextResponse.json({ error: "This quote is not valid." }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingRequestToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;
  if (!isActionTokenFormat(token)) {
    return invalidQuoteResponse();
  }

  try {
    const context = await getBookingRequestQuoteContext(token);
    return NextResponse.json(context);
  } catch (err) {
    if (err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingRequestToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;
  if (!isActionTokenFormat(token)) {
    return invalidQuoteResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const result = await respondToBookingRequestQuote({
      token,
      action: parsed.data.action,
      optionId: parsed.data.optionId,
      message: parsed.data.message,
    });
    return NextResponse.json(result);
  } catch (err) {
    // Each response action commits in one lock(1) transaction (INV-LOCK-005).
    const contended = transactionContendedResponse(
      err,
      "Booking request quote response contended for the lock(1) budget",
      { context: { action: parsed.data.action } },
    );
    if (contended) return contended;
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
