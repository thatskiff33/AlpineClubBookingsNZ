import { AgeTier } from "@prisma/client";
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
 * Calculate the total price for a booking.
 * Guests stay from checkIn night to checkOut-1 night.
 */
export function calculateBookingPrice(
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonRateData[]
): PriceBreakdown {
  const nights = eachDayOfInterval({
    start: checkIn,
    end: subDays(checkOut, 1),
  });

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
 * Apply a promo code discount to a total price.
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
