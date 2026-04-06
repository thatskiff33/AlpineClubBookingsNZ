import { describe, it, expect } from "vitest";
import type { CancellationRule } from "../cancellation";

// Re-implement pure functions to avoid prisma import (same pattern as cancellation.test.ts)

function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundPercentage: number; daysBeforeStay: number } {
  if (policyRules.length === 0) {
    return { refundPercentage: 0, daysBeforeStay: 0 };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return {
        refundPercentage: rule.refundPercentage,
        daysBeforeStay: rule.daysBeforeStay,
      };
    }
  }

  return { refundPercentage: 0, daysBeforeStay: 0 };
}

interface ChangeFeeInput {
  daysUntilOriginalCheckIn: number;
  daysUntilNewCheckIn: number;
  originalFinalPriceCents: number;
  policyRules: CancellationRule[];
}

interface ChangeFeeResult {
  feeCents: number;
  fromTierRefundPct: number;
  toTierRefundPct: number;
}

function calculateChangeFee(input: ChangeFeeInput): ChangeFeeResult {
  const {
    daysUntilOriginalCheckIn,
    daysUntilNewCheckIn,
    originalFinalPriceCents,
    policyRules,
  } = input;

  const fromTier = getRefundTier(daysUntilOriginalCheckIn, policyRules);
  const toTier = getRefundTier(daysUntilNewCheckIn, policyRules);

  const fromTierRefundPct = fromTier.refundPercentage;
  const toTierRefundPct = toTier.refundPercentage;

  if (toTierRefundPct <= fromTierRefundPct) {
    return { feeCents: 0, fromTierRefundPct, toTierRefundPct };
  }

  const feeCents = Math.round(
    ((toTierRefundPct - fromTierRefundPct) / 100) * originalFinalPriceCents
  );

  return { feeCents, fromTierRefundPct, toTierRefundPct };
}

// Re-implement refund with change fee exclusion (FEE-03)
function calculateRefundWithChangeFee(
  paidAmountCents: number,
  changeFeeCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundAmountCents: number; refundPercentage: number; refundableBaseCents: number } {
  const refundableBaseCents = paidAmountCents - changeFeeCents;
  const { refundPercentage } = getRefundTier(daysUntilCheckIn, policyRules);
  const refundAmountCents = Math.round(
    (refundableBaseCents * refundPercentage) / 100
  );
  return { refundAmountCents, refundPercentage, refundableBaseCents };
}

const standardPolicy: CancellationRule[] = [
  { daysBeforeStay: 14, refundPercentage: 100 },
  { daysBeforeStay: 7, refundPercentage: 50 },
  { daysBeforeStay: 0, refundPercentage: 0 },
];

// ==================== FEE-02: Change Fee Calculation ====================

describe("calculateChangeFee", () => {
  describe("tier transitions with fees", () => {
    it("AC1: 0% tier -> 100% tier charges full difference", () => {
      // 5 days out (0%) moved to 20 days out (100%), $200 booking
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(20000);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("AC2: 50% tier -> 100% tier charges half", () => {
      // 10 days out (50%) moved to 20 days out (100%), $200 booking
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 10,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(10000);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("AC5: 0% tier -> 50% tier charges 50%", () => {
      // 5 days out (0%) moved to 10 days out (50%), $200 booking
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 10,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(10000);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(50);
    });
  });

  describe("same or stricter tier - no fee", () => {
    it("AC3: same tier (100% -> 100%) charges nothing", () => {
      // 20 days out (100%) moved to 25 days out (100%)
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 20,
        daysUntilNewCheckIn: 25,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(100);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("AC4: moving to stricter tier (100% -> 50%) charges nothing", () => {
      // 20 days out (100%) moved to 10 days out (50%)
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 20,
        daysUntilNewCheckIn: 10,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(100);
      expect(result.toTierRefundPct).toBe(50);
    });

    it("moving to much stricter tier (50% -> 0%) charges nothing", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 10,
        daysUntilNewCheckIn: 3,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(0);
    });

    it("same tier (50% -> 50%) charges nothing", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 8,
        daysUntilNewCheckIn: 12,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(50);
    });

    it("same tier (0% -> 0%) charges nothing", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 2,
        daysUntilNewCheckIn: 5,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(0);
    });
  });

  describe("boundary conditions", () => {
    it("exact boundary: 6 days (0%) -> exactly 7 days (50%)", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 6,
        daysUntilNewCheckIn: 7,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(10000);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(50);
    });

    it("exact boundary: 13 days (50%) -> exactly 14 days (100%)", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 13,
        daysUntilNewCheckIn: 14,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(10000);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("at boundary: exactly 7 days (50%) -> exactly 14 days (100%)", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 7,
        daysUntilNewCheckIn: 14,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(10000);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("just inside boundary: exactly 7 days (50%) stays 50%", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 7,
        daysUntilNewCheckIn: 13,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(50);
    });
  });

  describe("edge cases", () => {
    it("empty policy returns zero fee", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: [],
      });
      expect(result.feeCents).toBe(0);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(0);
    });

    it("zero price booking charges zero fee", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 0,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
    });

    it("negative days (past check-in) treated as 0% tier", () => {
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: -1,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(20000);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(100);
    });

    it("rounds fractional cents correctly", () => {
      // 50% tier diff on odd amount: (50/100) * 333 = 166.5 -> 167
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 10,
        originalFinalPriceCents: 333,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(167);
    });

    it("handles single-rule policy (always 100%)", () => {
      const policy: CancellationRule[] = [
        { daysBeforeStay: 0, refundPercentage: 100 },
      ];
      // Both tiers are 100%, so no fee
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: policy,
      });
      expect(result.feeCents).toBe(0);
    });

    it("handles unsorted policy rules", () => {
      const unsorted: CancellationRule[] = [
        { daysBeforeStay: 0, refundPercentage: 0 },
        { daysBeforeStay: 14, refundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50 },
      ];
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 5,
        daysUntilNewCheckIn: 20,
        originalFinalPriceCents: 20000,
        policyRules: unsorted,
      });
      expect(result.feeCents).toBe(20000);
    });

    it("four-tier policy: 0% -> 75% charges 75%", () => {
      const fourTier: CancellationRule[] = [
        { daysBeforeStay: 21, refundPercentage: 100 },
        { daysBeforeStay: 14, refundPercentage: 75 },
        { daysBeforeStay: 7, refundPercentage: 50 },
        { daysBeforeStay: 0, refundPercentage: 0 },
      ];
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 3,
        daysUntilNewCheckIn: 18,
        originalFinalPriceCents: 10000,
        policyRules: fourTier,
      });
      expect(result.feeCents).toBe(7500);
      expect(result.fromTierRefundPct).toBe(0);
      expect(result.toTierRefundPct).toBe(75);
    });

    it("four-tier policy: 50% -> 75% charges 25%", () => {
      const fourTier: CancellationRule[] = [
        { daysBeforeStay: 21, refundPercentage: 100 },
        { daysBeforeStay: 14, refundPercentage: 75 },
        { daysBeforeStay: 7, refundPercentage: 50 },
        { daysBeforeStay: 0, refundPercentage: 0 },
      ];
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 10,
        daysUntilNewCheckIn: 18,
        originalFinalPriceCents: 10000,
        policyRules: fourTier,
      });
      expect(result.feeCents).toBe(2500);
      expect(result.fromTierRefundPct).toBe(50);
      expect(result.toTierRefundPct).toBe(75);
    });

    it("checkOut-only change (same checkIn) would produce zero fee", () => {
      // If checkIn doesn't change, both daysUntil values are the same
      const result = calculateChangeFee({
        daysUntilOriginalCheckIn: 10,
        daysUntilNewCheckIn: 10,
        originalFinalPriceCents: 20000,
        policyRules: standardPolicy,
      });
      expect(result.feeCents).toBe(0);
    });
  });
});

