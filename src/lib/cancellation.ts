import type { PrismaClient } from "@prisma/client";

import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { normalizeCancellationRule } from "./cancellation-rules";
import { getDefaultLodgeId, resolvePolicyRowsForLodge } from "./lodges";
import { prisma } from "./prisma";
import { type CancellationRule } from "./policies/cancellation";

export {
  calculateAppliedCreditRestore,
  calculateDualRefundAmounts,
  calculateRefundAmount,
  daysUntilDate,
  // test seam
  getRefundTier,
} from "./policies/cancellation";
export type { CancellationRule } from "./policies/cancellation";

type NonMemberHoldPolicySource = "period" | "default";

/**
 * The narrow client the three readers below need. A `Prisma.TransactionClient`
 * satisfies it, which is the whole point of the `db` parameter they take.
 *
 * COMPOSITION RULE - `db`, and it is `INV-LOCK-004`. The same rule
 * `validateMinimumStay` (`booking-policies.ts`) and
 * `loadAdultMemberHostingPolicy` (`adult-member-hosting-review.ts`) carry, and
 * binding here for the same reason: **a caller already inside
 * `prisma.$transaction` MUST pass its own `tx`.** Reaching for the module-level client while the caller holds
 * `pg_advisory_xact_lock(1)` and a per-lodge capacity lock checks out a SECOND
 * pool connection underneath both, which is the pool-starvation shape the
 * ordering rule at the top of `member-guest-add-policy.ts` exists to forbid:
 * under load every connection can end up held by a transaction waiting for a
 * connection. Passing `tx` also makes the read see the transaction's own
 * snapshot rather than a second, later one - which matters here because every
 * in-transaction caller feeds these readers a `checkIn` and `lodgeId` taken
 * from a booking row it re-read AFTER the locks.
 *
 * Callers genuinely outside a transaction keep the default; that is the
 * majority, and the module client is correct and cheapest there. See
 * docs/CONCURRENCY_AND_LOCKING.md -> "Which client reads the cancellation and
 * non-member-hold policy". `cancellation-policy-client-contract.test.ts` pins
 * both halves off the real source, so a tenth in-transaction call site cannot
 * quietly reintroduce the second connection.
 */
export type CancellationPolicyDb = Pick<
  PrismaClient,
  "bookingPeriod" | "bookingDefaults" | "cancellationPolicy" | "lodge"
>;

export type NonMemberHoldPolicy = {
  enabled: boolean;
  holdDays: number;
  source: NonMemberHoldPolicySource;
};

/**
 * Find the active BookingPeriod that covers a given check-in date at one
 * lodge, if any. Periods follow the club-wide-with-override rule (ADR-001
 * resolved question 3): a lodge with its own period rows uses them instead of
 * the club-wide set, so the whole active type is fetched and resolved before
 * the date is matched. Callers without lodge context omit lodgeId and get the
 * club's default lodge.
 */
async function getBookingPeriodForDate(
  checkIn: Date,
  lodgeId?: string | null,
  db: CancellationPolicyDb = prisma
) {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));
  const allPeriods = await db.bookingPeriod.findMany({
    where: {
      active: true,
      OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }],
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  return (
    resolvePolicyRowsForLodge(allPeriods, effectiveLodgeId).find(
      (period) => period.startDate <= checkIn && period.endDate >= checkIn
    ) ?? null
  );
}

/**
 * Resolve the effective non-member hold policy for a check-in date.
 * Date-specific periods override both the hold enabled flag and the threshold.
 */
export async function getNonMemberHoldPolicy(
  checkIn: Date,
  lodgeId?: string | null,
  db: CancellationPolicyDb = prisma
): Promise<NonMemberHoldPolicy> {
  const period = await getBookingPeriodForDate(checkIn, lodgeId, db);
  if (period) {
    return {
      enabled: period.nonMemberHoldEnabled,
      holdDays: period.nonMemberHoldDays,
      source: "period",
    };
  }

  const defaults = await db.bookingDefaults.findUnique({
    where: { id: "default" },
  });

  return {
    enabled:
      defaults?.nonMemberHoldEnabled ?? DEFAULT_BOOKING_DEFAULTS.nonMemberHoldEnabled,
    holdDays: defaults?.nonMemberHoldDays ?? DEFAULT_BOOKING_DEFAULTS.nonMemberHoldDays,
    source: "default",
  };
}

/**
 * Get the non-member hold days for a given check-in date.
 * Uses period-specific value if check-in falls in a BookingPeriod,
 * otherwise uses the global default from BookingDefaults.
 *
 * Request-origin payment-link flows use this threshold as a deadline even when
 * member-created provisional holds are disabled.
 */
export async function getNonMemberHoldDays(
  checkIn: Date,
  lodgeId?: string | null,
  db: CancellationPolicyDb = prisma
): Promise<number> {
  const policy = await getNonMemberHoldPolicy(checkIn, lodgeId, db);
  return policy.holdDays;
}

/**
 * Load the cancellation policy for a given check-in date.
 * If the check-in falls within an active BookingPeriod, uses that period's rules.
 * Otherwise falls back to the default CancellationPolicy table.
 */
export async function loadCancellationPolicy(
  checkIn?: Date,
  lodgeId?: string | null,
  db: CancellationPolicyDb = prisma
): Promise<CancellationRule[]> {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));
  if (checkIn) {
    const period = await getBookingPeriodForDate(checkIn, effectiveLodgeId, db);
    if (period) {
      const rawRules = period.cancellationRules as unknown as Array<{
        daysBeforeStay: number;
        refundPercentage: number;
        creditRefundPercentage?: number;
        fixedFeeCents?: number;
        creditFixedFeeCents?: number;
      }>;
      return rawRules
        .map(normalizeCancellationRule)
        .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
    }
  }

  const allRules = await db.cancellationPolicy.findMany({
    where: { OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }] },
    orderBy: { daysBeforeStay: "desc" },
  });

  return resolvePolicyRowsForLodge(allRules, effectiveLodgeId).map(
    normalizeCancellationRule
  );
}
