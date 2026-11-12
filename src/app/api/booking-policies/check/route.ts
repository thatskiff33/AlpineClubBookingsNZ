import { NextRequest, NextResponse } from "next/server"
import { requireActiveSession } from "@/lib/session-guards"
import {
  aggregatePolicyExceptionViolations,
  validateMinimumStay,
  formatViolationsDetail,
} from "@/lib/booking-policies"
import { z } from "zod"
import { parsedDateOnlySchema } from "@/lib/date-only-schema"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"

const bookingPolicyCheckQuerySchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  // Lodge being booked (multi-lodge phase 8): minimum-stay overrides resolve
  // per lodge. Omitted = the club's default lodge.
  lodgeId: z.string().min(1).nullish(),
})

export async function GET(request: NextRequest) {
  const guard = await requireActiveSession()
  if (!guard.ok) return guard.response

  const parsed = bookingPolicyCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
    lodgeId: request.nextUrl.searchParams.get("lodgeId"),
  })

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { checkIn, checkOut } = parsed.data

  if (checkOut <= checkIn) {
    return NextResponse.json(
      { error: "checkOut must be after checkIn" },
      { status: 400 }
    )
  }

  const effectiveLodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  )
  if (!effectiveLodgeId) {
    return NextResponse.json(
      { error: "Unknown or inactive lodgeId" },
      { status: 400 },
    )
  }

  const result = await validateMinimumStay(checkIn, checkOut, effectiveLodgeId)
  const review = aggregatePolicyExceptionViolations(result.violations)

  return NextResponse.json({
    valid: result.valid,
    violations: review.violations,
    exceptionReview: review,
    message: result.valid ? null : formatViolationsDetail(result.violations),
  })
}
