import { NextRequest, NextResponse } from "next/server"
import { parseOccupancyMonth } from "@/lib/admin-occupancy"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"
import { getRosterMonthStatus } from "@/lib/roster-status"
import { requireAdmin } from "@/lib/session-guards"
import { adminRosterMonthStatusQuerySchema } from "@/lib/admin-lodge-schemas/hut-leaders"
import { ADMIN_ROSTER_MONTH_STATUS_CONNECTION_SHAPE } from "@/lib/connection-shapes/lodge-hut-leaders"
import { connectionJson } from "@/lib/mcp-connection-request"

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
}

/**
 * GET /api/admin/roster/status?month=YYYY-MM[&lodgeId=]
 * Returns the per-date roster colour status for one calendar month, powering
 * the roster calendar overlay. Booking-granularity coverage: see
 * `computeRosterDayStatuses`.
 *
 * An explicit `lodgeId` scopes the overlay to one lodge so it matches the
 * lodge-filtered roster list below it (#1587 item 3); it is validated the same
 * way the roster list route does (`resolveOptionalActiveLodgeId` → 400 for an
 * unknown/inactive lodge). Unlike `/api/admin/roster/[date]`, an omitted
 * `lodgeId` is NOT resolved to the default lodge: it is left club-wide so the
 * single-active-lodge overlay stays byte-identical to before multi-lodge.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "lodge", level: "view" },
  })
  if (!guard.ok) return guard.response

  // The schema is shared with the AI app action `get_chore_roster_month_status`
  // (ALP-722). Only a missing month fails it, which the month parser below
  // answers with its own 400 as before.
  const query = adminRosterMonthStatusQuerySchema.safeParse({
    month: req.nextUrl.searchParams.get("month") ?? undefined,
    lodgeId: req.nextUrl.searchParams.get("lodgeId") ?? undefined,
  })
  const parsedMonth = parseOccupancyMonth(query.success ? query.data.month : null)
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 })
  }

  const requestedLodgeId = query.success ? query.data.lodgeId : undefined
  let lodgeId: string | undefined
  if (requestedLodgeId) {
    const resolved = await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    if (!resolved) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      )
    }
    lodgeId = resolved
  }

  const statuses = await getRosterMonthStatus({ month: parsedMonth.month, lodgeId })
  return connectionJson(req, { month: parsedMonth.month, statuses }, ADMIN_ROSTER_MONTH_STATUS_CONNECTION_SHAPE)
}
