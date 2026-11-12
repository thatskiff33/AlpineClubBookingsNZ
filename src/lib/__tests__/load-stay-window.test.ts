import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  mixedWriteNights,
  mixedWriteStay,
  monthsTouched,
  nightsBetween,
  paymentStay,
  utcDayOf,
} from "../../../load/lib/stay-window.js";

describe("load stay window (#4940)", () => {
  it("steps whole calendar days across month and year ends", () => {
    expect(addDaysIso("2026-07-01", 120)).toBe("2026-10-29");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2027-03-01", -1)).toBe("2027-02-28");
    expect(utcDayOf(Date.parse("2026-07-01T00:00:00.000Z"))).toBe("2026-07-01");
  });

  it("refuses a malformed or impossible date rather than guessing", () => {
    expect(() => addDaysIso("2026-7-1", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addDaysIso("2026-02-30", 1)).toThrow(/real calendar date/);
  });

  it("lists half-open night ranges and the zero-based months they touch", () => {
    const nights = nightsBetween("2026-10-30", "2026-11-02");
    expect(nights).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(monthsTouched(nights)).toEqual([
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
    expect(nightsBetween("2026-10-30", "2026-10-30")).toEqual([]);
  });

  it("spreads mixed writes over lodges and nights, all inside the observed window", () => {
    const start = "2026-10-29";
    const observed = new Set(mixedWriteNights(start, 3));
    const lodges = new Set<number>();
    const checkIns = new Set<string>();
    for (let vu = 1; vu <= 20; vu += 1) {
      for (let iter = 0; iter < 5; iter += 1) {
        const stay = mixedWriteStay(start, vu, iter, 3, 2);
        lodges.add(stay.lodgeIndex);
        checkIns.add(stay.checkIn);
        // The modify step extends the stay by one night; that night is observed too.
        for (const night of nightsBetween(stay.checkIn, addDaysIso(stay.checkOut, 1))) {
          expect(observed.has(night)).toBe(true);
        }
      }
    }
    expect([...lodges].sort()).toEqual([0, 1]);
    expect(checkIns.size).toBe(3);
    expect(() => mixedWriteStay(start, 1, 0, 0, 2)).toThrow(/spread/);
  });

  it("gives each payment iteration its own week of single nights", () => {
    expect(paymentStay("2026-10-29", 3, 1, 2)).toEqual({
      lodgeIndex: 1,
      checkIn: "2026-11-08",
      checkOut: "2026-11-09",
    });
    expect(paymentStay("2026-10-29", 3, 0, 0).lodgeIndex).toBe(0);
  });
});
