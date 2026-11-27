import { NextRequest, NextResponse } from "next/server";
import { bookingRequestQuoteInputSchema } from "@/lib/admin-bookings-schemas/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  BookingRequestQuoteError,
  createBookingRequestQuote,
  parseBookingRequestQuoteOptions,
} from "@/lib/booking-request-quotes";
import { BookingRequestError } from "@/lib/booking-request";
import {
  ADMIN_BOOKING_REQUEST_QUOTE_SAVED_CONNECTION_SHAPE,
  type AdminBookingRequestQuoteSavedAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/booking-requests/[id]/quote — Save quote: price the request
 * as a draft quote, superseding any earlier one. Also the AI app action
 * `save_booking_request_quote` (ALP-719).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  const jsonBody = await parseJsonRequestBody(req, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = bookingRequestQuoteInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const quote = await createBookingRequestQuote({
      requestId: id,
      adminMemberId: session.user.id,
      quote: parsed.data,
    });

    const answer: AdminBookingRequestQuoteSavedAnswer = {
      id: quote.id,
      version: quote.version,
      status: quote.status,
      pricingMode: quote.pricingMode,
      options: parseBookingRequestQuoteOptions(quote.options),
    };
    return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_QUOTE_SAVED_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
