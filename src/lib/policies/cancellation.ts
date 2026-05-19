import { normalizeCancellationRule, type CancellationRuleLike } from "../cancellation-rules";

export type CancellationRule = CancellationRuleLike;

/**
 * Determine which cancellation tier applies for a given number of days before check-in.
 * Returns the matching tier's refund percentage and days threshold.
 *
 * Policy rules are sorted by daysBeforeStay descending.
 * The first rule where daysUntilCheckIn >= daysBeforeStay applies.
 */
export function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  refundPercentage: number;
  creditRefundPercentage: number;
  fixedFeeCents: number;
  creditFixedFeeCents: number;
  daysBeforeStay: number;
} {
  if (policyRules.length === 0) {
    return {
      refundPercentage: 0,
      creditRefundPercentage: 0,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
      daysBeforeStay: 0,
    };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return normalizeCancellationRule(rule);
    }
  }

  return {
    refundPercentage: 0,
    creditRefundPercentage: 0,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
    daysBeforeStay: 0,
  };
}

/**
 * Calculate refund amount based on cancellation policy.
 *
 * Example policy:
 *   [{days: 14, refund: 100}, {days: 7, refund: 50}, {days: 0, refund: 0}]
 *
 * - Cancel 15 days before -> 100% refund
 * - Cancel 10 days before -> 50% refund
 * - Cancel 3 days before -> 0% refund
 */
export function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[],
  refundMethod: "card" | "credit" = "card"
): { refundAmountCents: number; refundPercentage: number } {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  const refundPercentage =
    refundMethod === "credit"
      ? tier.creditRefundPercentage
      : tier.refundPercentage;
  const fixedFeeCents =
    refundMethod === "credit"
      ? tier.creditFixedFeeCents
      : tier.fixedFeeCents;
  const refundAmountCents = Math.max(
    0,
    Math.round((paidAmountCents * refundPercentage) / 100) - fixedFeeCents
  );
  return { refundAmountCents, refundPercentage };
}

/**
 * Calculate both card and credit refund amounts for a cancel preview.
 */
export function calculateDualRefundAmounts(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
} {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  return {
    cardRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.refundPercentage) / 100) - tier.fixedFeeCents
    ),
    cardRefundPercentage: tier.refundPercentage,
    creditRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.creditRefundPercentage) / 100) - tier.creditFixedFeeCents
    ),
    creditRefundPercentage: tier.creditRefundPercentage,
  };
}

/**
 * Calculate days between now and check-in date.
 *
 * Uses Math.floor deliberately: partial days do NOT count toward a higher
 * refund tier. A cancellation 6.9 days before check-in gets the 6-day rule,
 * not the 7-day rule. This is distinct from the booking-creation hold-day
 * check which uses Math.ceil (any fraction over the threshold keeps the
 * booking pending to protect capacity).
 */
export function daysUntilDate(checkIn: Date, now: Date = new Date()): number {
  const diffMs = checkIn.getTime() - now.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}
