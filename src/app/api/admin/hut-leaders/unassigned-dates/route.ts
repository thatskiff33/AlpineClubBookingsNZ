import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";

/**
 * GET /api/admin/hut-leaders/unassigned-dates
 * Returns dates in the configured hut-leader lookahead window that have
 * paid/operational bookings but no HutLeaderAssignment.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return NextResponse.json({
    unassignedDates: await getUnassignedHutLeaderDates(),
  });
}
