import { prisma } from "@/lib/prisma"
import { getStayNights } from "@/lib/pricing"

export interface MinimumStayViolation {
  policyName: string
  triggerDay: string
  minimumNights: number
  actualNights: number
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `Day ${day}`
}

/**
 * Check if two date ranges overlap.
 * Range A: [aStart, aEnd], Range B: [bStart, bEnd] (all inclusive).
 */
function dateRangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * Validate booking dates against all active minimum stay policies.
 * Returns { valid: true, violations: [] } or { valid: false, violations: [...] }
 */
export async function validateMinimumStay(
  checkIn: Date,
  checkOut: Date
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }> {
  const nights = getStayNights(checkIn, checkOut)
  const nightCount = nights.length

  if (nightCount === 0) {
    return { valid: true, violations: [] }
  }

  const firstNight = nights[0]
  const lastNight = nights[nights.length - 1]

  // Query active policies whose date range overlaps with the stay
  const policies = await prisma.minimumStayPolicy.findMany({
    where: {
      active: true,
      startDate: { lte: lastNight },
      endDate: { gte: firstNight },
    },
  })

  if (policies.length === 0) {
    return { valid: true, violations: [] }
  }

  const violations: MinimumStayViolation[] = []

  for (const policy of policies) {
    // Check if any night in the stay falls on a trigger day AND is within the policy date range
    const triggered = nights.some((night) => {
      const dow = night.getDay()
      if (!policy.triggerDays.includes(dow)) return false
      return dateRangesOverlap(night, night, policy.startDate, policy.endDate)
    })

    if (triggered && nightCount < policy.minimumNights) {
      // Find the first triggering day name for the message
      const triggerDayNames = [...new Set(
        policy.triggerDays
          .filter((d) => nights.some((n) => n.getDay() === d && dateRangesOverlap(n, n, policy.startDate, policy.endDate)))
          .map(dayName)
      )]

      violations.push({
        policyName: policy.name,
        triggerDay: triggerDayNames.join(", "),
        minimumNights: policy.minimumNights,
        actualNights: nightCount,
      })
    }
  }

  return { valid: violations.length === 0, violations }
}

/**
 * Format a violation into a user-friendly error message.
 */
export function formatViolationMessage(violation: MinimumStayViolation): string {
  return `Bookings including a ${violation.triggerDay} night require a minimum stay of ${violation.minimumNights} nights (${violation.policyName}). Your booking is ${violation.actualNights} night${violation.actualNights === 1 ? "" : "s"}.`
}

/**
 * Format all violations into a single details string for API responses.
 */
export function formatViolationsDetail(violations: MinimumStayViolation[]): string {
  return violations.map(formatViolationMessage).join(" ")
}
