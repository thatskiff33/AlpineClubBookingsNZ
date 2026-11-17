import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getAdminPendingCounts } from "@/lib/admin-pending-counts";

/**
 * GET /api/admin/pending-counts
 * All admin queue counts in one payload, consumed by the sidebar badges. The
 * four Booking Requests queues in it come from `getBookingRequestPendingCounts`
 * (`admin-booking-request-pending-counts.ts`), the one definition the dashboard
 * card and the Booking Requests page's tab badges read too (#4969).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return NextResponse.json(await getAdminPendingCounts());
}
