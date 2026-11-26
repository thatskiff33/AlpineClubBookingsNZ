import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getBookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";
import { projectForConnection } from "@/lib/connection-projection";
import { ADMIN_BOOKING_REQUEST_PENDING_COUNTS_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-requests";
import { servingMcpConnection } from "@/lib/mcp-connection-request";

/**
 * GET /api/admin/booking-requests/pending-counts
 * The four Booking Requests queue counts (#4969), read by the page's tab
 * badges and landing tab. It asks for bookings view, the same area as the
 * lists it counts, so an admin who can open the page can read it. The
 * cross-area `/api/admin/pending-counts` aggregate resolves to `overview` and
 * runs every sidebar query, when the page needs only these four. The sidebar
 * total is the sum of the same helper's counts, so the two always agree.
 *
 * Also the AI app action `get_booking_request_counts` (ALP-719).
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const counts = await getBookingRequestPendingCounts();
  if (await servingMcpConnection()) {
    return NextResponse.json(projectForConnection(counts, ADMIN_BOOKING_REQUEST_PENDING_COUNTS_CONNECTION_SHAPE));
  }
  return NextResponse.json(counts);
}
