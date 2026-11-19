import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getAdminPendingCounts } from "@/lib/admin-pending-counts";

/**
 * GET /api/admin/pending-counts
 * Every officer work-queue count in one payload, consumed by the sidebar's
 * Needs Attention badges. Each count settles on its own (#4962): one that
 * fails is listed in `unavailable` and the rest still arrive. Never cached —
 * the sidebar refetches it after every navigation and queue decision.
 * The four Booking Requests queues in it come from
 * `getBookingRequestPendingCounts` (`admin-booking-request-pending-counts.ts`),
 * the one definition the Booking Requests page's tab badges read too (#4969).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return NextResponse.json(await getAdminPendingCounts(), {
    headers: { "Cache-Control": "no-store" },
  });
}
