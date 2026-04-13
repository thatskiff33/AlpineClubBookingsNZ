import { describe, it, expect } from "vitest";
import {
  calculatePromoDiscountForGuestRates,
  validatePromoCodeRules,
} from "../promo";
import { calculatePromoDiscount, type PromoCodeInput } from "../pricing";
import type { PromoCodeType } from "@prisma/client";

// --- Test helpers ---

function makePromoCode(overrides: Partial<{
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  maxRedemptions: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  singleUse: boolean;
  type: PromoCodeType;
  freeNights: number | null;
}> = {}) {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    currentRedemptions: 0,
    membersOnly: false,
    singleUse: false,
    ...overrides,
  };
}

const defaultBookingDetails = { memberId: "member-1" };
const now = new Date("2026-07-15T12:00:00Z");

// --- Validation Rule Tests ---

describe("validatePromoCodeRules", () => {
  it("returns null for a valid promo code", () => {
    const result = validatePromoCodeRules(makePromoCode(), defaultBookingDetails, now);
    expect(result).toBeNull();
  });

  it("returns error when promo code is null (not found)", () => {
    const result = validatePromoCodeRules(null, defaultBookingDetails, now);
    expect(result).toBe("Promo code not found");
  });

  it("returns error when promo code is inactive", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ active: false }),
      defaultBookingDetails,
      now
    );
    expect(result).toBe("This promo code is no longer active");
  });

  it("returns error when promo code is not yet valid", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ validFrom: new Date("2026-08-01") }),
      defaultBookingDetails,
      now
    );
    expect(result).toBe("This promo code is not yet valid");
  });

  it("allows promo code on exact validFrom date", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ validFrom: new Date("2026-07-15T00:00:00Z") }),
      defaultBookingDetails,
      new Date("2026-07-15T12:00:00Z")
    );
    expect(result).toBeNull();
  });

  it("returns error when promo code has expired", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ validUntil: new Date("2026-07-01") }),
      defaultBookingDetails,
      now
    );
    expect(result).toBe("This promo code has expired");
  });

  it("allows promo code before validUntil", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ validUntil: new Date("2026-12-31") }),
      defaultBookingDetails,
      now
    );
    expect(result).toBeNull();
  });

  it("returns error when max redemptions reached", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ maxRedemptions: 10, currentRedemptions: 10 }),
      defaultBookingDetails,
      now
    );
    expect(result).toBe("This promo code has reached its maximum number of uses");
  });

  it("allows when redemptions below max", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ maxRedemptions: 10, currentRedemptions: 9 }),
      defaultBookingDetails,
      now
    );
    expect(result).toBeNull();
  });

  it("allows unlimited redemptions when maxRedemptions is null", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ maxRedemptions: null, currentRedemptions: 999 }),
      defaultBookingDetails,
      now
    );
    expect(result).toBeNull();
  });

  it("returns error for members-only code with no memberId", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ membersOnly: true }),
      { memberId: "" },
      now
    );
    expect(result).toBe("This promo code is only available to members");
  });

  it("allows members-only code for a member", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ membersOnly: true }),
      defaultBookingDetails,
      now
    );
    expect(result).toBeNull();
  });

  it("returns error for single-use code already used by member", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ singleUse: true }),
      defaultBookingDetails,
      now,
      1 // member has already redeemed once
    );
    expect(result).toBe("You have already used this promo code");
  });

  it("allows single-use code not yet used by member", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ singleUse: true }),
      defaultBookingDetails,
      now,
      0
    );
    expect(result).toBeNull();
  });

  it("checks multiple validation rules - expired takes precedence", () => {
    const result = validatePromoCodeRules(
      makePromoCode({
        active: true,
        validUntil: new Date("2026-01-01"),
        maxRedemptions: 0,
        currentRedemptions: 0,
      }),
      defaultBookingDetails,
      now
    );
    // Expired check comes before max redemptions
    expect(result).toBe("This promo code has expired");
  });

  it("checks inactive before expired", () => {
    const result = validatePromoCodeRules(
      makePromoCode({
        active: false,
        validUntil: new Date("2026-01-01"),
      }),
      defaultBookingDetails,
      now
    );
    expect(result).toBe("This promo code is no longer active");
  });
});

// --- Cumulative Free Nights Validation Tests ---

