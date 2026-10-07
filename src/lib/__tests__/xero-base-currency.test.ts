import { describe, expect, it } from "vitest";

import { xeroBaseCurrencyMismatch } from "@/lib/xero-base-currency";

/**
 * The one comparison behind the Xero base-currency warning (#3633). Every
 * surface routes through it, so these cases are the whole rule: warn only when
 * BOTH currencies are known and they differ.
 */
describe("xeroBaseCurrencyMismatch (#3633)", () => {
  it("is null when the two currencies match", () => {
    expect(xeroBaseCurrencyMismatch("NZD", "NZD")).toBeNull();
  });

  it("returns both codes when they differ", () => {
    expect(xeroBaseCurrencyMismatch("NZD", "AUD")).toEqual({
      xeroBaseCurrency: "NZD",
      clubCurrencyCode: "AUD",
    });
  });

  it("ignores case and surrounding space, and reports the canonical codes", () => {
    expect(xeroBaseCurrencyMismatch("nzd", " NZD ")).toBeNull();
    expect(xeroBaseCurrencyMismatch(" aud", "nzd")).toEqual({
      xeroBaseCurrency: "AUD",
      clubCurrencyCode: "NZD",
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank", "   "],
    ["not a currency code", "dollars"],
  ])("is null when the Xero side is %s", (_label, xero) => {
    expect(xeroBaseCurrencyMismatch(xero, "NZD")).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank", ""],
    ["not a currency code", "NZ$"],
  ])("is null when the club side is %s", (_label, club) => {
    expect(xeroBaseCurrencyMismatch("AUD", club)).toBeNull();
  });
});
