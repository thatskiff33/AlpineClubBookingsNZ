import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: z.string(),
  endDate: z.string(),
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1, "At least one trigger day is required"),
  minimumNights: z.number().int().min(2, "Minimum nights must be at least 2"),
  active: z.boolean().optional(),
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

  const policies = await prisma.minimumStayPolicy.findMany({
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(policies)
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const body = await request.json()
    const data = createSchema.parse(body)

    const startDate = new Date(data.startDate)
    const endDate = new Date(data.endDate)

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      )
    }

    const policy = await prisma.minimumStayPolicy.create({
      data: {
        name: data.name,
        startDate,
        endDate,
        triggerDays: data.triggerDays,
        minimumNights: data.minimumNights,
        active: data.active ?? true,
      },
    })

    logAudit({
      action: "minimum-stay-policy.create",
      memberId: session.user.id,
      details: `Created "${data.name}": min ${data.minimumNights} nights`,
    })

    return NextResponse.json(policy, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: "Failed to create minimum stay policy" },
      { status: 500 }
    )
  }
}
