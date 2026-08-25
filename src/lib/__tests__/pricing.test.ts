import { describe, it, expect } from "vitest"
import {
  getStayNights,
  findSeasonForDate,
  getNightlyRate,
  calculateBookingPrice,
  calculatePromoDiscount,
  formatCents,
  type SeasonRateData,
  type GuestInput,
  type PromoCodeInput,
} from "../pricing"
import { formatDateOnly } from "../date-only"
import { seasonYearOfStoredDate } from "../financial-year"

// --- Test fixtures ---
// Rates are keyed by membership type (#1930, E4): old member rows map to
// MEMBER_TYPE, non-member rows to NONMEMBER_TYPE.
const MEMBER_TYPE = "type-member"
const NONMEMBER_TYPE = "type-nonmember"

function makeSeason(overrides: Partial<SeasonRateData> = {}): SeasonRateData {
  return {
    seasonId: "season-winter-2026",
    startDate: new Date("2026-06-01"),  // June 1
    endDate: new Date("2026-09-30"),   // Sep 30
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 6500 },
      { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3000 },
      { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 4500 },
      { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1500 },
      { ageTier: "CHILD", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 2500 },
    ],
    ...overrides,
  }
}

function makeSummerSeason(): SeasonRateData {
  return {
    seasonId: "season-summer-2026",
    startDate: new Date("2026-11-01"),  // Nov 1
    endDate: new Date("2027-03-31"),    // Mar 31
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3500 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5000 },
      { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 2500 },
      { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 3500 },
      { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1000 },
      { ageTier: "CHILD", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 2000 },
    ],
  }
}

const allSeasons: SeasonRateData[] = [makeSeason(), makeSummerSeason()]

// --- Tests ---

describe("getStayNights", () => {
  // `formatDateOnly`, not `toLocaleDateString`, throughout this describe. A
  // stay night is a calendar day encoded at UTC midnight, and reading it in the
  // HOST's zone is the very thing this lane removed from the engine
  // (`INV-DATE-013`: the correct reading of a UTC-midnight column is UTC getters
  // or `formatDateOnly`). These six assertions were `toLocaleDateString("en-CA")`
  // and failed on any host behind Greenwich, five lines above the fixtures this
  // lane rewrote for the same reason.
  it("returns correct nights for a 3-night stay", () => {
    const nights = getStayNights(new Date("2026-07-10"), new Date("2026-07-13"))
    expect(nights).toHaveLength(3)
    expect(formatDateOnly(nights[0])).toBe("2026-07-10")
    expect(formatDateOnly(nights[1])).toBe("2026-07-11")
    expect(formatDateOnly(nights[2])).toBe("2026-07-12")
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
    expect(formatDateOnly(nights[0])).toBe("2026-07-30")
    expect(formatDateOnly(nights[1])).toBe("2026-07-31")
    expect(formatDateOnly(nights[2])).toBe("2026-08-01")
  })
})

