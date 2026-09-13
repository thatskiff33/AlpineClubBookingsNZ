import { beforeEach, describe, expect, it, vi } from "vitest";

// #3354: the one reader of the stored NZD -> club-currency rate, exercised for a
// NON-NZD club (the NZD short-circuit is pinned in a sibling suite below, by
// re-importing the module with the real operational config).

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  currency: "AUD",
}));

vi.mock("@/config/operational", () => ({
  get APP_CURRENCY() {
    return mocks.currency;
  },
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: { findUnique: mocks.findUnique },
  },
}));

import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadAiSpendCurrency for a non-NZD club", () => {
  it("returns the stored rate with when and by whom it was set", async () => {
    const rateSetAt = new Date("2026-06-01T00:00:00.000Z");
    mocks.findUnique.mockResolvedValue({
      clubUnitsPerNzdMicros: 920_000,
      rateSetAt,
      rateSetByMemberId: "admin-1",
    });
    const result = await loadAiSpendCurrency();
    expect(result).toEqual({
      clubCurrency: "AUD",
      isNzd: false,
      clubUnitsPerNzdMicros: 920_000,
      rateSetAt,
      rateSetByMemberId: "admin-1",
      isConfigured: true,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "default" } });
  });

  it("falls back to the identity rate, flagged unconfigured, when no row is stored", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await loadAiSpendCurrency();
    expect(result.isNzd).toBe(false);
    expect(result.isConfigured).toBe(false);
    expect(result.clubUnitsPerNzdMicros).toBe(1_000_000);
    expect(result.rateSetAt).toBeNull();
  });

  it("falls back to identity when the stored value is outside the parser's bounds", async () => {
    mocks.findUnique.mockResolvedValue({
      clubUnitsPerNzdMicros: 0,
      rateSetAt: new Date("2026-06-01T00:00:00.000Z"),
      rateSetByMemberId: null,
    });
    const result = await loadAiSpendCurrency();
    expect(result.isConfigured).toBe(false);
    expect(result.clubUnitsPerNzdMicros).toBe(1_000_000);
  });

  it("falls back to identity when the delegate is missing (old-colour client)", async () => {
    const result = await loadAiSpendCurrency({});
    expect(result.isConfigured).toBe(false);
    expect(result.clubUnitsPerNzdMicros).toBe(1_000_000);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("reads through the client it is handed, so a transaction can supply its own", async () => {
    const txFind = vi.fn().mockResolvedValue({
      clubUnitsPerNzdMicros: 500_000,
      rateSetAt: new Date("2026-06-01T00:00:00.000Z"),
      rateSetByMemberId: null,
    });
    const result = await loadAiSpendCurrency({
      aiSpendCurrencySettings: { findUnique: txFind },
    });
    expect(result.clubUnitsPerNzdMicros).toBe(500_000);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("PROPAGATES a database error — a rate we could not read is not a rate to price at", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    await expect(loadAiSpendCurrency()).rejects.toThrow("db down");
  });
});
