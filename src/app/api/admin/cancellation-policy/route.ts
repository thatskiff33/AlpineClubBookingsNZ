import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"

const policySchema = z.object({
  rules: z.array(
    z.object({
      daysBeforeStay: z.number().int().min(0),
      refundPercentage: z.number().int().min(0).max(100),
    })
  ).min(1, "At least one rule is required"),
})

export async function GET() {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const policies = await prisma.cancellationPolicy.findMany({
    orderBy: { daysBeforeStay: "desc" },
  })

  return NextResponse.json(policies)
}

export async function PUT(req: NextRequest) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const body = await req.json()
  const parsed = policySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { rules } = parsed.data

  // Validate: days must be unique and refund % should decrease as days decrease
  const sortedRules = [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  const dayValues = sortedRules.map((r) => r.daysBeforeStay)
  if (new Set(dayValues).size !== dayValues.length) {
    return NextResponse.json(
      { error: "Each rule must have a unique number of days" },
      { status: 400 }
    )
  }

  // Replace all rules atomically
  const policies = await prisma.$transaction(async (tx) => {
    await tx.cancellationPolicy.deleteMany()
    await tx.cancellationPolicy.createMany({
      data: sortedRules.map((rule) => ({
        daysBeforeStay: rule.daysBeforeStay,
        refundPercentage: rule.refundPercentage,
      })),
    })
    return tx.cancellationPolicy.findMany({
      orderBy: { daysBeforeStay: "desc" },
    })
  })

  return NextResponse.json(policies)
}
