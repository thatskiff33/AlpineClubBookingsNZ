import { normalizeCancellationRule } from "./cancellation-rules";
import { prisma } from "./prisma";
import {
  calculateRefundAmount,
  daysUntilDate,
  type CancellationRule,
} from "./policies/cancellation";

export {
  calculateDualRefundAmounts,
  calculateRefundAmount,
  daysUntilDate,
  getRefundTier,
} from "./policies/cancellation";
export type { CancellationRule } from "./policies/cancellation";

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

  const rules = await prisma.cancellationPolicy.findMany({
    orderBy: { daysBeforeStay: "desc" },
  });

  return rules.map(normalizeCancellationRule);
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
    !["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) ||
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
