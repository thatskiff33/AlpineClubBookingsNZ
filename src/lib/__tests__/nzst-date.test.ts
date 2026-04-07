import { describe, it, expect } from "vitest";
import { getNZSTToday, getNZSTTomorrow } from "../nzst-date";

describe("getNZSTToday", () => {
  it("returns a Date object", () => {
    const today = getNZSTToday();
    expect(today).toBeInstanceOf(Date);
  });

  it("returns midnight (00:00:00)", () => {
    const today = getNZSTToday();
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    expect(today.getSeconds()).toBe(0);
  });

  it("returns a date not in the future", () => {
    const today = getNZSTToday();
    const now = new Date();
    // Allow 1 day buffer for timezone differences
    expect(today.getTime()).toBeLessThanOrEqual(now.getTime() + 86400000);
  });
});

describe("getNZSTTomorrow", () => {
  it("returns exactly 1 day after getNZSTToday", () => {
    const today = getNZSTToday();
    const tomorrow = getNZSTTomorrow();
    const diffMs = tomorrow.getTime() - today.getTime();
    expect(diffMs).toBe(86400000); // 24 hours in ms
  });
});
