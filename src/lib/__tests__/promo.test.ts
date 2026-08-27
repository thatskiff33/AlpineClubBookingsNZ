import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  calculatePromoDiscountForGuestRates,
  validateAndCalculatePromoDiscount,
  validatePromoCodeRules,
  type PromoRuleSubject,
} from "../promo";
import { calculatePromoDiscount, type PromoCodeInput } from "../pricing";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

// --- Test helpers ---

function makePromoCode(overrides: Partial<PromoRuleSubject> = {}): PromoRuleSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    ...overrides,
  };
}

const defaultBookingDetails = { memberId: "member-1" };
// #3123 — `validatePromoCodeRules` now takes the CLUB's calendar day, not an
// instant it projects through `APP_TIME_ZONE`. This constant is the day the
// old `new Date("2026-07-15T12:00:00Z")` fixture resolved to under the
// container's zone, so every window boundary below is unchanged.
const now = requireCalendarDate("2026-07-16");

const singleMemberGuest = [
  { memberId: "member-1", isMember: true, perNightRates: [5000, 5000, 5000] },
];

// --- Validation Rule Tests ---

describe("validatePromoCodeRules", () => {
  it("returns null for a valid promo code", () => {
    expect(validatePromoCodeRules(makePromoCode(), defaultBookingDetails, now)).toBeNull();
  });

  it("returns error when promo code is null (not found)", () => {
    expect(validatePromoCodeRules(null, defaultBookingDetails, now)).toBe("Promo code not found");
  });

  it("returns error when promo code is inactive", () => {
    expect(validatePromoCodeRules(makePromoCode({ active: false }), defaultBookingDetails, now)).toBe(
      "This promo code is no longer active"
    );
  });

  it("returns error when promo code is not yet valid", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validFrom: new Date("2026-08-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code is not yet valid");
  });

  it("allows promo code on exact validFrom date", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validFrom: new Date("2026-07-15T00:00:00Z") }),
        defaultBookingDetails,
        requireCalendarDate("2026-07-15")
      )
    ).toBeNull();
  });

  // #3123 — WHAT THIS CASE USED TO ASSERT, AND WHY IT HAD TO CHANGE.
  //
  // It was called "uses New Zealand date keys for validFrom" and it passed
  // `2026-06-30T12:01:00.000Z` — an instant that is 30 June in UTC and 1 July in
  // New Zealand — expecting a promotion valid from 1 July to be live. So what it
  // actually pinned was that the validator projected an instant through
  // `APP_TIME_ZONE`, the CONTAINER's zone, which is the exact defect #3123
  // removes: a club configured for `America/Denver` on a New Zealand host was
  // told its promotion had already started.
  //
  // The claim it was reaching for — that a real instant becomes a calendar day in
  // the CLUB's zone — is still true and still tested, but it belongs to
  // `clubCalendarDateOf` / `clubToday` and to whichever caller resolves the day.
  // Here the day arrives already resolved, so what is left to state is the
  // boundary itself: the first valid day is IN, the day before it is OUT.
  it("the first valid day is in and the day before it is out", () => {
    const promo = makePromoCode({
      validFrom: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(
      validatePromoCodeRules(
        promo,
        defaultBookingDetails,
        requireCalendarDate("2026-07-01")
      )
    ).toBeNull();
    expect(
      validatePromoCodeRules(
        promo,
        defaultBookingDetails,
        requireCalendarDate("2026-06-30")
      )
    ).toBe("This promo code is not yet valid");
  });

  it("returns error when promo code has expired", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validUntil: new Date("2026-07-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has expired");
  });

  it("allows promo code before validUntil", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validUntil: new Date("2026-12-31") }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  // #3123 — same correction as the validFrom pair above. This was "keeps
  // validUntil active through the selected New Zealand date" and split its two
  // legs on `11:59:59Z` versus `12:00:00Z`, i.e. on the moment New Zealand rolls
  // over — the container's zone deciding a club-facing answer. `validUntil` is
  // INCLUSIVE, so the boundary is now stated as the two club days either side.
  it("validUntil is inclusive: its own day is in, the next day is out", () => {
    const promo = makePromoCode({
      validUntil: new Date("2026-07-15T00:00:00.000Z"),
    });
    expect(
      validatePromoCodeRules(
        promo,
        defaultBookingDetails,
        requireCalendarDate("2026-07-15")
      )
    ).toBeNull();
    expect(
      validatePromoCodeRules(
        promo,
        defaultBookingDetails,
        requireCalendarDate("2026-07-16")
      )
    ).toBe("This promo code has expired");
  });

  it("returns error when total redemptions cap reached", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 10, currentRedemptions: 10 }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("allows when redemptions below cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 10, currentRedemptions: 9 }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("rejects when requested beneficiary allocations would exceed total redemption cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 10, currentRedemptions: 9 }),
        defaultBookingDetails,
        now,
        { requestedRedemptionCount: 2 }
      )
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("allows unlimited redemptions when cap is null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: null, currentRedemptions: 999 }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("returns error for members-only code with no memberId", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ membersOnly: true }),
        { memberId: "" },
        now
      )
    ).toBe("This promo code is only available to members");
  });

  it("allows members-only code for a member", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ membersOnly: true }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("returns 'already used' error when maxUsesPerMember is 1 and member already redeemed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 1 }
      )
    ).toBe("You have already used this promo code");
  });

  it("returns 'max uses reached' error when maxUsesPerMember > 1 and member has used all", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 3 }
      )
    ).toBe("You have reached the maximum uses of this promo code");
  });

  it("allows additional use when below maxUsesPerMember cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 2 }
      )
    ).toBeNull();
  });

  it("does not reject at rule layer when one beneficiary is at the use cap but others remain", () => {
    // Per-beneficiary filtering is applied upstream in
    // validateAndCalculatePromoDiscount, so the bare rule check is null here.
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCounts: { "member-1": 0, "member-2": 1 } }
      )
    ).toBeNull();
  });

  it("rejects at rule layer when all assigned beneficiaries are exhausted", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        defaultBookingDetails,
        now,
        { allBeneficiariesExhausted: true }
      )
    ).toBe("All linked member guests have used this promo code");
  });

  it("checks expired before total cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({
          active: true,
          validUntil: new Date("2026-01-01"),
          maxRedemptionsTotal: 0,
          currentRedemptions: 0,
        }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has expired");
  });

  it("checks inactive before expired", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ active: false, validUntil: new Date("2026-01-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code is no longer active");
  });
});

