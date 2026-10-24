import { NextRequest, NextResponse } from "next/server"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { lodgeNullTolerantScope } from "@/lib/lodges"
import {
  membershipTypeSeasonRateInputSchema,
  replaceMembershipTypeSeasonRates,
  validateMembershipTypeSeasonRates,
} from "@/lib/season-rate-editor"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

// Rates keyed by membership type (#1930, E4); legacy SeasonRate is gone (#2129).
const updateSeasonSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["WINTER", "SUMMER"]).optional(),
  startDate: dateOnlyString.optional(),
  endDate: dateOnlyString.optional(),
  active: z.boolean().optional(),
  membershipTypeRates: membershipTypeSeasonRateInputSchema.optional(),
  // Flat whole-lodge night rate in integer cents (#2338). Nullable so the Hut
  // Fees editor can CLEAR it (null); omitted leaves it untouched — the
  // windows-only /admin/seasons PUT never sends it, so a window edit never wipes
  // a configured flat rate. Flows through `...seasonData` into the update.
  flatWholeLodgeNightCents: z.number().int().min(0).nullable().optional(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params

  const season = await prisma.season.findUnique({
    where: { id },
    include: { membershipTypeRates: true },
  })

  if (!season) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  return NextResponse.json(season)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params
  const body = await req.json()
  const parsed = updateSeasonSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const existing = await prisma.season.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  const { membershipTypeRates, startDate, endDate, ...seasonData } = parsed.data

  if (membershipTypeRates) {
    const rateError = await validateMembershipTypeSeasonRates(prisma, membershipTypeRates)
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 })
    }
  }

  const parsedStartDate = startDate ? parseDateOnly(startDate) : undefined
  const parsedEndDate = endDate ? parseDateOnly(endDate) : undefined
  const effectiveStart = parsedStartDate ?? existing.startDate
  const effectiveEnd = parsedEndDate ?? existing.endDate

  if (effectiveEnd <= effectiveStart) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  // Check overlaps excluding current season, scoped to the season's own
  // lodge (lodges may run different season windows). A season still missing
  // its lodgeId (expand-release tolerance) conservatively checks every lodge.
  if (startDate || endDate) {
    const overlapping = await prisma.season.findFirst({
      where: {
        id: { not: id },
        AND: [
          { startDate: { lte: effectiveEnd } },
          { endDate: { gte: effectiveStart } },
          ...(existing.lodgeId
            ? [lodgeNullTolerantScope(existing.lodgeId)]
            : []),
        ],
      },
    })

    if (overlapping) {
      return NextResponse.json(
        { error: `Dates overlap with existing season: ${overlapping.name}` },
        { status: 400 }
      )
    }
  }

  const season = await prisma.$transaction(async (tx) => {
    // Update season fields
    await tx.season.update({
      where: { id },
      data: {
        ...seasonData,
        ...(parsedStartDate && { startDate: parsedStartDate }),
        ...(parsedEndDate && { endDate: parsedEndDate }),
      },
    })

    // Update membership-type rates if provided — the only hut-rate table there
    // is (#1930, E4; the legacy SeasonRate table was dropped by #2129 step 2).
    if (membershipTypeRates) {
      await replaceMembershipTypeSeasonRates(tx, id, membershipTypeRates)
    }

    return tx.season.findUnique({
      where: { id },
      include: { membershipTypeRates: true },
    })
  })

  logAudit({
    action: "season.update",
    category: "booking",
    memberId: session.user.id,
    targetId: id,
    entityType: "Season",
    entityId: id,
    details: `Updated season: ${existing.name}`,
  })

  // This club's own Other lodge follows the Fees page (#77).
  await syncOwnOtherLodgesFromFees("fees season updated", session.user.id)
  revalidatePublicPageContent()
  return NextResponse.json(season)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params

  const existing = await prisma.season.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  await prisma.season.delete({ where: { id } })

  logAudit({
    action: "season.delete",
    category: "booking",
    memberId: session.user.id,
    targetId: id,
    entityType: "Season",
    entityId: id,
    details: `Deleted season: ${existing.name}`,
  })

  await syncOwnOtherLodgesFromFees("fees season deleted", session.user.id)
  revalidatePublicPageContent()
  return NextResponse.json({ success: true })
}
