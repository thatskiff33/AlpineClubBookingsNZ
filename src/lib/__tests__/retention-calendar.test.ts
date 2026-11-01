import { describe, expect, it } from "vitest";
import { addUtcYears } from "@/lib/retention-calendar";

describe("retention anniversaries", () => {
  it("clamps leap days so a year subtraction never erases a day early", () => {
    const now = new Date("2024-02-29T12:30:00.000Z");
    expect(addUtcYears(now, -1).toISOString()).toBe("2023-02-28T12:30:00.000Z");
    expect(now.toISOString()).toBe("2024-02-29T12:30:00.000Z");
  });
  it("keeps the anniversary's time of day and leap day when present", () => {
    expect(addUtcYears(new Date("2024-02-29T01:02:03.004Z"), -4).toISOString()).toBe("2020-02-29T01:02:03.004Z");
  });
});
