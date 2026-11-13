import { TaxRate } from "xero-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the Xero client is stubbed, so the mapping and the cache run for real.
const live = vi.hoisted(() => ({
  getTaxRates: vi.fn(),
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({ xero: { accountingApi: { getTaxRates: live.getTaxRates } }, tenantId: "tenant-1" }),
  callXeroApi: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/xero-mock-endpoint", () => ({ isXeroMockActive: () => false }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { readXeroTaxRates, readXeroTaxRatesOrNull, resetXeroTaxRatesCacheForTests } from "@/lib/xero-tax-rates";

function serve(taxRates: Partial<TaxRate>[]) {
  live.getTaxRates.mockResolvedValue({ body: { taxRates } });
}

describe("readXeroTaxRates (#4632)", () => {
  beforeEach(() => resetXeroTaxRatesCacheForTests());
  afterEach(() => live.getTaxRates.mockReset());

  it("maps each rate to its code, rate in basis points, status and revenue use, sorted by code", async () => {
    serve([
      { taxType: "OUTPUT2", name: "15% GST on Income", effectiveRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: true },
      { taxType: "INPUT2", name: "15% GST on Expenses", displayTaxRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: false },
      { taxType: "NONE", effectiveRate: 0, status: TaxRate.StatusEnum.ARCHIVED },
      { name: "no code" },
    ]);
    await expect(readXeroTaxRates()).resolves.toEqual([
      { taxType: "INPUT2", name: "15% GST on Expenses", rateBasisPoints: 1500, active: true, revenue: false },
      { taxType: "NONE", name: "NONE", rateBasisPoints: 0, active: false, revenue: false },
      { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true },
    ]);
  });

  it("serves a recent read from the cache, but a fresh read always asks Xero again", async () => {
    serve([{ taxType: "OUTPUT2", effectiveRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: true }]);
    await readXeroTaxRates();
    await readXeroTaxRates();
    expect(live.getTaxRates).toHaveBeenCalledTimes(1);

    serve([{ taxType: "OUTPUT2", effectiveRate: 15, status: TaxRate.StatusEnum.ARCHIVED, canApplyToRevenue: true }]);
    await expect(readXeroTaxRates({ fresh: true })).resolves.toEqual([
      expect.objectContaining({ taxType: "OUTPUT2", active: false }),
    ]);
    expect(live.getTaxRates).toHaveBeenCalledTimes(2);
  });

  it("throws when Xero cannot be read, and the degrading reader answers null instead", async () => {
    live.getTaxRates.mockRejectedValue(new Error("429"));
    await expect(readXeroTaxRates()).rejects.toThrow("429");
    await expect(readXeroTaxRatesOrNull()).resolves.toBeNull();
  });
});
