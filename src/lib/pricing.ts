import { AgeTier, PromoCodeType } from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";

export interface SeasonRateData {
  seasonId: string;
  startDate: Date;
  endDate: Date;
  rates: {
    ageTier: AgeTier;
    isMember: boolean;
    pricePerNightCents: number;
  }[];
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

/**
 * Generate an array of dates for each night of a stay.
 * A stay from checkIn to checkOut charges for each night FROM checkIn UP TO (not including) checkOut.
 */
export function getStayNights(checkIn: Date, checkOut: Date): Date[] {
  const lastNight = subDays(checkOut, 1);
  if (lastNight < checkIn) return [];
  return eachDayOfInterval({
    start: checkIn,
    end: lastNight,
  });
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
  const dateTime = date.getTime();

  for (const season of seasons) {
    const start = season.startDate.getTime();
    const end = season.endDate.getTime();
    if (dateTime >= start && dateTime <= end) {
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
  const dateTime = date.getTime();

  for (const season of seasons) {
    const start = season.startDate.getTime();
    const end = season.endDate.getTime();
    if (dateTime >= start && dateTime <= end) {
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
 * Calculate the total price for a booking.
 * Guests stay from checkIn night to checkOut-1 night.
 */
export function calculateBookingPrice(
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonRateData[]
): PriceBreakdown {
  const nights = getStayNights(checkIn, checkOut);

  const guestBreakdowns = guests.map((guest) => {
    const perNightCents: number[] = [];
    let guestTotal = 0;

    for (const night of nights) {
      const rate = findRateForNight(night, guest.ageTier, guest.isMember, seasons);
      if (rate === null) {
        throw new Error(
          `No rate found for ${guest.ageTier} (member: ${guest.isMember}) on ${night.toISOString().split("T")[0]}`
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

/**
 * Apply a promo code discount to a booking total.
 * Returns the discount amount in cents.
 */
export function calculatePromoDiscount(
  promo: PromoCodeInput,
  totalPriceCents: number,
  perNightRates?: number[]
): number {
  switch (promo.type) {
    case "PERCENTAGE": {
      if (!promo.percentOff) return 0;
      return Math.round((totalPriceCents * promo.percentOff) / 100);
    }

    case "FIXED_AMOUNT": {
      if (!promo.valueCents) return 0;
      return Math.min(promo.valueCents, totalPriceCents);
    }

    case "FREE_NIGHTS": {
      if (!promo.freeNights || promo.freeNights <= 0) return 0;
      if (!perNightRates) return 0;

      // Sort ascending to find cheapest nights
      const sorted = [...perNightRates].sort((a, b) => a - b);
      const freeCount = Math.min(promo.freeNights, sorted.length);
      return sorted.slice(0, freeCount).reduce((sum, r) => sum + r, 0);
    }

    default:
      return 0;
  }
}

/**
 * Apply a promo code discount (simplified interface used by Phase 3 booking code).
 */
export function applyPromoDiscount(
  totalPriceCents: number,
  promoType: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS",
  promoValue: { percentOff?: number; valueCents?: number; freeNights?: number },
  perNightRates?: number[]
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
      const sorted = [...perNightRates].sort((a, b) => a - b);
      const freeCount = Math.min(promoValue.freeNights, sorted.length);
      return sorted.slice(0, freeCount).reduce((sum, r) => sum + r, 0);
    }
    default:
      return 0;
  }
}

// Re-export from canonical locations for backwards compatibility
export { formatCents, getSeasonYear } from "./utils";