// ==================== FEE-03: Change Fee + Cancellation ====================

describe("calculateRefundWithChangeFee (FEE-03)", () => {
  it("AC1: $200 booking + $200 change fee, 100% refund tier -> refunds $200", () => {
    // Paid $400 total ($200 booking + $200 fee), fee non-refundable
    // Refund base = $400 - $200 = $200, 100% of $200 = $200
    const result = calculateRefundWithChangeFee(40000, 20000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(20000);
    expect(result.refundPercentage).toBe(100);
    expect(result.refundableBaseCents).toBe(20000);
  });

  it("AC2: $200 booking + $100 change fee, 50% refund tier -> refunds $100", () => {
    // Paid $300 total, refund base = $300 - $100 = $200, 50% of $200 = $100
    const result = calculateRefundWithChangeFee(30000, 10000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(50);
    expect(result.refundableBaseCents).toBe(20000);
  });

  it("AC3: no change fee - cancellation identical to current behaviour", () => {
    const result = calculateRefundWithChangeFee(20000, 0, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(20000);
    expect(result.refundPercentage).toBe(100);
    expect(result.refundableBaseCents).toBe(20000);
  });

  it("0% refund tier with change fee -> refunds nothing", () => {
    // 5 days out -> 0% refund, doesn't matter what fee is
    const result = calculateRefundWithChangeFee(30000, 10000, 5, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
    expect(result.refundableBaseCents).toBe(20000);
  });

  it("change fee equals full paid amount -> refundable base is 0", () => {
    const result = calculateRefundWithChangeFee(20000, 20000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(100);
    expect(result.refundableBaseCents).toBe(0);
  });

  it("large change fee with partial refund tier", () => {
    // Paid $500, change fee $150, 50% refund
    // Refund base = $500 - $150 = $350, 50% of $350 = $175
    const result = calculateRefundWithChangeFee(50000, 15000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(17500);
    expect(result.refundPercentage).toBe(50);
    expect(result.refundableBaseCents).toBe(35000);
  });

  it("rounds correctly with odd amounts", () => {
    // Paid $333, change fee $100, 50% refund
    // Refund base = $333 - $100 = $233, 50% of $233 = $116.50 -> 117
    const result = calculateRefundWithChangeFee(33300, 10000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(11650);
    expect(result.refundPercentage).toBe(50);
    expect(result.refundableBaseCents).toBe(23300);
  });

  it("empty policy with change fee -> zero refund", () => {
    const result = calculateRefundWithChangeFee(30000, 10000, 20, []);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("multiple change fees accumulated in changeFeeCents", () => {
    // Simulate: original $200, two modifications each added $50 fee = $100 total change fees
    // Total paid = $200 + $100 = $300
    // Refund base = $300 - $100 = $200, 100% refund = $200
    const result = calculateRefundWithChangeFee(30000, 10000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(20000);
    expect(result.refundableBaseCents).toBe(20000);
  });
});
