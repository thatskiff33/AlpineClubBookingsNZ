import { describe, it, expect } from "vitest";
import {
  computeAge,
  computeSeasonYear,
  computeAgeTierWithSettings,
  AGE_TIER_DEFAULTS,
  getSeasonStartDate,
} from "../age-tier";

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

describe("getSeasonStartDate", () => {
  it("returns April 1 of the given season year", () => {
    const d = getSeasonStartDate(2026);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April = 3 in JS
    expect(d.getDate()).toBe(1);
  });

  it("works for other season years", () => {
    const d = getSeasonStartDate(2025);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(1);
  });
});

describe("computeAgeTierWithSettings (TAC boundaries: CHILD 5-12, YOUTH 13-17, ADULT 18+)", () => {
  // Use April 1 2026 as reference (season start date for season 2026)
  const ref = new Date("2026-04-01");

  it("returns INFANT for age under 5", () => {
    // Born 2025-01-01: age 1 -> INFANT
    expect(computeAgeTierWithSettings(new Date("2025-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("INFANT");
    // Born 2021-04-02: age 4 on April 1 2026 -> INFANT
    expect(computeAgeTierWithSettings(new Date("2021-04-02"), ref, AGE_TIER_DEFAULTS)).toBe("INFANT");
  });

  it("returns CHILD for age 5-12", () => {
    // Born 2021-04-01: age 5 on April 1 2026 -> CHILD
    expect(computeAgeTierWithSettings(new Date("2021-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Born 2017-01-01: age 9 on April 1 2026 -> CHILD
    expect(computeAgeTierWithSettings(new Date("2017-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Born 2016-04-01: age 10 on April 1 2026 -> CHILD (CHILD goes up to 12)
    expect(computeAgeTierWithSettings(new Date("2016-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Born 2016-04-02: still 9 on April 1 2026 (turns 10 on April 2) -> CHILD
    expect(computeAgeTierWithSettings(new Date("2016-04-02"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Born 2016-01-01: age 10 on April 1 2026 -> CHILD
    expect(computeAgeTierWithSettings(new Date("2016-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Born 2014-08-28 (Malia example): age 11 on April 1 2026 -> CHILD (under 13)
    expect(computeAgeTierWithSettings(new Date("2014-08-28"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
  });

  it("returns YOUTH for age 13 to 17 (inclusive)", () => {
    // Born 2013-04-01: exactly 13 on April 1 2026 -> YOUTH
    expect(computeAgeTierWithSettings(new Date("2013-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("YOUTH");
    // Born 2013-01-01: age 13 on April 1 2026 -> YOUTH
    expect(computeAgeTierWithSettings(new Date("2013-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("YOUTH");
    // Born 2009-01-01: age 17 on April 1 2026 -> YOUTH
    expect(computeAgeTierWithSettings(new Date("2009-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("YOUTH");
    // Born 2008-04-02: age 17 on April 1 2026 (hasn't turned 18 yet) -> YOUTH
    expect(computeAgeTierWithSettings(new Date("2008-04-02"), ref, AGE_TIER_DEFAULTS)).toBe("YOUTH");
  });

  it("returns ADULT for age 18 and over", () => {
    // Born 2008-04-01: exactly 18 on April 1 2026 -> ADULT
    expect(computeAgeTierWithSettings(new Date("2008-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("ADULT");
    // Born 2008-01-01: age 18 -> ADULT
    expect(computeAgeTierWithSettings(new Date("2008-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("ADULT");
    // Born 2000-01-01: age 26 -> ADULT
    expect(computeAgeTierWithSettings(new Date("2000-01-01"), ref, AGE_TIER_DEFAULTS)).toBe("ADULT");
    // Born 1980-06-15: age 45 -> ADULT
    expect(computeAgeTierWithSettings(new Date("1980-06-15"), ref, AGE_TIER_DEFAULTS)).toBe("ADULT");
  });

  it("Malia example: DOB 2014-08-28, season 2026 -> CHILD (age 11 on April 1 2026, CHILD goes to 12)", () => {
    const malia = new Date("2014-08-28");
    const seasonStart = getSeasonStartDate(2026); // April 1, 2026
    expect(computeAgeTierWithSettings(malia, seasonStart, AGE_TIER_DEFAULTS)).toBe("CHILD");
    // Verify age calculation: she turns 12 in August, so on April 1 she is 11
    expect(computeAge(malia, seasonStart)).toBe(11);
  });

  it("birthday edge case: turning 10 on April 1 -> CHILD (CHILD is 5-12)", () => {
    // Born exactly April 1 2016: turns 10 on April 1 2026 -> CHILD (max age is 12)
    expect(computeAgeTierWithSettings(new Date("2016-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
  });

  it("birthday edge case: born April 2 2016 is still CHILD on April 1 2026", () => {
    // Still 9 years old (turns 10 the next day) -> CHILD
    expect(computeAgeTierWithSettings(new Date("2016-04-02"), ref, AGE_TIER_DEFAULTS)).toBe("CHILD");
  });

  it("birthday edge case: turning 18 on April 1 -> ADULT", () => {
    expect(computeAgeTierWithSettings(new Date("2008-04-01"), ref, AGE_TIER_DEFAULTS)).toBe("ADULT");
  });

  it("birthday edge case: born April 2 2008 is still YOUTH on April 1 2026", () => {
    // Still 17 years old (turns 18 the next day) -> YOUTH
    expect(computeAgeTierWithSettings(new Date("2008-04-02"), ref, AGE_TIER_DEFAULTS)).toBe("YOUTH");
  });

  it("season start date is used as reference", () => {
    // Malia born 2014-08-28:
    //   - On April 1 2024 she is 9 -> CHILD
    //   - On April 1 2025 she is 10 -> CHILD (CHILD goes to 12)
    //   - On April 1 2026 she is 11 -> CHILD
    const malia = new Date("2014-08-28");
    expect(computeAgeTierWithSettings(malia, getSeasonStartDate(2024), AGE_TIER_DEFAULTS)).toBe("CHILD");
    expect(computeAgeTierWithSettings(malia, getSeasonStartDate(2025), AGE_TIER_DEFAULTS)).toBe("CHILD"); // age 10
    expect(computeAgeTierWithSettings(malia, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)).toBe("CHILD"); // age 11
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
