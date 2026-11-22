import { NextRequest, NextResponse } from "next/server";
import {
  getAdminOccupancyMonth,
  parseOccupancyMonth,
} from "@/lib/admin-occupancy";
import { adminOccupancyQuerySchema } from "@/lib/admin-bookings-schemas/occupancy";
import { ADMIN_OCCUPANCY_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-review-queues";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

/**
 * GET /api/admin/occupancy?month=YYYY-MM&lodgeId=…
 * Returns operational guest occupancy per lodge night for one calendar month.
 * Also the AI app action `get_lodge_occupancy` (ALP-719).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const query = adminOccupancyQuerySchema.safeParse({
    month: req.nextUrl.searchParams.get("month") ?? undefined,
    lodgeId: req.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0]?.message }, { status: 400 });
  }
  const parsedMonth = parseOccupancyMonth(query.data.month);
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 });
  }
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, query.data.lodgeId);
  if (!lodgeId) {
    return NextResponse.json({ error: "A valid lodgeId is required." }, { status: 400 });
  }

  return connectionJson(
    req,
    await getAdminOccupancyMonth({ ...parsedMonth, lodgeId }),
    ADMIN_OCCUPANCY_CONNECTION_SHAPE,
  );
}
