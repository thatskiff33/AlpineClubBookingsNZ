import { describe, expect, it } from "vitest";
import {
  reusableSavedPaymentMethodOnRow,
  savedPaymentMethodForBooking,
  savedPaymentMethodRowStamp,
  type SavedPaymentMethodRow,
} from "@/lib/saved-payment-method";

// #3269 / INV-PAY-053: a card is chargeable off-session only when the row that
// offers it also carries the SetupIntent that saved it. These pin the one home
// for that decision; the cron, route and page suites pin what each caller does
// with the answer.

const SETUP_INTENT_CARD: SavedPaymentMethodRow = {
  stripeCustomerId: "cus_saved",
  stripePaymentMethodId: "pm_saved",
  stripeSetupIntentId: "seti_saved",
};

// What `markBookingPaymentSucceeded` leaves on a row after a one-off Payment
// Element checkout: customer and payment method, no SetupIntent. Stripe refuses
// to charge this payment method again.
const ONE_OFF_CHECKOUT_CARD: SavedPaymentMethodRow = {
  stripeCustomerId: "cus_oneoff",
  stripePaymentMethodId: "pm_oneoff",
  stripeSetupIntentId: null,
};

describe("reusableSavedPaymentMethodOnRow", () => {
  it("returns the card only when customer, payment method AND SetupIntent are all set", () => {
    expect(reusableSavedPaymentMethodOnRow(SETUP_INTENT_CARD)).toEqual({
      stripeCustomerId: "cus_saved",
      stripePaymentMethodId: "pm_saved",
    });
  });

  it("treats a one-off checkout card (no SetupIntent) as no card", () => {
    expect(reusableSavedPaymentMethodOnRow(ONE_OFF_CHECKOUT_CARD)).toBeNull();
  });

  it.each<[string, SavedPaymentMethodRow]>([
    [
      "a minted-but-unconfirmed SetupIntent (id, no payment method yet)",
      { stripeCustomerId: "cus_x", stripePaymentMethodId: null, stripeSetupIntentId: "seti_x" },
    ],
    [
      "a payment method with no customer to charge it against",
      { stripeCustomerId: null, stripePaymentMethodId: "pm_x", stripeSetupIntentId: "seti_x" },
    ],
    [
      "an Internet Banking row (nothing Stripe at all)",
      { stripeCustomerId: null, stripePaymentMethodId: null, stripeSetupIntentId: null },
    ],
    [
      "empty strings, which are not ids",
      { stripeCustomerId: "", stripePaymentMethodId: "", stripeSetupIntentId: "" },
    ],
  ])("returns null for %s", (_label, row) => {
    expect(reusableSavedPaymentMethodOnRow(row)).toBeNull();
  });

  it("returns null when there is no Payment row", () => {
    expect(reusableSavedPaymentMethodOnRow(null)).toBeNull();
    expect(reusableSavedPaymentMethodOnRow(undefined)).toBeNull();
  });

  it("does not leak the SetupIntent id into the card it returns", () => {
    expect(reusableSavedPaymentMethodOnRow(SETUP_INTENT_CARD)).not.toHaveProperty(
      "stripeSetupIntentId"
    );
  });
});

describe("savedPaymentMethodForBooking", () => {
  it("prefers the booking's own SetupIntent card over the parent's, and says so", () => {
    expect(
      savedPaymentMethodForBooking({
        payment: SETUP_INTENT_CARD,
        parentBooking: {
          payment: { ...SETUP_INTENT_CARD, stripePaymentMethodId: "pm_parent" },
        },
      })
    ).toEqual({
      stripeCustomerId: "cus_saved",
      stripePaymentMethodId: "pm_saved",
      source: "own",
    });
  });

  it("falls back to the split parent's SetupIntent card when the child has none, and says so", () => {
    expect(
      savedPaymentMethodForBooking({
        payment: null,
        parentBooking: { payment: SETUP_INTENT_CARD },
      })
    ).toEqual({
      stripeCustomerId: "cus_saved",
      stripePaymentMethodId: "pm_saved",
      source: "parent",
    });
  });

  it("refuses a parent that paid by one-off card checkout — the production incident", () => {
    expect(
      savedPaymentMethodForBooking({
        payment: null,
        parentBooking: { payment: ONE_OFF_CHECKOUT_CARD },
      })
    ).toBeNull();
  });

  it("no longer counts a legacy laundered child row (parent's one-off card copied on, no SetupIntent) as the child's own card", () => {
    // Before #3269 the cron copied the parent's pm onto the child's row, so a
    // production child carries customer + pm and no SetupIntent. That row must
    // read as "no card" — which is what repairs it without a migration.
    expect(
      savedPaymentMethodForBooking({
        payment: { ...ONE_OFF_CHECKOUT_CARD },
        parentBooking: { payment: ONE_OFF_CHECKOUT_CARD },
      })
    ).toBeNull();
  });

  it("skips a laundered own row and still finds a genuinely saved parent card", () => {
    expect(
      savedPaymentMethodForBooking({
        payment: ONE_OFF_CHECKOUT_CARD,
        parentBooking: { payment: SETUP_INTENT_CARD },
      })
    ).toEqual(expect.objectContaining({ source: "parent", stripePaymentMethodId: "pm_saved" }));
  });

  it("returns null with no parent at all (a non-split booking, or a caller that opted out of the fallback)", () => {
    expect(savedPaymentMethodForBooking({ payment: null, parentBooking: null })).toBeNull();
    expect(
      savedPaymentMethodForBooking({ payment: ONE_OFF_CHECKOUT_CARD, parentBooking: undefined })
    ).toBeNull();
  });
});

describe("savedPaymentMethodRowStamp", () => {
  it("writes customer and payment method back when the card came from this row (a no-op stamp)", () => {
    expect(
      savedPaymentMethodRowStamp({
        stripeCustomerId: "cus_saved",
        stripePaymentMethodId: "pm_saved",
        source: "own",
      })
    ).toEqual({ stripeCustomerId: "cus_saved", stripePaymentMethodId: "pm_saved" });
  });

  it("writes ONLY the customer when the card was borrowed from the parent — never launders the pm onto the child", () => {
    const stamp = savedPaymentMethodRowStamp({
      stripeCustomerId: "cus_parent",
      stripePaymentMethodId: "pm_parent",
      source: "parent",
    });
    expect(stamp).toEqual({ stripeCustomerId: "cus_parent" });
    // The KEY must be absent, not present-and-undefined: Prisma writes an
    // explicit `undefined` as "leave unchanged" today, but an absent key is the
    // only shape that cannot become a write under a future client.
    expect(Object.keys(stamp)).toEqual(["stripeCustomerId"]);
  });
});
