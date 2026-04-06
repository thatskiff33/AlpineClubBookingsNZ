import { describe, it, expect } from "vitest";
import { computeAgeTier, computeAge, computeSeasonYear } from "../age-tier";

describe("computeAge", () => {
  const ref = new Date("2026-04-03");

  it("calculates correct age", () => {
    expect(computeAge(new Date("2000-01-01"), ref)).toBe(26);
    expect(computeAge(new Date("1980-06-15"), ref)).toBe(45);
  });

  it("handles birthday not yet passed this year", () => {
    expect(computeAge(new Date("2000-06-15"), ref)).toBe(25); // birthday in June, ref is April
  });

  it("handles exact birthday", () => {
    expect(computeAge(new Date("2000-04-03"), ref)).toBe(26);
  });

  it("handles day before birthday", () => {
    expect(computeAge(new Date("2000-04-04"), ref)).toBe(25);
  });
});

describe("computeAgeTier", () => {
  const ref = new Date("2026-04-03");

  it("returns CHILD for age < 13", () => {
    expect(computeAgeTier(new Date("2014-06-01"), ref)).toBe("CHILD"); // 11
    expect(computeAgeTier(new Date("2015-01-01"), ref)).toBe("CHILD"); // 11
    expect(computeAgeTier(new Date("2013-04-04"), ref)).toBe("CHILD"); // 12 (hasn't turned 13 yet)
  });

  it("returns YOUTH for age 13-17", () => {
    expect(computeAgeTier(new Date("2013-04-03"), ref)).toBe("YOUTH"); // exactly 13
    expect(computeAgeTier(new Date("2013-01-01"), ref)).toBe("YOUTH"); // 13
    expect(computeAgeTier(new Date("2009-01-01"), ref)).toBe("YOUTH"); // 17
    expect(computeAgeTier(new Date("2008-04-04"), ref)).toBe("YOUTH"); // 17 (hasn't turned 18)
  });

  it("returns ADULT for age >= 18", () => {
    expect(computeAgeTier(new Date("2008-04-03"), ref)).toBe("ADULT"); // exactly 18
    expect(computeAgeTier(new Date("2008-01-01"), ref)).toBe("ADULT"); // 18
    expect(computeAgeTier(new Date("2000-01-01"), ref)).toBe("ADULT"); // 26
    expect(computeAgeTier(new Date("1980-06-15"), ref)).toBe("ADULT"); // 45
  });

  it("handles birthday edge cases", () => {
    // Exactly on 13th birthday -> YOUTH
    expect(computeAgeTier(new Date("2013-04-03"), ref)).toBe("YOUTH");
    // Day before 13th birthday -> still CHILD
    expect(computeAgeTier(new Date("2013-04-04"), ref)).toBe("CHILD");
    // Exactly on 18th birthday -> ADULT
    expect(computeAgeTier(new Date("2008-04-03"), ref)).toBe("ADULT");
    // Day before 18th birthday -> still YOUTH
    expect(computeAgeTier(new Date("2008-04-04"), ref)).toBe("YOUTH");
  });
});

describe("computeSeasonYear", () => {
  it("returns current year when month >= April", () => {
    expect(computeSeasonYear(new Date("2026-04-01"))).toBe(2026);
    expect(computeSeasonYear(new Date("2026-06-15"))).toBe(2026);
    expect(computeSeasonYear(new Date("2026-12-31"))).toBe(2026);
  });

  it("returns previous year when month < April", () => {
    expect(computeSeasonYear(new Date("2026-01-01"))).toBe(2025);
    expect(computeSeasonYear(new Date("2026-02-15"))).toBe(2025);
    expect(computeSeasonYear(new Date("2026-03-31"))).toBe(2025);
  });

  it("handles year boundary correctly", () => {
    expect(computeSeasonYear(new Date("2025-03-31"))).toBe(2024);
    expect(computeSeasonYear(new Date("2025-04-01"))).toBe(2025);
  });
});
