import type { AgeTier, FixedNightlyMode, PromoCodeType, SeasonType } from "@prisma/client";
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
  freeNightsPerIndividual?: number | null;
  fixedNightlyPriceCents?: number | null;
  fixedNightlyMode?: FixedNightlyMode | null;
  maxGuestsPerBooking?: number | null;
  maxNightlyValueCents?: number | null;
  memberGuestsOnly?: boolean | null;
}

export interface PromoDiscountGuest {
  memberId: string | null;
  isMember: boolean;
  perNightRates: number[];
}

export interface CalculatePromoDiscountOptions {
  totalPriceCents: number;
  guests: PromoDiscountGuest[];
  // For FREE_NIGHTS: how many free nights remain in the booker's lifetime
  // budget for this code (already-consumed nights subtracted). When undefined,
  // no cap is applied beyond freeNightsPerIndividual.
  remainingFreeNights?: number;
  // For beneficiary-scoped FREE_NIGHTS promos: remaining free nights by member.
  remainingFreeNightsByMemberId?: Record<string, number>;
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
  priceAdjustmentCents: number;
  freeNightsUsed: number;
  eligibleGuestCount: number;
  allocations: PromoDiscountAllocation[];
}

export interface PromoDiscountAllocation {
  memberId: string;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}

export function selectPromoDiscountGuests(
  promo: PromoCodeInput,
  guests: PromoDiscountGuest[],
) {
  const eligibleAll = promo.memberGuestsOnly
    ? guests.filter((g) => g.isMember)
    : guests;

  const withTotals = eligibleAll.map((g, idx) => ({
    guest: g,
    idx,
    total: g.perNightRates.reduce((sum, r) => sum + r, 0),
  }));
  withTotals.sort((a, b) => b.total - a.total);
  const guestCap = promo.maxGuestsPerBooking ?? withTotals.length;
  return withTotals.slice(0, Math.max(0, guestCap));
}

function addPromoAllocation(
  allocations: Map<string, PromoDiscountAllocation>,
  memberId: string | null,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed: number,
  includeWhenZero = false,
) {
  if (
    !memberId ||
    (discountCents <= 0 && freeNightsUsed <= 0 && priceAdjustmentCents === 0 && !includeWhenZero)
  ) return;

  const existing = allocations.get(memberId);
  if (existing) {
    existing.discountCents += discountCents;
    existing.priceAdjustmentCents += priceAdjustmentCents;
    existing.freeNightsUsed += freeNightsUsed;
    return;
  }

  allocations.set(memberId, {
    memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed,
  });
}

/**
 * Apply a promo code discount to a booking. All promo types are applied
 * per eligible guest.
 *
 * Eligibility:
 *   - If promo.memberGuestsOnly is true, only guests with isMember=true count.
 *   - Eligible guests are then sorted by total stay cost descending.
 *   - If promo.maxGuestsPerBooking is set, only the top N count.
 *
 * Per-type behaviour applied to each selected guest:
 *   - PERCENTAGE: percentOff% off each of the guest's nights. If
 *     maxNightlyValueCents is set, the discount per night is capped at it.
 *   - FIXED_AMOUNT: valueCents off each selected guest, capped at the
 *     guest's stay total.
 *   - FREE_NIGHTS: discount the guest's most expensive freeNightsPerIndividual
 *     nights. The lifetime cap (remainingFreeNights) is a single pool the
 *     booker draws on across selected guests, applied to the most expensive
 *     nights first. maxNightlyValueCents (if set) caps each freed night,
 *     turning full coverage into a partial subsidy.
 */
