import { NextRequest, NextResponse } from "next/server";

import { parseJsonRequestBody } from "@/lib/api-json";
import { ApiError } from "@/lib/api-error";
import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import { adminBookingCopyBodySchema } from "@/lib/admin-bookings-schemas/bookings";
import { ADMIN_BOOKING_COPY_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/**
 * POST /api/admin/bookings/[id]/copy — copy a booking to a new draft starting
 * on another date. Also the AI app action `copy_booking_to_draft` (ALP-719).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = adminBookingCopyBodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id: bookingId } = await params;
  try {
    const result = await copyBookingToDraft({
      sourceBookingId: bookingId,
      targetCheckIn: parsed.data.checkIn,
      adminMemberId: guard.session.user.id,
    });
    return connectionJson(request, result, ADMIN_BOOKING_COPY_CONNECTION_SHAPE);
  } catch (error) {
    // `INV-LOCK-006`: the draft's one transaction rolled back.
    const contended = transactionContendedResponse(
      error,
      "Admin booking copy contended for the lock(1) budget",
      { context: { bookingId } },
    );
    if (contended) return contended;
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // #1888 — unexpected (non-ApiError) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err: error, bookingId }, "Failed to copy booking");
    return NextResponse.json(
      { error: "Failed to copy booking" },
      { status: 400 },
    );
  }
}
