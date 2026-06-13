import { NextRequest, NextResponse } from "next/server";
import { isActionTokenFormat } from "@/lib/action-tokens";
import { parseBookingRequestGuests, verifyBookingRequest } from "@/lib/booking-request";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Verify a public booking request's contact email from the emailed token.
 * On first verification the request moves NEW -> VERIFIED and joins the
 * admin queue. Returns only non-sensitive summary fields.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.bookingRequestToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;
  if (!isActionTokenFormat(token)) {
    return NextResponse.json({ outcome: "invalid" }, { status: 404 });
  }

  const result = await verifyBookingRequest(token);

  switch (result.outcome) {
    case "invalid":
      return NextResponse.json({ outcome: "invalid" }, { status: 404 });
    case "expired":
      return NextResponse.json({ outcome: "expired" }, { status: 410 });
    case "verified":
    case "already_verified":
      return NextResponse.json({
        outcome: result.outcome,
        checkIn: result.request.checkIn.toISOString(),
        checkOut: result.request.checkOut.toISOString(),
        guestCount: parseBookingRequestGuests(result.request.guests).length,
      });
  }
}
