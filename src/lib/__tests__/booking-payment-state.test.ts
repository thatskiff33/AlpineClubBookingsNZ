import { describe, expect, it } from "vitest";
import { PaymentSource } from "@prisma/client";
import {
  editReviewRefundGoesBackOnCard,
  editReviewRefundIsPaidBackByHand,
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

  it("asks the settle screen exactly the complement of the chooser's card test, for every source (#3536, INV-SSOT)", () => {
    // The chooser takes the card route exactly when `editReviewRefundGoesBackOnCard`
    // holds; the screen offers cash-or-bank exactly when it does not. A source
    // added later lands on one side of both, never on opposite sides.
    const sources: Array<string | null> = [...Object.values(PaymentSource), null];
    for (const source of sources) {
      const byHand = editReviewRefundIsPaidBackByHand({
        paymentId: "payment-1",
        payment: source === null ? null : { source },
        booking: { status: "PAID", payment: null },
      });
      expect(byHand).toBe(!editReviewRefundGoesBackOnCard({ source }));
    }
    expect(editReviewRefundGoesBackOnCard({ source: PaymentSource.STRIPE })).toBe(true);
    expect(editReviewRefundGoesBackOnCard({ source: null })).toBe(false);
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
