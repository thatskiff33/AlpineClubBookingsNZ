import { NextRequest, NextResponse } from "next/server"
import {
  getAdminRosterForDate,
  rosterActionSchema,
  updateAdminRosterForDate,
} from "@/lib/admin-roster-service"
import {
  adminRosterDateParamsSchema,
  adminRosterQuerySchema,
} from "@/lib/admin-lodge-schemas/hut-leaders"
import {
  ADMIN_ROSTER_ACTION_CONNECTION_SHAPES,
  ADMIN_ROSTER_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-hut-leaders"
import { connectionJson } from "@/lib/mcp-connection-request"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"
import { requireAdmin } from "@/lib/session-guards"
import { transactionContendedResponse } from "@/lib/transaction-contended-response"
import logger from "@/lib/logger"

// The params, query and body schemas live in admin-lodge-schemas/hut-leaders.ts
// so the AI app roster actions offer the same fields (ALP-722). The app's
// read leaves out `regenerate`; it regenerates with `regenerate_chore_roster`.

function unauthorizedResponse() {
  return NextResponse.json(
    { code: "ROSTER_UNAUTHORIZED", error: "Roster access requires an administrator account. Sign in and try again." },
    { status: 401 },
  )
}

function rosterWriteForbiddenResponse() {
  return NextResponse.json(
    {
      code: "ROSTER_PERMISSION_CHANGED",
      error:
        "Roster not saved. Your account no longer has Lodge edit access. Ask a full admin to update it.",
    },
    { status: 403 },
  )
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
}

// Lodge scope for the roster (multi-lodge phase 7 retrofit): an explicit
// ?lodgeId= must name an active lodge; omitted falls back to the club's
// default lodge, preserving single-lodge behaviour.
async function resolveRosterLodgeId(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("lodgeId") ?? undefined
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requested)
  if (!lodgeId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { code: "ROSTER_LODGE_INVALID", error: "Roster request could not be completed. Choose an active lodge and try again." },
        { status: 400 },
      ),
    }
  }
  return { ok: true as const, lodgeId }
}

function parseRosterDate(dateStr: string) {
  if (!isDateOnlyString(dateStr)) {
    return { ok: false as const, response: NextResponse.json(
      { code: "ROSTER_DATE_INVALID", error: "Roster date is invalid. Choose a valid lodge night and try again." },
      { status: 400 },
    ) }
  }
  const date = parseDateOnly(dateStr)
  if (isNaN(date.getTime())) {
    return { ok: false as const, response: NextResponse.json(
      { code: "ROSTER_DATE_INVALID", error: "Roster date is invalid. Choose a valid lodge night and try again." },
      { status: 400 },
    ) }
  }
  return { ok: true as const, date }
}

/**
 * GET /api/admin/roster/[date]
 * Returns the roster for a given date. If no assignments exist, auto-suggests.
 *
 * Query params:
 *   ?includeNonEssential=true/false  (override occupancy-based selection)
 *   ?regenerate=true                 (force re-suggest, deletes existing SUGGESTED)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "lodge", level: "view" },
  })
  if (!guard.ok) return guard.response

  const parsedParams = adminRosterDateParamsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json(
      { code: "ROSTER_PARAMS_INVALID", error: "Roster could not be loaded because its route parameters were invalid. Choose a valid lodge night and try again.", details: parsedParams.error.flatten() },
      { status: 400 }
    )
  }

  const parsedDate = parseRosterDate(parsedParams.data.date)
  if (!parsedDate.ok) return parsedDate.response

  const parsedQuery = adminRosterQuerySchema.safeParse({
    lodgeId: req.nextUrl.searchParams.get("lodgeId") ?? undefined,
    regenerate: req.nextUrl.searchParams.get("regenerate") ?? undefined,
    includeNonEssential: req.nextUrl.searchParams.get("includeNonEssential") ?? undefined,
  })
  if (!parsedQuery.success) {
    return NextResponse.json(
      { code: "ROSTER_QUERY_INVALID", error: "Roster options were invalid. Review the selected options and try again.", details: parsedQuery.error.flatten() },
      { status: 400 }
    )
  }

  const lodge = await resolveRosterLodgeId(req)
  if (!lodge.ok) return lodge.response

  const { regenerate, includeNonEssential } = parsedQuery.data
  const result = await getAdminRosterForDate({
    date: parsedDate.date,
    dateString: parsedParams.data.date,
    regenerate: regenerate === "true",
    includeNonEssential: includeNonEssential === undefined ? undefined : includeNonEssential === "true",
    lodgeId: lodge.lodgeId,
  })
  return connectionJson(req, result.body, ADMIN_ROSTER_CONNECTION_SHAPE, result.init)
  } catch (error) {
    const contended = transactionContendedResponse(
      error,
      "Admin roster load contended for the lock(1) budget",
    )
    if (contended) return contended
    logger.error({ error }, "Failed to load admin roster")
    return NextResponse.json(
      { code: "ROSTER_LOAD_FAILED", error: "Roster could not be loaded because the service is unavailable. Try again." },
      { status: 500 },
    )
  }
}

/**
 * PUT /api/admin/roster/[date]
 * Atomically save the complete staged roster draft for a date, or run one of
 * the retained regenerate/confirm/email actions.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  let parsedAction: string | undefined
  try {
  const guard = await requireAdmin({
    forbiddenResponse: rosterWriteForbiddenResponse,
    permission: { area: "lodge", level: "edit" },
  })
  if (!guard.ok) return guard.response

  const parsedParams = adminRosterDateParamsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json(
      { code: "ROSTER_PARAMS_INVALID", error: "Roster not saved because its route parameters were invalid. Choose a valid lodge night and try again.", details: parsedParams.error.flatten() },
      { status: 400 }
    )
  }

  const parsedDate = parseRosterDate(parsedParams.data.date)
  if (!parsedDate.ok) return parsedDate.response

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { code: "ROSTER_JSON_INVALID", error: "Roster not saved because the request could not be read. Reload the roster and try again." },
      { status: 400 },
    )
  }

  const parsedBody = rosterActionSchema.safeParse(body)
  if (!parsedBody.success) {
    return NextResponse.json(
      { code: "ROSTER_INPUT_INVALID", error: "Roster not saved because the submitted changes were invalid. Review the roster and try again.", details: parsedBody.error.flatten() },
      { status: 400 }
    )
  }
  parsedAction = parsedBody.data.action

  const lodge = await resolveRosterLodgeId(req)
  if (!lodge.ok) return lodge.response

  const result = await updateAdminRosterForDate({
    date: parsedDate.date,
    dateString: parsedParams.data.date,
    data: parsedBody.data,
    lodgeId: lodge.lodgeId,
    adminMemberId: guard.session.user.id,
  })
  // Each variant is its own AI app action, answered with that action's shape.
  return connectionJson(
    req,
    result.body,
    ADMIN_ROSTER_ACTION_CONNECTION_SHAPES[parsedBody.data.action],
    result.init,
  )
  } catch (error) {
    const contended = transactionContendedResponse(
      error,
      "Admin roster update contended for the lock(1) budget",
    )
    if (contended) return contended
    logger.error({ error }, "Failed to update admin roster")
    const saveFailed = parsedAction === "save"
    return NextResponse.json(
      saveFailed
        ? { code: "ROSTER_SERVICE_UNAVAILABLE", error: "Roster not saved because the service could not be reached. Your draft is still here; try Save again." }
        : { code: "ROSTER_ACTION_FAILED", error: "Roster action could not be completed because the service is unavailable. Nothing was changed; try again." },
      { status: 500 },
    )
  }
}
