import { describe, expect, it } from "vitest";
import {
  MAX_BUDGET_CENTS,
  centsToDollars,
  parseDollarsToCents,
} from "../budget";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

describe("centsToDollars", () => {
  it("formats integer cents as a 2dp dollar string", () => {
    expect(centsToDollars(0)).toBe("0.00");
    expect(centsToDollars(1000)).toBe("10.00");
    expect(centsToDollars(1234)).toBe("12.34");
    expect(centsToDollars(MAX_BUDGET_CENTS)).toBe("1000.00");
  });
});

describe("parseDollarsToCents", () => {
  it("parses valid dollars-and-cents to integer cents", () => {
    expect(parseDollarsToCents("10", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 1000 });
    expect(parseDollarsToCents("10.00", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 1000 });
    expect(parseDollarsToCents("12.34", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 1234 });
    expect(parseDollarsToCents("0", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents("0.00", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents(" 5.5 ", CLUB_FORMAT_TEST)).toEqual({ ok: true, cents: 550 });
  });

  it("accepts the maximum but rejects above it", () => {
    expect(parseDollarsToCents("1000", CLUB_FORMAT_TEST)).toEqual({
      ok: true,
      cents: MAX_BUDGET_CENTS,
    });
    expect(parseDollarsToCents("1000.01", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("5000", CLUB_FORMAT_TEST).ok).toBe(false);
  });

  it("rejects blanks, non-numbers, negatives, and over-precise input", () => {
    expect(parseDollarsToCents("", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("   ", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("abc", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("-5", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("10.001", CLUB_FORMAT_TEST).ok).toBe(false);
    expect(parseDollarsToCents("$10", CLUB_FORMAT_TEST).ok).toBe(false);
  });
});
