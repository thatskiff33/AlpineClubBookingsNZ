import { describe, expect, it, vi } from "vitest";

// #3354: for an NZD club (the test default — `APP_CURRENCY` resolves to "NZD"
// with no CURRENCY env) the reader never touches the database. This is the
// property that keeps the only current deployment's behaviour byte-identical.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: { findUnique: mocks.findUnique },
  },
}));

import { APP_CURRENCY } from "@/config/operational";
import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";

describe("loadAiSpendCurrency for an NZD club", () => {
  it("returns identity and never reads the table", async () => {
    expect(APP_CURRENCY).toBe("NZD");
    const result = await loadAiSpendCurrency();
    expect(result).toEqual({
      clubCurrency: "NZD",
      isNzd: true,
      clubUnitsPerNzdMicros: 1_000_000,
      rateSetAt: null,
      rateSetByMemberId: null,
      isConfigured: false,
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
