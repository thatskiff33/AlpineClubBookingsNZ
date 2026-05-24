import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  minimumNights: z.number().int().min(2).optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params

  try {
    const body = await request.json()
    const data = updateSchema.parse(body)

    const existing = await prisma.minimumStayPolicy.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }

    const startDate = data.startDate ? new Date(data.startDate) : existing.startDate
    const endDate = data.endDate ? new Date(data.endDate) : existing.endDate

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      )
    }

    const policy = await prisma.minimumStayPolicy.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.startDate && { startDate }),
        ...(data.endDate && { endDate }),
        ...(data.triggerDays !== undefined && { triggerDays: data.triggerDays }),
        ...(data.minimumNights !== undefined && { minimumNights: data.minimumNights }),
        ...(data.active !== undefined && { active: data.active }),
      },
    })

    logAudit({
      action: "minimum-stay-policy.update",
      memberId: session.user.id,
      targetId: id,
      details: `Updated "${policy.name}"`,
    })

    return NextResponse.json(policy)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: "Failed to update minimum stay policy" },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params

  try {
    const existing = await prisma.minimumStayPolicy.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }

    // Soft delete — set active=false to preserve audit history
    await prisma.minimumStayPolicy.update({
      where: { id },
      data: { active: false },
    })

    logAudit({
      action: "minimum-stay-policy.delete",
      memberId: session.user.id,
      targetId: id,
      details: `Deactivated "${existing.name}"`,
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json(
      { error: "Failed to delete minimum stay policy" },
      { status: 500 }
    )
  }
}
