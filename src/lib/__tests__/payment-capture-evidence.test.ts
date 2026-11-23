import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  paymentHasCaptureEvidence,
  type CaptureEvidencePayment,
} from "@/lib/payment-capture-evidence";

function payment(
  overrides: Partial<CaptureEvidencePayment> = {}
): CaptureEvidencePayment {
  return {
    id: overrides.id ?? "pay_1",
    bookingId: overrides.bookingId ?? "bk_1",
    source: overrides.source ?? PaymentSource.STRIPE,
    status: overrides.status ?? PaymentStatus.FAILED,
    amountCents: overrides.amountCents ?? 10_000,
    refundedAmountCents: overrides.refundedAmountCents ?? 0,
    transactions: overrides.transactions ?? [],
    booking: overrides.booking ?? { organiserSettled: false, parentBookingId: null },
  };
}

describe("paymentHasCaptureEvidence (mirror of booking-cancel #1489 discriminator)", () => {
  it("treats any captured ledger row as capture evidence, incl. IB", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({
          source: PaymentSource.INTERNET_BANKING,
          transactions: [{ status: PaymentStatus.SUCCEEDED }],
        })
      )
    ).toBe(true);
  });

  it("trusts the STRIPE-only refund mirror for pre-ledger rows", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({ source: PaymentSource.STRIPE, refundedAmountCents: 2_500 })
      )
    ).toBe(true);
  });

  it("does NOT trust the mirror for a folded never-captured IB payment", () => {
    // The inbound reconcile folds credit notes into refundedAmountCents on
    // never-captured IB payments (zero cash) — these must stay FAILED.
    expect(
      paymentHasCaptureEvidence(
        payment({
          source: PaymentSource.INTERNET_BANKING,
          refundedAmountCents: 3_000,
          transactions: [],
        })
      )
    ).toBe(false);
  });

  it("finds no evidence for a genuinely never-captured STRIPE row (mirror clean)", () => {
    expect(
      paymentHasCaptureEvidence(
        payment({ source: PaymentSource.STRIPE, refundedAmountCents: 0 })
      )
    ).toBe(false);
  });
});
