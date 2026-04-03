import { AgeTier, PromoType } from "@prisma/client"

export interface SeasonRateData {
  seasonId: string
  ageTier: AgeTier
  isMember: boolean
  pricePerNightCents: number
}

export interface SeasonData {
  id: string
  name: string
  startDate: Date
  endDate: Date
  active: boolean
  rates: SeasonRateData[]
}

export interface GuestInput {
  ageTier: AgeTier
  isMember: boolean
}

export interface PromoCodeInput {
  type: PromoType
  valueCents?: number | null
  percentOff?: number | null
  freeNights?: number | null
}

export interface NightRate {
  date: Date
  seasonId: string
  seasonName: string
  rates: Map<string, number> // key: `${ageTier}-${isMember}` -> cents
}

/**
 * Get the rate key for looking up a guest's price
 */
export function getRateKey(ageTier: AgeTier, isMember: boolean): string {
  return `${ageTier}-${isMember}`
}

/**
 * Generate an array of dates for each night of a stay.
 * A stay from checkIn to checkOut charges for each night FROM checkIn UP TO (not including) checkOut.
 */
export function getStayNights(checkIn: Date, checkOut: Date): Date[] {
  const nights: Date[] = []
  const current = new Date(checkIn)
  const end = new Date(checkOut)

  // Normalize to date-only (strip time)
  current.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)

  while (current < end) {
    nights.push(new Date(current))
    current.setDate(current.getDate() + 1)
  }

  return nights
}

/**
 * Find the season that contains a given date.
 * Returns null if no season covers that date.
 */
export function findSeasonForDate(
  date: Date,
  seasons: SeasonData[]
): SeasonData | null {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)

  for (const season of seasons) {
    const start = new Date(season.startDate)
    const end = new Date(season.endDate)
    start.setHours(0, 0, 0, 0)
    end.setHours(0, 0, 0, 0)

    if (d >= start && d <= end && season.active) {
      return season
    }
  }

  return null
}

/**
 * Get the nightly rate for a specific guest on a specific date.
 * Returns the price in cents, or null if no rate is found.
 */
export function getNightlyRate(
  date: Date,
  ageTier: AgeTier,
  isMember: boolean,
  seasons: SeasonData[]
): { priceCents: number; seasonId: string; seasonName: string } | null {
  const season = findSeasonForDate(date, seasons)
  if (!season) return null

  const rate = season.rates.find(
    (r) => r.ageTier === ageTier && r.isMember === isMember
  )
  if (!rate) return null

  return {
    priceCents: rate.pricePerNightCents,
    seasonId: season.id,
    seasonName: season.name,
  }
}

/**
 * Calculate the total price for a single guest across all nights of a stay.
 */
export function calculateGuestPrice(
  checkIn: Date,
  checkOut: Date,
  ageTier: AgeTier,
  isMember: boolean,
  seasons: SeasonData[]
): { totalCents: number; nightlyBreakdown: { date: Date; priceCents: number; seasonName: string }[] } {
  const nights = getStayNights(checkIn, checkOut)
  const breakdown: { date: Date; priceCents: number; seasonName: string }[] = []
  let totalCents = 0

  for (const night of nights) {
    const rate = getNightlyRate(night, ageTier, isMember, seasons)
    if (!rate) {
      throw new Error(
        `No rate found for ${ageTier} ${isMember ? "member" : "non-member"} on ${night.toISOString().split("T")[0]}`
      )
    }
    breakdown.push({
      date: night,
      priceCents: rate.priceCents,
      seasonName: rate.seasonName,
    })
    totalCents += rate.priceCents
  }

  return { totalCents, nightlyBreakdown: breakdown }
}

/**
 * Calculate the total price for all guests in a booking.
 */
export function calculateBookingPrice(
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonData[]
): {
  totalPriceCents: number
  guestPrices: { guest: GuestInput; totalCents: number }[]
} {
  const guestPrices: { guest: GuestInput; totalCents: number }[] = []
  let totalPriceCents = 0

  for (const guest of guests) {
    const { totalCents } = calculateGuestPrice(
      checkIn,
      checkOut,
      guest.ageTier,
      guest.isMember,
      seasons
    )
    guestPrices.push({ guest, totalCents })
    totalPriceCents += totalCents
  }

  return { totalPriceCents, guestPrices }
}

/**
 * Apply a promo code discount to a booking total.
 * Returns the discount amount in cents.
 */
export function calculatePromoDiscount(
  promo: PromoCodeInput,
  totalPriceCents: number,
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonData[]
): number {
  switch (promo.type) {
    case "PERCENTAGE": {
      if (!promo.percentOff) return 0
      return Math.round((totalPriceCents * promo.percentOff) / 100)
    }

    case "FIXED_AMOUNT": {
      if (!promo.valueCents) return 0
      // Discount cannot exceed total
      return Math.min(promo.valueCents, totalPriceCents)
    }

    case "FREE_NIGHTS": {
      if (!promo.freeNights || promo.freeNights <= 0) return 0

      // Find the cheapest N nights across all guests and subtract them
      const allNightPrices: number[] = []

      for (const guest of guests) {
        const { nightlyBreakdown } = calculateGuestPrice(
          checkIn,
          checkOut,
          guest.ageTier,
          guest.isMember,
          seasons
        )
        for (const night of nightlyBreakdown) {
          allNightPrices.push(night.priceCents)
        }
      }

      // Sort ascending to find cheapest nights
      allNightPrices.sort((a, b) => a - b)

      // Sum the cheapest N nights
      const freeCount = Math.min(promo.freeNights, allNightPrices.length)
      let discount = 0
      for (let i = 0; i < freeCount; i++) {
        discount += allNightPrices[i]
      }

      return discount
    }

    default:
      return 0
  }
}

/**
 * Calculate the refund amount based on cancellation policy.
 * Policy rules are sorted by daysBeforeStay DESC.
 * Find the first rule where daysBeforeStay <= actual days before stay.
 */
export function calculateRefund(
  paidAmountCents: number,
  checkIn: Date,
  cancellationDate: Date,
  policyRules: { daysBeforeStay: number; refundPercentage: number }[]
): number {
  const checkInDate = new Date(checkIn)
  const cancelDate = new Date(cancellationDate)
  checkInDate.setHours(0, 0, 0, 0)
  cancelDate.setHours(0, 0, 0, 0)

  const diffMs = checkInDate.getTime() - cancelDate.getTime()
  const daysBeforeStay = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  // Sort rules by days descending
  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  )

  // Find the applicable rule (first rule where our days >= rule's days threshold)
  for (const rule of sortedRules) {
    if (daysBeforeStay >= rule.daysBeforeStay) {
      return Math.round((paidAmountCents * rule.refundPercentage) / 100)
    }
  }

  // If no rule matches (shouldn't happen if policy includes 0 days), no refund
  return 0
}

/**
 * Format cents to display as dollars (e.g., 4550 -> "$45.50")
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Get the current season year based on the April-March cycle.
 * If current month >= April, seasonYear = currentYear; else currentYear - 1
 */
export function getSeasonYear(date: Date = new Date()): number {
  const month = date.getMonth() // 0-indexed (0=Jan, 3=April)
  const year = date.getFullYear()
  return month >= 3 ? year : year - 1
}
