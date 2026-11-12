import { NextRequest, NextResponse } from "next/server"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { requireAdmin } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { parseDateOnly } from "@/lib/date-only"
import { dateOnlyStringSchema } from "@/lib/date-only-schema"
import {
  DUPLICATE_MINIMUM_STAY_POLICY_NAME_MESSAGE,
  lockMinimumStayPolicySet,
} from "@/lib/minimum-stay-policy-set"

const updateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
  startDate: dateOnlyStringSchema.optional(),
  endDate: dateOnlyStringSchema.optional(),
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  minimumNights: z.number().int().min(2).optional(),
  capacityMode: z.enum(["HOLD", "NO_HOLD"]).optional(),
  active: z.boolean().optional(),
})

const deleteSchema = z.object({
  version: z.number().int().positive(),
})

function canonicalTriggerDays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b)
}

class PolicyNotFoundError extends Error {}

class PolicyVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("Policy version changed")
  }
}

function versionConflict(error: PolicyVersionConflictError) {
  return NextResponse.json(
    {
      error: "This policy changed since it was loaded. Reload it and try again.",
      code: "POLICY_VERSION_CONFLICT",
      currentVersion: error.currentVersion,
    },
    { status: 409 },
  )
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  })
  if (!guard.ok) return guard.response
  const session = guard.session
  const { id } = await params

  try {
    const data = updateSchema.parse(await request.json())
    const outcome = await prisma.$transaction(async (tx) => {
      // The global policy-set lock is acquired before the first read. The DB
      // statement trigger takes this same key for draining old-colour DML.
      await lockMinimumStayPolicySet(tx)
      const existing = await tx.minimumStayPolicy.findUnique({ where: { id } })
      if (!existing) throw new PolicyNotFoundError()
      if (existing.version !== data.version) {
        throw new PolicyVersionConflictError(existing.version)
      }

      const startDate = data.startDate
        ? parseDateOnly(data.startDate)
        : existing.startDate
      const endDate = data.endDate ? parseDateOnly(data.endDate) : existing.endDate
      if (endDate <= startDate) return { kind: "invalid-dates" as const }

      // #2363: a rename — or a reactivate that brings an old name back — must
      // not leave two ACTIVE policies sharing one (scope, name). That pair is
      // how configuration transfer identifies a policy, and the table carries
      // no unique constraint on it, so a duplicate created here would abort the
      // whole export later. Checked under the policy-set lock already held, and
      // against the scope this row lives in (PUT never moves a row's lodge).
      // Inactive rows are exempt — see the message's own note.
      const nextName = data.name ?? existing.name
      const nextActive = data.active ?? existing.active
      if (nextActive) {
        const clash = await tx.minimumStayPolicy.findFirst({
          where: {
            id: { not: id },
            lodgeId: existing.lodgeId,
            name: nextName,
            active: true,
          },
          select: { id: true },
        })
        if (clash) return { kind: "name-conflict" as const }
      }

      const triggerDays = data.triggerDays
        ? canonicalTriggerDays(data.triggerDays)
        : existing.triggerDays
      const material =
        (data.name !== undefined && data.name !== existing.name) ||
        (data.startDate !== undefined &&
          startDate.getTime() !== existing.startDate.getTime()) ||
        (data.endDate !== undefined &&
          endDate.getTime() !== existing.endDate.getTime()) ||
        (data.triggerDays !== undefined &&
          (triggerDays.length !== existing.triggerDays.length ||
            triggerDays.some((day, index) => day !== existing.triggerDays[index]))) ||
        (data.minimumNights !== undefined &&
          data.minimumNights !== existing.minimumNights) ||
        (data.capacityMode !== undefined &&
          data.capacityMode !== existing.capacityMode) ||
        (data.active !== undefined && data.active !== existing.active)

      if (!material) return { kind: "unchanged" as const, existing }

      const claimed = await tx.minimumStayPolicy.updateMany({
        where: { id, version: data.version },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.startDate && { startDate }),
          ...(data.endDate && { endDate }),
          ...(data.triggerDays !== undefined && { triggerDays }),
          ...(data.minimumNights !== undefined && {
            minimumNights: data.minimumNights,
          }),
          ...(data.capacityMode !== undefined && {
            capacityMode: data.capacityMode,
          }),
          ...(data.active !== undefined && { active: data.active }),
          version: { increment: 1 },
        },
      })
      if (claimed.count !== 1) {
        const current = await tx.minimumStayPolicy.findUnique({
          where: { id },
          select: { version: true },
        })
        if (!current) throw new PolicyNotFoundError()
        throw new PolicyVersionConflictError(current.version)
      }
      const policy = await tx.minimumStayPolicy.findUnique({ where: { id } })
      if (!policy) throw new PolicyNotFoundError()
      return { kind: "updated" as const, existing, policy }
    })

    if (outcome.kind === "invalid-dates") {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 },
      )
    }
    if (outcome.kind === "name-conflict") {
      // 409, like the version conflict above: the admin screen's existing
      // 409 branch shows this sentence and reloads the list, so the row they
      // have to rename around is on screen when they read it.
      return NextResponse.json(
        {
          error: DUPLICATE_MINIMUM_STAY_POLICY_NAME_MESSAGE,
          code: "POLICY_NAME_CONFLICT",
        },
        { status: 409 },
      )
    }
    if (outcome.kind === "unchanged") {
      return NextResponse.json(outcome.existing)
    }

    logAudit({
      action: "minimum-stay-policy.update",
      category: "booking",
      memberId: session.user.id,
      targetId: id,
      entityType: "MinimumStayPolicy",
      entityId: id,
      details: JSON.stringify({
        lodgeId: outcome.existing.lodgeId,
        before: outcome.existing,
        after: outcome.policy,
      }),
    })

    revalidatePublicPageContent()
    return NextResponse.json(outcome.policy)
  } catch (error) {
    if (error instanceof PolicyNotFoundError) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }
    if (error instanceof PolicyVersionConflictError) return versionConflict(error)
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: "Failed to update minimum stay policy" },
      { status: 500 },
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  })
  if (!guard.ok) return guard.response
  const session = guard.session
  const { id } = await params

  try {
    const data = deleteSchema.parse(await request.json())
    const outcome = await prisma.$transaction(async (tx) => {
      await lockMinimumStayPolicySet(tx)
      const existing = await tx.minimumStayPolicy.findUnique({ where: { id } })
      if (!existing) throw new PolicyNotFoundError()
      if (existing.version !== data.version) {
        throw new PolicyVersionConflictError(existing.version)
      }
      if (!existing.active) return { existing, changed: false }

      const claimed = await tx.minimumStayPolicy.updateMany({
        where: { id, version: data.version, active: true },
        data: { active: false, version: { increment: 1 } },
      })
      if (claimed.count !== 1) {
        const current = await tx.minimumStayPolicy.findUnique({
          where: { id },
          select: { version: true },
        })
        if (!current) throw new PolicyNotFoundError()
        throw new PolicyVersionConflictError(current.version)
      }
      return { existing, changed: true }
    })

    if (!outcome.changed) return NextResponse.json({ success: true })
    const after = {
      ...outcome.existing,
      active: false,
      version: outcome.existing.version + 1,
    }
    logAudit({
      action: "minimum-stay-policy.delete",
      category: "booking",
      memberId: session.user.id,
      targetId: id,
      entityType: "MinimumStayPolicy",
      entityId: id,
      details: JSON.stringify({
        lodgeId: outcome.existing.lodgeId,
        before: outcome.existing,
        after,
      }),
    })

    revalidatePublicPageContent()
    return NextResponse.json({ success: true, policy: after })
  } catch (error) {
    if (error instanceof PolicyNotFoundError) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }
    if (error instanceof PolicyVersionConflictError) return versionConflict(error)
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: "Failed to delete minimum stay policy" },
      { status: 500 },
    )
  }
}
