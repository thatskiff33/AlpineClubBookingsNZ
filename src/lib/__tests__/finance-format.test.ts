import { describe, expect, it, vi } from "vitest";
import {
  formatCompactDollarsDisplay,
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";

describe("finance display formatters", () => {
  it("formats whole dollars with thousands separators and no cents", () => {
    expect(formatDollarsDisplay(44_667_484)).toBe("$446,675");
    expect(formatDollarsDisplay(123_456)).toBe("$1,235");
    expect(formatDollarsDisplay(49)).toBe("$0");
    expect(formatDollarsDisplay(-2_500_00)).toBe("-$2,500");
  });

  it("formats signed dollar deltas", () => {
    expect(formatSignedDollarsDisplay(120_400)).toBe("+$1,204");
    expect(formatSignedDollarsDisplay(-31_000)).toBe("-$310");
    expect(formatSignedDollarsDisplay(0)).toBe("$0");
    expect(formatSignedDollarsDisplay(20)).toBe("$0");
  });

  it("formats counts and percentages", () => {
    expect(formatFinanceNumber(12_345)).toBe("12,345");
    expect(formatFinanceSignedNumber(42)).toBe("+42");
    expect(formatFinanceSignedNumber(-7)).toBe("-7");
    expect(formatFinancePercent(0.125)).toBe("12.5%");
  });
});

describe("formatCompactDollarsDisplay (#3325)", () => {
  it("keeps the chart theme's k/m tick shape under the default configuration", () => {
    expect(formatCompactDollarsDisplay(1_000_000)).toBe("$10k");
    expect(formatCompactDollarsDisplay(120_000_000)).toBe("$1.2m");
    expect(formatCompactDollarsDisplay(45_000)).toBe("$450");
    expect(formatCompactDollarsDisplay(-120_000_000)).toBe("$-1.2m");
  });

  // The symbol and its position come from the configured locale, not a
  // hand-spelt `$` prefix: de-DE writes the euro AFTER the number. A fresh
  // import is required because the formatter is built at module load.
  it("places the compact number where the configured locale puts its digits", async () => {
    vi.resetModules();
    vi.doMock("@/config/operational", () => ({
      APP_CURRENCY: "EUR",
      APP_STRIPE_CURRENCY: "eur",
      APP_TIME_ZONE: "Europe/Berlin",
      APP_LOCALE: "de-DE",
    }));
    try {
      const fresh = await import("@/lib/finance-format");
      expect(fresh.formatCompactDollarsDisplay(1_000_000)).toBe("10k\u00a0€");
      expect(fresh.formatCompactDollarsDisplay(120_000_000)).toBe("1.2m\u00a0€");
    } finally {
      vi.doUnmock("@/config/operational");
      vi.resetModules();
    }
  });
});
