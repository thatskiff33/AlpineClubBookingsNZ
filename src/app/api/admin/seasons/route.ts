import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync"
import {
  membershipTypeSeasonRateInputSchema,
  validateMembershipTypeSeasonRates,
} from "@/lib/season-rate-editor"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

// Rates are keyed by membership type (#1930, E4); the legacy boolean-keyed
// SeasonRate table was dropped by #2129 step 2.
const seasonSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["WINTER", "SUMMER"]),
  startDate: dateOnlyString,
  endDate: dateOnlyString,
  active: z.boolean().default(true),
  membershipTypeRates: membershipTypeSeasonRateInputSchema,
  // Flat whole-lodge night rate for this season, in integer cents (#2338).
  // Nullable/optional: null or omitted means "no flat rate", so a whole-lodge
  // approval prices per guest as before.
  flatWholeLodgeNightCents: z.number().int().min(0).nullable().optional(),
  lodgeId: z.string().min(1).optional(),
})

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  const lodgeId = req.nextUrl.searchParams.get("lodgeId")
  const seasons = await prisma.season.findMany({
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    // membershipTypeRates is the authoritative pricing table the editor
    // reads and writes (#1930, E4). The legacy `rates` relation is no longer
    // selected by any read path (#2129); consumers of this response — including
    // the lodge-setup copy-seasons flow — read `membershipTypeRates`.
    include: { membershipTypeRates: true },
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(seasons)
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json()
  const parsed = seasonSchema.safeParse(body)

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
  await syncOwnOtherLodgesFromFees("fees season created")
  revalidatePublicPageContent()

  return NextResponse.json(season, { status: 201 })
}
