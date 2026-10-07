import { describe, expect, it } from "vitest";
import { formatCents, formatSignedCents } from "@/lib/utils";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

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
    expect(formatSignedCents(2500, CLUB_FORMAT_TEST)).toBe("+$25.00");
    expect(formatSignedCents(-12000, CLUB_FORMAT_TEST)).toBe("-$120.00");
    expect(formatSignedCents(2001, CLUB_FORMAT_TEST)).toBe("+$20.01");
    expect(formatSignedCents(-14000, CLUB_FORMAT_TEST)).toBe("-$140.00");
  });

  it("renders zero unsigned, never as -$0.00", () => {
    // Three of the seven copies rendered zero as "-$0.00" (their prefix was
    // `cents > 0 ? "+" : "-"`); the unified helper takes the four that did not.
    expect(formatSignedCents(0, CLUB_FORMAT_TEST)).toBe(formatCents(0, CLUB_FORMAT_TEST));
    expect(formatSignedCents(0, CLUB_FORMAT_TEST)).toBe("$0.00");
  });

  it("derives from formatCents, so the locale's grouping and currency apply", () => {
    // The promo-code input's copy spelt "$" by hand with toFixed(2) and so
    // rendered "-$1234.56" here; the shared helper follows formatCents.
    expect(formatSignedCents(-123456, CLUB_FORMAT_TEST)).toBe(`-${formatCents(123456, CLUB_FORMAT_TEST)}`);
    expect(formatSignedCents(-123456, CLUB_FORMAT_TEST)).toBe("-$1,234.56");
  });
});
