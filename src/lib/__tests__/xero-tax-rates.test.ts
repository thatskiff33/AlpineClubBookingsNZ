import { TaxRate } from "xero-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the Xero client is stubbed, so the mapping and the cache run for real.
const live = vi.hoisted(() => ({
  getTaxRates: vi.fn(),
  tenantId: "tenant-1",
  connectedTenantId: "tenant-1" as string | null,
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({ xero: { accountingApi: { getTaxRates: live.getTaxRates } }, tenantId: live.tenantId }),
  callXeroApi: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/xero-connection", () => ({
  readXeroConnection: async () => (live.connectedTenantId === null ? null : { tenantId: live.connectedTenantId, expiresAt: new Date() }),
}));
vi.mock("@/lib/xero-mock-endpoint", () => ({ isXeroMockActive: () => false }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { readXeroTaxRates, readXeroTaxRatesOrNull, resetXeroTaxRatesCacheForTests } from "@/lib/xero-tax-rates";

function serve(taxRates: Partial<TaxRate>[]) {
  live.getTaxRates.mockResolvedValue({ body: { taxRates } });
}

describe("readXeroTaxRates (#4632)", () => {
  beforeEach(() => {
    resetXeroTaxRatesCacheForTests();
    live.tenantId = "tenant-1";
    live.connectedTenantId = "tenant-1";
  });
  afterEach(() => live.getTaxRates.mockReset());

  it("maps each rate to its code, rate in basis points, status and revenue and expense use, sorted by code", async () => {
    serve([
      { taxType: "OUTPUT2", name: "15% GST on Income", effectiveRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: true },
      { taxType: "INPUT2", name: "15% GST on Expenses", displayTaxRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: false, canApplyToExpenses: true },
      { taxType: "NONE", effectiveRate: 0, status: TaxRate.StatusEnum.ARCHIVED },
      { name: "no code" },
    ]);
    await expect(readXeroTaxRates()).resolves.toEqual([
      { taxType: "INPUT2", name: "15% GST on Expenses", rateBasisPoints: 1500, active: true, revenue: false, expenses: true },
      { taxType: "NONE", name: "NONE", rateBasisPoints: 0, active: false, revenue: false, expenses: false },
      { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false },
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

  it("treats the cache as a miss once a different Xero organisation is connected (#5209)", async () => {
    serve([{ taxType: "EXEMPTA", effectiveRate: 0, status: TaxRate.StatusEnum.ACTIVE }]);
    await readXeroTaxRates();

    live.tenantId = "tenant-2";
    live.connectedTenantId = "tenant-2";
    serve([{ taxType: "EXEMPTB", effectiveRate: 0, status: TaxRate.StatusEnum.ACTIVE }]);
    await expect(readXeroTaxRates()).resolves.toEqual([expect.objectContaining({ taxType: "EXEMPTB" })]);
    expect(live.getTaxRates).toHaveBeenCalledTimes(2);

    // Same organisation again: the cache answers.
    await readXeroTaxRates();
    expect(live.getTaxRates).toHaveBeenCalledTimes(2);

    // Disconnected: the cache never answers for no organisation.
    live.connectedTenantId = null;
    await readXeroTaxRates();
    expect(live.getTaxRates).toHaveBeenCalledTimes(3);
  });

  it("throws when Xero cannot be read, and the degrading reader answers null instead", async () => {
    live.getTaxRates.mockRejectedValue(new Error("429"));
    await expect(readXeroTaxRates()).rejects.toThrow("429");
    await expect(readXeroTaxRatesOrNull()).resolves.toBeNull();
  });

  it("does not ask Xero again for a minute after the degrading reader failed", async () => {
    live.getTaxRates.mockRejectedValue(new Error("503"));
    await expect(readXeroTaxRatesOrNull()).resolves.toBeNull();
    await expect(readXeroTaxRatesOrNull()).resolves.toBeNull();
    expect(live.getTaxRates).toHaveBeenCalledTimes(1);

    serve([{ taxType: "OUTPUT2", effectiveRate: 15, status: TaxRate.StatusEnum.ACTIVE, canApplyToRevenue: true }]);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await expect(readXeroTaxRatesOrNull()).resolves.toEqual([expect.objectContaining({ taxType: "OUTPUT2" })]);
    expect(live.getTaxRates).toHaveBeenCalledTimes(2);
  });
});
