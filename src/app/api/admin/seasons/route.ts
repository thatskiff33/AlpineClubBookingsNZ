import { NextRequest, NextResponse } from "next/server"
import { parseJsonRequestBody } from "@/lib/api-json"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { parseDateOnly } from "@/lib/date-only"
import {
  adminSeasonsQuerySchema,
  seasonCreateBodySchema,
} from "@/lib/admin-bookings-schemas/setup"
import {
  ADMIN_SEASON_CONNECTION_SHAPE,
  ADMIN_SEASON_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-setup"
import { connectionJson, connectionListJson } from "@/lib/mcp-connection-request"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync"
import { validateMembershipTypeSeasonRates } from "@/lib/season-rate-editor"

// The body schema lives in admin-bookings-schemas/setup.ts so the AI app
// actions `list_seasons` and `create_season` offer the same fields (ALP-719).

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  // A string or nothing always parses; the 400 is only a backstop.
  const query = adminSeasonsQuerySchema.safeParse({
    lodgeId: req.nextUrl.searchParams.get("lodgeId") ?? undefined,
  })
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0]?.message }, { status: 400 })
  }
  const lodgeId = query.data.lodgeId
  const seasons = await prisma.season.findMany({
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    // membershipTypeRates is the authoritative pricing table the editor
    // reads and writes (#1930, E4). The legacy `rates` relation is no longer
    // selected by any read path (#2129); consumers of this response — including
    // the lodge-setup copy-seasons flow — read `membershipTypeRates`.
    include: { membershipTypeRates: true },
    orderBy: { startDate: "desc" },
  })

  // The browser keeps the bare array; a connection gets it under `seasons`.
  return connectionListJson(req, seasons, "seasons", ADMIN_SEASON_LIST_CONNECTION_SHAPE)
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(req)
  if (!jsonBody.ok) return jsonBody.response
  const body = jsonBody.body
  const parsed = seasonCreateBodySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const {
    name,
    type,
    startDate,
    endDate,
    active,
    membershipTypeRates,
    flatWholeLodgeNightCents,
  } = parsed.data

  const parsedStartDate = parseDateOnly(startDate)
  const parsedEndDate = parseDateOnly(endDate)

  if (parsedEndDate <= parsedStartDate) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  const rateError = await validateMembershipTypeSeasonRates(prisma, membershipTypeRates)
  if (rateError) {
    return NextResponse.json({ error: rateError }, { status: 400 })
  }

  const lodgeId = await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId)
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    )
  }

  // Check for overlapping seasons at this lodge. Lodges may run different
  // season windows, so the check is per lodge; rows with a null lodgeId
  // (expand-release tolerance) conservatively overlap every lodge.
  const overlapping = await prisma.season.findFirst({
    where: {
      AND: [
        { startDate: { lte: parsedEndDate } },
        { endDate: { gte: parsedStartDate } },
        lodgeNullTolerantScope(lodgeId),
      ],
    },
  })

  if (overlapping) {
    return NextResponse.json(
      { error: `Dates overlap with existing season: ${overlapping.name}` },
      { status: 400 }
    )
  }

  const season = await prisma.$transaction(async (tx) => {
    const created = await tx.season.create({
      data: {
        name,
        type,
        startDate: parsedStartDate,
        endDate: parsedEndDate,
        active,
        // #2338: null when omitted (no flat whole-lodge rate for this season).
        flatWholeLodgeNightCents: flatWholeLodgeNightCents ?? null,
        lodgeId,
        membershipTypeRates: {
          create: membershipTypeRates.map((rate) => ({
            membershipTypeId: rate.membershipTypeId,
            ageTier: rate.ageTier,
            pricePerNightCents: rate.pricePerNightCents,
          })),
        },
      },
    })
    return tx.season.findUnique({
      where: { id: created.id },
      include: { membershipTypeRates: true },
    })
  })

  logAudit({
    action: "season.create",
    category: "booking",
    memberId: session.user.id,
    targetId: season?.id,
    entityType: "Season",
    entityId: season?.id,
    details: `Created season: ${name}`,
  });

  // This club's own Other lodge follows the Fees page (#77).
  await syncOwnOtherLodgesFromFees("fees season created", session.user.id)
  revalidatePublicPageContent()

  return connectionJson(req, season, ADMIN_SEASON_CONNECTION_SHAPE, { status: 201 })
}
