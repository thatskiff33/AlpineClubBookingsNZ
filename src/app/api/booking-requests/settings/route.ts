import { NextRequest, NextResponse } from "next/server";
import { getBookingRequestSettings } from "@/lib/booking-request";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public read of the booking request pricing visibility setting, used by the
 * non-member booking request form to decide between "Request to Book" (with
 * indicative pricing) and "Request for Price" (no pricing shown).
 */
export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const settings = await getBookingRequestSettings();
  return NextResponse.json(settings);
}
