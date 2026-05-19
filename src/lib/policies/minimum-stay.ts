import { getStayNights } from "./pricing";

export interface MinimumStayViolation {
  policyName: string;
  triggerDay: string;
  minimumNights: number;
  actualNights: number;
}

export interface MinimumStayPolicyLike {
  name: string;
  startDate: Date;
  endDate: Date;
  triggerDays: number[];
  minimumNights: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `Day ${day}`;
}

/**
 * Check if two date ranges overlap.
 * Range A: [aStart, aEnd], Range B: [bStart, bEnd] (all inclusive).
 */
export function dateRangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function getMinimumStayViolations(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[]
): MinimumStayViolation[] {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0 || policies.length === 0) {
    return [];
  }

  const violations: MinimumStayViolation[] = [];

  for (const policy of policies) {
    // Check if any night in the stay falls on a trigger day AND is within the policy date range
    const triggered = nights.some((night) => {
      const dow = night.getDay();
      if (!policy.triggerDays.includes(dow)) return false;
      return dateRangesOverlap(night, night, policy.startDate, policy.endDate);
    });

    if (triggered && nightCount < policy.minimumNights) {
      // Find the first triggering day name for the message
      const triggerDayNames = [...new Set(
        policy.triggerDays
          .filter((d) => nights.some((n) => n.getDay() === d && dateRangesOverlap(n, n, policy.startDate, policy.endDate)))
          .map(dayName)
      )];

      violations.push({
        policyName: policy.name,
        triggerDay: triggerDayNames.join(", "),
        minimumNights: policy.minimumNights,
        actualNights: nightCount,
      });
    }
  }

  return violations;
}

export function validateMinimumStayWithPolicies(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[]
): { valid: boolean; violations: MinimumStayViolation[] } {
  const violations = getMinimumStayViolations(checkIn, checkOut, policies);
  return { valid: violations.length === 0, violations };
}

/**
 * Format a violation into a user-friendly error message.
 */
export function formatViolationMessage(violation: MinimumStayViolation): string {
  return `Bookings including a ${violation.triggerDay} night require a minimum stay of ${violation.minimumNights} nights (${violation.policyName}). Your booking is ${violation.actualNights} night${violation.actualNights === 1 ? "" : "s"}.`;
}

/**
 * Format all violations into a single details string for API responses.
 */
export function formatViolationsDetail(violations: MinimumStayViolation[]): string {
  return violations.map(formatViolationMessage).join(" ");
}
