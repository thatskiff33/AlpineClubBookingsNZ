import { describe, it, expect } from "vitest";
import { validatePromoCodeRules } from "../promo";
import { calculatePromoDiscount, type PromoCodeInput } from "../pricing";

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

// --- Discount Calculation Tests (using pricing.ts calculatePromoDiscount) ---

describe("calculatePromoDiscount - PERCENTAGE", () => {
  it("calculates 20% off $100", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(2000);
  });

  it("calculates 50% off $45.50", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    expect(calculatePromoDiscount(promo, 4550)).toBe(2275);
  });

  it("calculates 100% off", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 100 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(10000);
  });

  it("returns 0 for 0%", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("returns 0 for null percentOff", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("rounds correctly for odd percentages", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 33 };
    // 33% of 10000 = 3300 exactly
    expect(calculatePromoDiscount(promo, 10000)).toBe(3300);
  });

  it("rounds correctly for non-even result", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 15 };
    // 15% of 9999 = 1499.85, rounds to 1500
    expect(calculatePromoDiscount(promo, 9999)).toBe(1500);
  });
});

describe("calculatePromoDiscount - FIXED_AMOUNT", () => {
  it("subtracts fixed amount from total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 3000 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(3000);
  });

  it("caps discount at total price (discount exceeds total)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 15000 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(10000);
  });

  it("returns 0 for zero value", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("returns 0 for null valueCents", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: null };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("handles exact match (discount equals total)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 10000 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(10000);
  });
});

describe("calculatePromoDiscount - FREE_NIGHTS", () => {
  // Scenario: 2 guests, 3 nights each = 6 per-night rates
  const perNightRates = [4500, 4500, 4500, 1500, 1500, 1500];
  const total = 18000; // 3*4500 + 3*1500

  it("removes cheapest 1 night", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };
    // Cheapest = 1500
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(1500);
  });

  it("removes cheapest 2 nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    // 2 cheapest = 1500 + 1500 = 3000
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(3000);
  });

  it("removes cheapest 3 nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 3 };
    // 3 cheapest = 1500 + 1500 + 1500 = 4500
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(4500);
  });

  it("removes cheapest 4 nights (mix of prices)", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 4 };
    // 4 cheapest = 1500 + 1500 + 1500 + 4500 = 9000
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(9000);
  });

  it("handles freeNights exceeding total nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 100 };
    // All 6 = 18000
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(18000);
  });

  it("returns 0 when no perNightRates provided", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    expect(calculatePromoDiscount(promo, total)).toBe(0);
  });

  it("returns 0 for zero freeNights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 0 };
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(0);
  });

  it("returns 0 for null freeNights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: null };
    expect(calculatePromoDiscount(promo, total, perNightRates)).toBe(0);
  });

  it("handles single-night stay with FREE_NIGHTS", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 1 };
    const singleNightRates = [4500];
    expect(calculatePromoDiscount(promo, 4500, singleNightRates)).toBe(4500);
  });

  it("handles single-night stay with more free nights than available", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 3 };
    const singleNightRates = [4500];
    // Only 1 night available, so just that 1 night free
    expect(calculatePromoDiscount(promo, 4500, singleNightRates)).toBe(4500);
  });

  it("selects cheapest nights correctly with varied rates", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    const variedRates = [5000, 2000, 3000, 1000, 4000];
    // Sorted: 1000, 2000, 3000, 4000, 5000
    // 2 cheapest = 1000 + 2000 = 3000
    expect(calculatePromoDiscount(promo, 15000, variedRates)).toBe(3000);
  });
});

describe("edge cases", () => {
  it("zero-value promo code (PERCENTAGE 0%)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("zero-value promo code (FIXED_AMOUNT $0)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    expect(calculatePromoDiscount(promo, 10000)).toBe(0);
  });

  it("discount on zero total (PERCENTAGE)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    expect(calculatePromoDiscount(promo, 0)).toBe(0);
  });

  it("discount on zero total (FIXED_AMOUNT)", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    expect(calculatePromoDiscount(promo, 0)).toBe(0);
  });

  it("discount on zero total (FREE_NIGHTS with empty rates)", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNights: 2 };
    expect(calculatePromoDiscount(promo, 0, [])).toBe(0);
  });
});