describe("validatePromoCodeRules - cumulative free nights", () => {
  it("returns error when all free nights have been consumed", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "FREE_NIGHTS", freeNights: 4 }),
      defaultBookingDetails,
      now,
      0, // memberRedemptionCount
      null, // assignedMemberIds
      4 // memberFreeNightsUsed - all 4 used
    );
    expect(result).toBe("You have used all your free nights for this promo code");
  });

  it("returns error when free nights exceed allowance", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "FREE_NIGHTS", freeNights: 4 }),
      defaultBookingDetails,
      now,
      0,
      null,
      5 // more than 4
    );
    expect(result).toBe("You have used all your free nights for this promo code");
  });

  it("allows when some free nights remain", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "FREE_NIGHTS", freeNights: 4 }),
      defaultBookingDetails,
      now,
      0,
      null,
      2 // 2 of 4 used
    );
    expect(result).toBeNull();
  });

  it("allows when no free nights have been used", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "FREE_NIGHTS", freeNights: 4 }),
      defaultBookingDetails,
      now,
      0,
      null,
      0
    );
    expect(result).toBeNull();
  });

  it("does not check free nights for non-FREE_NIGHTS promos", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "PERCENTAGE" }),
      defaultBookingDetails,
      now,
      0,
      null,
      100 // should be ignored for PERCENTAGE type
    );
    expect(result).toBeNull();
  });

  it("does not check free nights when freeNights is null", () => {
    const result = validatePromoCodeRules(
      makePromoCode({ type: "FREE_NIGHTS", freeNights: null }),
      defaultBookingDetails,
      now,
      0,
      null,
      10
    );
    expect(result).toBeNull();
  });
});

// --- Discount Calculation Tests (using pricing.ts calculatePromoDiscount) ---

describe("calculatePromoDiscount - PERCENTAGE", () => {
  it("calculates 20% off $100", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(2000);
  });

  it("calculates 50% off $45.50", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    expect(calculatePromoDiscount(promo, 4550).discountCents).toBe(2275);
  });

  it("calculates 100% off", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 100 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(10000);
  });

  it("returns 0 for 0%", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("returns 0 for null percentOff", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("rounds correctly for odd percentages", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 33 };
    // 33% of 10000 = 3300 exactly
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(3300);
  });

  it("rounds correctly for non-even result", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 15 };
    // 15% of 9999 = 1499.85, rounds to 1500
    expect(calculatePromoDiscount(promo, 9999).discountCents).toBe(1500);
  });

  it("returns freeNightsUsed as 0 for PERCENTAGE type", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    expect(calculatePromoDiscount(promo, 10000).freeNightsUsed).toBe(0);
  });
});

describe("calculatePromoDiscount - FIXED_AMOUNT", () => {
  it("subtracts fixed amount from total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 3000 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(3000);
  });

  it("caps discount at total price (discount exceeds total)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 15000 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(10000);
  });

  it("returns 0 for zero value", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("returns 0 for null valueCents", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: null };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("handles exact match (discount equals total)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 10000 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(10000);
  });

  it("returns freeNightsUsed as 0 for FIXED_AMOUNT type", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 3000 };
    expect(calculatePromoDiscount(promo, 10000).freeNightsUsed).toBe(0);
  });
});

describe("calculatePromoDiscount - FREE_NIGHTS", () => {
  // Scenario: 2 guests, 3 nights each = 6 per-night rates
  const perNightRates = [4500, 4500, 4500, 1500, 1500, 1500];
  const total = 18000; // 3*4500 + 3*1500

  it("removes cheapest 1 night", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };
    // Cheapest = 1500
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(1500);
  });

  it("removes cheapest 2 nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    // 2 cheapest = 1500 + 1500 = 3000
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(3000);
  });

  it("removes cheapest 3 nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 3 };
    // 3 cheapest = 1500 + 1500 + 1500 = 4500
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(4500);
  });

  it("removes cheapest 4 nights (mix of prices)", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    // 4 cheapest = 1500 + 1500 + 1500 + 4500 = 9000
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(9000);
  });

  it("handles freeNights exceeding total nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 100 };
    // All 6 = 18000
    const result = calculatePromoDiscount(promo, total, perNightRates);
    expect(result.discountCents).toBe(18000);
    expect(result.freeNightsUsed).toBe(6);
  });

  it("returns 0 when no perNightRates provided", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    expect(calculatePromoDiscount(promo, total).discountCents).toBe(0);
  });

  it("returns 0 for zero freeNights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 0 };
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(0);
  });

  it("returns 0 for null freeNights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: null };
    expect(calculatePromoDiscount(promo, total, perNightRates).discountCents).toBe(0);
  });

  it("handles single-night stay with FREE_NIGHTS", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };
    const singleNightRates = [4500];
    expect(calculatePromoDiscount(promo, 4500, singleNightRates).discountCents).toBe(4500);
  });

  it("handles single-night stay with more free nights than available", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 3 };
    const singleNightRates = [4500];
    // Only 1 night available, so just that 1 night free
    const result = calculatePromoDiscount(promo, 4500, singleNightRates);
    expect(result.discountCents).toBe(4500);
    expect(result.freeNightsUsed).toBe(1);
  });

  it("selects cheapest nights correctly with varied rates", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    const variedRates = [5000, 2000, 3000, 1000, 4000];
    // Sorted: 1000, 2000, 3000, 4000, 5000
    // 2 cheapest = 1000 + 2000 = 3000
    expect(calculatePromoDiscount(promo, 15000, variedRates).discountCents).toBe(3000);
  });

  it("returns correct freeNightsUsed count", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 3 };
    const result = calculatePromoDiscount(promo, total, perNightRates);
    expect(result.freeNightsUsed).toBe(3);
  });
});

// --- Cumulative Free Nights (remainingFreeNights) ---

