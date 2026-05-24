import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { ageTierEnum } from "@/lib/age-tier-schema"
import { logAudit } from "@/lib/audit"

const seasonSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["WINTER", "SUMMER"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  active: z.boolean().default(true),
  rates: z.array(
    z.object({
      ageTier: ageTierEnum,
      isMember: z.boolean(),
      pricePerNightCents: z.number().int().min(0),
    })
  ).min(1, "Must provide at least one rate"),
})

export async function GET() {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const seasons = await prisma.season.findMany({
    include: { rates: true },
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(seasons)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await req.json()
  const parsed = seasonSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { name, type, startDate, endDate, active, rates } = parsed.data

  if (new Date(endDate) <= new Date(startDate)) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  // Check for overlapping seasons
  const overlapping = await prisma.season.findFirst({
    where: {
      AND: [
        { startDate: { lte: new Date(endDate) } },
        { endDate: { gte: new Date(startDate) } },
      ],
    },
  })

  if (overlapping) {
    return NextResponse.json(
      { error: `Dates overlap with existing season: ${overlapping.name}` },
      { status: 400 }
    )
  }

  const season = await prisma.season.create({
    data: {
      name,
      type,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      active,
      rates: {
        create: rates.map((rate) => ({
          ageTier: rate.ageTier,
          isMember: rate.isMember,
          pricePerNightCents: rate.pricePerNightCents,
        })),
      },
    },
    include: { rates: true },
  })

  logAudit({
    action: "season.create",
    memberId: session.user.id,
    targetId: season.id,
    details: `Created season: ${name}`,
  });

  return NextResponse.json(season, { status: 201 })
}