// --- maxUniqueMembersTotal Validation Tests ---

describe("validatePromoCodeRules - maxUniqueMembersTotal", () => {
  it("rejects new member when unique-members cap reached", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5 }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 5, memberHasRedeemedBefore: false }
      )
    ).toBe("This promo code has reached its maximum number of unique members");
  });

  it("allows existing member to redeem again even when unique-members cap is full", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5, maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        {
          uniqueMembersUsed: 5,
          memberHasRedeemedBefore: true,
          memberRedemptionCount: 1,
        }
      )
    ).toBeNull();
  });

  it("allows new member when below unique-members cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5 }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 4, memberHasRedeemedBefore: false }
      )
    ).toBeNull();
  });

  it("rejects when requested new beneficiaries would exceed unique-member cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5 }),
        defaultBookingDetails,
        now,
        {
          uniqueMembersUsed: 4,
          requestedNewUniqueMemberCount: 2,
        }
      )
    ).toBe("This promo code has reached its maximum number of unique members");
  });

  it("ignores unique-members cap when null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: null }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 99999, memberHasRedeemedBefore: false }
      )
    ).toBeNull();
  });
});

// --- Cumulative Free Nights Validation Tests ---

describe("validatePromoCodeRules - cumulative free nights", () => {
  it("returns error when all free nights have been consumed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", lifetimeFreeNightsCap: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 4 }
      )
    ).toBe("You have used all your free nights for this promo code");
  });

  it("returns error when free nights exceed allowance", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", lifetimeFreeNightsCap: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 5 }
      )
    ).toBe("You have used all your free nights for this promo code");
  });

  it("does not reject at rule layer when one beneficiary is at the free-night cap but others remain", () => {
    // Per-beneficiary filtering is applied upstream; the rule check is null here.
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", lifetimeFreeNightsCap: 3 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsedByMemberId: { "member-1": 0, "member-2": 3 } }
      )
    ).toBeNull();
  });

  it("allows when some free nights remain", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", lifetimeFreeNightsCap: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 2 }
      )
    ).toBeNull();
  });

  it("does not check free nights for non-FREE_NIGHTS promos", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "PERCENTAGE" }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 100 }
      )
    ).toBeNull();
  });

  it("does not check free nights when lifetimeFreeNightsCap is null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", lifetimeFreeNightsCap: null }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 10 }
      )
    ).toBeNull();
  });
});

