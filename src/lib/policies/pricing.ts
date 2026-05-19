import type { AgeTier, PromoCodeType, SeasonType } from "@prisma/client";
import { APP_TIME_ZONE } from "@/config/operational";
import { addDaysDateOnly, formatDateOnly, parseDateOnly } from "../date-only";

export interface SeasonRateData {
  seasonId: string;
  startDate: Date;
  endDate: Date;
  type?: SeasonType;
  rates: {
    ageTier: AgeTier;
    isMember: boolean;
    pricePerNightCents: number;
  }[];
}

export interface GroupDiscountConfig {
  minGroupSize: number;
  summerOnly: boolean;
  enabled: boolean;
}

export interface GuestInput {
  ageTier: AgeTier;
  isMember: boolean;
}

export interface PriceBreakdown {
  guests: {
    ageTier: AgeTier;
    isMember: boolean;
    nights: number;
    priceCents: number;
    perNightCents: number[];
  }[];
  totalPriceCents: number;
}

export interface PromoCodeInput {
  type: PromoCodeType;
  valueCents?: number | null;
  percentOff?: number | null;
  freeNights?: number | null;
}

function getDateOnlyStringForTimeZone(date: Date, timeZone = APP_TIME_ZONE): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive booking date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function normalizeBookingDate(date: Date): Date {
  const normalized = parseDateOnly(getDateOnlyStringForTimeZone(date));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid booking date: ${date.toISOString()}`);
  }

  return normalized;
}

function getBookingDateKey(date: Date): string {
  return formatDateOnly(normalizeBookingDate(date));
}

/**
 * Generate an array of dates for each night of a stay.
 * A stay from checkIn to checkOut charges for each night FROM checkIn UP TO (not including) checkOut.
 */
export function getStayNights(checkIn: Date, checkOut: Date): Date[] {
  const start = normalizeBookingDate(checkIn);
  const exclusiveEnd = normalizeBookingDate(checkOut);

  if (exclusiveEnd <= start) return [];

  const nights: Date[] = [];
  for (let current = start; current < exclusiveEnd; current = addDaysDateOnly(current, 1)) {
    nights.push(current);
  }

  return nights;
}

/**
 * Find the rate for a specific night, guest tier, and membership status.
 */
export function findRateForNight(
  date: Date,
  ageTier: AgeTier,
  isMember: boolean,
  seasons: SeasonRateData[]
): number | null {
  const dateKey = getBookingDateKey(date);

  for (const season of seasons) {
    const startKey = getBookingDateKey(season.startDate);
    const endKey = getBookingDateKey(season.endDate);
    if (dateKey >= startKey && dateKey <= endKey) {
      const rate = season.rates.find(
        (r) => r.ageTier === ageTier && r.isMember === isMember
      );
      return rate ? rate.pricePerNightCents : null;
    }
  }
  return null;
}

/**
 * Find the season that contains a given date.
 * Returns null if no season covers that date.
 */
export function findSeasonForDate(
  date: Date,
  seasons: SeasonRateData[]
): SeasonRateData | null {
  const dateKey = getBookingDateKey(date);

  for (const season of seasons) {
    const startKey = getBookingDateKey(season.startDate);
    const endKey = getBookingDateKey(season.endDate);
    if (dateKey >= startKey && dateKey <= endKey) {
      return season;
    }
  }
  return null;
}

/**
 * Get the nightly rate for a specific guest on a specific date.
 * Returns the price in cents, or null if no rate is found.
 */
export function getNightlyRate(
  date: Date,
  ageTier: AgeTier,
  isMember: boolean,
  seasons: SeasonRateData[]
): { priceCents: number; seasonId: string } | null {
  const season = findSeasonForDate(date, seasons);
  if (!season) return null;

  const rate = season.rates.find(
    (r) => r.ageTier === ageTier && r.isMember === isMember
  );
  if (!rate) return null;

  return {
    priceCents: rate.pricePerNightCents,
    seasonId: season.seasonId,
  };
}

/**
 * Check if a group discount applies for a given night.
 * Returns true if the group discount should override isMember to true.
 */
export function isGroupDiscountApplicable(
  guestCount: number,
  night: Date,
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): boolean {
  if (!groupDiscount || !groupDiscount.enabled) return false;
  if (guestCount < groupDiscount.minGroupSize) return false;
  if (!groupDiscount.summerOnly) return true;

  const season = findSeasonForDate(night, seasons);
  return season?.type === "SUMMER";
}

export function isGroupDiscountAppliedToStay(
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): boolean {
  return getStayNights(checkIn, checkOut).some((night) =>
    isGroupDiscountApplicable(guestCount, night, seasons, groupDiscount)
  );
}

/**
 * Calculate the total price for a booking.
 * Guests stay from checkIn night to checkOut-1 night.
 */
export function calculateBookingPrice(
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): PriceBreakdown {
  const nights = getStayNights(checkIn, checkOut);

  const guestBreakdowns = guests.map((guest) => {
    const perNightCents: number[] = [];
    let guestTotal = 0;

    for (const night of nights) {
      // Group discount: if applicable, treat all guests as members for rate lookup
      const effectiveIsMember =
        guest.isMember ||
        isGroupDiscountApplicable(guests.length, night, seasons, groupDiscount);

      const rate = findRateForNight(night, guest.ageTier, effectiveIsMember, seasons);
      if (rate === null) {
        throw new Error(
          `No rate found for ${guest.ageTier} (member: ${guest.isMember}) on ${formatDateOnly(night)}`
        );
      }
      perNightCents.push(rate);
      guestTotal += rate;
    }

    return {
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      nights: nights.length,
      priceCents: guestTotal,
      perNightCents,
    };
  });

  const totalPriceCents = guestBreakdowns.reduce((sum, g) => sum + g.priceCents, 0);

  return {
    guests: guestBreakdowns,
    totalPriceCents,
  };
}

export interface PromoDiscountResult {
  discountCents: number;
  freeNightsUsed: number;
}

/**
 * Apply a promo code discount to a booking total.
 * Returns the discount amount in cents and the number of free nights used.
 * For FREE_NIGHTS promos, remainingFreeNights caps how many nights can be
 * discounted (supports cumulative tracking across multiple bookings).
 */
export function calculatePromoDiscount(
  promo: PromoCodeInput,
  totalPriceCents: number,
  perNightRates?: number[],
  remainingFreeNights?: number
): PromoDiscountResult {
  switch (promo.type) {
    case "PERCENTAGE": {
      if (!promo.percentOff) return { discountCents: 0, freeNightsUsed: 0 };
      return { discountCents: Math.round((totalPriceCents * promo.percentOff) / 100), freeNightsUsed: 0 };
    }

    case "FIXED_AMOUNT": {
      if (!promo.valueCents) return { discountCents: 0, freeNightsUsed: 0 };
      return { discountCents: Math.min(promo.valueCents, totalPriceCents), freeNightsUsed: 0 };
    }

    case "FREE_NIGHTS": {
      if (!promo.freeNights || promo.freeNights <= 0) return { discountCents: 0, freeNightsUsed: 0 };
      if (!perNightRates) return { discountCents: 0, freeNightsUsed: 0 };

      // Cap by remaining allowance if provided (cumulative tracking)
      const effectiveFreeNights = remainingFreeNights !== undefined
        ? Math.min(promo.freeNights, remainingFreeNights)
        : promo.freeNights;

      if (effectiveFreeNights <= 0) return { discountCents: 0, freeNightsUsed: 0 };

      // Sort ascending to find cheapest nights
      const sorted = [...perNightRates].sort((a, b) => a - b);
      const freeCount = Math.min(effectiveFreeNights, sorted.length);
      const discountCents = sorted.slice(0, freeCount).reduce((sum, r) => sum + r, 0);
      return { discountCents, freeNightsUsed: freeCount };
    }

    default:
      return { discountCents: 0, freeNightsUsed: 0 };
  }
}

/**
 * Apply a promo code discount (simplified interface used by Phase 3 booking code).
 */
export function applyPromoDiscount(
  totalPriceCents: number,
  promoType: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS",
  promoValue: { percentOff?: number; valueCents?: number; freeNights?: number },
  perNightRates?: number[],
  remainingFreeNights?: number
): number {
  switch (promoType) {
    case "PERCENTAGE": {
      const percent = promoValue.percentOff ?? 0;
      return Math.round(totalPriceCents * (percent / 100));
    }
    case "FIXED_AMOUNT": {
      const fixed = promoValue.valueCents ?? 0;
      return Math.min(fixed, totalPriceCents);
    }
    case "FREE_NIGHTS": {
      if (!perNightRates || !promoValue.freeNights) return 0;
      const effectiveFreeNights = remainingFreeNights !== undefined
        ? Math.min(promoValue.freeNights, remainingFreeNights)
        : promoValue.freeNights;
      if (effectiveFreeNights <= 0) return 0;
      const sorted = [...perNightRates].sort((a, b) => a - b);
      const freeCount = Math.min(effectiveFreeNights, sorted.length);
      return sorted.slice(0, freeCount).reduce((sum, r) => sum + r, 0);
    }
    default:
      return 0;
  }
}
