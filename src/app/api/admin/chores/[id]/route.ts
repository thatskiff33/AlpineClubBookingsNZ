import { NextRequest, NextResponse } from "next/server"
import { parseJsonRequestBody } from "@/lib/api-json"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { createAuditLog } from "@/lib/audit"
import { acquireLodgeCapacityLock } from "@/lib/capacity"
import { getDefaultLodgeId } from "@/lib/lodges"

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
  timeOfDay: z.enum(["MORNING", "EVENING", "ANYTIME"]).optional(),
  frequencyMode: z.enum(["DAILY", "EVERY_X_DAYS", "SPECIFIC_DAYS"]).optional(),
  frequencyDays: z.number().int().min(2).nullable().optional(),
  frequencyDaysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params
  const jsonBody = await parseJsonRequestBody(req)
  if (!jsonBody.ok) return jsonBody.response
  const body = jsonBody.body
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

  const lockTarget = await prisma.choreTemplate.findUnique({ where: { id } })
  if (!lockTarget) {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
  const effectiveLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(prisma))
  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // Save/Confirm/email all hold this lodge tier while validating active
      // templates. Serialize the template update with that read so an active
      // chore cannot be deactivated immediately after validation.
      await acquireLodgeCapacityLock(tx, effectiveLodgeId)
      const before = await tx.choreTemplate.findUnique({ where: { id } })
      if (!before) return null
      const chore = await tx.choreTemplate.update({ where: { id }, data })
      return { before, chore }
    })
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
  if (!result) return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  const { before, chore } = result

  // Audit with the acting admin as actor so the bootstrap-import six-signal
  // probe (signal 6) detects hand-configured chore templates.
  await createAuditLog({
    action: "CHORE_TEMPLATE_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "ChoreTemplate",
    entityId: chore.id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Chore template updated",
    metadata: {
      lodgeId: chore.lodgeId,
      changedFields: Object.keys(data),
      before: before
        ? {
            name: before.name,
            active: before.active,
            isEssential: before.isEssential,
          }
        : null,
      after: {
        name: chore.name,
        active: chore.active,
        isEssential: chore.isEssential,
      },
    },
  })

  return NextResponse.json(chore)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params

  const lockTarget = await prisma.choreTemplate.findUnique({ where: { id } })
  if (!lockTarget) {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
  const effectiveLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(prisma))
  let before
  try {
    before = await prisma.$transaction(async (tx) => {
      await acquireLodgeCapacityLock(tx, effectiveLodgeId)
      const current = await tx.choreTemplate.findUnique({ where: { id } })
      if (!current) return null
      await tx.choreTemplate.delete({ where: { id } })
      return current
    })
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }
  if (!before) return NextResponse.json({ error: "Chore not found" }, { status: 404 })

  await createAuditLog({
    action: "CHORE_TEMPLATE_DELETED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "ChoreTemplate",
    entityId: id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Chore template deleted",
    metadata: {
      lodgeId: before?.lodgeId ?? null,
      name: before?.name ?? null,
    },
  })

  return NextResponse.json({ success: true })
}
