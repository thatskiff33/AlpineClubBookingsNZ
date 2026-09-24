import { describe, expect, it } from "vitest";
import { describeCancellationSchedule } from "@/lib/cancellation-schedule";
import type { NormalizedCancellationRule } from "@/lib/cancellation-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function rule(
  overrides: Partial<NormalizedCancellationRule> & { daysBeforeStay: number },
): NormalizedCancellationRule {
  return {
    refundPercentage: 0,
    creditRefundPercentage: 0,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
    ...overrides,
  };
}

describe("describeCancellationSchedule", () => {
  it("orders tiers and labels the day ranges", () => {
    const rows = describeCancellationSchedule([
      rule({ daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 }),
      rule({ daysBeforeStay: 30, refundPercentage: 100, creditRefundPercentage: 100 }),
      rule({ daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 }),
    ], CLUB_FORMAT_TEST);

    expect(rows.map((row) => row.description)).toEqual([
      "30+ days before stay: 100% refund",
      "7-29 days: 50% refund",
      "Less than 7 days: 0% refund",
    ]);
    expect(rows.map((row) => row.refundPercentage)).toEqual([100, 50, 0]);
  });

  it("splits card vs credit when the credit percentage or fee differs", () => {
    const rows = describeCancellationSchedule([
      rule({
        daysBeforeStay: 14,
        refundPercentage: 50,
        creditRefundPercentage: 75,
      }),
      rule({ daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 }),
    ], CLUB_FORMAT_TEST);

    expect(rows[0].description).toBe("14+ days before stay: 50% card / 75% credit");
  });

  it("appends fixed fees in dollars", () => {
    const rows = describeCancellationSchedule([
      rule({
        daysBeforeStay: 3,
        refundPercentage: 80,
        creditRefundPercentage: 80,
        fixedFeeCents: 500,
        creditFixedFeeCents: 500,
      }),
    ], CLUB_FORMAT_TEST);

    expect(rows[0].description).toBe("3+ days before stay: 80% refund less $5.00 fee");
  });
});
