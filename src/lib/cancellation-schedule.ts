import {
  normalizeCancellationRule,
  type CancellationRuleLike,
} from "@/lib/cancellation-rules";
import { formatCents } from "@/lib/utils";

export type CancellationScheduleRow = {
  description: string;
  refundPercentage: number;
};

/**
 * Formats an applicable cancellation policy (its tier rules) into ordered,
 * human-readable rows. Shared by the admin policy preview and the member-facing
 * booking help so operators and members always read the identical tier schedule
 * (#1371 F28 / #1239). Rules are normalized first so nullable/absent credit and
 * fee fields fall back exactly as the settlement math does.
 */
export function describeCancellationSchedule(
  rules: CancellationRuleLike[],
): CancellationScheduleRow[] {
  const sortedRules = rules
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);

  return sortedRules.map((rule, index) => {
    let prefix: string;
    if (index === 0) {
      prefix = `${rule.daysBeforeStay}+ days before stay:`;
    } else if (rule.daysBeforeStay === 0 && index === sortedRules.length - 1) {
      prefix = `Less than ${sortedRules[index - 1]?.daysBeforeStay ?? 0} days:`;
    } else {
      const prevDays = sortedRules[index - 1]?.daysBeforeStay ?? 0;
      prefix = `${rule.daysBeforeStay}-${prevDays - 1} days:`;
    }

    const creditDiffers = rule.creditRefundPercentage !== rule.refundPercentage;
    const creditFeeDiffers = rule.creditFixedFeeCents !== rule.fixedFeeCents;
    const cardFeeStr =
      rule.fixedFeeCents > 0
        ? ` less ${formatCents(rule.fixedFeeCents)} fee`
        : "";
    const creditFeeStr =
      rule.creditFixedFeeCents > 0
        ? ` less ${formatCents(rule.creditFixedFeeCents)} fee`
        : "";
    const description =
      creditDiffers || creditFeeDiffers
        ? `${prefix} ${rule.refundPercentage}% card${cardFeeStr} / ${rule.creditRefundPercentage}% credit${creditFeeStr}`
        : `${prefix} ${rule.refundPercentage}% refund${cardFeeStr}`;

    return { description, refundPercentage: rule.refundPercentage };
  });
}
