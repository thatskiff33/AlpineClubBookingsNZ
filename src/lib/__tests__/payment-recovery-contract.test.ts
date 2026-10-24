import { describe, expect, it } from "vitest";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  isExistingCardTransactionStatusUnconfirmed,
  isPaymentReceivedFinalisationPending,
  isPaymentReceivedStatusUnconfirmed,
  isRefundedCardTransactionRepaymentRequired,
  isSupersededCardPaymentRefunding,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
  REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
  SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY,
} from "@/lib/payment-recovery-contract";

describe("ordinary post-capture payment recovery contract", () => {
  it("recognises only the two positive captured-and-pending facts", () => {
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
        finalisationPending: true,
      }),
    ).toBe(true);
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
      }),
    ).toBe(false);
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        finalisationPending: true,
      }),
    ).toBe(false);
  });

  it("accepts only the exact status-unconfirmed marker", () => {
    expect(
      isPaymentReceivedStatusUnconfirmed(
        PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
      ),
    ).toBe(true);
    expect(
      isPaymentReceivedStatusUnconfirmed({
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        bookingStatusUnconfirmed: false,
      }),
    ).toBe(false);
    expect(
      isPaymentReceivedStatusUnconfirmed({
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        finalisationPending: true,
      }),
    ).toBe(false);
  });

  it("does not expose an intent id or claim finalisation is pending", () => {
    expect(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "paymentIntentId",
    );
    expect(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "finalisationPending",
    );
  });

  it("keeps succeeded-observed recovery separate from payment-received claims", () => {
    expect(
      isExistingCardTransactionStatusUnconfirmed(
        EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
      ),
    ).toBe(true);
    expect(EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "paymentReceived",
    );
    expect(
      isExistingCardTransactionStatusUnconfirmed({
        ...EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
        paymentReceived: true,
      }),
    ).toBe(false);
  });

  it("recognises only the paired local-refund and repayment-required facts", () => {
    expect(
      isRefundedCardTransactionRepaymentRequired(
        REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
      ),
    ).toBe(true);
    expect(
      isRefundedCardTransactionRepaymentRequired({
        ...REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
        repaymentRequired: false,
      }),
    ).toBe(false);
    expect(REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY).not.toHaveProperty(
      "paymentReceived",
    );
    expect(REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY).not.toHaveProperty(
      "paymentIntentId",
    );
  });

  it("#4300: recognises only the paired refunding and repayment-required facts of a superseded payment", () => {
    expect(isSupersededCardPaymentRefunding(SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY)).toBe(true);
    expect(isSupersededCardPaymentRefunding({ ...SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY, repaymentRequired: false })).toBe(false);
    expect(isSupersededCardPaymentRefunding({ ...SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY, paymentRefunding: false })).toBe(false);
    expect(isSupersededCardPaymentRefunding(REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY)).toBe(false);
    // Never a claim that the booking was paid, and no provider id.
    expect(SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY).not.toHaveProperty("paymentReceived");
    expect(SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY).not.toHaveProperty("paymentIntentId");
  });
});