describe("findSeasonForDate", () => {
  it("finds winter season for a July date", () => {
    const season = findSeasonForDate(new Date("2026-07-15"), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  /*
    WHAT THIS USED TO PIN, AND WHY IT WAS BACKWARDS (CT-4, #2870, group F2).

    It was called "matches a season start date for browser-submitted NZ local
    dates" and handed `findSeasonForDate` the INSTANT `2026-07-03T12:00:00.000Z`
    — NZ-local midnight on 4 July — expecting a season starting 4 July to match.
    The only reason it passed is the defect this lane removed: the engine
    projected every date through `APP_TIME_ZONE`, so an instant half a day before
    the stored season edge was read as being on it.

    There is no such caller, and the reason is worth stating precisely rather
    than sweepingly. The envelope fields are validated: `checkIn`/`checkOut` are
    `dateOnlyString.transform(parseDateOnly)` in the create and quote routes, and
    a bare `parseDateOnly` plus a NaN guard in modify-quote. The per-guest
    `nights` arrays are NOT all validated — only `bookings/route.ts` uses
    `z.array(dateOnlyString)`; `bookings/quote`, `bookings/[id]/modify` and
    `bookings/[id]/modify-quote` accept `z.array(z.string())`. What closes it is
    the CONVERTER rather than the schema: `parseDateOnly` returns UTC midnight or
    an Invalid Date, and `normalizeBookingDate` refuses both an Invalid Date and
    any value carrying a UTC time of day. So an instant cannot arrive here from
    outside, and the test was pinning a compensation for an input shape the
    product cannot produce.

    So it now asserts the real rule: a season edge is a stored calendar day, and
    the day that matches it is that same stored day. Read in UTC, which
    `INV-DATE-019`'s first exact boundary blesses by name for a `@db.Date` value
    ("truncating an existing `@db.Date` value the same way is fine") and
    `INV-DATE-026` establishes the columns for. NOT `INV-DATE-010`, which this
    comment used to cite for the inverse of what it says.
  */
  it("matches a season start date by the stored calendar day, not a projection", () => {
    const boundarySeason = makeSeason({
      startDate: new Date("2026-07-04T00:00:00.000Z"),
      endDate: new Date("2026-09-30T00:00:00.000Z"),
    })

    expect(
      findSeasonForDate(new Date("2026-07-04T00:00:00.000Z"), [boundarySeason])
        ?.seasonId
    ).toBe("season-winter-2026")

    // The day BEFORE the edge is outside the season on every host and for every
    // club. Under the old projection a club behind Greenwich matched it here.
    expect(
      findSeasonForDate(new Date("2026-07-03T00:00:00.000Z"), [boundarySeason])
    ).toBeNull()
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
    const season = findSeasonForDate(new Date("2026-06-01"), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  it("includes end date of season", () => {
    const season = findSeasonForDate(new Date("2026-09-30"), allSeasons)
    expect(season?.seasonId).toBe("season-winter-2026")
  })

  it("returns null for date in gap between seasons", () => {
    const season = findSeasonForDate(new Date("2026-10-15"), allSeasons)
    expect(season).toBeNull()
  })
})

describe("getNightlyRate", () => {
  it("returns adult member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "ADULT", MEMBER_TYPE, allSeasons)
    expect(result?.priceCents).toBe(4500)
    expect(result?.seasonId).toBe("season-winter-2026")
  })

  it("returns adult non-member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "ADULT", NONMEMBER_TYPE, allSeasons)
    expect(result?.priceCents).toBe(6500)
  })

  it("returns child member rate", () => {
    const result = getNightlyRate(new Date("2026-07-15"), "CHILD", MEMBER_TYPE, allSeasons)
    expect(result?.priceCents).toBe(1500)
  })

  it("returns null for date outside season", () => {
    const result = getNightlyRate(new Date("2026-10-15"), "ADULT", MEMBER_TYPE, allSeasons)
    expect(result).toBeNull()
  })
})

describe("calculateBookingPrice - single guest", () => {
  it("calculates 3-night adult member stay", () => {
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }]
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
    const guests: GuestInput[] = [{ ageTier: "YOUTH", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, rateSource: "NON_MEMBER_DEFAULT" }]
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      guests,
      allSeasons
    )
    expect(result.totalPriceCents).toBe(4500 * 2) // $45/night x 2 nights
  })

  it("throws error for date outside any season", () => {
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }]
    expect(() =>
      calculateBookingPrice(
        new Date("2026-10-10"),
        new Date("2026-10-12"),
        guests,
        allSeasons
      )
    ).toThrow("No rate found")
  })

  /*
    The pricing half of the same correction — see the long note on
    `findSeasonForDate` above for why the old "browser-submitted NZ local dates"
    framing described a caller that does not exist.

    The night priced here is the season's FIRST night. The old test asked for the
    night starting at NZ-local midnight on 4 July (`2026-07-03T12:00:00.000Z`)
    and was answered with the 4 July rate only because the engine projected. Now
    the stored day decides: the 4 July night is inside the season and the 3 July
    night is not covered at all, which `calculateBookingPrice` refuses rather
    than silently pricing at a neighbouring season's rate.
  */
  it("prices the season's first night from the stored calendar day", () => {
    const boundarySeason = makeSeason({
      startDate: new Date("2026-07-04T00:00:00.000Z"),
      endDate: new Date("2026-09-30T00:00:00.000Z"),
    })
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }]

    const result = calculateBookingPrice(
      new Date("2026-07-04T00:00:00.000Z"),
      new Date("2026-07-05T00:00:00.000Z"),
      guests,
      [boundarySeason]
    )

    expect(result.totalPriceCents).toBe(4500)
    expect(result.guests[0].perNightCents).toEqual([4500])

    // One night earlier is outside the season, so there is no rate to charge.
    expect(() =>
      calculateBookingPrice(
        new Date("2026-07-03T00:00:00.000Z"),
        new Date("2026-07-04T00:00:00.000Z"),
        guests,
        [boundarySeason]
      )
    ).toThrow("No rate found")
  })
})

