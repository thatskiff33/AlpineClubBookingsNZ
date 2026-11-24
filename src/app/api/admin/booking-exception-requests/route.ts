import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { readUnifiedExceptionQueue } from "@/lib/booking-exception-request-service";
import { adminBookingExceptionRequestQueueQuerySchema } from "@/lib/admin-bookings-schemas/review-queues";
import {
  ADMIN_EXCEPTION_REQUEST_QUEUE_CONNECTION_SHAPE,
  type AdminExceptionRequestQueueAnswer,
} from "@/lib/connection-shapes/bookings-review-queues";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * The unified Booking Officer queue: every policy-exception request, merged from
 * the new-booking table and the POLICY_EXCEPTION BookingChangeRequest rows into
 * one age-ordered `{ data, page, pageSize, total, totalPages }` view. Same guard and
 * envelope as the existing booking-change-request queue.
 *
 * Also the AI app action `list_booking_exception_requests` (ALP-719).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = adminBookingExceptionRequestQueueQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result: AdminExceptionRequestQueueAnswer = await readUnifiedExceptionQueue(parsed.data);
  return connectionJson(req, result, ADMIN_EXCEPTION_REQUEST_QUEUE_CONNECTION_SHAPE);
}
