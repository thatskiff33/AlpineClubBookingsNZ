import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  calculateBookingCreditApplication,
  calculateBookingHoldDecision,
  calculateCancellationPreview,
  isGroupDiscountAppliedToBooking,
  toGroupDiscountConfig,
  toSeasonRateData,
  type CancellationRule,
} from "@/lib/policies";

describe("booking route policy decisions", () => {
  it("normalizes enabled group discount settings and ignores disabled settings", () => {
    expect(
      toGroupDiscountConfig({ enabled: true, minGroupSize: 5, summerOnly: true })
    ).toEqual({ enabled: true, minGroupSize: 5, summerOnly: true });
    expect(
      toGroupDiscountConfig({ enabled: false, minGroupSize: 5, summerOnly: true })
    ).toBeUndefined();
  });

  it("detects group-discount application using the route response contract", () => {
    const seasons = toSeasonRateData([
      {
        id: "summer",
        startDate: new Date("2026-11-01"),
        endDate: new Date("2027-03-31"),
        type: "SUMMER",
        rates: [],
      },
    ]);

    expect(
      isGroupDiscountAppliedToBooking({
        checkIn: new Date("2026-12-10"),
        checkOut: new Date("2026-12-12"),
        guestCount: 5,
        seasons,
        groupDiscount: { enabled: true, minGroupSize: 5, summerOnly: true },
      })
    ).toBe(true);
    expect(
      isGroupDiscountAppliedToBooking({
        checkIn: new Date("2026-12-10"),
        checkOut: new Date("2026-12-12"),
        guestCount: 4,
        seasons,
        groupDiscount: { enabled: true, minGroupSize: 5, summerOnly: true },
      })
    ).toBe(false);
  });

  it("calculates booking hold status with ceil day semantics", () => {
    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        checkIn: new Date("2026-07-10T12:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T13:00:00.000Z"),
      })
    ).toMatchObject({
      daysUntilCheckIn: 7,
      shouldBePending: false,
      status: BookingStatus.PAYMENT_PENDING,
    });

    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        checkIn: new Date("2026-07-11T12:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T13:00:00.000Z"),
      }).status
    ).toBe(BookingStatus.PENDING);
  });

  it("validates booking credit application against balance, status, and price", () => {
    expect(
      calculateBookingCreditApplication({
        requestedCreditCents: 2500,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PAYMENT_PENDING,
      })
    ).toEqual({ creditAppliedCents: 2500, effectivePriceCents: 1500 });

    expect(() =>
      calculateBookingCreditApplication({
        requestedCreditCents: 5000,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PAYMENT_PENDING,
      })
    ).toThrow("Insufficient credit: 3000 cents available, 5000 requested");

    expect(
      calculateBookingCreditApplication({
        requestedCreditCents: 2500,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PENDING,
      })
    ).toEqual({ creditAppliedCents: 0, effectivePriceCents: 4000 });
  });

  it("calculates cancellation preview amounts without route-side refund math", () => {
    const policyRules: CancellationRule[] = [
      {
        daysBeforeStay: 7,
        refundPercentage: 50,
        creditRefundPercentage: 75,
        fixedFeeCents: 1000,
        creditFixedFeeCents: 500,
      },
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
    ];

    expect(
      calculateCancellationPreview({
        payment: {
          amountCents: 10000,
          refundedAmountCents: 1000,
          changeFeeCents: 1000,
          creditAppliedCents: 2000,
        },
        checkIn: new Date("2026-07-15T00:00:00.000Z"),
        policyRules,
        now: new Date("2026-07-05T00:00:00.000Z"),
      })
    ).toMatchObject({
      refundAmountCents: 3000,
      keptAmountCents: 6000,
      changeFeeCents: 1000,
      refundPercentage: 50,
      creditRefundAmountCents: 5500,
      creditRefundPercentage: 75,
      creditRestoredCents: 2000,
      totalPaidCents: 9000,
    });
  });
});