describe("calculatePromoDiscount - remainingFreeNights", () => {
  const perNightRates = [4500, 4500, 4500]; // 3 nights at $45
  const total = 13500;

  it("caps free nights at remaining allowance", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    // Promo allows 4 free nights, but only 2 remaining
    const result = calculatePromoDiscount(promo, total, perNightRates, 2);
    expect(result.discountCents).toBe(9000); // 2 nights at 4500
    expect(result.freeNightsUsed).toBe(2);
  });

  it("uses full promo freeNights when remaining exceeds promo value", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    // 10 remaining, but promo only gives 2
    const result = calculatePromoDiscount(promo, total, perNightRates, 10);
    expect(result.discountCents).toBe(9000); // 2 nights at 4500
    expect(result.freeNightsUsed).toBe(2);
  });

  it("returns 0 when remaining is 0", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    const result = calculatePromoDiscount(promo, total, perNightRates, 0);
    expect(result.discountCents).toBe(0);
    expect(result.freeNightsUsed).toBe(0);
  });

  it("caps at 1 remaining free night", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    const result = calculatePromoDiscount(promo, total, perNightRates, 1);
    expect(result.discountCents).toBe(4500); // 1 cheapest night
    expect(result.freeNightsUsed).toBe(1);
  });

  it("ignores remainingFreeNights for PERCENTAGE type", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, total, perNightRates, 0);
    expect(result.discountCents).toBe(6750); // 50% of 13500
  });

  it("ignores remainingFreeNights for FIXED_AMOUNT type", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscount(promo, total, perNightRates, 0);
    expect(result.discountCents).toBe(5000);
  });

  it("works without remainingFreeNights (undefined = no cap)", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    const result = calculatePromoDiscount(promo, total, perNightRates, undefined);
    // No cap, so uses min(4, 3 nights) = 3
    expect(result.discountCents).toBe(13500);
    expect(result.freeNightsUsed).toBe(3);
  });

  it("handles committee member scenario: 4 free nights, used 2, booking 3 nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    // Member has used 2 of 4 free nights, remaining = 2
    // Booking is 3 nights at $45 each
    const result = calculatePromoDiscount(promo, total, perNightRates, 2);
    expect(result.discountCents).toBe(9000); // 2 cheapest nights (both $45)
    expect(result.freeNightsUsed).toBe(2);
  });
});

describe("calculatePromoDiscountForGuestRates", () => {
  it("scopes assigned free-night promos to the assigned member's own guest nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };

    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", perNightRates: [5000] },
        { memberId: "member-2", perNightRates: [2000] },
      ],
      ["member-1"]
    );

    expect(result.discountCents).toBe(5000);
  });

  it("keeps using all guest nights for unassigned free-night promos", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };

    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", perNightRates: [5000] },
        { memberId: "member-2", perNightRates: [2000] },
      ],
      null
    );

    expect(result.discountCents).toBe(2000);
  });

  it("returns 0 when the assigned member is not included as a linked guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };

    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [{ memberId: "member-2", perNightRates: [2000, 2000] }],
      ["member-1"]
    );

    expect(result.discountCents).toBe(0);
  });

  it("passes remainingFreeNights through to limit free nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };

    const result = calculatePromoDiscountForGuestRates(
      promo,
      15000,
      "member-1",
      [
        { memberId: "member-1", perNightRates: [5000, 5000, 5000] },
      ],
      ["member-1"],
      undefined,
      2 // only 2 remaining
    );

    expect(result.discountCents).toBe(10000); // 2 nights at $50
    expect(result.freeNightsUsed).toBe(2);
  });

  it("committee member scenario: 3-night stay with family, 2 remaining free nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };

    // Committee member + family member, 3 nights
    const result = calculatePromoDiscountForGuestRates(
      promo,
      27000, // total for both guests
      "committee-member",
      [
        { memberId: "committee-member", perNightRates: [4500, 4500, 4500] }, // member's nights
        { memberId: "family-member", perNightRates: [4500, 4500, 4500] },    // family nights
      ],
      ["committee-member"], // assigned to committee member
      undefined,
      2 // only 2 remaining
    );

    // Should only discount committee member's nights (assigned), capped at 2
    expect(result.discountCents).toBe(9000); // 2 nights at $45
    expect(result.freeNightsUsed).toBe(2);
  });
});

describe("edge cases", () => {
  it("zero-value promo code (PERCENTAGE 0%)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("zero-value promo code (FIXED_AMOUNT $0)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    expect(calculatePromoDiscount(promo, 10000).discountCents).toBe(0);
  });

  it("discount on zero total (PERCENTAGE)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    expect(calculatePromoDiscount(promo, 0).discountCents).toBe(0);
  });

  it("discount on zero total (FIXED_AMOUNT)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    expect(calculatePromoDiscount(promo, 0).discountCents).toBe(0);
  });

  it("discount on zero total (FREE_NIGHTS with empty rates)", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    expect(calculatePromoDiscount(promo, 0, []).discountCents).toBe(0);
  });
});
