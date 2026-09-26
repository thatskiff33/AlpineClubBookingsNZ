import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";

/**
 * #3567 review: an outstanding ADDITIONAL ask minted before the club changed its
 * currency is re-issued on a new intent in the club's currency, in the same
 * three steps as a modification mint — mint, write the new row FIRST, then
 * supersede the rest and reconcile.
 */

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  getPaymentIntent: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  reconcilePaymentAggregates: vi.fn(),
  queueSupersededAdditionalIntentCancellations: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  getPaymentIntent: mocks.getPaymentIntent,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  reconcilePaymentAggregates: mocks.reconcilePaymentAggregates,
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations:
    mocks.queueSupersededAdditionalIntentCancellations,
}));

import {
  intentCurrencyDiffers,
  reissueAdditionalIntentInClubCurrency,
  reissueRaisedAskIfCurrencyChanged,
} from "@/lib/additional-intent-currency";
import { restateAdditionalAsk } from "@/lib/additional-payment-ask";
import { UnsupportedChargeCurrencyError } from "@/lib/stripe-charge-currency";
import { CLUB_FORMAT_TEST, CLUB_FORMAT_TEST_OTHER } from "./support/club-format-fixture";

const JPY = { currencyCode: "JPY", locale: "ja-JP" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createPaymentIntent.mockResolvedValue({
    id: "pi_chf",
    amount: 4500,
    currency: "chf",
    client_secret: "pi_chf_secret",
  });
  mocks.upsertPaymentIntentTransaction.mockResolvedValue({});
  mocks.queueSupersededAdditionalIntentCancellations.mockResolvedValue([]);
  mocks.reconcilePaymentAggregates.mockResolvedValue(null);
});

describe("intentCurrencyDiffers", () => {
  it("compares Stripe's currency with the club's, ignoring case and surrounding whitespace", () => {
    expect(intentCurrencyDiffers({ currency: "nzd" }, CLUB_FORMAT_TEST)).toBe(false);
    expect(intentCurrencyDiffers({ currency: " NZD " }, CLUB_FORMAT_TEST)).toBe(false);
    expect(intentCurrencyDiffers({ currency: "aud" }, CLUB_FORMAT_TEST)).toBe(true);
    expect(intentCurrencyDiffers({ currency: "CHF" }, CLUB_FORMAT_TEST_OTHER)).toBe(false);
    expect(intentCurrencyDiffers({ currency: "nzd" }, CLUB_FORMAT_TEST_OTHER)).toBe(true);
  });

  it("throws UnsupportedChargeCurrencyError for a club currency without two decimal places", () => {
    expect(() => intentCurrencyDiffers({ currency: "jpy" }, JPY)).toThrow(
      UnsupportedChargeCurrencyError,
    );
  });
});

describe("reissueAdditionalIntentInClubCurrency", () => {
  const ask = restateAdditionalAsk({ amountCents: 4500, carriedAskCents: 1500 });

  it("mints in the club's currency under a key naming the stale intent, the currency and the amount", async () => {
    const pi = await reissueAdditionalIntentInClubCurrency({
      format: CLUB_FORMAT_TEST_OTHER,
      bookingId: "bk1",
      paymentId: "p1",
      staleIntentId: "pi_nzd",
      ask,
      reason: "edit_financial_review_charge",
      customerId: "cus_1",
    });

    expect(pi.id).toBe("pi_chf");
    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST_OTHER,
      amountCents: 4500,
      customerId: "cus_1",
      metadata: {
        bookingId: "bk1",
        type: "modification_additional",
        reason: "edit_financial_review_charge",
      },
      idempotencyKey: "pi_nzd_reissue_chf_4500",
    });
  });

  it("writes the new ADDITIONAL row, keeping the reason and the carried part, BEFORE superseding the rest, then reconciles", async () => {
    await reissueAdditionalIntentInClubCurrency({
      format: CLUB_FORMAT_TEST_OTHER,
      bookingId: "bk1",
      paymentId: "p1",
      staleIntentId: "pi_nzd",
      ask,
      reason: "edit_financial_review_charge",
      customerId: "cus_1",
    });

    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith({
      paymentId: "p1",
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: "pi_chf",
      amountCents: 4500,
      carriedAskCents: 1500,
      status: PaymentStatus.PENDING,
      reason: "edit_financial_review_charge",
      stripeCustomerId: "cus_1",
    });
    expect(mocks.queueSupersededAdditionalIntentCancellations).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST_OTHER,
      bookingId: "bk1",
      paymentId: "p1",
      newPaymentIntentId: "pi_chf",
    });
    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: "p1" });

    const order = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0]!;
    expect(order(mocks.createPaymentIntent)).toBeLessThan(order(mocks.upsertPaymentIntentTransaction));
    expect(order(mocks.upsertPaymentIntentTransaction)).toBeLessThan(
      order(mocks.queueSupersededAdditionalIntentCancellations),
    );
    expect(order(mocks.queueSupersededAdditionalIntentCancellations)).toBeLessThan(
      order(mocks.reconcilePaymentAggregates),
    );
  });

  it("refuses a club currency without two decimal places before minting anything", async () => {
    await expect(
      reissueAdditionalIntentInClubCurrency({
        format: JPY,
        bookingId: "bk1",
        paymentId: "p1",
        staleIntentId: "pi_nzd",
        ask,
        reason: null,
        customerId: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedChargeCurrencyError);
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });
});

describe("reissueRaisedAskIfCurrencyChanged", () => {
  const ask = restateAdditionalAsk({ amountCents: 4500, carriedAskCents: 0 });
  const params = {
    format: CLUB_FORMAT_TEST_OTHER,
    bookingId: "bk1",
    paymentId: "p1",
    staleIntentId: "pi_live",
    ask,
    reason: "edit_financial_review_charge",
  };

  it("returns null and mints nothing when the live intent is already in the club's currency", async () => {
    mocks.getPaymentIntent.mockResolvedValue({ id: "pi_live", currency: "chf", customer: "cus_1" });

    await expect(reissueRaisedAskIfCurrencyChanged(params)).resolves.toBeNull();
    expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_live");
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.queueSupersededAdditionalIntentCancellations).not.toHaveBeenCalled();
  });

  it("re-issues the raised ask in the club's currency when the live intent is in another, keeping the intent's customer", async () => {
    mocks.getPaymentIntent.mockResolvedValue({
      id: "pi_live",
      currency: "nzd",
      customer: { id: "cus_obj" },
    });

    await expect(reissueRaisedAskIfCurrencyChanged(params)).resolves.toBe("pi_chf");
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        customerId: "cus_obj",
        idempotencyKey: "pi_live_reissue_chf_4500",
      }),
    );
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_chf",
        reason: "edit_financial_review_charge",
        carriedAskCents: 0,
      }),
    );
  });
});
