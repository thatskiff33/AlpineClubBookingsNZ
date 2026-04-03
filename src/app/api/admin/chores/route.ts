import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"

const choreSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional().default(""),
  recommendedPeopleMin: z.number().int().min(1).default(1),
  recommendedPeopleMax: z.number().int().min(1).default(2),
  isEssential: z.boolean().default(false),
  ageRestriction: z.enum(["ANY", "ADULTS_ONLY", "MIXED_PREFERRED", "ADULT_SUPERVISED"]).default("ANY"),
  conditionalNote: z.string().nullable().optional().default(null),
  minAge: z.number().int().min(0).default(0),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
})

export async function GET() {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const chores = await prisma.choreTemplate.findMany({
    orderBy: { sortOrder: "asc" },
  })
  return NextResponse.json(chores)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const parsed = choreSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const data = parsed.data
  if (data.recommendedPeopleMax < data.recommendedPeopleMin) {
    return NextResponse.json(
      { error: "Max people must be >= min people" },
      { status: 400 }
    )
  }

  const chore = await prisma.choreTemplate.create({ data })
  return NextResponse.json(chore, { status: 201 })
}