// --- Discount calculation: PERCENTAGE (per individual) ---

describe("calculatePromoDiscount - PERCENTAGE per individual", () => {
  it("20% off one guest's nights", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: [{ memberId: null, isMember: true, perNightRates: [5000, 5000] }],
    });
    // 20% × 5000 = 1000 per night × 2 = 2000
    expect(result.discountCents).toBe(2000);
  });

  it("applies to all eligible guests when no per-booking cap", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 10 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 20000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000] },
        { memberId: null, isMember: true, perNightRates: [5000, 5000] },
      ],
    });
    // 10% of 20000 total = 2000
    expect(result.discountCents).toBe(2000);
    expect(result.eligibleGuestCount).toBe(2);
  });

  it("caps to maxGuestsPerBooking, picking most expensive guests", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000, 5000] }, // 15000 total
        { memberId: null, isMember: true, perNightRates: [1000, 1000, 1000] }, // 3000 total
      ],
    });
    // Picks the 15000 guest, 50% = 7500
    expect(result.discountCents).toBe(7500);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("filters non-member guests when memberGuestsOnly is true", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000, 5000] },
        { memberId: null, isMember: false, perNightRates: [1000, 1000, 1000] },
      ],
    });
    // Only the member guest counts: 50% × 15000 = 7500
    expect(result.discountCents).toBe(7500);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("applies nightly value cap to percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, maxNightlyValueCents: 1000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 6000,
      guests: [{ memberId: null, isMember: true, perNightRates: [3000, 3000] }],
    });
    // 50% × 3000 = 1500 per night, capped to 1000 × 2 nights = 2000
    expect(result.discountCents).toBe(2000);
  });

  it("returns 0 for 0%", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });

  it("returns 0 for null percentOff", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- Discount calculation: FIXED_AMOUNT (per individual) ---

describe("calculatePromoDiscount - FIXED_AMOUNT per individual", () => {
  it("$50 off each eligible guest", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 20000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [6000] },
        { memberId: null, isMember: true, perNightRates: [6000] },
      ],
    });
    expect(result.discountCents).toBe(10000);
    expect(result.eligibleGuestCount).toBe(2);
  });

  it("caps per-guest discount at guest's stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 15000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: [{ memberId: null, isMember: true, perNightRates: [10000] }],
    });
    expect(result.discountCents).toBe(10000);
  });

  it("limits to top maxGuestsPerBooking by stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 15000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [10000] },
        { memberId: null, isMember: true, perNightRates: [5000] },
      ],
    });
    expect(result.discountCents).toBe(5000);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("returns 0 for zero valueCents", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- Discount calculation: FIXED_NIGHTLY_PRICE (per guest-night) ---

describe("calculatePromoDiscount - FIXED_NIGHTLY_PRICE", () => {
  it("SET_PRICE can increase cheaper nights and discount dearer nights", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 11000,
      guests: [
        { memberId: "member-1", isMember: true, perNightRates: [2000, 5000] },
        { memberId: "member-2", isMember: true, perNightRates: [4000] },
      ],
    });

    expect(result.priceAdjustmentCents).toBe(-2000);
    expect(result.discountCents).toBe(2000);
    expect(result.eligibleGuestCount).toBe(2);
  });

  it("SET_PRICE can produce a positive adjustment", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 1000,
      guests: [{ memberId: "member-1", isMember: true, perNightRates: [1000] }],
    });

    expect(result.priceAdjustmentCents).toBe(2000);
    expect(result.discountCents).toBe(0);
    expect(result.allocations).toEqual([
      { memberId: "member-1", discountCents: 0, priceAdjustmentCents: 2000, freeNightsUsed: 0 },
    ]);
  });

  it("CAP_ONLY only reduces nights above the configured cap", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "CAP_ONLY",
    };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: [{ memberId: "member-1", isMember: true, perNightRates: [2000, 5000, 3000] }],
    });

    expect(result.priceAdjustmentCents).toBe(-2000);
    expect(result.discountCents).toBe(2000);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("CAP_ONLY has no effect and no beneficiaries when all nights are below the cap", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "CAP_ONLY",
    };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 3000,
      guests: [{ memberId: "member-1", isMember: true, perNightRates: [1000, 2000] }],
    });

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.discountCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(0);
    expect(result.allocations).toEqual([]);
  });

  it("SET_PRICE counts assigned beneficiaries even when the net adjustment is zero", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      3000,
      "member-1",
      [{ memberId: "member-1", isMember: true, perNightRates: [3000] }],
      ["member-1"]
    );

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([
      { memberId: "member-1", discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0 },
    ]);
  });
});

