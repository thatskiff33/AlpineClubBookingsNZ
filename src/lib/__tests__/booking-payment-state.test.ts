import { describe, expect, it } from "vitest";
import {
  formatPaidRefundedBreakdown,
  getPaymentNetOfRefundsCents,
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
});

/*
  #3372 — the per-payment net the payments list's "Amount (net)" column, its
  sort, the diagnostics subject and the change-requests panel all read, and the
  "paid, refunded or credited" line printed beneath a net headline.
*/
describe("per-payment net and its breakdown line", () => {
  it("nets one payment row with no status gate, unlike the refundable balance", () => {
    // The #3340 booking: $130.00 captured, $65.00 refunded.
    expect(
      getPaymentNetOfRefundsCents({ amountCents: 13_000, refundedAmountCents: 6_500 })
    ).toBe(6_500);
    // An unpaid row still shows its amount in the column; only the refundable
    // balance, which asks "how much could a refund still take?", reads 0.
    const pending = { status: "PENDING", amountCents: 9_000, refundedAmountCents: 0 };
    expect(getPaymentNetOfRefundsCents(pending)).toBe(9_000);
    expect(getRemainingRefundableCents(pending)).toBe(0);
  });

  it("prints gross and refunded in the caller's exact-cents formatter", () => {
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(formatPaidRefundedBreakdown(13_000, 6_500, cents)).toBe(
      "$130.00 paid, $65.00 refunded or credited"
    );
  });

  it("returns null when nothing was refunded or credited, so no caller prints the line", () => {
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(formatPaidRefundedBreakdown(13_000, 0, cents)).toBeNull();
  });
});
