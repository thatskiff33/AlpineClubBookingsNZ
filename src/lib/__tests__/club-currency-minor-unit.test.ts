import { describe, expect, it } from "vitest";

import {
  currencyHasTwoDecimalPlaces,
  twoDecimalPlacesRequiredMessage,
} from "@/lib/club-currency-minor-unit";
import { listSelectableClubCurrencyCodes } from "@/lib/club-format";

/**
 * The one home of "does this currency count in hundredths" (#3567, owner
 * decision D3). The save route, the charge guard in `stripe.ts` and the panel's
 * option list all ask it, so these pin its answers directly.
 */
describe("currencyHasTwoDecimalPlaces", () => {
  it.each(["NZD", "AUD", "CHF", "GBP", "USD", "EUR", "CAD", "NOK"])(
    "accepts %s, a two-decimal currency",
    (code) => {
      expect(currencyHasTwoDecimalPlaces(code)).toBe(true);
    },
  );

  /*
    Stripe's published zero-decimal and three-decimal lists, as literals: if the
    table ever drops one of these, a club in that currency would be charged 100x
    or a tenth of what it is shown, so this must fail.
  */
  const STRIPE_ZERO_DECIMAL = [
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
    "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
  ];
  const STRIPE_THREE_DECIMAL = ["BHD", "JOD", "KWD", "OMR", "TND"];

  it.each([...STRIPE_ZERO_DECIMAL, ...STRIPE_THREE_DECIMAL])(
    "refuses %s, which Stripe does not charge in hundredths",
    (code) => {
      expect(currencyHasTwoDecimalPlaces(code)).toBe(false);
    },
  );

  it.each(["ISK", "IQD", "LYD", "CLF", "XAU", "XTS"])(
    "refuses %s, whose ISO 4217 minor unit is not 2",
    (code) => {
      expect(currencyHasTwoDecimalPlaces(code)).toBe(false);
    },
  );

  it("does not depend on the engine: HUF, IDR and COP count in hundredths here even where V8 says 0", () => {
    for (const code of ["HUF", "IDR", "COP"]) {
      expect(currencyHasTwoDecimalPlaces(code)).toBe(true);
    }
  });

  it("is case-insensitive and trims, so a raw seed and a stored code agree", () => {
    expect(currencyHasTwoDecimalPlaces("jpy")).toBe(false);
    expect(currencyHasTwoDecimalPlaces(" kwd ")).toBe(false);
    expect(currencyHasTwoDecimalPlaces("nzd")).toBe(true);
  });

  it("names the currency and the fix in its refusal", () => {
    const message = twoDecimalPlacesRequiredMessage("JPY");
    expect(message).toContain("JPY");
    expect(message).toContain("two decimal places");
  });
});

describe("listSelectableClubCurrencyCodes and the minor-unit rule", () => {
  it("offers no currency the save route would refuse", () => {
    const offered = listSelectableClubCurrencyCodes();
    expect(offered).toContain("NZD");
    expect(offered).not.toContain("JPY");
    expect(offered).not.toContain("KWD");
    expect(offered.every(currencyHasTwoDecimalPlaces)).toBe(true);
  });
});