// --- Discount calculation: FREE_NIGHTS (per individual) ---

describe("calculatePromoDiscount - FREE_NIGHTS per individual", () => {
  it("frees the most expensive nights for each eligible guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
      ],
    });
    // 2 most expensive per guest × 4500 × 2 guests = 18000
    expect(result.discountCents).toBe(18000);
    expect(result.freeNightsUsed).toBe(4);
  });

  it("respects maxGuestsPerBooking - picks most expensive guests first", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] }, // 13500 total
        { memberId: null, isMember: true, perNightRates: [1000, 1000, 1000] }, // 3000 total
      ],
    });
    // Only top guest: 2 most expensive nights = 4500 + 4500 = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("respects lifetime cap as a single pool across selected guests", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500] },
      ],
      remainingFreeNights: 2,
    });
    // Booker only has 2 left from their lifetime budget; pick the 2 most expensive
    // candidate nights across the selected guests' top-3-each candidate pools.
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
  });

  it("returns 0 when lifetime cap is exhausted", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: singleMemberGuest,
      remainingFreeNights: 0,
    });
    expect(result.discountCents).toBe(0);
    expect(result.freeNightsUsed).toBe(0);
  });

  it("applies nightly value cap as partial subsidy", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3, maxNightlyValueCents: 3000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [{ memberId: null, isMember: true, perNightRates: [8000, 8000, 8000] }],
    });
    // 3 nights at 8000 capped to 3000 each = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(3);
  });

  it("filters non-member guests when memberGuestsOnly is true", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: false, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
      ],
    });
    // Non-member guest excluded; 2 free nights for the one member = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("returns 0 when no eligible guests", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 9000,
      guests: [{ memberId: null, isMember: false, perNightRates: [4500, 4500] }],
    });
    expect(result.discountCents).toBe(0);
  });

  it("returns 0 for zero freeNightsPerIndividual", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- calculatePromoDiscountForGuestRates (the booking-time wrapper) ---

describe("calculatePromoDiscountForGuestRates", () => {
  it("scopes assigned free-night promos to the assigned member's own guest nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", isMember: true, perNightRates: [5000] },
        { memberId: "member-2", isMember: true, perNightRates: [2000] },
      ],
      ["member-1"]
    );
    expect(result.discountCents).toBe(5000);
  });

  it("discounts each assigned linked member guest and reports beneficiary allocations", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      12000,
      "member-1",
      [
        { memberId: "member-1", isMember: true, perNightRates: [2000, 2000, 2000] },
        { memberId: "member-2", isMember: true, perNightRates: [2000, 2000, 2000] },
        { memberId: "member-3", isMember: true, perNightRates: [2000, 2000, 2000] },
      ],
      ["member-1", "member-2"],
      undefined,
      { "member-1": 3, "member-2": 3 }
    );

    expect(result.discountCents).toBe(12000);
    expect(result.freeNightsUsed).toBe(6);
    expect(result.eligibleGuestCount).toBe(2);
    expect(result.allocations).toEqual([
      { memberId: "member-1", discountCents: 6000, priceAdjustmentCents: -6000, freeNightsUsed: 3 },
      { memberId: "member-2", discountCents: 6000, priceAdjustmentCents: -6000, freeNightsUsed: 3 },
    ]);
  });

  it("includes all guests for unassigned free-night promos", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", isMember: true, perNightRates: [5000] },
        { memberId: "member-2", isMember: true, perNightRates: [2000] },
      ],
      null
    );
    // Both guests get 1 night free = 5000 + 2000 = 7000
    expect(result.discountCents).toBe(7000);
  });

  it("returns 0 when assigned member is not a guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      4000,
      "member-1",
      [{ memberId: "member-2", isMember: true, perNightRates: [2000, 2000] }],
      ["member-1"]
    );
    expect(result.discountCents).toBe(0);
  });

  it("passes remainingFreeNights through to limit free nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 4 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      15000,
      "member-1",
      [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000, 5000] }],
      ["member-1"],
      2
    );
    expect(result.discountCents).toBe(10000);
    expect(result.freeNightsUsed).toBe(2);
  });
});

