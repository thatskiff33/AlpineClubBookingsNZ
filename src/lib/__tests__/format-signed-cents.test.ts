import { describe, expect, it } from "vitest";
import { formatCents, formatSignedCents } from "@/lib/utils";

/**
 * Pins for the one home of `formatSignedCents` (#3264). Each expectation is a
 * string one of the seven former copies rendered for an existing fixture, so
 * the collapse is proved against the callers rather than reasoned about:
 * booking history ("+$25.00", "-$120.00"), the finance report mappings
 * ("+$20.01"), the P&L export rows, and the promo adjustment line on the
 * booking screens.
 */
describe("formatSignedCents", () => {
  it("prefixes the sign and keeps exact cents", () => {
    expect(formatSignedCents(2500)).toBe("+$25.00");
    expect(formatSignedCents(-12000)).toBe("-$120.00");
    expect(formatSignedCents(2001)).toBe("+$20.01");
    expect(formatSignedCents(-14000)).toBe("-$140.00");
  });

  it("renders zero unsigned, never as -$0.00", () => {
    // Three of the seven copies rendered zero as "-$0.00" (their prefix was
    // `cents > 0 ? "+" : "-"`); the unified helper takes the four that did not.
    expect(formatSignedCents(0)).toBe(formatCents(0));
    expect(formatSignedCents(0)).toBe("$0.00");
  });

  it("derives from formatCents, so the locale's grouping and currency apply", () => {
    // The promo-code input's copy spelt "$" by hand with toFixed(2) and so
    // rendered "-$1234.56" here; the shared helper follows formatCents.
    expect(formatSignedCents(-123456)).toBe(`-${formatCents(123456)}`);
    expect(formatSignedCents(-123456)).toBe("-$1,234.56");
  });
});
