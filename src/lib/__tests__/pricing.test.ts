import { describe, it, expect } from "vitest"
import {
  getStayNights,
  findSeasonForDate,
  getNightlyRate,
  calculateGuestPrice,
  calculateBookingPrice,
  calculatePromoDiscount,
  calculateRefund,
  formatCents,
  getSeasonYear,
  type SeasonData,
  type GuestInput,
  type PromoCodeInput,
} from "../pricing"

// --- Test fixtures ---

function makeSeason(overrides: Partial<SeasonData> = {}): SeasonData {
  return {
    id: "season-winter-2026",
    name: "Winter 2026",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-09-30"),
    active: true,
    rates: [
      { seasonId: "season-winter-2026", ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
      { seasonId: "season-winter-2026", ageTier: "ADULT", isMember: false, pricePerNightCents: 6500 },
      { seasonId: "season-winter-2026", ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
      { seasonId: "season-winter-2026", ageTier: "YOUTH", isMember: false, pricePerNightCents: 4500 },
      { seasonId: "season-winter-2026", ageTier: "CHILD", isMember: true, pricePerNightCents: 1500 },
      { seasonId: "season-winter-2026", ageTier: "CHILD", isMember: false, pricePerNightCents: 2500 },
    ],
    ...overrides,
  }
}

function makeSummerSeason(): SeasonData {
  return {
    id: "season-summer-2026",
    name: "Summer 2026-27",
    startDate: new Date("2026-11-01"),
    endDate: new Date("2027-03-31"),
    active: true,
    rates: [
      { seasonId: "season-summer-2026", ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
      { seasonId: "season-summer-2026", ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
      { seasonId: "season-summer-2026", ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
      { seasonId: "season-summer-2026", ageTier: "YOUTH", isMember: false, pricePerNightCents: 3500 },
      { seasonId: "season-summer-2026", ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
      { seasonId: "season-summer-2026", ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
    ],
  }
}

const allSeasons: SeasonData[] = [makeSeason(), makeSummerSeason()]

// --- Tests ---

describe("getStayNights", () => {
  it("returns correct nights for a 3-night stay", () => {
    const nights = getStayNights(new Date("2026-07-10"), new Date("2026-07-13"))
    expect(nights).toHaveLength(3)
    expect(nights[0].toISOString().split("T")[0]).toBe("2026-07-10")
    expect(nights[1].toISOString().split("T")[0]).toBe("2026-07-11")
    expect(nights[2].toISOString().split("T")[0]).toBe("2026-07-12")
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
    expect(nights[0].toISOString().split("T")[0]).toBe("2026-07-30")
    expect(nights[1].toISOString().split("T")[0]).toBe("2026-07-31")
    expect(nights[2].toISOString().split("T")[0]).toBe("2026-08-01")
  })
})

describe("findSeasonForDate", () => {
  it("finds winter season for a July date", () => {
    const season = findSeasonForDate(new Date("2026-07-15"), allSeasons)
    expect(season?.id).toBe("season-winter-2026")
  })

  it("finds summer season for a December date", () => {
    const season = findSeasonForDate(new Date("2026-12-15"), allSeasons)
    expect(season?.id).toBe("season-summer-2026")
  })

  it("returns null for a date not in any season", () => {
    const season = findSeasonForDate(new Date("2026-10-15"), allSeasons)
    expect(season).toBeNull()
  })

  it("includes start date of season", () => {
    const season = findSeasonForDate(new Date("2026-06-01"), allSeasons)
    expect(season?.id).toBe("season-winter-2026")
  })

  it("includes end date of season", () => {
    const season = findSeasonForDate(new Date("2026-09-30"), allSeasons)
    expect(season?.id).toBe("season-winter-2026")
  })

  it("ignores inactive seasons", () => {
    const inactiveSeasons = [makeSeason({ active: false })]
    const season = findSeasonForDate(new Date("2026-07-15"), inactiveSeasons)
    expect(season).toBeNull()
  })
})

describe("getNightlyRate", () => {
  it("returns adult member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "ADULT", true, allSeasons)
    expect(result?.priceCents).toBe(4500)
    expect(result?.seasonName).toBe("Winter 2026")
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

describe("calculateGuestPrice", () => {
  it("calculates 3-night adult member stay", () => {
    const { totalCents, nightlyBreakdown } = calculateGuestPrice(
      new Date("2026-07-10"),
      new Date("2026-07-13"),
      "ADULT",
      true,
      allSeasons
    )
    expect(totalCents).toBe(4500 * 3) // $45/night x 3 nights
    expect(nightlyBreakdown).toHaveLength(3)
  })

  it("calculates youth non-member price", () => {
    const { totalCents } = calculateGuestPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      "YOUTH",
      false,
      allSeasons
    )
    expect(totalCents).toBe(4500 * 2) // $45/night x 2 nights
  })

  it("throws error for date outside any season", () => {
    expect(() =>
      calculateGuestPrice(
        new Date("2026-10-10"),
        new Date("2026-10-12"),
        "ADULT",
        true,
        allSeasons
      )
    ).toThrow("No rate found")
  })
})

describe("calculateBookingPrice", () => {
  it("calculates total for multiple guests", () => {
    const guests: GuestInput[] = [
      { ageTier: "ADULT", isMember: true },
      { ageTier: "ADULT", isMember: false },
      { ageTier: "CHILD", isMember: true },
    ]

    const { totalPriceCents, guestPrices } = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      guests,
      allSeasons
    )

    // 2 nights: adult member $45, adult non-member $65, child member $15
    // = (4500 + 6500 + 1500) * 2 = 25000
    expect(totalPriceCents).toBe(25000)
    expect(guestPrices).toHaveLength(3)
    expect(guestPrices[0].totalCents).toBe(9000)
    expect(guestPrices[1].totalCents).toBe(13000)
    expect(guestPrices[2].totalCents).toBe(3000)
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
  const guests: GuestInput[] = [
    { ageTier: "ADULT", isMember: true },
    { ageTier: "CHILD", isMember: true },
  ]
  // 2 nights: adult $45/night = $90, child $15/night = $30 = $120 total
  const totalPrice = 12000
  const checkIn = new Date("2026-07-10")
  const checkOut = new Date("2026-07-12")

  it("applies percentage discount", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    expect(discount).toBe(2400) // 20% of $120 = $24
  })

  it("applies fixed amount discount", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    expect(discount).toBe(5000) // $50 off
  })

  it("caps fixed amount at total price", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 99999 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    expect(discount).toBe(12000) // capped at total
  })

  it("applies free nights discount - cheapest nights first", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    // 4 guest-nights: [1500, 1500, 4500, 4500] sorted asc
    // 2 cheapest = 1500 + 1500 = 3000
    expect(discount).toBe(3000)
  })

  it("handles free nights exceeding total nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 100 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    // All 4 guest-nights free = 1500+1500+4500+4500 = 12000
    expect(discount).toBe(12000)
  })

  it("returns 0 for zero percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    expect(discount).toBe(0)
  })

  it("returns 0 for null values", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null }
    const discount = calculatePromoDiscount(
      promo, totalPrice, checkIn, checkOut, guests, allSeasons
    )
    expect(discount).toBe(0)
  })
})

describe("calculateRefund", () => {
  const defaultPolicy = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ]

  it("full refund when cancelling 14+ days before", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-07-15"),
      defaultPolicy
    )
    expect(refund).toBe(10000) // 17 days before -> 100%
  })

  it("full refund when cancelling exactly 14 days before", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-07-18"),
      defaultPolicy
    )
    expect(refund).toBe(10000) // exactly 14 days -> 100%
  })

  it("50% refund when cancelling 7-13 days before", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-07-20"),
      defaultPolicy
    )
    expect(refund).toBe(5000) // 12 days before -> 50%
  })

  it("50% refund when cancelling exactly 7 days before", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-07-25"),
      defaultPolicy
    )
    expect(refund).toBe(5000) // 7 days -> 50%
  })

  it("no refund when cancelling less than 7 days before", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-07-28"),
      defaultPolicy
    )
    expect(refund).toBe(0) // 4 days -> 0%
  })

  it("no refund on day of check-in", () => {
    const refund = calculateRefund(
      10000,
      new Date("2026-08-01"),
      new Date("2026-08-01"),
      defaultPolicy
    )
    expect(refund).toBe(0) // 0 days -> 0%
  })

  it("handles odd amounts with rounding", () => {
    const refund = calculateRefund(
      9999,
      new Date("2026-08-01"),
      new Date("2026-07-20"),
      defaultPolicy
    )
    expect(refund).toBe(5000) // Math.round(9999 * 50 / 100) = 5000
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
