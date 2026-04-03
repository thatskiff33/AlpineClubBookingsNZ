import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  recommendedPeopleMin: z.number().int().min(1).optional(),
  recommendedPeopleMax: z.number().int().min(1).optional(),
  isEssential: z.boolean().optional(),
  ageRestriction: z.enum(["ANY", "ADULTS_ONLY", "MIXED_PREFERRED", "ADULT_SUPERVISED"]).optional(),
  conditionalNote: z.string().nullable().optional(),
  minAge: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const data = parsed.data
  if (
    data.recommendedPeopleMin !== undefined &&
    data.recommendedPeopleMax !== undefined &&
    data.recommendedPeopleMax < data.recommendedPeopleMin
  ) {
    return NextResponse.json(
      { error: "Max people must be >= min people" },
      { status: 400 }
    )
  }

  try {
    const chore = await prisma.choreTemplate.update({
      where: { id },
      data,
    })
    return NextResponse.json(chore)
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    await prisma.choreTemplate.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
}
