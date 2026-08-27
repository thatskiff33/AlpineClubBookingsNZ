import { describe, it, expect } from "vitest";
import {
  calculateBookingPrice,
  calculatePromoDiscount,
  findRateForNight,
  type PromoCodeInput,
  type SeasonRateData,
} from "@/lib/pricing";

// Test fixtures. Rates are keyed by membership type (#1930, E4): the old
// member rows map to MEMBER_TYPE, the non-member rows to NONMEMBER_TYPE.
const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";

const winterSeason: SeasonRateData = {
  seasonId: "winter-2026",
  startDate: new Date("2026-06-01"),  // June 1
  endDate: new Date("2026-09-30"),   // Sep 30
  rates: [
    { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
    { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 7000 },
    { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3000 },
    { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5000 },
    { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1500 },
    { ageTier: "CHILD", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 3000 },
  ],
};

const summerSeason: SeasonRateData = {
  seasonId: "summer-2026",
  startDate: new Date("2025-10-01"),   // Oct 1
  endDate: new Date("2026-05-31"),    // May 31
  rates: [
    { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3500 },
    { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5500 },
    { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 2500 },
    { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 4000 },
    { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1000 },
    { ageTier: "CHILD", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 2000 },
  ],
};

const allSeasons = [winterSeason, summerSeason];

describe("findRateForNight", () => {
  it("finds winter rate for a winter date", () => {
    const rate = findRateForNight(new Date("2026-07-15"), "ADULT", MEMBER_TYPE, allSeasons);
    expect(rate).toBe(4500);
  });

  it("finds summer rate for a summer date", () => {
    const rate = findRateForNight(new Date("2026-03-15"), "ADULT", MEMBER_TYPE, allSeasons);
    expect(rate).toBe(3500);
  });

  it("finds non-member rate", () => {
    const rate = findRateForNight(new Date("2026-07-15"), "ADULT", NONMEMBER_TYPE, allSeasons);
    expect(rate).toBe(7000);
  });

  it("finds youth member rate", () => {
    const rate = findRateForNight(new Date("2026-07-15"), "YOUTH", MEMBER_TYPE, allSeasons);
    expect(rate).toBe(3000);
  });

  it("finds child non-member rate", () => {
    const rate = findRateForNight(new Date("2026-07-15"), "CHILD", NONMEMBER_TYPE, allSeasons);
    expect(rate).toBe(3000);
  });

  it("returns null for date not covered by any season", () => {
    const rate = findRateForNight(new Date("2027-01-15"), "ADULT", MEMBER_TYPE, allSeasons);
    expect(rate).toBeNull();
  });

  it("handles season boundary start date (inclusive)", () => {
    const rate = findRateForNight(new Date("2026-06-01"), "ADULT", MEMBER_TYPE, allSeasons);
    expect(rate).toBe(4500);
  });

  it("handles season boundary end date (inclusive)", () => {
    const rate = findRateForNight(new Date("2026-09-30"), "ADULT", MEMBER_TYPE, allSeasons);
    expect(rate).toBe(4500);
  });
});

describe("calculateBookingPrice", () => {
  it("calculates price for single adult member, 1 night", () => {
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-11"),
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }],
      allSeasons
    );

    expect(result.totalPriceCents).toBe(4500);
    expect(result.guests).toHaveLength(1);
    expect(result.guests[0].nights).toBe(1);
    expect(result.guests[0].priceCents).toBe(4500);
  });

  it("calculates price for single adult member, 3 nights", () => {
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-13"),
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }],
      allSeasons
    );

    expect(result.totalPriceCents).toBe(4500 * 3);
    expect(result.guests[0].nights).toBe(3);
    expect(result.guests[0].perNightCents).toEqual([4500, 4500, 4500]);
  });

  it("calculates price for mixed group", () => {
    const result = calculateBookingPrice(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      [
        { ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
        { ageTier: "ADULT", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, rateSource: "NON_MEMBER_DEFAULT" },
        { ageTier: "CHILD", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
      ],
      allSeasons
    );

    // 2 nights: adult member 4500*2, adult non-member 7000*2, child member 1500*2
    expect(result.totalPriceCents).toBe(9000 + 14000 + 3000);
    expect(result.guests).toHaveLength(3);
  });

  it("handles booking spanning season boundary", () => {
    // May 30 (summer) to June 2 (June 1 is winter start)
    const result = calculateBookingPrice(
      new Date("2026-05-30"),
      new Date("2026-06-02"),
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }],
      allSeasons
    );

    // Night of May 30 = summer (3500), May 31 = summer (3500), June 1 = winter (4500)
    expect(result.guests[0].perNightCents).toEqual([3500, 3500, 4500]);
    expect(result.totalPriceCents).toBe(3500 + 3500 + 4500);
  });

  it("throws error when no rate covers a date", () => {
    expect(() =>
      calculateBookingPrice(
        new Date("2027-01-10"),
        new Date("2027-01-12"),
        [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }],
        allSeasons
      )
    ).toThrow("No rate found");
  });

  it("handles single night stay correctly (checkIn to checkOut = 1 day)", () => {
    const result = calculateBookingPrice(
      new Date("2026-07-15"),
      new Date("2026-07-16"),
      [{ ageTier: "YOUTH", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, rateSource: "NON_MEMBER_DEFAULT" }],
      allSeasons
    );

    expect(result.guests[0].nights).toBe(1);
    expect(result.totalPriceCents).toBe(5000);
  });

  it("calculates correctly for a week stay", () => {
    const result = calculateBookingPrice(
      new Date("2026-07-01"),
      new Date("2026-07-08"),
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }],
      allSeasons
    );

    expect(result.guests[0].nights).toBe(7);
    expect(result.totalPriceCents).toBe(4500 * 7);
  });
});

describe("calculatePromoDiscount - per-individual model", () => {
  // Single guest with 5 nights for simplicity.
  const oneGuestFive = [{ memberId: null, isMember: true, perNightRates: [3000, 4500, 5000, 4500, 3000] }];
  const totalOneGuestFive = 20000;

  it("applies percentage discount per guest", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 10000, guests: [{ memberId: null, isMember: true, perNightRates: [10000] }] });
    expect(result.discountCents).toBe(2000);
  });

  it("applies fixed amount per guest", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 2500 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 10000, guests: [{ memberId: null, isMember: true, perNightRates: [10000] }] });
    expect(result.discountCents).toBe(2500);
  });

  it("caps fixed amount per guest at that guest's stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 2500 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 1000, guests: [{ memberId: null, isMember: true, perNightRates: [1000] }] });
    expect(result.discountCents).toBe(1000);
  });

  it("applies free nights to a guest's most expensive nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: totalOneGuestFive, guests: oneGuestFive });
    // 2 most expensive: 5000, 4500
    expect(result.discountCents).toBe(9500);
    expect(result.freeNightsUsed).toBe(2);
  });

  it("handles free nights when promo allows more than guest has", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 5 };
    const guests = [{ memberId: null, isMember: true, perNightRates: [3000, 4500] }];
    const result = calculatePromoDiscount(promo, { totalPriceCents: 7500, guests });
    expect(result.discountCents).toBe(7500);
    expect(result.freeNightsUsed).toBe(2);
  });

  it("handles 100% percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 100 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 15000, guests: [{ memberId: null, isMember: true, perNightRates: [15000] }] });
    expect(result.discountCents).toBe(15000);
  });

  it("handles 0% percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 15000, guests: [{ memberId: null, isMember: true, perNightRates: [15000] }] });
    expect(result.discountCents).toBe(0);
  });
});
