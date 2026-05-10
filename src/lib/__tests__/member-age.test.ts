import { describe, expect, it } from "vitest";
import { formatAgeYearsMonths } from "@/lib/member-age";

describe("formatAgeYearsMonths", () => {
  it("formats a normal date of birth", () => {
    expect(formatAgeYearsMonths("1990-01-01", "2026-05-10")).toBe(
      "36 years 4 months"
    );
  });

  it("handles a birthday that has not occurred this month", () => {
    expect(formatAgeYearsMonths("1990-05-20", "2026-05-10")).toBe(
      "35 years 11 months"
    );
  });

  it("handles a birthday today", () => {
    expect(formatAgeYearsMonths("1990-05-10", "2026-05-10")).toBe(
      "36 years 0 months"
    );
  });

  it("handles leap-day dates of birth in non-leap years", () => {
    expect(formatAgeYearsMonths("2000-02-29", "2026-02-28")).toBe(
      "26 years 0 months"
    );
  });

  it("returns null for a null date of birth", () => {
    expect(formatAgeYearsMonths(null, "2026-05-10")).toBeNull();
  });
});
