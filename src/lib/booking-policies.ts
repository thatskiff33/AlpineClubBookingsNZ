import type { PrismaClient } from "@prisma/client";

import { getDefaultLodgeId, resolvePolicyRowsForLodge } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { getStayNights } from "@/lib/pricing";
import {
  validateMinimumStayWithPolicies,
  type MinimumStayViolation,
} from "@/lib/policies/minimum-stay";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";

export {
  // test seam
  formatViolationMessage,
  formatViolationsDetail,
} from "@/lib/policies/minimum-stay";
export type { MinimumStayViolation } from "@/lib/policies/minimum-stay";

/**
 * The narrow client this evaluator needs. A `Prisma.TransactionClient` satisfies
 * it, which is the whole point of the parameter below.
 */
export type MinimumStayPolicyDb = Pick<
  PrismaClient,
  "minimumStayPolicy" | "lodge"
>;

/**
 * Validate booking dates against the minimum stay policies that apply at one
 * lodge. Policy resolution follows the club-wide-with-override rule: a lodge
 * with its own minimum-stay rows uses them instead of the club-wide set
 * (ADR-001 resolved question 3), so the whole active policy type is fetched
 * and resolved before date filtering. Callers without lodge context omit
 * lodgeId and get the club's default lodge.
 *
 * COMPOSITION RULE — `db`. Out-of-transaction callers omit it and read through
 * the module-level pool client, which is the common case (booking create, both
 * group-join stages, the advisory quote and policy-check surfaces). A caller
 * that is ALREADY INSIDE `prisma.$transaction` must pass its own `tx`: the two
 * modify services run this check while holding `pg_advisory_xact_lock(1)` and
 * the per-lodge capacity lock, and reaching for the module client there would
 * check out a SECOND pool connection underneath both locks — the pool-starvation
 * shape the ordering rule at the top of `member-guest-add-policy.ts` exists to
 * forbid. Passing `tx` also makes the read see the transaction's own snapshot
 * rather than a second, later one. See docs/CONCURRENCY_AND_LOCKING.md →
 * "Composition: minimum-stay policy set".
 */
export async function validateMinimumStay(
  checkIn: Date,
  checkOut: Date,
  lodgeId?: string | null,
  db: MinimumStayPolicyDb = prisma
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }> {
  // Both ends of the stay, read where the policy window is compared against
  // them: a stay with no night breaks no minimum (#2800, INV-DATE).
  const nights = getStayNights(checkIn, checkOut);
  const firstNight = nights[0];
  const lastNight = nights.at(-1);

  if (firstNight === undefined || lastNight === undefined) {
    return { valid: true, violations: [] };
  }

  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));

  // Fetch the whole active policy type for this lodge plus club-wide rows
  // (the table is small), resolve the override set, then date-filter.
  const allPolicies = await db.minimumStayPolicy.findMany({
    where: {
      active: true,
      OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }],
    },
  });

  const policies = resolvePolicyRowsForLodge(allPolicies, effectiveLodgeId).filter(
    (policy) => policy.startDate <= lastNight && policy.endDate >= firstNight
  );

  if (policies.length === 0) {
    return { valid: true, violations: [] };
  }

  return validateMinimumStayWithPolicies(
    checkIn,
    checkOut,
    policies,
    effectiveLodgeId,
  );
}

export { aggregatePolicyExceptionViolations };