describe("validateAndCalculatePromoDiscount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses allocation-backed counts and excludes the current booking during recalculation", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 3,
          maxRedemptionsTotal: 10,
          maxUniqueMembersTotal: 10,
          maxUsesPerMember: 1,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 3,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        memberGuestsOnly: false,
      },
      {
        memberId: "member-1",
        bookingCheckIn: new Date("2026-08-01T00:00:00Z"),
        totalPriceCents: 12000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [2000, 2000, 2000] },
          { memberId: "member-2", isMember: true, perNightRates: [2000, 2000, 2000] },
        ],
      },
      ["member-1", "member-2"],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST, excludeBookingId: "booking-1" }
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(12000);
    expect(prisma.promoRedemptionAllocation.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          promoCodeId: "promo-1",
          memberId: "member-1",
          bookingId: { not: "booking-1" },
        }),
      })
    );
    expect(prisma.promoRedemptionAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          promoCodeId: "promo-1",
          bookingId: { not: "booking-1" },
        }),
      })
    );
  });

  it("supports asymmetric per-booking and lifetime caps", async () => {
    const { prisma } = await import("@/lib/prisma");
    // Member has already used 2 of 3 lifetime nights; per-booking cap is 1.
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 2 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          lifetimeFreeNightsCap: 3,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: 3,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        memberGuestsOnly: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 9000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [3000, 3000, 3000] },
        ],
      },
      null
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    // Per-booking cap of 1 limits to one night; lifetime budget of 1 remaining
    // is the smaller constraint. One night at 3000 → 3000.
    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(3000);
    expect(result.discount?.freeNightsUsed).toBe(1);
    expect(result.remainingFreeNights).toBe(1);
  });

  it("applies discount only to beneficiaries with remaining lifetime budget (Brendon/Richie scenario)", async () => {
    const { prisma } = await import("@/lib/prisma");
    // member-1 has exhausted lifetime cap of 1; member-2 has 0 used.
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockImplementation(
      ((args: any) =>
        Promise.resolve({
          _sum: {
            freeNightsUsed: args.where.memberId === "member-1" ? 1 : 0,
          },
        } as any)) as never
    );
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          lifetimeFreeNightsCap: 1,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: 1,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: 3500,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        memberGuestsOnly: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
        ],
      },
      ["member-1", "member-2"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBeUndefined();
    // Only member-2 receives the discount, capped at maxNightlyValueCents=3500.
    expect(result.discount?.discountCents).toBe(3500);
    expect(result.discount?.freeNightsUsed).toBe(1);
    expect(result.beneficiaryMemberIds).toEqual(["member-2"]);
  });

  it("rejects when every assigned beneficiary has exhausted the lifetime cap", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    // Both members at lifetime cap of 1.
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 1 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          lifetimeFreeNightsCap: 1,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: 1,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        memberGuestsOnly: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
        ],
      },
      ["member-1", "member-2"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBe("All linked member guests have used this promo code");
    expect(result.discount).toBeUndefined();
  });

  it("lets assigned members apply a promo to anyone on their booking when own-night scoping is off", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          assignedMembersOnlyOwnNights: false,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 7000,
        guests: [
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
          { memberId: null, isMember: false, perNightRates: [2000] },
        ],
      },
      ["member-1"],
      {
      todayAtClub: CLUB_TODAY_FOR_TEST, selectedGuestIndexes: [0, 1] }
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(7000);
    expect(result.beneficiaryMemberIds).toEqual(["member-1"]);
    expect(result.selectedGuestIndexes).toEqual([0, 1]);
    expect(result.discount?.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 7000,
        priceAdjustmentCents: -7000,
        freeNightsUsed: 2,
      },
    ]);
  });

  it("lets any booker use an own-night assigned promo when the assigned member is staying", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          assignedMembersOnlyOwnNights: true,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: true,
      },
      {
        memberId: "booker-1",
        totalPriceCents: 7000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: null, isMember: false, perNightRates: [2000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(5000);
    expect(result.beneficiaryMemberIds).toEqual(["member-1"]);
    expect(result.discount?.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 5000,
        priceAdjustmentCents: -5000,
        freeNightsUsed: 1,
      },
    ]);
  });

  it("rejects an own-night assigned promo when no assigned member is staying", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          assignedMembersOnlyOwnNights: true,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: true,
      },
      {
        memberId: "booker-1",
        totalPriceCents: 5000,
        guests: [
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBe(
      "This promo code only applies when an assigned member is staying on the booking"
    );
    expect(result.discount).toBeUndefined();
  });

  it("requires guest selection for assigned-booker promos", async () => {
    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 1,
          assignedMembersOnlyOwnNights: false,
        }),
        type: "FREE_NIGHTS",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: 1,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 7000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: null, isMember: false, perNightRates: [2000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBe("Choose which guests should receive this promo code");
    expect(result.requiresGuestSelection).toBe(true);
    expect(result.selectableGuestIndexes).toEqual([0, 1]);
  });

  it("applies assigned fixed-nightly group pricing to every eligible guest-night", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FIXED_NIGHTLY_PRICE",
          assignedMembersOnlyOwnNights: false,
        }),
        type: "FIXED_NIGHTLY_PRICE",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: 3000,
        fixedNightlyMode: "SET_PRICE",
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 9000,
        guests: [
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
          { memberId: null, isMember: false, perNightRates: [4000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    // Both the member guest and the non-member guest are repriced to the
    // configured nightly rate, attributed to the booking contact.
    expect(result.error).toBeUndefined();
    expect(result.requiresGuestSelection).toBeFalsy();
    expect(result.discount?.discountCents).toBe(3000);
    expect(result.discount?.priceAdjustmentCents).toBe(-3000);
    expect(result.discount?.eligibleGuestCount).toBe(2);
    expect(result.beneficiaryMemberIds).toEqual(["member-1"]);
    expect(result.discount?.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 3000,
        priceAdjustmentCents: -3000,
        freeNightsUsed: 0,
      },
    ]);
  });

  it("rejects assigned fixed-nightly group pricing for an unassigned booking contact", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FIXED_NIGHTLY_PRICE",
          assignedMembersOnlyOwnNights: false,
        }),
        type: "FIXED_NIGHTLY_PRICE",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: 3000,
        fixedNightlyMode: "SET_PRICE",
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: false,
      },
      {
        memberId: "booker-9",
        totalPriceCents: 5000,
        guests: [
          { memberId: "member-2", isMember: true, perNightRates: [5000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBe("This promo code is not assigned to you");
    expect(result.discount).toBeUndefined();
  });

  it("scopes a fixed-nightly group code to the assigned member when own-night scoping stays on", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as any);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([]);

    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FIXED_NIGHTLY_PRICE",
          assignedMembersOnlyOwnNights: true,
        }),
        type: "FIXED_NIGHTLY_PRICE",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: 3000,
        fixedNightlyMode: "SET_PRICE",
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: true,
      },
      {
        memberId: "booker-1",
        totalPriceCents: 9000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: null, isMember: false, perNightRates: [4000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    // Only the assigned member's own night is repriced; the non-member guest
    // is untouched, and any booker may use the code.
    expect(result.error).toBeUndefined();
    expect(result.requiresGuestSelection).toBeFalsy();
    expect(result.discount?.eligibleGuestCount).toBe(1);
    expect(result.discount?.discountCents).toBe(2000);
    expect(result.beneficiaryMemberIds).toEqual(["member-1"]);
  });

  it("treats a member-guests-only fixed-nightly code as booker-chooses, not group", async () => {
    const result = await validateAndCalculatePromoDiscount(
      {
        ...makePromoCode({
          type: "FIXED_NIGHTLY_PRICE",
          assignedMembersOnlyOwnNights: false,
        }),
        type: "FIXED_NIGHTLY_PRICE",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: 3000,
        fixedNightlyMode: "SET_PRICE",
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: true,
        assignedMembersOnlyOwnNights: false,
      },
      {
        memberId: "member-1",
        totalPriceCents: 9000,
        guests: [
          { memberId: "member-1", isMember: true, perNightRates: [5000] },
          { memberId: "member-2", isMember: true, perNightRates: [4000] },
        ],
      },
      ["member-1"]
    ,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    // member-guests-only excludes the group treatment, so the booker is still
    // asked to pick which member guests receive the code.
    expect(result.requiresGuestSelection).toBe(true);
    expect(result.error).toBe("Choose which guests should receive this promo code");
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  it("returns 0 for an empty guest list", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 0, guests: [] });
    expect(result.discountCents).toBe(0);
  });

  it("discount on zero total (PERCENTAGE)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 0,
      guests: [{ memberId: null, isMember: true, perNightRates: [0] }],
    });
    expect(result.discountCents).toBe(0);
  });

  it("discount on zero total (FIXED_AMOUNT) is capped at 0", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 0,
      guests: [{ memberId: null, isMember: true, perNightRates: [0] }],
    });
    expect(result.discountCents).toBe(0);
  });
});
