import { NextResponse } from "next/server";
import logger from "@/lib/logger";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { requireAdmin } from "@/lib/session-guards";
import { getStuckStateDashboard } from "@/lib/stuck-state-dashboard";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // #2823: the route is gated at support:view (the area /admin/stuck-states is
  // registered under). The named member / booking-owner detail rows are a
  // membership-roll surface, so they are gated separately on membership:view —
  // the same permission /api/admin/members requires — read off the DB-verified
  // matrix requireAdmin() just resolved onto the session. Support-only admins
  // still get every count and card-level link.
  const viewerCanViewMembership = hasAdminAreaAccess(guard.session.user, {
    area: "membership",
    level: "view",
  });

  // #4162: the voided bank refund notes' panel is finance information.
  const viewerCanViewFinance = hasAdminAreaAccess(guard.session.user, {
    area: "finance",
    level: "view",
  });

  try {
    return NextResponse.json(
      await getStuckStateDashboard({ viewerCanViewMembership, viewerCanViewFinance }),
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to load stuck-state dashboard");
    return NextResponse.json(
      { error: "Failed to load stuck-state dashboard" },
      { status: 500 },
    );
  }
}
