import { NextRequest, NextResponse } from "next/server";
import {
  getBookingRequestSettings,
  getPublicBookingRequestLodges,
  getPublicOtherLodges,
} from "@/lib/booking-request";
import { loadSchoolGroupSoftCap } from "@/lib/lodge-settings";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public read of the booking request pricing visibility setting, used by the
 * non-member booking request form to decide between "Request to Book" (with
 * indicative pricing) and "Request for Price" (no pricing shown).
 *
 * Also lists the ACTIVE lodges a requester may choose between (id and name
 * only — this endpoint is public). Empty for a single-lodge club, so the
 * forms render no lodge copy (ADR-002 presentation rule).
 */
export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const [settings, lodges, otherLodges, schoolGroupSoftCap] = await Promise.all([
    getBookingRequestSettings(),
    getPublicBookingRequestLodges(),
    // Other/partner lodges for the "member of another lodge?" drop-down (#2749).
    getPublicOtherLodges(),
    // Default-lodge soft cap for the single-lodge case (no lodge selector);
    // multi-lodge forms read the per-lodge value from `lodges` instead.
    loadSchoolGroupSoftCap(),
  ]);
  return NextResponse.json({
    ...settings,
    lodges,
    otherLodges,
    schoolGroupSoftCap,
  });
}
