import { describe, expect, it, vi } from "vitest";

// #3354: for an NZD club the reader never touches the database. This is the
// property that keeps the only current deployment's behaviour byte-identical.
// #3566: "an NZD club" is now the club's STORED currency, read through the same
// client as the rate; the stored row here is the shared default fixture.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
const { CLUB_FORMAT_TEST } = await vi.hoisted(async () => import("./support/club-format-fixture"));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: { findUnique: mocks.findUnique },
    clubFormatSettings: {
      findUnique: async () => CLUB_FORMAT_TEST,
    },
  },
}));

import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";

describe("loadAiSpendCurrency for an NZD club", () => {
  it("returns identity and never reads the table", async () => {
    expect(CLUB_FORMAT_TEST.currencyCode).toBe("NZD");
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
