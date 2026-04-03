import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"

const updateSeasonSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["WINTER", "SUMMER"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  active: z.boolean().optional(),
  rates: z.array(
    z.object({
      ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
      isMember: z.boolean(),
      pricePerNightCents: z.number().int().min(0),
    })
  ).length(6).optional(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const { id } = await params

  const season = await prisma.season.findUnique({
    where: { id },
    include: { rates: true },
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
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

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

  const { rates, startDate, endDate, ...seasonData } = parsed.data

  const effectiveStart = startDate ? new Date(startDate) : existing.startDate
  const effectiveEnd = endDate ? new Date(endDate) : existing.endDate

  if (effectiveEnd <= effectiveStart) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  // Check overlaps excluding current season
  if (startDate || endDate) {
    const overlapping = await prisma.season.findFirst({
      where: {
        id: { not: id },
        AND: [
          { startDate: { lte: effectiveEnd } },
          { endDate: { gte: effectiveStart } },
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
    const updated = await tx.season.update({
      where: { id },
      data: {
        ...seasonData,
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
      },
    })

    // Update rates if provided
    if (rates) {
      await tx.seasonRate.deleteMany({ where: { seasonId: id } })
      await tx.seasonRate.createMany({
        data: rates.map((rate) => ({
          seasonId: id,
          ageTier: rate.ageTier,
          isMember: rate.isMember,
          pricePerNightCents: rate.pricePerNightCents,
        })),
      })
    }

    return tx.season.findUnique({
      where: { id },
      include: { rates: true },
    })
  })

  return NextResponse.json(season)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const { id } = await params

  const existing = await prisma.season.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  await prisma.season.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
