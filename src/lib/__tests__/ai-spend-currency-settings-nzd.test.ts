import { describe, expect, it, vi } from "vitest";

// #3354: for an NZD club the reader never touches the database. This is the
// property that keeps the only current deployment's behaviour byte-identical.
// #3566: "an NZD club" is now the club's STORED currency, the argument, passed
// here from the shared default fixture rather than read from the environment.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: { findUnique: mocks.findUnique },
  },
}));

import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("loadAiSpendCurrency for an NZD club", () => {
  it("returns identity and never reads the table", async () => {
    expect(CLUB_FORMAT_TEST.currencyCode).toBe("NZD");
    const result = await loadAiSpendCurrency(CLUB_FORMAT_TEST.currencyCode);
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
