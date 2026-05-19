import { prisma } from "@/lib/prisma";
import { getStayNights } from "@/lib/pricing";
import {
  validateMinimumStayWithPolicies,
  type MinimumStayViolation,
} from "@/lib/policies/minimum-stay";

export {
  dateRangesOverlap,
  formatViolationMessage,
  formatViolationsDetail,
  getMinimumStayViolations,
  validateMinimumStayWithPolicies,
} from "@/lib/policies/minimum-stay";
export type { MinimumStayPolicyLike, MinimumStayViolation } from "@/lib/policies/minimum-stay";

/**
 * Validate booking dates against all active minimum stay policies.
 * Returns { valid: true, violations: [] } or { valid: false, violations: [...] }
 */
export async function validateMinimumStay(
  checkIn: Date,
  checkOut: Date
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }> {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0) {
    return { valid: true, violations: [] };
  }

  const firstNight = nights[0];
  const lastNight = nights[nights.length - 1];

  // Query active policies whose date range overlaps with the stay
  const policies = await prisma.minimumStayPolicy.findMany({
    where: {
      active: true,
      startDate: { lte: lastNight },
      endDate: { gte: firstNight },
    },
  });

  if (policies.length === 0) {
    return { valid: true, violations: [] };
  }

  return validateMinimumStayWithPolicies(checkIn, checkOut, policies);
}
