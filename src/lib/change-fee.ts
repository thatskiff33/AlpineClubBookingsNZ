import { getRefundTier, type CancellationRule } from "./cancellation";

export interface ChangeFeeInput {
  /** Days from now to the original check-in date */
  daysUntilOriginalCheckIn: number;
  /** Days from now to the new check-in date */
  daysUntilNewCheckIn: number;
  /** The booking's finalPriceCents (after promo discount) */
  originalFinalPriceCents: number;
  /** The cancellation policy rules */
  policyRules: CancellationRule[];
}

export interface ChangeFeeResult {
  feeCents: number;
  fromTierRefundPct: number;
  toTierRefundPct: number;
}

/**
 * Calculate the late-notice change fee when modifying booking dates.
 *
 * A fee is charged when moving from a stricter cancellation tier (lower refund %)
 * to a more lenient tier (higher refund %). This prevents members from pushing
 * dates out to escape cancellation penalties.
 *
 * Fee = (toTierRefundPct - fromTierRefundPct) / 100 * originalFinalPriceCents
 *
 * - Tier for original position: determined by days from now to original check-in
 * - Tier for new position: determined by days from now to new check-in
 * - If moving to a stricter or same tier: no fee
 * - If only checkOut changes (checkIn unchanged): no fee (tiers are identical)
 */
export function calculateChangeFee(input: ChangeFeeInput): ChangeFeeResult {
  const {
    daysUntilOriginalCheckIn,
    daysUntilNewCheckIn,
    originalFinalPriceCents,
    policyRules,
  } = input;

  const fromTier = getRefundTier(daysUntilOriginalCheckIn, policyRules);
  const toTier = getRefundTier(daysUntilNewCheckIn, policyRules);

  const fromTierRefundPct = fromTier.refundPercentage;
  const toTierRefundPct = toTier.refundPercentage;

  // Fee only when moving to a more lenient (higher refund %) tier
  if (toTierRefundPct <= fromTierRefundPct) {
    return { feeCents: 0, fromTierRefundPct, toTierRefundPct };
  }

  const feeCents = Math.round(
    ((toTierRefundPct - fromTierRefundPct) / 100) * originalFinalPriceCents
  );

  return { feeCents, fromTierRefundPct, toTierRefundPct };
}