export function calculatePromoDiscount(
  promo: PromoCodeInput,
  opts: CalculatePromoDiscountOptions,
): PromoDiscountResult {
  const {
    totalPriceCents,
    guests,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
  } = opts;
  const empty: PromoDiscountResult = {
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  };

  const selected = selectPromoDiscountGuests(promo, guests);
  if (selected.length === 0) return empty;

  switch (promo.type) {
    case "PERCENTAGE": {
      const pct = promo.percentOff ?? 0;
      if (pct <= 0) return empty;
      let discount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (const { guest } of selected) {
        let guestDiscount = 0;
        for (const rate of guest.perNightRates) {
          const raw = Math.round((rate * pct) / 100);
          const capped = promo.maxNightlyValueCents != null
            ? Math.min(raw, promo.maxNightlyValueCents)
            : raw;
          guestDiscount += capped;
        }
        discount += guestDiscount;
        addPromoAllocation(allocations, guest.memberId, guestDiscount, -guestDiscount, 0);
      }
      // Cap at total booking price as a safety rail.
      const discountCents = Math.min(discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed: 0,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FIXED_AMOUNT": {
      const perGuest = promo.valueCents ?? 0;
      if (perGuest <= 0) return empty;
      let discount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (const { guest } of selected) {
        const guestTotal = guest.perNightRates.reduce((s, r) => s + r, 0);
        const guestDiscount = Math.min(perGuest, guestTotal);
        discount += guestDiscount;
        addPromoAllocation(allocations, guest.memberId, guestDiscount, -guestDiscount, 0);
      }
      const discountCents = Math.min(discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed: 0,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FREE_NIGHTS": {
      const perIndividual = promo.freeNightsPerIndividual ?? 0;
      if (perIndividual <= 0) return empty;

      // Apply the lifetime cap as a single pool the booker draws on across
      // selected guests, allocated to the most expensive remaining nights.
      const lifetimeCap = remainingFreeNights !== undefined
        ? Math.max(0, remainingFreeNights)
        : Number.POSITIVE_INFINITY;
      if (!remainingFreeNightsByMemberId && lifetimeCap <= 0) return empty;

      // Collect candidate nights from each selected guest: each guest contributes
      // up to perIndividual of their most expensive nights.
      const candidates: { rate: number; memberId: string | null }[] = [];
      for (const { guest } of selected) {
        const sortedDesc = [...guest.perNightRates].sort((a, b) => b - a);
        for (const rate of sortedDesc.slice(0, perIndividual)) {
          candidates.push({ rate, memberId: guest.memberId });
        }
      }
      if (candidates.length === 0) return empty;

      // Of those candidates, pick the most expensive up to the lifetime cap.
      candidates.sort((a, b) => b.rate - a.rate);
      const usedCount = remainingFreeNightsByMemberId
        ? candidates.length
        : Math.min(candidates.length, Math.floor(Math.min(lifetimeCap, candidates.length)));
      let discount = 0;
      let freeNightsUsed = 0;
      const usedByMemberId = new Map<string, number>();
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (let i = 0; i < usedCount; i++) {
        const { rate, memberId } = candidates[i];

        if (remainingFreeNightsByMemberId) {
          if (!memberId) continue;
          const memberCap = Math.max(
            0,
            Math.floor(remainingFreeNightsByMemberId[memberId] ?? perIndividual)
          );
          const memberUsed = usedByMemberId.get(memberId) ?? 0;
          if (memberUsed >= memberCap) continue;
          usedByMemberId.set(memberId, memberUsed + 1);
        }

        const capped = promo.maxNightlyValueCents != null
          ? Math.min(rate, promo.maxNightlyValueCents)
          : rate;
        discount += capped;
        freeNightsUsed += 1;
        addPromoAllocation(allocations, memberId, capped, -capped, 1);
      }
      const discountCents = Math.min(discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FIXED_NIGHTLY_PRICE": {
      const fixedNightlyPriceCents = promo.fixedNightlyPriceCents ?? 0;
      if (fixedNightlyPriceCents <= 0) return empty;

      const mode = promo.fixedNightlyMode ?? "CAP_ONLY";
      let totalAdjustment = 0;
      let effectiveGuestCount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();

      for (const { guest } of selected) {
        let guestAdjustment = 0;
        let cappedNightCount = 0;

        for (const rate of guest.perNightRates) {
          if (mode === "CAP_ONLY") {
            if (rate <= fixedNightlyPriceCents) continue;
            guestAdjustment += fixedNightlyPriceCents - rate;
            cappedNightCount += 1;
          } else {
            guestAdjustment += fixedNightlyPriceCents - rate;
          }
        }

        const countsAsBeneficiary =
          mode === "SET_PRICE"
            ? guest.perNightRates.length > 0
            : cappedNightCount > 0;
        if (!countsAsBeneficiary) continue;

        totalAdjustment += guestAdjustment;
        effectiveGuestCount += 1;
        addPromoAllocation(
          allocations,
          guest.memberId,
          Math.max(0, -guestAdjustment),
          guestAdjustment,
          0,
          mode === "SET_PRICE"
        );
      }

      return {
        discountCents: Math.max(0, -totalAdjustment),
        priceAdjustmentCents: totalAdjustment,
        freeNightsUsed: 0,
        eligibleGuestCount: effectiveGuestCount,
        allocations: [...allocations.values()],
      };
    }

    default:
      return empty;
  }
}
