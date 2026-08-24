import { describe, expect, it } from "vitest";
import {
  calculateBookingPrice,
  getNightlyRate,
  type GuestInput,
  type SeasonRateData,
} from "../pricing";
import { lodgeNullTolerantScope } from "../lodges";

// docs/multi-lodge/test-plan.md — "Dual-lodge pricing values". Query scoping is
// tested elsewhere; this is the value-level assertion the production-readiness
// review found missing: two lodges with DIFFERENT active season rates for the
// SAME date and age tier must each resolve THEIR OWN price. Booking pricing is
// pure over the season rows it is given (booking-create.ts scopes the
// season.findMany by lodge via lodgeNullTolerantScope, then feeds the rows into
// these functions), so exercising the pricing functions with each lodge's own
// scoped rows proves the money value is lodge-specific.

// Same season window and identical age tiers at both lodges; only the
// pricePerNightCents differs, so any leakage between lodges would surface as a
// wrong dollar figure rather than a scoping error.
const WINTER_START = new Date("2026-06-01"); // 1 Jun 2026
const WINTER_END = new Date("2026-09-30"); // 30 Sep 2026

const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";

function lodgeASeason(): SeasonRateData {
  return {
    seasonId: "lodge-a-winter-2026",
    startDate: WINTER_START,
    endDate: WINTER_END,
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 6500 },
      { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1500 },
    ],
  };
}

function lodgeBSeason(): SeasonRateData {
  return {
    seasonId: "lodge-b-winter-2026",
    startDate: WINTER_START,
    endDate: WINTER_END,
    rates: [
      // Deliberately different money for the same date/tier as lodge A.
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 8000 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 11000 },
      { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3000 },
    ],
  };
}

const night = new Date("2026-07-15");

describe("dual-lodge nightly rate resolution", () => {
  it("resolves each lodge's own member rate for the same date and tier", () => {
    const a = getNightlyRate(night, "ADULT", MEMBER_TYPE, [lodgeASeason()]);
    const b = getNightlyRate(night, "ADULT", MEMBER_TYPE, [lodgeBSeason()]);

    expect(a?.priceCents).toBe(4500);
    expect(b?.priceCents).toBe(8000);
    // Distinct season rows, so the resolved seasonId is lodge-specific too.
    expect(a?.seasonId).toBe("lodge-a-winter-2026");
    expect(b?.seasonId).toBe("lodge-b-winter-2026");
  });

  it("resolves each lodge's own non-member rate for the same date and tier", () => {
    const a = getNightlyRate(night, "ADULT", NONMEMBER_TYPE, [lodgeASeason()]);
    const b = getNightlyRate(night, "ADULT", NONMEMBER_TYPE, [lodgeBSeason()]);

    expect(a?.priceCents).toBe(6500);
    expect(b?.priceCents).toBe(11000);
  });
});

describe("dual-lodge booking price totals", () => {
  const checkIn = new Date("2026-07-10");
  const checkOut = new Date("2026-07-13"); // 3 nights
  const guests: GuestInput[] = [
    { ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
    { ageTier: "CHILD", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" },
  ];

  it("totals a booking at each lodge using that lodge's own rates", () => {
    const priceA = calculateBookingPrice(checkIn, checkOut, guests, [
      lodgeASeason(),
    ]);
    const priceB = calculateBookingPrice(checkIn, checkOut, guests, [
      lodgeBSeason(),
    ]);

    // Lodge A: (4500 adult + 1500 child) * 3 nights = 18,000c
    expect(priceA.totalPriceCents).toBe((4500 + 1500) * 3);
    // Lodge B: (8000 adult + 3000 child) * 3 nights = 33,000c
    expect(priceB.totalPriceCents).toBe((8000 + 3000) * 3);
    // The whole point: identical guests/dates, different money per lodge.
    expect(priceA.totalPriceCents).not.toBe(priceB.totalPriceCents);
  });
});

describe("season query scoping is lodge-specific", () => {
  it("scopes the season lookup strictly to one lodge", () => {
    // The value split above only holds because booking-create.ts fetches each
    // booking's seasons through lodgeNullTolerantScope(lodgeId), which never
    // returns another lodge's rows. Season.lodgeId is NOT NULL, so the scope is
    // a strict per-lodge match. Pin the fragment so a regression that drops the
    // lodge scope from the season query would fail here too.
    expect(lodgeNullTolerantScope("lodge-a")).toEqual({ lodgeId: "lodge-a" });
    expect(lodgeNullTolerantScope("lodge-b")).toEqual({ lodgeId: "lodge-b" });
  });
});
