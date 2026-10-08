import { describe, expect, it } from "vitest";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";

describe("getCancellationSettlementBreakdown", () => {
  it("separates account credit from card refunds", () => {
    const result = getCancellationSettlementBreakdown(7000, [
      {
        amountCents: 5000,
        description: "Cancellation refund for booking abc123",
        type: "CANCELLATION_REFUND",
        restoredFromBookingId: null,
      },
      {
        amountCents: 1200,
        description: "Credit restored from cancelled booking abc123",
        type: "CANCELLATION_REFUND",
        restoredFromBookingId: "abc123",
      },
    ]);

    expect(result.accountCreditCents).toBe(5000);
    expect(result.restoredAppliedCreditCents).toBe(1200);
    expect(result.refundToOriginalMethodCents).toBe(2000);
  });

  it("tells a restore apart by the one test: the marker, or a pre-8-Jul row's type and description", () => {
    const result = getCancellationSettlementBreakdown(0, [
      // Written before `restoredFromBookingId` existed (8 Jul 2026, #1636).
      {
        amountCents: 1200,
        description: "Credit restored from cancelled booking abc123",
        type: "CANCELLATION_REFUND",
        restoredFromBookingId: null,
      },
      // The marker decides, whatever the text says.
      {
        amountCents: 300,
        description: "Restored",
        type: "CANCELLATION_REFUND",
        restoredFromBookingId: "abc123",
      },
      // The restore text on another type is not a restore.
      {
        amountCents: 50,
        description: "Credit restored from cancelled booking abc123",
        type: "BOOKING_MODIFICATION_REFUND",
        restoredFromBookingId: null,
      },
    ]);

    expect(result.restoredAppliedCreditCents).toBe(1500);
    expect(result.accountCreditCents).toBe(0);
  });
});

describe("getPaymentDisplayStatus", () => {
  it("labels full account-credit cancellations clearly", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CANCELLED",
      paymentStatus: "REFUNDED",
      refundedAmountCents: 5000,
      credits: [
        {
          amountCents: 5000,
          description: "Cancellation refund for booking abc123",
          type: "CANCELLATION_REFUND",
          restoredFromBookingId: null,
        },
      ],
    });

    expect(result.label).toBe("Credit Issued");
    expect(result.toneStatus).toBe("REFUNDED");
  });

  it("labels card refunds clearly", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CANCELLED",
      paymentStatus: "REFUNDED",
      refundedAmountCents: 5000,
      credits: [],
    });

    expect(result.label).toBe("Refunded to Card");
  });

  it("labels mixed credit and card outcomes clearly", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CANCELLED",
      paymentStatus: "PARTIALLY_REFUNDED",
      refundedAmountCents: 7000,
      credits: [
        {
          amountCents: 5000,
          description: "Cancellation refund for booking abc123",
          type: "CANCELLATION_REFUND",
          restoredFromBookingId: null,
        },
      ],
    });

    expect(result.label).toBe("Partial Credit + Card Refund");
  });

  it("explains processing as awaiting confirmation", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CONFIRMED",
      paymentStatus: "PROCESSING",
      refundedAmountCents: 0,
    });

    expect(result.label).toBe("Awaiting Payment Confirmation");
    expect(result.detail).toContain("Stripe confirmation");
  });

  it("treats cancelled processing payments as cancelled before payment", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CANCELLED",
      paymentStatus: "PROCESSING",
      refundedAmountCents: 0,
    });

    expect(result.label).toBe("Cancelled Before Payment");
  });

  it("distinguishes cancelled bookings that kept the original payment", () => {
    const result = getPaymentDisplayStatus({
      bookingStatus: "CANCELLED",
      paymentStatus: "SUCCEEDED",
      refundedAmountCents: 0,
    });

    expect(result.label).toBe("Cancelled - No Refund");
  });
});
