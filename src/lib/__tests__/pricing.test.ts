import { describe, it, expect } from "vitest"
import { format } from "date-fns"
import {
  getStayNights,
  findSeasonForDate,
  getNightlyRate,
  calculateBookingPrice,
  calculatePromoDiscount,
  formatCents,
  getSeasonYear,
  type SeasonRateData,
  type GuestInput,
  type PromoCodeInput,
} from "../pricing"

// --- Test fixtures ---

function makeSeason(overrides: Partial<SeasonRateData> = {}): SeasonRateData {
  return {
    seasonId: "season-winter-2026",
    startDate: new Date(2026, 5, 1),  // June 1
    endDate: new Date(2026, 8, 30),   // Sep 30
    rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
      { ageTier: "ADULT", isMember: false, pricePerNightCents: 6500 },
      { ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
      { ageTier: "YOUTH", isMember: false, pricePerNightCents: 4500 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 1500 },
      { ageTier: "CHILD", isMember: false, pricePerNightCents: 2500 },
    ],
    ...overrides,
  }
}

function makeSummerSeason(): SeasonRateData {
  return {
    seasonId: "season-summer-2026",
    startDate: new Date(2026, 10, 1),  // Nov 1
    endDate: new Date(2027, 2, 31),    // Mar 31
    rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
      { ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
      { ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
      { ageTier: "YOUTH", isMember: false, pricePerNightCents: 3500 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
      { ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
    ],
  }
}

const allSeasons: SeasonRateData[] = [makeSeason(), makeSummerSeason()]

// --- Tests ---

describe("getStayNights", () => {
  it("returns correct nights for a 3-night stay", () => {
    const nights = getStayNights(new Date("2026-07-10"), new Date("2026-07-13"))
    expect(nights).toHaveLength(3)
    expect(nights[0].toLocaleDateString("en-CA")).toBe("2026-07-10")
    expect(nights[1].toLocaleDateString("en-CA")).toBe("2026-07-11")
    expect(nights[2].toLocaleDateString("en-CA")).toBe("2026-07-12")
  })

  it("returns 1 night for consecutive dates", () => {
    const nights = getStayNights(new Date("2026-07-10"), new Date("2026-07-11"))
    expect(nights).toHaveLength(1)
  })

  it("returns 0 nights if checkIn equals checkOut", () => {
    const nights = getStayNights(new Date("2026-07-10"), new Date("2026-07-10"))
    expect(nights).toHaveLength(0)
  })

  it("handles month boundaries", () => {
    const nights = getStayNights(new Date("2026-07-30"), new Date("2026-08-02"))
    expect(nights).toHaveLength(3)
    expect(nights[0].toLocaleDateString("en-CA")).toBe("2026-07-30")
    expect(nights[1].toLocaleDateString("en-CA")).toBe("2026-07-31")
    expect(nights[2].toLocaleDateString("en-CA")).toBe("2026-08-01")
  })
})

describe("findSeasonForDate", () => {
  it("finds winter season for a July date", () => {
    const season = findSeasonForDate(new Date("2026-07-15"), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  it("finds summer season for a December date", () => {
    const season = findSeasonForDate(new Date("2026-12-15"), allSeasons)
    expect(season?.seasonId).toBe("season-summer-2026")
  })

  it("returns null for a date not in any season", () => {
    const season = findSeasonForDate(new Date("2026-10-15"), allSeasons)
    expect(season).toBeNull()
  })

  it("includes start date of season", () => {
    const season = findSeasonForDate(new Date(2026, 5, 1), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  it("includes end date of season", () => {
    const season = findSeasonForDate(new Date(2026, 8, 30), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  it("returns null for date in gap between seasons", () => {
    const season = findSeasonForDate(new Date("2026-10-15"), allSeasons)
    expect(season).toBeNull()
  })
})

describe("getNightlyRate", () => {
  it("returns adult member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "ADULT", true, allSeasons)
    expect(result?.priceCents).toBe(4500)
    expect(result?.seasonId).toBe("season-winter-2026")
  })

  it("returns adult non-member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "ADULT", false, allSeasons)
    expect(result?.priceCents).toBe(6500)
  })

  it("returns child member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "CHILD", true, allSeasons)
    expect(result?.priceCents).toBe(1500)
  })

  it("returns null for date outside season", () => {
    const result = getNightlyRate(new Date("2026-10-15"), "ADULT", true, allSeasons)
    expect(result).toBeNull()
  })
})

describe("calculateBookingPrice - single guest", () => {
  it("calculates 3-night adult member stay", () => {
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true }]
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-13"),
      guests,
      allSeasons
    )
    expect(result.totalPriceCents).toBe(4500 * 3) // $45/night x 3 nights
    expect(result.guests).toHaveLength(1)
    expect(result.guests[0].nights).toBe(3)
  })

  it("calculates youth non-member price", () => {
    const guests: GuestInput[] = [{ ageTier: "YOUTH", isMember: false }]
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      guests,
      allSeasons
    )
    expect(result.totalPriceCents).toBe(4500 * 2) // $45/night x 2 nights
  })

  it("throws error for date outside any season", () => {
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true }]
    expect(() =>
      calculateBookingPrice(
        new Date("2026-10-10"),
        new Date("2026-10-12"),
        guests,
        allSeasons
      )
    ).toThrow("No rate found")
  })
})

describe("calculateBookingPrice - multiple guests", () => {
  it("calculates total for multiple guests", () => {
    const guests: GuestInput[] = [
      { ageTier: "ADULT", isMember: true },
      { ageTier: "ADULT", isMember: false },
      { ageTier: "CHILD", isMember: true },
    ]

    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      guests,
      allSeasons
    )

    // 2 nights: adult member $45, adult non-member $65, child member $15
    // = (4500 + 6500 + 1500) * 2 = 25000
    expect(result.totalPriceCents).toBe(25000)
    expect(result.guests).toHaveLength(3)
    expect(result.guests[0].priceCents).toBe(9000)
    expect(result.guests[1].priceCents).toBe(13000)
    expect(result.guests[2].priceCents).toBe(3000)
  })

  it("handles single guest single night", () => {
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true }]
    const { totalPriceCents } = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-11"),
      guests,
      allSeasons
    )
    expect(totalPriceCents).toBe(4500)
  })
})

