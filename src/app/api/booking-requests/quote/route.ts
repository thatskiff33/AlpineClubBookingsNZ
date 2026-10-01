import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRequestedLodgeActive,
  bookingRequestGuestSchema,
  BookingRequestError,
  calculateIndicativeNonMemberPriceCents,
  getBookingRequestSettings,
} from "@/lib/booking-request";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { lodgeGuestLimitMessage } from "@/lib/lodge-booking-readiness";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const quoteSchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  // Lodge the stay is requested at; omitted prices the club's default lodge.
  lodgeId: z.string().min(1).optional(),
  guests: z.array(bookingRequestGuestSchema).min(1).max(200),
});

/**
 * Public indicative pricing quote for the non-member booking request form.
 * Only returns a price when the admin has enabled "show pricing to
 * non-members" — otherwise the form must submit as a Request for Price.
 */
export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const settings = await getBookingRequestSettings();
  if (!settings.showPricingToNonMembers) {
    return NextResponse.json({ showPricing: false, indicativePriceCents: null });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { checkIn, checkOut, guests } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  try {
    // A provided lodgeId must name an ACTIVE lodge (400 otherwise); omitted
    // prices against the club's default lodge.
    const lodgeId = await assertRequestedLodgeActive(parsed.data.lodgeId);

    const lodgeCapacity = lodgeId
      ? await getLodgeCapacity(lodgeId)
      : await getDefaultLodgeCapacity();
    if (guests.length > lodgeCapacity) {
      return NextResponse.json(
        { error: lodgeGuestLimitMessage(lodgeCapacity, (limit) => `A booking request cannot exceed ${limit} guests`) },
        { status: 400 }
      );
    }

    const indicativePriceCents = await calculateIndicativeNonMemberPriceCents({
      checkIn,
      checkOut,
      guests,
      lodgeId,
    });

    return NextResponse.json({ showPricing: true, indicativePriceCents });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
