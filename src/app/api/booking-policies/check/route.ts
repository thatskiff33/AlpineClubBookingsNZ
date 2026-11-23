import { NextRequest, NextResponse } from "next/server"
import { requireActiveSession } from "@/lib/session-guards"
import {
  aggregatePolicyExceptionViolations,
  validateMinimumStay,
  formatViolationsDetail,
} from "@/lib/booking-policies"
import { bookingPolicyCheckQuerySchema } from "@/lib/booking-stay-check-query"
import { BOOKING_RULES_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings"
import { connectionJson } from "@/lib/mcp-connection-request"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"
import { loadCancellationPolicy } from "@/lib/cancellation"
import { describeCancellationSchedule } from "@/lib/cancellation-schedule"
import { clubFormat } from "@/lib/club-format-server"
import logger from "@/lib/logger"

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

  // Also the AI app action `check_booking_rules` (ALP-794).
  return connectionJson(request, {
    valid: result.valid,
    violations: review.violations,
    exceptionReview: review,
    message: result.valid ? null : formatViolationsDetail(result.violations),
    cancellationSchedule: await loadCancellationScheduleRows(checkIn, effectiveLodgeId),
  }, BOOKING_RULES_CONNECTION_SHAPE)
}

/**
 * The club's current cancellation schedule for this lodge and check-in, as the
 * rows the booking wizard's review step shows before the member commits money
 * (#4946). Same loader the cancel flow settles with, same formatter the booking
 * page and admin preview use, so the three never disagree.
 *
 * Null when it cannot be read: the date precheck this route exists for must not
 * fail because of a disclosure, and the review step shows a neutral fallback
 * line instead of rows.
 */
async function loadCancellationScheduleRows(
  checkIn: Date,
  lodgeId: string,
): Promise<string[] | null> {
  try {
    const [rules, money] = await Promise.all([
      loadCancellationPolicy(checkIn, lodgeId),
      clubFormat(),
    ])
    return describeCancellationSchedule(rules, money.format).map(
      (row) => row.description,
    )
  } catch (err) {
    logger.error({ err, lodgeId }, "Failed to load the cancellation schedule for the policy check")
    return null
  }
}
