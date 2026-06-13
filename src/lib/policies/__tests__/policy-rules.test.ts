import { describe, expect, it } from "vitest";
import {
  AGE_TIER_DEFAULTS,
  calculateBookingPrice,
  calculateChangeFee,
  calculateDualRefundAmounts,
  calculateRefundAmount,
  computeAgeTierWithSettings,
  formatViolationsDetail,
  getMinimumStayViolations,
  getRefundTier,
  getSeasonStartDate,
  normalizeAgeTierSettings,
  requiresPaidSubscriptionForAgeTier,
  validateMinimumStayWithPolicies,
  type AgeTierSettingData,
  type CancellationRule,
  type GroupDiscountConfig,
  type MinimumStayPolicyLike,
  type SeasonRateData,
} from "@/lib/policies";

const ref2026 = getSeasonStartDate(2026);

function makeSeason(overrides: Partial<SeasonRateData> = {}): SeasonRateData {
  return {
    seasonId: "summer-2026",
    startDate: new Date(2026, 10, 1),
    endDate: new Date(2027, 2, 31),
    type: "SUMMER",
    rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
      { ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
      { ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
      { ageTier: "YOUTH", isMember: false, pricePerNightCents: 3500 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
      { ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
      { ageTier: "INFANT", isMember: true, pricePerNightCents: 0 },
      { ageTier: "INFANT", isMember: false, pricePerNightCents: 0 },
    ],
    ...overrides,
  };
}

describe("policy age-tier rules", () => {
  it("classifies age-tier boundaries from the season start date", () => {
    expect(
      computeAgeTierWithSettings(new Date("2021-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    expect(
      computeAgeTierWithSettings(new Date("2021-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
    expect(
      computeAgeTierWithSettings(new Date("2016-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
    expect(
      computeAgeTierWithSettings(new Date("2008-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
  });

  it("normalizes empty and legacy settings to configured defaults", () => {
    const legacyRows: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child", sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
    ];

    expect(normalizeAgeTierSettings([])).toEqual(AGE_TIER_DEFAULTS);
    expect(normalizeAgeTierSettings(legacyRows)).toEqual(AGE_TIER_DEFAULTS);
  });
});

describe("policy subscription rules", () => {
  it("uses per-tier subscription settings and defaults missing tiers to required", () => {
    expect(requiresPaidSubscriptionForAgeTier("INFANT", AGE_TIER_DEFAULTS)).toBe(false);
    expect(requiresPaidSubscriptionForAgeTier("CHILD", AGE_TIER_DEFAULTS)).toBe(false);
    expect(requiresPaidSubscriptionForAgeTier("YOUTH", AGE_TIER_DEFAULTS)).toBe(true);
    expect(requiresPaidSubscriptionForAgeTier(undefined, AGE_TIER_DEFAULTS)).toBe(true);
  });
});

describe("policy pricing rules", () => {
  const groupDiscount: GroupDiscountConfig = {
    enabled: true,
    minGroupSize: 5,
    summerOnly: true,
  };

  it("prices bookings with summer group discount membership-rate behavior", () => {
    const guests = Array.from({ length: 5 }, () => ({
      ageTier: "ADULT" as const,
      isMember: false,
    }));

    const result = calculateBookingPrice(
      new Date("2026-12-10"),
      new Date("2026-12-12"),
      guests,
      [makeSeason()],
      groupDiscount
    );

    expect(result.totalPriceCents).toBe(5 * 2 * 3500);
    expect(result.guests[0].perNightCents).toEqual([3500, 3500]);
  });

  it("does not apply group discount below the configured threshold", () => {
    const guests = Array.from({ length: 4 }, () => ({
      ageTier: "ADULT" as const,
      isMember: false,
    }));

    const result = calculateBookingPrice(
      new Date("2026-12-10"),
      new Date("2026-12-11"),
      guests,
      [makeSeason()],
      groupDiscount
    );

    expect(result.totalPriceCents).toBe(4 * 5000);
  });
});

describe("policy cancellation rules", () => {
  const policyRules: CancellationRule[] = [
    { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 500 },
    { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75, fixedFeeCents: 2000, creditFixedFeeCents: 1000 },
    { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  ];

  it("selects refund tiers with fixed fees normalized per refund method", () => {
    expect(getRefundTier(10, policyRules)).toMatchObject({
      refundPercentage: 50,
      creditRefundPercentage: 75,
      fixedFeeCents: 2000,
      creditFixedFeeCents: 1000,
      daysBeforeStay: 7,
    });
  });

  it("calculates card and credit refunds with method-specific fixed fees", () => {
    expect(calculateRefundAmount(10000, 10, policyRules)).toEqual({
      refundAmountCents: 3000,
      refundPercentage: 50,
    });
    expect(calculateRefundAmount(10000, 10, policyRules, "credit")).toEqual({
      refundAmountCents: 6500,
      refundPercentage: 75,
    });
    expect(calculateDualRefundAmounts(1000, 10, policyRules)).toMatchObject({
      cardRefundAmountCents: 0,
      creditRefundAmountCents: 0,
    });
  });
});

describe("policy change-fee rules", () => {
  const standardPolicy: CancellationRule[] = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  it("charges only when moving into a more lenient cancellation tier", () => {
    expect(
      calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      })
    ).toEqual({ feeCents: 20000, fromTierRefundPct: 0, toTierRefundPct: 100 });

    expect(
      calculateChangeFee({
        daysUntilOriginalCheckIn: 20,
        daysUntilNewCheckIn: 10,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      })
    ).toEqual({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 50 });
  });
});

describe("policy minimum-stay rules", () => {
  const saturdayPolicy: MinimumStayPolicyLike = {
    name: "Winter Saturday Minimum Stay",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-09-30"),
    triggerDays: [6],
    minimumNights: 2,
  };

  it("matches pure minimum-stay policies and formats violations", () => {
    const violations = getMinimumStayViolations(
      new Date("2026-07-04"),
      new Date("2026-07-05"),
      [saturdayPolicy]
    );

    expect(violations).toEqual([
      {
        policyName: "Winter Saturday Minimum Stay",
        triggerDay: "Saturday",
        minimumNights: 2,
        actualNights: 1,
      },
    ]);
    expect(formatViolationsDetail(violations)).toBe(
      "Bookings including a Saturday night require a minimum stay of 2 nights (Winter Saturday Minimum Stay). Your booking is 1 night."
    );
  });

  it("returns valid when the stay meets the pure policy", () => {
    expect(
      validateMinimumStayWithPolicies(
        new Date("2026-07-04"),
        new Date("2026-07-06"),
        [saturdayPolicy]
      )
    ).toEqual({ valid: true, violations: [] });
  });
});