describe("calculatePromoDiscount", () => {
  // 2 nights: adult $45/night = $90, child $15/night = $30 = $120 total
  const totalPrice = 12000

  it("applies percentage discount", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 }
    const discount = calculatePromoDiscount(promo, totalPrice)
    expect(discount).toBe(2400) // 20% of $120 = $24
  })

  it("applies fixed amount discount", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 }
    const discount = calculatePromoDiscount(promo, totalPrice)
    expect(discount).toBe(5000) // $50 off
  })

  it("caps fixed amount at total price", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 99999 }
    const discount = calculatePromoDiscount(promo, totalPrice)
    expect(discount).toBe(12000) // capped at total
  })

  it("applies free nights discount - cheapest nights first", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 }
    const perNightRates = [1500, 1500, 4500, 4500]
    const discount = calculatePromoDiscount(promo, totalPrice, perNightRates)
    // 2 cheapest = 1500 + 1500 = 3000
    expect(discount).toBe(3000)
  })

  it("handles free nights exceeding total nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 100 }
    const perNightRates = [1500, 1500, 4500, 4500]
    const discount = calculatePromoDiscount(promo, totalPrice, perNightRates)
    // All 4 guest-nights free = 1500+1500+4500+4500 = 12000
    expect(discount).toBe(12000)
  })

  it("returns 0 for zero percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 }
    const discount = calculatePromoDiscount(promo, totalPrice)
    expect(discount).toBe(0)
  })

  it("returns 0 for null values", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null }
    const discount = calculatePromoDiscount(promo, totalPrice)
    expect(discount).toBe(0)
  })
})

describe("formatCents", () => {
  it("formats whole dollars", () => {
    expect(formatCents(4500)).toBe("$45.00")
  })

  it("formats cents", () => {
    expect(formatCents(4550)).toBe("$45.50")
  })

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00")
  })

  it("formats large amounts", () => {
    expect(formatCents(100000)).toBe("$1000.00")
  })
})

describe("getSeasonYear", () => {
  it("returns current year for April (month index 3)", () => {
    expect(getSeasonYear(new Date("2026-04-15"))).toBe(2026)
  })

  it("returns current year for December", () => {
    expect(getSeasonYear(new Date("2026-12-01"))).toBe(2026)
  })

  it("returns previous year for January", () => {
    expect(getSeasonYear(new Date("2026-01-15"))).toBe(2025)
  })

  it("returns previous year for March", () => {
    expect(getSeasonYear(new Date("2026-03-31"))).toBe(2025)
  })
})
