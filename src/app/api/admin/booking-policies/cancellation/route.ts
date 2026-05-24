import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireActiveSessionUser } from "@/lib/session-guards"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"

const policySchema = z.object({
  rules: z.array(
    z.object({
      daysBeforeStay: z.number().int().min(0),
      refundPercentage: z.number().int().min(0).max(100),
      creditRefundPercentage: z.number().int().min(0).max(100).optional(),
      fixedFeeCents: z.number().int().min(0).optional(),
      creditFixedFeeCents: z.number().int().min(0).optional(),
    })
  ).min(1, "At least one rule is required"),
  nonMemberHoldDays: z.number().int().min(1).max(30).optional(),
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

  const policies = await prisma.cancellationPolicy.findMany({
    orderBy: { daysBeforeStay: "desc" },
  })

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  })

  return NextResponse.json({
    rules: policies.map(normalizeCancellationRule),
    nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
  })
}

export async function PUT(req: NextRequest) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await req.json()
  const parsed = policySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { rules, nonMemberHoldDays } = parsed.data

  // Validate: days must be unique
  const sortedRules = [...rules]
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  const dayValues = sortedRules.map((r) => r.daysBeforeStay)
  if (new Set(dayValues).size !== dayValues.length) {
    return NextResponse.json(
      { error: "Each rule must have a unique number of days" },
      { status: 400 }
    )
  }

  // Replace all rules atomically and update defaults
  const result = await prisma.$transaction(async (tx) => {
    await tx.cancellationPolicy.deleteMany()
    await tx.cancellationPolicy.createMany({
      data: sortedRules.map((rule) => ({
        daysBeforeStay: rule.daysBeforeStay,
        refundPercentage: rule.refundPercentage,
        creditRefundPercentage: rule.creditRefundPercentage,
        fixedFeeCents: rule.fixedFeeCents,
        creditFixedFeeCents: rule.creditFixedFeeCents,
      })),
    })

    if (nonMemberHoldDays !== undefined) {
      await tx.bookingDefaults.upsert({
        where: { id: "default" },
        update: { nonMemberHoldDays },
        create: { id: "default", nonMemberHoldDays },
      })
    }

    const policies = await tx.cancellationPolicy.findMany({
      orderBy: { daysBeforeStay: "desc" },
    })

    const defaults = await tx.bookingDefaults.findUnique({
      where: { id: "default" },
    })

    return {
      rules: policies.map(normalizeCancellationRule),
      nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
    }
  })

  logAudit({
    action: "cancellation-policy.update",
    memberId: session.user.id,
    details: `Updated to ${sortedRules.length} rules, holdDays=${nonMemberHoldDays ?? "unchanged"}`,
  })

  return NextResponse.json(result)
}