describe("calculateBookingPrice - multiple guests", () => {
  it("calculates total for multiple guests", () => {
    const guests: GuestInput[] = [
      { ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
      { ageTier: "ADULT", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, rateSource: "NON_MEMBER_DEFAULT" },
      { ageTier: "CHILD", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
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
    const guests: GuestInput[] = [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }]
    const { totalPriceCents } = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-11"),
      guests,
      allSeasons
    )
    expect(totalPriceCents).toBe(4500)
  })

  it("prices guest-specific stay ranges", () => {
    const guests: GuestInput[] = [
      {
        ageTier: "ADULT",
        isMember: true,
        rateMembershipTypeId: MEMBER_TYPE,
        rateSource: "OWN_TYPE",
        stayStart: new Date("2026-07-10"),
        stayEnd: new Date("2026-07-13"),
      },
      {
        ageTier: "ADULT",
        isMember: true,
        rateMembershipTypeId: MEMBER_TYPE,
        rateSource: "OWN_TYPE",
        stayStart: new Date("2026-07-10"),
        stayEnd: new Date("2026-07-14"),
      },
      {
        ageTier: "CHILD",
        isMember: true,
        rateMembershipTypeId: MEMBER_TYPE,
        rateSource: "OWN_TYPE",
        stayStart: new Date("2026-07-11"),
        stayEnd: new Date("2026-07-14"),
      },
    ]

    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-14"),
      guests,
      allSeasons
    )

    expect(result.totalPriceCents).toBe(4500 * 3 + 4500 * 4 + 1500 * 3)
    expect(result.guests.map((guest) => guest.nights)).toEqual([3, 4, 3])
    expect(result.guests.map((guest) => guest.priceCents)).toEqual([
      13500,
      18000,
      4500,
    ])
  })

  it("uses active guest count for group discounts on each night", () => {
    const guests: GuestInput[] = [
      {
        ageTier: "ADULT",
        isMember: false,
        rateMembershipTypeId: NONMEMBER_TYPE,
        rateSource: "NON_MEMBER_DEFAULT",
        stayStart: new Date("2026-07-10"),
        stayEnd: new Date("2026-07-12"),
      },
      {
        ageTier: "ADULT",
        isMember: false,
        rateMembershipTypeId: NONMEMBER_TYPE,
        rateSource: "NON_MEMBER_DEFAULT",
        stayStart: new Date("2026-07-11"),
        stayEnd: new Date("2026-07-12"),
      },
    ]

    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      guests,
      allSeasons,
      { enabled: true, minGroupSize: 2, summerOnly: false, rateMembershipTypeId: MEMBER_TYPE }
    )

    expect(result.guests[0].perNightCents).toEqual([6500, 4500])
    expect(result.guests[1].perNightCents).toEqual([4500])
    expect(result.totalPriceCents).toBe(15500)
  })
})

describe("calculatePromoDiscount", () => {
  // 1 guest, 2 nights at varied rates
  const singleAdultMember = {
    memberId: null,
    isMember: true,
    perNightRates: [4500, 4500],
  }
  const totalPrice = 9000

  it("applies percentage discount per guest", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 }
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalPrice, guests: [singleAdultMember] })
    // 20% × 4500 × 2 = 1800
    expect(result.discountCents).toBe(1800)
  })

  it("applies fixed amount per guest", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 }
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalPrice, guests: [singleAdultMember] })
    expect(result.discountCents).toBe(5000)
  })

  it("caps fixed amount per guest at guest's stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 99999 }
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalPrice, guests: [singleAdultMember] })
    expect(result.discountCents).toBe(totalPrice)
  })

  it("applies free nights to most expensive nights per guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 }
    const guests = [{ memberId: null, isMember: true, perNightRates: [1500, 1500, 4500, 4500] }]
    const result = calculatePromoDiscount(promo, { totalPriceCents: 12000, guests })
    // 2 most expensive = 4500 + 4500 = 9000
    expect(result.discountCents).toBe(9000)
  })

  it("handles free nights exceeding guest's nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 100 }
    const guests = [{ memberId: null, isMember: true, perNightRates: [1500, 1500, 4500, 4500] }]
    const result = calculatePromoDiscount(promo, { totalPriceCents: 12000, guests })
    expect(result.discountCents).toBe(12000)
  })

  it("returns 0 for zero percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 }
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalPrice, guests: [singleAdultMember] })
    expect(result.discountCents).toBe(0)
  })

  it("returns 0 for null values", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null }
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalPrice, guests: [singleAdultMember] })
    expect(result.discountCents).toBe(0)
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

  it("formats large amounts with thousands separators", () => {
    expect(formatCents(100000)).toBe("$1,000.00")
  })
})

// The retired `getSeasonYear` read its argument with host-local getters; these
// fixtures are all UTC-midnight date-only strings, so the successor for them is
// `seasonYearOfStoredDate`, which takes no zone (CT-4 group F1, #2870).
describe("seasonYearOfStoredDate", () => {
  it("returns current year for April (month index 3)", () => {
    expect(seasonYearOfStoredDate(new Date("2026-04-15"))).toBe(2026)
  })

  it("returns current year for December", () => {
    expect(seasonYearOfStoredDate(new Date("2026-12-01"))).toBe(2026)
  })

  it("returns previous year for January", () => {
    expect(seasonYearOfStoredDate(new Date("2026-01-15"))).toBe(2025)
  })

  it("returns previous year for March", () => {
    expect(seasonYearOfStoredDate(new Date("2026-03-31"))).toBe(2025)
  })
})
