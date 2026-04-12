import { describe, it, expect } from "vitest";
import {
  isGroupDiscountApplicable,
  calculateBookingPrice,
  type SeasonRateData,
  type GroupDiscountConfig,
} from "../pricing";
import { validatePromoCodeRules } from "../promo";
import {
  calculateRefundAmount,
  calculateDualRefundAmounts,
  getRefundTier,
  type CancellationRule,
} from "../cancellation";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeWinterSeason(): SeasonRateData {
  return {
    seasonId: "season-winter",
    startDate: new Date(2026, 5, 1), // June 1
    endDate: new Date(2026, 8, 30), // Sep 30
    type: "WINTER",
    rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
      { ageTier: "ADULT", isMember: false, pricePerNightCents: 6500 },
      { ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
      { ageTier: "YOUTH", isMember: false, pricePerNightCents: 4500 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 1500 },
      { ageTier: "CHILD", isMember: false, pricePerNightCents: 2500 },
    ],
  };
}

function makeSummerSeason(): SeasonRateData {
  return {
    seasonId: "season-summer",
    startDate: new Date(2026, 10, 1), // Nov 1
    endDate: new Date(2027, 2, 31), // Mar 31
    type: "SUMMER",
    rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
      { ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
      { ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
      { ageTier: "YOUTH", isMember: false, pricePerNightCents: 3500 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
      { ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
    ],
  };
}

const allSeasons = [makeWinterSeason(), makeSummerSeason()];

const defaultGroupDiscount: GroupDiscountConfig = {
  minGroupSize: 5,
  summerOnly: true,
  enabled: true,
};

// ─── P5.1: Group Booking Discount ────────────────────────────────────────────

describe("P5.1: Group booking discount", () => {
  describe("isGroupDiscountApplicable", () => {
    it("returns true when guest count meets threshold in summer", () => {
      const summerNight = new Date(2026, 11, 15); // Dec 15
      expect(
        isGroupDiscountApplicable(5, summerNight, allSeasons, defaultGroupDiscount)
      ).toBe(true);
    });

    it("returns false when guest count is below threshold", () => {
      const summerNight = new Date(2026, 11, 15);
      expect(
        isGroupDiscountApplicable(4, summerNight, allSeasons, defaultGroupDiscount)
      ).toBe(false);
    });

    it("returns false for winter when summerOnly is enabled", () => {
      const winterNight = new Date(2026, 6, 15); // Jul 15
      expect(
        isGroupDiscountApplicable(5, winterNight, allSeasons, defaultGroupDiscount)
      ).toBe(false);
    });

    it("returns true for winter when summerOnly is disabled", () => {
      const winterNight = new Date(2026, 6, 15);
      const config = { ...defaultGroupDiscount, summerOnly: false };
      expect(
        isGroupDiscountApplicable(5, winterNight, allSeasons, config)
      ).toBe(true);
    });

    it("returns false when group discount is disabled", () => {
      const summerNight = new Date(2026, 11, 15);
      const config = { ...defaultGroupDiscount, enabled: false };
      expect(
        isGroupDiscountApplicable(10, summerNight, allSeasons, config)
      ).toBe(false);
    });

    it("returns false when no config provided", () => {
      const summerNight = new Date(2026, 11, 15);
      expect(
        isGroupDiscountApplicable(5, summerNight, allSeasons, undefined)
      ).toBe(false);
    });
  });

  describe("calculateBookingPrice with group discount", () => {
    it("charges member rates for all guests when group discount applies in summer", () => {
      const checkIn = new Date(2026, 11, 10); // Dec 10 (summer)
      const checkOut = new Date(2026, 11, 12); // Dec 12 (2 nights)
      const guests = [
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
      ];

      const result = calculateBookingPrice(
        checkIn,
        checkOut,
        guests,
        allSeasons,
        defaultGroupDiscount
      );

      // All 5 non-members should get member rate of 3500/night x 2 nights = 7000 each
      expect(result.totalPriceCents).toBe(5 * 3500 * 2);
    });

    it("charges non-member rates when below group threshold", () => {
      const checkIn = new Date(2026, 11, 10);
      const checkOut = new Date(2026, 11, 11); // 1 night
      const guests = [
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
        { ageTier: "ADULT" as const, isMember: false },
      ];

      const result = calculateBookingPrice(
        checkIn,
        checkOut,
        guests,
        allSeasons,
        defaultGroupDiscount
      );

      // 4 guests below threshold of 5: non-member rate 5000/night
      expect(result.totalPriceCents).toBe(4 * 5000);
    });

    it("does not apply group discount in winter when summerOnly", () => {
      const checkIn = new Date(2026, 6, 10); // Jul 10 (winter)
      const checkOut = new Date(2026, 6, 11); // 1 night
      const guests = Array(6).fill({ ageTier: "ADULT" as const, isMember: false });

      const result = calculateBookingPrice(
        checkIn,
        checkOut,
        guests,
        allSeasons,
        defaultGroupDiscount
      );

      // Winter, summerOnly = true, so non-member rate 6500
      expect(result.totalPriceCents).toBe(6 * 6500);
    });
  });
});

// ─── P5.3: Promo Code Date Gating ───────────────────────────────────────────

describe("P5.3: Promo code booking date gating", () => {
  const basePromo = {
    active: true,
    validFrom: null as Date | null,
    validUntil: null as Date | null,
    maxRedemptions: null as number | null,
    currentRedemptions: 0,
    membersOnly: false,
    singleUse: false,
    bookingStartFrom: new Date("2026-07-01") as Date | null,
    bookingStartUntil: new Date("2026-08-01") as Date | null,
  };

  it("allows booking check-in within gated date range", () => {
    const result = validatePromoCodeRules(
      basePromo,
      { memberId: "m1", bookingCheckIn: new Date("2026-07-15") }
    );
    expect(result).toBeNull();
  });

  it("rejects booking check-in before bookingStartFrom", () => {
    const result = validatePromoCodeRules(
      basePromo,
      { memberId: "m1", bookingCheckIn: new Date("2026-06-30") }
    );
    expect(result).toBe("This promo code is not valid for your booking dates");
  });

  it("rejects booking check-in on or after bookingStartUntil", () => {
    const result = validatePromoCodeRules(
      basePromo,
      { memberId: "m1", bookingCheckIn: new Date("2026-08-01") }
    );
    expect(result).toBe("This promo code is not valid for your booking dates");
  });

  it("allows any check-in when no booking date gating set", () => {
    const promoNoGating = {
      ...basePromo,
      bookingStartFrom: null,
      bookingStartUntil: null,
    };
    const result = validatePromoCodeRules(
      promoNoGating,
      { memberId: "m1", bookingCheckIn: new Date("2025-01-01") }
    );
    expect(result).toBeNull();
  });

  it("allows any check-in when bookingCheckIn not provided", () => {
    const result = validatePromoCodeRules(
      basePromo,
      { memberId: "m1" }
    );
    expect(result).toBeNull();
  });

  it("validates only bookingStartFrom when bookingStartUntil is null", () => {
    const promoFromOnly = {
      ...basePromo,
      bookingStartUntil: null,
    };
    expect(
      validatePromoCodeRules(promoFromOnly, {
        memberId: "m1",
        bookingCheckIn: new Date("2026-07-15"),
      })
    ).toBeNull();
    expect(
      validatePromoCodeRules(promoFromOnly, {
        memberId: "m1",
        bookingCheckIn: new Date("2026-06-15"),
      })
    ).toBe("This promo code is not valid for your booking dates");
  });
});

// ─── P5.5: Mixed Cancellation Fees ──────────────────────────────────────────

describe("P5.5: Mixed cancellation fees (fixedFeeCents)", () => {
  const policyRules: CancellationRule[] = [
    { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 1000 },
    { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75, fixedFeeCents: 2000 },
    { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0 },
  ];

  describe("getRefundTier", () => {
    it("returns fixedFeeCents from the matched tier", () => {
      const tier = getRefundTier(20, policyRules);
      expect(tier.fixedFeeCents).toBe(1000);
      expect(tier.refundPercentage).toBe(100);
    });

    it("returns fixedFeeCents for mid tier", () => {
      const tier = getRefundTier(10, policyRules);
      expect(tier.fixedFeeCents).toBe(2000);
      expect(tier.refundPercentage).toBe(50);
    });

    it("returns 0 fixedFeeCents when no rules", () => {
      const tier = getRefundTier(10, []);
      expect(tier.fixedFeeCents).toBe(0);
    });
  });

  describe("calculateRefundAmount with fixedFeeCents", () => {
    it("deducts fixed fee from percentage refund", () => {
      // 100% of 10000 = 10000, minus 1000 fee = 9000
      const result = calculateRefundAmount(10000, 20, policyRules);
      expect(result.refundAmountCents).toBe(9000);
      expect(result.refundPercentage).toBe(100);
    });

    it("deducts fixed fee from 50% refund", () => {
      // 50% of 10000 = 5000, minus 2000 fee = 3000
      const result = calculateRefundAmount(10000, 10, policyRules);
      expect(result.refundAmountCents).toBe(3000);
      expect(result.refundPercentage).toBe(50);
    });

    it("floors refund at zero when fee exceeds percentage refund", () => {
      // 50% of 2000 = 1000, minus 2000 fee = -1000 → clamped to 0
      const result = calculateRefundAmount(2000, 10, policyRules);
      expect(result.refundAmountCents).toBe(0);
    });

    it("credit refund also deducts fixed fee", () => {
      // credit: 75% of 10000 = 7500, minus 2000 fee = 5500
      const result = calculateRefundAmount(10000, 10, policyRules, "credit");
      expect(result.refundAmountCents).toBe(5500);
    });

    it("works with zero fixed fee", () => {
      const noFeeRules: CancellationRule[] = [
        { daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0 },
      ];
      const result = calculateRefundAmount(10000, 5, noFeeRules);
      expect(result.refundAmountCents).toBe(5000);
    });
  });

  describe("calculateDualRefundAmounts with fixedFeeCents", () => {
    it("applies fixed fee to both card and credit refunds", () => {
      // Card: 50% of 10000 = 5000, minus 2000 = 3000
      // Credit: 75% of 10000 = 7500, minus 2000 = 5500
      const result = calculateDualRefundAmounts(10000, 10, policyRules);
      expect(result.cardRefundAmountCents).toBe(3000);
      expect(result.creditRefundAmountCents).toBe(5500);
    });

    it("floors both at zero", () => {
      const result = calculateDualRefundAmounts(1000, 10, policyRules);
      // Card: 50% of 1000 = 500, minus 2000 = -1500 → 0
      // Credit: 75% of 1000 = 750, minus 2000 = -1250 → 0
      expect(result.cardRefundAmountCents).toBe(0);
      expect(result.creditRefundAmountCents).toBe(0);
    });
  });
});
