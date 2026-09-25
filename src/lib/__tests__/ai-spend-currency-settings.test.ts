import { beforeEach, describe, expect, it, vi } from "vitest";

// #3354: the one reader of the stored NZD -> club-currency rate, exercised for a
// NON-NZD club (the NZD short-circuit is pinned in a sibling suite).
//
// #3566: the club side is now the club's STORED currency, read by the reader
// itself through the same client as the rate. The environment's `APP_CURRENCY`
// is mocked to a DIFFERENT value here so that a reader which went back to it
// would answer the wrong currency and fail.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  formatFindUnique: vi.fn(),
}));

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: { findUnique: mocks.findUnique },
    clubFormatSettings: { findUnique: mocks.formatFindUnique },
  },
}));

import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatFindUnique.mockResolvedValue({ currencyCode: "AUD", locale: "en-AU" });
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
    const txFormat = vi.fn().mockResolvedValue({ currencyCode: "AUD", locale: "en-AU" });
    const txFind = vi.fn().mockResolvedValue({
      clubUnitsPerNzdMicros: 500_000,
      rateSetAt: new Date("2026-06-01T00:00:00.000Z"),
      rateSetByMemberId: null,
    });
    const result = await loadAiSpendCurrency({
      aiSpendCurrencySettings: { findUnique: txFind },
      clubFormatSettings: { findUnique: txFormat },
    });
    expect(result.clubUnitsPerNzdMicros).toBe(500_000);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    // The CURRENCY is read through the same client, not the module one (#3566).
    expect(txFormat).toHaveBeenCalledTimes(1);
    expect(mocks.formatFindUnique).not.toHaveBeenCalled();
  });

  it("PROPAGATES a database error — a rate we could not read is not a rate to price at", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    await expect(loadAiSpendCurrency()).rejects.toThrow("db down");
  });
});

describe("#3566: the club side is the club's STORED currency, not the environment's", () => {
  it("a stored CHF club with no rate is non-NZD and unconfigured, whatever APP_CURRENCY says", async () => {
    // The environment says NZD (mocked above). The live mismatch this fixes: a
    // club that switched to CHF in the panel saw "Monthly cap (CHF)" beside a
    // rate card claiming NZD and nothing to convert.
    mocks.formatFindUnique.mockResolvedValue({ currencyCode: "CHF", locale: "de-CH" });
    mocks.findUnique.mockResolvedValue(null);
    const result = await loadAiSpendCurrency();
    expect(result).toMatchObject({
      clubCurrency: "CHF",
      isNzd: false,
      isConfigured: false,
      clubUnitsPerNzdMicros: 1_000_000,
    });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("a stored NZD club short-circuits to identity and never reads the rate table", async () => {
    mocks.formatFindUnique.mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ" });
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

  it("PROPAGATES a database error on the CURRENCY read, and never prices at a guess", async () => {
    // `getClubFormat()` swallows its read error and answers the seed; a metering
    // path that did that would count NZ cents as whatever the seed says. The
    // reader reads the currency itself precisely so the failure reaches the
    // callers' fail-closed catch instead.
    mocks.formatFindUnique.mockRejectedValue(new Error("db down"));
    await expect(loadAiSpendCurrency()).rejects.toThrow("db down");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("hands every caller its own identity object, so one caller cannot re-price another", async () => {
    mocks.formatFindUnique.mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ" });
    const first = await loadAiSpendCurrency();
    first.clubUnitsPerNzdMicros = 5;
    const second = await loadAiSpendCurrency();
    expect(second.clubUnitsPerNzdMicros).toBe(1_000_000);
  });
});
