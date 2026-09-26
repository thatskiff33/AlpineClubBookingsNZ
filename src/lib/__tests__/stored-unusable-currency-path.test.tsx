// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #3567 re-review, D3 as the owner decided: refuse at PAYMENT time, on the
  STORED value. This walks the whole path from a stored row — the club saved
  JPY (by hand, or a pre-#3567 seed) and priced a booking at 5 000.00:

  1. the canonical reader returns a format that DISPLAYS the fallback (the
     server's CURRENCY, then NZD) and names the stored code;
  2. pages still render amounts in that fallback;
  3. every charge is refused — never made in the fallback, which would have
     charged NZ$5,000.00 for a price set in yen;
  4. every admin sees the banner saying card payments are off.
*/

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { clubFormatSettings: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { CardPaymentsRefusedBanner } from "@/components/admin/card-payments-refused-banner";
import { getClubFormat } from "@/lib/club-format-settings";
import { chargeCurrencyRefusal, stripeChargeCurrency, UnsupportedChargeCurrencyError } from "@/lib/stripe-charge-currency";
import { formatCents } from "@/lib/utils";

beforeEach(() => {
  findUnique.mockReset();
  vi.stubEnv("CURRENCY", "");
});

describe("a stored JPY row, end to end", () => {
  it("displays the fallback, refuses every charge, and raises the admin banner", async () => {
    findUnique.mockResolvedValue({
      currencyCode: "JPY",
      locale: "en-NZ",
      updatedByMemberId: null,
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    const format = await getClubFormat();
    expect(format).toEqual({ currencyCode: "NZD", locale: "en-NZ", unusableStoredCurrency: "JPY" });

    // Display still renders.
    expect(formatCents(500000, format)).toBe("$5,000.00");

    // No charge, in any currency.
    expect(() => stripeChargeCurrency(format)).toThrow(UnsupportedChargeCurrencyError);
    expect(chargeCurrencyRefusal(format)?.currencyCode).toBe("JPY");

    render(<CardPaymentsRefusedBanner format={format} />);
    const banner = screen.getByTestId("card-payments-refused-banner");
    expect(banner).toHaveTextContent('"JPY", cannot be charged');
    expect(banner).toHaveTextContent("Members see amounts in NZD");
  });

  it("falls back to the server's CURRENCY for display when it is usable, and still refuses charges", async () => {
    vi.stubEnv("CURRENCY", "AUD");
    findUnique.mockResolvedValue({ currencyCode: "KWD", locale: "en-AU", updatedByMemberId: null, updatedAt: new Date() });

    const format = await getClubFormat();
    expect(format).toEqual({ currencyCode: "AUD", locale: "en-AU", unusableStoredCurrency: "KWD" });
    expect(chargeCurrencyRefusal(format)?.currencyCode).toBe("KWD");
  });

  it("treats a row with a BLANK currency as unusable too: charges refused, banner up (#3567 final check)", async () => {
    findUnique.mockResolvedValue({ currencyCode: "  ", locale: "en-NZ", updatedByMemberId: null, updatedAt: new Date() });

    const format = await getClubFormat();
    expect(format).toEqual({ currencyCode: "NZD", locale: "en-NZ", unusableStoredCurrency: "(blank)" });
    expect(() => stripeChargeCurrency(format)).toThrow("The club has no currency recorded");
    render(<CardPaymentsRefusedBanner format={format} />);
    expect(screen.getByTestId("card-payments-refused-banner")).toHaveTextContent(
      "The club has no currency recorded, so no card can be charged.",
    );
  });

  it("refuses nothing when there is no row at all", async () => {
    findUnique.mockResolvedValue(null);
    const format = await getClubFormat();
    expect(format).toEqual({ currencyCode: "NZD", locale: "en-NZ" });
    expect(chargeCurrencyRefusal(format)).toBeNull();
  });

  it("shows no banner and refuses nothing for a usable stored currency", async () => {
    findUnique.mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ", updatedByMemberId: null, updatedAt: new Date() });

    const format = await getClubFormat();
    expect(format).toEqual({ currencyCode: "NZD", locale: "en-NZ" });
    expect(stripeChargeCurrency(format)).toBe("nzd");
    const { container } = render(<CardPaymentsRefusedBanner format={format} />);
    expect(container).toBeEmptyDOMElement();
  });
});
