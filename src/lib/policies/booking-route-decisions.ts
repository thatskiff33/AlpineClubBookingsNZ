import { BookingStatus, type AgeTier, type SeasonType } from "@prisma/client";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type GuestInput,
  type PriceBreakdown,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  type CancellationRule,
} from "./cancellation";

export type { CancellationRule };

export interface GroupDiscountSettingLike {
  enabled: boolean;
  minGroupSize: number;
  summerOnly: boolean;
}

export interface SeasonRateSource {
  id: string;
  startDate: Date;
  endDate: Date;
  type?: SeasonType;
  rates: Array<{
    ageTier: AgeTier;
    isMember: boolean;
    pricePerNightCents: number;
  }>;
}

export interface GuestPricingSource {
  ageTier: AgeTier;
  isMember: boolean;
}

export function toGroupDiscountConfig(
  setting: GroupDiscountSettingLike | null | undefined
): GroupDiscountConfig | undefined {
  if (!setting?.enabled) {
    return undefined;
  }

  return {
    minGroupSize: setting.minGroupSize,
    summerOnly: setting.summerOnly,
    enabled: true,
  };
}

export function toSeasonRateData(seasons: SeasonRateSource[]): SeasonRateData[] {
  return seasons.map((season) => ({
    seasonId: season.id,
    startDate: season.startDate,
    endDate: season.endDate,
    type: season.type,
    rates: season.rates.map((rate) => ({
      ageTier: rate.ageTier,
      isMember: rate.isMember,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  }));
}

export function toGuestPricingInputs(guests: GuestPricingSource[]): GuestInput[] {
  return guests.map((guest) => ({
    ageTier: guest.ageTier,
    isMember: guest.isMember,
  }));
}

export function priceBookingGuests(input: {
  checkIn: Date;
  checkOut: Date;
  guests: GuestInput[];
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): PriceBreakdown {
  return calculateBookingPrice(
    input.checkIn,
    input.checkOut,
    input.guests,
    input.seasons,
    input.groupDiscount
  );
}

export function isGroupDiscountAppliedToBooking(input: {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): boolean {
  const { checkIn, checkOut, guestCount, seasons, groupDiscount } = input;
  if (!groupDiscount?.enabled) {
    return false;
  }
  if (guestCount < groupDiscount.minGroupSize) {
    return false;
  }
  if (!groupDiscount.summerOnly) {
    return true;
  }

  return seasons.some(
    (season) =>
      season.type === "SUMMER" &&
      season.startDate < checkOut &&
      season.endDate >= checkIn
  );
}

export function calculateHoldDaysUntilCheckIn(
  checkIn: Date,
  now: Date = new Date()
): number {
  // Math.ceil keeps any fractional day over the threshold pending; cancellation
  // refund tier lookups deliberately use floor semantics instead.
  return Math.ceil(
    (checkIn.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
}

export function calculateBookingHoldDecision(input: {
  hasNonMembers: boolean;
  checkIn: Date;
  holdDays: number;
  now?: Date;
}): {
  daysUntilCheckIn: number;
  shouldBePending: boolean;
  status: BookingStatus;
} {
  const daysUntilCheckIn = calculateHoldDaysUntilCheckIn(input.checkIn, input.now);
  const shouldBePending = input.hasNonMembers && daysUntilCheckIn > input.holdDays;

  return {
    daysUntilCheckIn,
    shouldBePending,
    status: shouldBePending ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
  };
}

export function calculateBookingCreditApplication(input: {
  requestedCreditCents: number;
  creditBalanceCents: number;
  finalPriceCents: number;
  status: BookingStatus;
}): {
  creditAppliedCents: number;
  effectivePriceCents: number;
} {
  const { requestedCreditCents, creditBalanceCents, finalPriceCents, status } = input;
  if (requestedCreditCents <= 0 || status !== BookingStatus.PAYMENT_PENDING) {
    return {
      creditAppliedCents: 0,
      effectivePriceCents: finalPriceCents,
    };
  }

  if (requestedCreditCents > creditBalanceCents) {
    throw new Error(
      `Insufficient credit: ${creditBalanceCents} cents available, ${requestedCreditCents} requested`
    );
  }
  if (requestedCreditCents > finalPriceCents) {
    throw new Error(
      `Credit amount (${requestedCreditCents}) exceeds booking price (${finalPriceCents})`
    );
  }

  return {
    creditAppliedCents: requestedCreditCents,
    effectivePriceCents: finalPriceCents - requestedCreditCents,
  };
}

export function calculateCancellationPreview(input: {
  payment: {
    amountCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    creditAppliedCents?: number | null;
  };
  checkIn: Date;
  policyRules: CancellationRule[];
  now?: Date;
}): {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
} {
  const paidAmountCents =
    input.payment.amountCents - input.payment.refundedAmountCents;
  const changeFeeCents = input.payment.changeFeeCents;
  const refundableBaseCents = paidAmountCents - changeFeeCents;
  const days = daysUntilDate(input.checkIn, input.now);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(refundableBaseCents, days, input.policyRules);

  return {
    refundAmountCents: cardRefundAmountCents,
    keptAmountCents: paidAmountCents - cardRefundAmountCents,
    changeFeeCents,
    refundPercentage: cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
    creditRestoredCents: input.payment.creditAppliedCents || 0,
    totalPaidCents: paidAmountCents,
  };
}
