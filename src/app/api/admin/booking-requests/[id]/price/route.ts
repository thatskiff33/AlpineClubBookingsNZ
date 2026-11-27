import { NextRequest, NextResponse } from "next/server";
import { adminBookingRequestPriceBodySchema } from "@/lib/admin-bookings-schemas/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  BookingRequestError,
  priceBookingRequest,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { ADMIN_BOOKING_REQUEST_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/booking-requests/[id]/price — set or override the officer
 * price on a verified request. Also the AI app action `price_booking_request`
 * (ALP-719).
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

  const parsed = adminBookingRequestPriceBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const updated = await priceBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      priceCents: parsed.data.priceCents,
    });

    return connectionJson(req, serializeBookingRequestForAdmin(updated!), ADMIN_BOOKING_REQUEST_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
