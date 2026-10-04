import { describe, expect, it } from "vitest";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
  stripeRefundMirrorShowsCapture,
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

  it("trusts a refund mirror as capture evidence on a STRIPE payment only (#1473/#1491)", () => {
    const stripe = { source: "STRIPE", status: "FAILED", refundedAmountCents: 0 };
    expect(stripeRefundMirrorShowsCapture(stripe)).toBe(false);
    expect(stripeRefundMirrorShowsCapture({ ...stripe, status: "REFUNDED" })).toBe(true);
    expect(stripeRefundMirrorShowsCapture({ ...stripe, status: "PARTIALLY_REFUNDED" })).toBe(true);
    expect(stripeRefundMirrorShowsCapture({ ...stripe, refundedAmountCents: 1 })).toBe(true);
    // The inbound reconcile folds credit notes into a never-captured Internet
    // Banking payment's mirror: bookkeeping, not cash.
    expect(
      stripeRefundMirrorShowsCapture({ source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 5000 })
    ).toBe(false);
  });
});
