import { prisma } from "./prisma";

export interface CancellationRule {
  daysBeforeStay: number;
  refundPercentage: number;
}

/**
 * Find the active BookingPeriod that covers a given check-in date, if any.
 */
export async function getBookingPeriodForDate(checkIn: Date) {
  return prisma.bookingPeriod.findFirst({
    where: {
      active: true,
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
    },
  });
}

/**
 * Get the non-member hold days for a given check-in date.
 * Uses period-specific value if check-in falls in a BookingPeriod,
 * otherwise uses the global default from BookingDefaults.
 */
export async function getNonMemberHoldDays(checkIn: Date): Promise<number> {
  const period = await getBookingPeriodForDate(checkIn);
  if (period) {
    return period.nonMemberHoldDays;
  }

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  });
  return defaults?.nonMemberHoldDays ?? 7;
}

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
): { refundPercentage: number; daysBeforeStay: number } {
  if (policyRules.length === 0) {
    return { refundPercentage: 0, daysBeforeStay: 0 };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return {
        refundPercentage: rule.refundPercentage,
        daysBeforeStay: rule.daysBeforeStay,
      };
    }
  }

  return { refundPercentage: 0, daysBeforeStay: 0 };
}

/**
 * Calculate refund amount based on cancellation policy.
 *
 * Example policy:
 *   [{days: 14, refund: 100}, {days: 7, refund: 50}, {days: 0, refund: 0}]
 *
 * - Cancel 15 days before → 100% refund
 * - Cancel 10 days before → 50% refund
 * - Cancel 3 days before → 0% refund
 */
export function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundAmountCents: number; refundPercentage: number } {
  const { refundPercentage } = getRefundTier(daysUntilCheckIn, policyRules);
  const refundAmountCents = Math.round(
    (paidAmountCents * refundPercentage) / 100
  );
  return { refundAmountCents, refundPercentage };
}

/**
 * Calculate days between now and check-in date.
 */
export function daysUntilDate(checkIn: Date, now: Date = new Date()): number {
  const diffMs = checkIn.getTime() - now.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Load the cancellation policy for a given check-in date.
 * If the check-in falls within an active BookingPeriod, uses that period's rules.
 * Otherwise falls back to the default CancellationPolicy table.
 */
export async function loadCancellationPolicy(
  checkIn?: Date
): Promise<CancellationRule[]> {
  if (checkIn) {
    const period = await getBookingPeriodForDate(checkIn);
    if (period) {
      const rules = period.cancellationRules as unknown as CancellationRule[];
      return [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
    }
  }

  const rules = await prisma.cancellationPolicy.findMany({
    orderBy: { daysBeforeStay: "desc" },
  });

  return rules.map((r) => ({
    daysBeforeStay: r.daysBeforeStay,
    refundPercentage: r.refundPercentage,
  }));
}

/**
 * Calculate the refund for a booking cancellation.
 * Returns the refund amount and percentage, or null if booking can't be cancelled.
 */
export async function calculateBookingRefund(
  bookingId: string
): Promise<{
  refundAmountCents: number;
  refundPercentage: number;
  paidAmountCents: number;
  daysUntilCheckIn: number;
} | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });

  if (!booking || !booking.payment) {
    return null;
  }

  if (
    booking.status !== "CONFIRMED" ||
    booking.payment.status !== "SUCCEEDED"
  ) {
    return null;
  }

  const paidAmountCents =
    booking.payment.amountCents - booking.payment.refundedAmountCents;
  const days = daysUntilDate(booking.checkIn);
  const policy = await loadCancellationPolicy(booking.checkIn);
  const { refundAmountCents, refundPercentage } = calculateRefundAmount(
    paidAmountCents,
    days,
    policy
  );

  return {
    refundAmountCents,
    refundPercentage,
    paidAmountCents,
    daysUntilCheckIn: days,
  };
}
