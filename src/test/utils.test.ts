import { describe, it, expect } from "vitest";
import { formatCents, getSeasonYear } from "@/lib/utils";

describe("formatCents", () => {
  it("formats whole dollar amounts", () => {
    expect(formatCents(4500)).toBe("$45.00");
  });

  it("formats cents correctly", () => {
    expect(formatCents(4550)).toBe("$45.50");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats large amounts", () => {
    expect(formatCents(100000)).toBe("$1000.00");
  });

  it("formats single cent", () => {
    expect(formatCents(1)).toBe("$0.01");
  });
});

describe("getSeasonYear", () => {
  it("returns current year for April", () => {
    expect(getSeasonYear(new Date("2026-04-15"))).toBe(2026);
  });

  it("returns current year for December", () => {
    expect(getSeasonYear(new Date("2026-12-15"))).toBe(2026);
  });

  it("returns previous year for January", () => {
    expect(getSeasonYear(new Date("2026-01-15"))).toBe(2025);
  });

  it("returns previous year for March", () => {
    expect(getSeasonYear(new Date("2026-03-31"))).toBe(2025);
  });

  it("returns current year for April 1 (boundary)", () => {
    expect(getSeasonYear(new Date("2026-04-01"))).toBe(2026);
  });
});
