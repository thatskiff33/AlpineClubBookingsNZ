/**
 * #4052: every door's Booking Modified email names an edit's additional
 * payment - its figure and how it is paid - through one decision, so the two
 * cannot drift apart. The door-level regressions sit with each door's suite
 * (`phase8b-booking-mods`, `fix-mod-payment`, `batch-modify-payment`).
 */
import { PaymentSource } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { additionalAskEmailTerms, asksMemberCard } from "@/lib/additional-ask-email-terms";

const CARD_ASK = { amountCents: 2_000, reissuesUnpaidAsk: false };
const NO_ASK = { amountCents: 0, reissuesUnpaidAsk: false };
const LIVE = { additionalAskRetired: false };
const RETIRED = { additionalAskRetired: true };

describe("additionalAskEmailTerms", () => {
  it.each([
    // A card-settled booking's ask - minted, or waiting on its failed mint's retry: the email cannot tell, and must not.
    ["a card-paid booking's ask", { additionalAsk: CARD_ASK, hasSucceededPayment: true, paymentSource: PaymentSource.STRIPE }],
    // #3502: a credit-paid ($0) booking's card-eligible increase arrives here exactly so;
    // the real settlement's answer for one is pinned in `booking-modify-reduction-unpaid-ask.test.ts`.
    // #3954: a re-issue was asked of the card already, captured or not.
    ["a re-issued ask on a booking that captured nothing", { additionalAsk: { amountCents: 2_000, reissuesUnpaidAsk: true }, hasSucceededPayment: false, paymentSource: PaymentSource.STRIPE }],
  ])("MUTATION: names %s as a card payment, at its figure", (_label, edit) => {
    expect(additionalAskEmailTerms({ ...edit, additionalAmountCents: 2_000 }, LIVE)).toEqual({
      additionalAmountCents: 2_000,
      additionalPaymentMethod: "STRIPE",
    });
  });

  it("MUTATION: names an Internet Banking booking's supplementary invoice as an Internet Banking payment", () => {
    expect(
      additionalAskEmailTerms(
        { additionalAsk: NO_ASK, hasSucceededPayment: false, paymentSource: PaymentSource.INTERNET_BANKING, additionalAmountCents: 2_000 },
        LIVE,
      ),
    ).toEqual({ additionalAmountCents: 2_000, additionalPaymentMethod: "INTERNET_BANKING" });
  });

  it("names a figure no card ask stands behind, on a booking not paid by Internet Banking, without a method", () => {
    expect(
      additionalAskEmailTerms(
        { additionalAsk: NO_ASK, hasSucceededPayment: false, paymentSource: PaymentSource.STRIPE, additionalAmountCents: 2_000 },
        LIVE,
      ),
    ).toEqual({ additionalAmountCents: 2_000, additionalPaymentMethod: undefined });
  });

  it.each([
    ["zero", { additionalAsk: NO_ASK, hasSucceededPayment: true, paymentSource: PaymentSource.STRIPE, additionalAmountCents: 0 }, LIVE],
    ["an Internet Banking zero", { additionalAsk: NO_ASK, hasSucceededPayment: false, paymentSource: PaymentSource.INTERNET_BANKING, additionalAmountCents: 0 }, LIVE],
    // #3954 round 9: a reduction retired it before it was offered.
    ["a retired card ask", { additionalAsk: CARD_ASK, hasSucceededPayment: true, paymentSource: PaymentSource.STRIPE, additionalAmountCents: 2_000 }, RETIRED],
  ])("names nothing, and no method, for %s", (_label, edit, mint) => {
    expect(additionalAskEmailTerms(edit, mint)).toEqual({ additionalAmountCents: 0, additionalPaymentMethod: undefined });
  });
});

describe("asksMemberCard: the minter's own test", () => {
  it.each([
    [CARD_ASK, true, true],
    [CARD_ASK, false, false],
    [{ amountCents: 2_000, reissuesUnpaidAsk: true }, false, true],
    [NO_ASK, true, false],
  ])("ask %o, settled by card %s -> %s", (additionalAsk, hasSucceededPayment, expected) => {
    expect(asksMemberCard({ additionalAsk, hasSucceededPayment })).toBe(expected);
  });
});
