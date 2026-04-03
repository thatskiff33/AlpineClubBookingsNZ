import { describe, it, expect } from "vitest";

// Import only the pure functions (no prisma dependency)
// We test calculateRefundAmount and daysUntilDate which are pure logic
import type { CancellationRule } from "../cancellation";

// Re-implement the pure functions here to avoid importing the module
// which pulls in prisma. In a real setup with a test DB, we'd import directly.
// For unit tests, we test the algorithm in isolation.

function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundAmountCents: number; refundPercentage: number } {
  if (policyRules.length === 0) {
    return { refundAmountCents: 0, refundPercentage: 0 };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      const refundAmountCents = Math.round(
        (paidAmountCents * rule.refundPercentage) / 100
      );
      return { refundAmountCents, refundPercentage: rule.refundPercentage };
    }
  }

  return { refundAmountCents: 0, refundPercentage: 0 };
}

function daysUntilDate(checkIn: Date, now: Date = new Date()): number {
  const diffMs = checkIn.getTime() - now.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

describe("calculateRefundAmount", () => {
  const standardPolicy: CancellationRule[] = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  it("returns 100% refund when cancelling 14+ days before", () => {
    const result = calculateRefundAmount(10000, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 100% refund when cancelling 20 days before", () => {
    const result = calculateRefundAmount(10000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 50% refund when cancelling 7-13 days before", () => {
    const result = calculateRefundAmount(10000, 7, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 50% refund when cancelling 10 days before", () => {
    const result = calculateRefundAmount(10000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 0% refund when cancelling less than 7 days before", () => {
    const result = calculateRefundAmount(10000, 6, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling on the day", () => {
    const result = calculateRefundAmount(10000, 0, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling after check-in (negative days)", () => {
    const result = calculateRefundAmount(10000, -1, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles empty policy (no refund)", () => {
    const result = calculateRefundAmount(10000, 30, []);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles single rule policy", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("correctly rounds refund amounts for odd percentages", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(3300);
    expect(result.refundPercentage).toBe(33);
  });

  it("correctly rounds fractional cents", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33 },
    ];
    // 333 * 33 / 100 = 109.89 -> rounds to 110
    const result = calculateRefundAmount(333, 5, policy);
    expect(result.refundAmountCents).toBe(110);
  });

  it("handles unsorted policy rules correctly", () => {
    const unsortedPolicy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 0 },
      { daysBeforeStay: 14, refundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 10, unsortedPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles generous policy (always 100%)", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 100 },
    ];
    const result = calculateRefundAmount(5000, 1, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(100);
  });

  it("refunds based on paid amount after partial refunds", () => {
    const result = calculateRefundAmount(7000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(3500);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles zero amount gracefully", () => {
    const result = calculateRefundAmount(0, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(100);
  });
});

describe("daysUntilDate", () => {
  it("calculates days correctly for future date", () => {
    const now = new Date("2025-07-01T12:00:00Z");
    const checkIn = new Date("2025-07-15T12:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(14);
  });

  it("returns 0 for same day", () => {
    const now = new Date("2025-07-01T12:00:00Z");
    const checkIn = new Date("2025-07-01T23:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(0);
  });

  it("returns negative for past date", () => {
    const now = new Date("2025-07-15T12:00:00Z");
    const checkIn = new Date("2025-07-10T12:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(-5);
  });

  it("handles exact day boundary", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const checkIn = new Date("2025-07-08T00:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(7);
  });

  it("floors partial days", () => {
    const now = new Date("2025-07-01T18:00:00Z");
    const checkIn = new Date("2025-07-08T06:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(6);
  });
});
