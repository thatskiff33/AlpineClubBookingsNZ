import { describe, expect, it } from "vitest";
import {
  editReviewRefundIsPaidBackByHand,
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";

describe("booking payment state helpers", () => {
  it("treats pending and failed payments as not captured", () => {
    expect(
      hasCapturedPayment({ status: "PENDING", amountCents: 9000 })
    ).toBe(false);
    expect(
      hasCapturedPayment({ status: "FAILED", amountCents: 9000 })
    ).toBe(false);
  });

  it("returns zero refundable cents when no successful charge exists", () => {
    expect(
      getRemainingRefundableCents({
        status: "PENDING",
        amountCents: 9000,
        refundedAmountCents: 0,
      })
    ).toBe(0);
  });

  it("returns the remaining refundable balance for captured payments", () => {
    expect(
      getRemainingRefundableCents({
        status: "PARTIALLY_REFUNDED",
        amountCents: 9000,
        refundedAmountCents: 2500,
      })
    ).toBe(6500);
  });

  it("does not treat zero-dollar successful records as refundable payments", () => {
    expect(
      hasCapturedPayment({ status: "SUCCEEDED", amountCents: 0 })
    ).toBe(false);
    expect(
      getRemainingRefundableCents({
        status: "SUCCEEDED",
        amountCents: 0,
        refundedAmountCents: 0,
      })
    ).toBe(0);
  });

  it("asks cash-or-bank only where an edit-review refund is paid back by hand (#3536)", () => {
    const captured = (source: string) => ({
      id: "payment-1",
      status: "SUCCEEDED",
      amountCents: 9000,
      refundedAmountCents: 0,
      source,
    });
    // The task's stored payment wins where it has one.
    expect(
      editReviewRefundIsPaidBackByHand({
        paymentId: "payment-1",
        payment: { source: "INTERNET_BANKING" },
        booking: { status: "PAID", payment: captured("STRIPE") },
      }),
    ).toBe(true);
    expect(
      editReviewRefundIsPaidBackByHand({
        paymentId: "payment-1",
        payment: { source: "STRIPE" },
        booking: { status: "PAID", payment: captured("INTERNET_BANKING") },
      }),
    ).toBe(false);
    // With none stored, the booking's captured payment is re-asked now.
    expect(
      editReviewRefundIsPaidBackByHand({
        paymentId: null,
        payment: null,
        booking: { status: "PAID", payment: captured("INTERNET_BANKING") },
      }),
    ).toBe(true);
    // Nothing captured: the refund becomes account credit, never a hand-back.
    expect(
      editReviewRefundIsPaidBackByHand({
        paymentId: null,
        payment: null,
        booking: { status: "PAID", payment: { ...captured("INTERNET_BANKING"), status: "PENDING" } },
      }),
    ).toBe(false);
  });
});
