import { describe, expect, it } from "vitest";
import { seasonDatesProblem } from "@/lib/other-lodge-seasons";

/** Winter June to September, summer December to March (#75). */
const BOTH = {
  winterSeasonStart: "2026-06-01",
  winterSeasonEnd: "2026-09-30",
  summerSeasonStart: "2026-12-01",
  summerSeasonEnd: "2027-03-31",
};

describe("seasonDatesProblem (#75, the central server's rule)", () => {
  it("accepts seasons with a gap, with ends missing, touching seasons, or nothing set", () => {
    expect(seasonDatesProblem(BOTH)).toBeNull();
    expect(seasonDatesProblem({ ...BOTH, winterSeasonEnd: null, summerSeasonEnd: null })).toBeNull();
    expect(seasonDatesProblem({ ...BOTH, winterSeasonEnd: "2026-11-30" })).toBeNull();
    expect(seasonDatesProblem({})).toBeNull();
  });

  it.each([
    ["seasons that share days", { ...BOTH, winterSeasonEnd: "2026-12-15" }, /overlap: both include 1 December/],
    ["a summer running into winter, across New Year", { ...BOTH, summerSeasonEnd: "2027-06-10" }, /overlap: both include 1 June/],
    ["an overlap through a season with no end", { winterSeasonStart: "2026-06-01", summerSeasonStart: "2026-08-01", summerSeasonEnd: "2026-07-01" }, /overlap/],
    ["an end with no start", { winterSeasonEnd: "2026-09-30" }, /winter season has an end date but no start date/],
    ["a start and end on the same day of the year", { summerSeasonStart: "2026-12-01", summerSeasonEnd: "2027-12-01" }, /must be different days/],
  ] as const)("refuses %s", (_label, dates, message) => {
    expect(seasonDatesProblem(dates)).toMatch(message);
  });
});
