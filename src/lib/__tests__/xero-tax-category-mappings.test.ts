/**
 * A line's tax in one of the club's categories (#5209): income is the dated
 * schedule's own code, a mapped category is its mapping in the CONNECTED Xero
 * organisation, an unregistered club names no tax type, and anything Xero
 * cannot carry is refused with the typed error, never sent under a fallback.
 * The frozen clock's club today is 2026-07-01.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate, requireInstant } from "@/lib/club-time";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { describeExemptLineContract } from "./helpers/xero-exempt-line-contract";

const h = vi.hoisted(() => ({
  schedule: vi.fn(),
  connection: vi.fn(),
  rows: vi.fn(),
  rates: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { xeroTaxCategoryMapping: { findMany: h.rows } } }));
vi.mock("@/lib/booking-tax-anchor", () => ({ readBookingTaxAnchorInstant: vi.fn() }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: h.schedule,
}));
vi.mock("@/lib/xero-connection", () => ({ readXeroConnection: h.connection }));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.rates }));

import { XeroTaxCategoryUnavailableError } from "@/lib/xero-tax-categories";
import { loadXeroTaxCategoryMappings, resolveXeroCategoryLineTax } from "@/lib/xero-tax-category-mappings";

const TENANT = "tenant-connected";
const ANCHOR = { kind: "instant", at: requireInstant(new Date("2026-06-15T00:00:00.000Z")) } as const;
const REGISTERED: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS];
const UNREGISTERED: ClubTaxSchedule = [
  CLUB_TAX_SETTINGS_DEFAULTS,
  { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2026-01-01") },
];
const rate = (taxType: string, overrides: Partial<XeroTaxRateOption> = {}): XeroTaxRateOption => ({
  taxType,
  name: taxType,
  rateBasisPoints: 0,
  active: true,
  revenue: true,
  expenses: true,
  ...overrides,
});
const mapping = (category: string, taxType: string, xeroTenantId = TENANT) => ({ category, taxType, xeroTenantId });

beforeEach(() => {
  vi.clearAllMocks();
  h.schedule.mockResolvedValue(REGISTERED);
  h.connection.mockResolvedValue({ tenantId: TENANT, expiresAt: new Date() });
  h.rows.mockResolvedValue([]);
  h.rates.mockResolvedValue([rate("EXEMPTCODE"), rate("ZEROCODE"), rate("INPUTCODE", { rateBasisPoints: 1500 })]);
});

describe("resolveXeroCategoryLineTax (#5209)", () => {
  it("gives income the schedule's own code, with no mapping or Xero read", async () => {
    await expect(resolveXeroCategoryLineTax(ANCHOR, "SALES_TAX_ON_INCOME")).resolves.toEqual({ taxType: "OUTPUT2" });
    expect(h.rows).not.toHaveBeenCalled();
    expect(h.rates).not.toHaveBeenCalled();
  });

  it.each([
    ["SALES_TAX_ON_EXPENSES", "INPUTCODE"],
    ["EXEMPT", "EXEMPTCODE"],
    ["ZERO_RATED", "ZEROCODE"],
  ] as const)("gives %s its mapped code", async (category, taxType) => {
    h.rows.mockResolvedValue([mapping(category, taxType)]);
    await expect(resolveXeroCategoryLineTax(ANCHOR, category)).resolves.toEqual({ taxType });
  });

  it("names no tax type for any category while the anchor's period is unregistered", async () => {
    h.schedule.mockResolvedValue(UNREGISTERED);
    for (const category of ["SALES_TAX_ON_INCOME", "SALES_TAX_ON_EXPENSES", "EXEMPT", "ZERO_RATED"] as const) {
      expect(await resolveXeroCategoryLineTax(ANCHOR, category)).toEqual({});
    }
  });

  async function reasonFor(): Promise<string> {
    const error = await resolveXeroCategoryLineTax(ANCHOR, "EXEMPT").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XeroTaxCategoryUnavailableError);
    return (error as XeroTaxCategoryUnavailableError).reason;
  }

  it("refuses an unmapped category", async () => {
    expect(await reasonFor()).toBe("unmapped");
  });

  it("refuses a mapping saved in another Xero organisation, or with none connected", async () => {
    h.rows.mockResolvedValue([mapping("EXEMPT", "EXEMPTCODE", "tenant-before")]);
    expect(await reasonFor()).toBe("wrong-tenant");
    h.connection.mockResolvedValue(null);
    expect(await reasonFor()).toBe("wrong-tenant");
  });

  it("refuses a rate removed in Xero, or made inactive there", async () => {
    h.rows.mockResolvedValue([mapping("EXEMPT", "EXEMPTCODE")]);
    h.rates.mockResolvedValue([rate("ZEROCODE")]);
    expect(await reasonFor()).toBe("removed");
    h.rates.mockResolvedValue([rate("EXEMPTCODE", { active: false })]);
    expect(await reasonFor()).toBe("inactive");
  });

  it("refuses an Exempt or Zero rated rate that is no longer 0% in Xero, by the writer's own test", async () => {
    for (const [category, taxType] of [["EXEMPT", "EXEMPTCODE"], ["ZERO_RATED", "ZEROCODE"]] as const) {
      h.rows.mockResolvedValue([mapping(category, taxType)]);
      h.rates.mockResolvedValue([rate(taxType, { rateBasisPoints: 1500 })]);
      const error = await resolveXeroCategoryLineTax(ANCHOR, category).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(XeroTaxCategoryUnavailableError);
      expect((error as XeroTaxCategoryUnavailableError).reason).toBe("unfit");
    }
  });

  it("refuses a Sales tax on expenses rate Xero no longer lets apply to expenses", async () => {
    h.rows.mockResolvedValue([mapping("SALES_TAX_ON_EXPENSES", "INPUTCODE")]);
    h.rates.mockResolvedValue([rate("INPUTCODE", { rateBasisPoints: 1500, expenses: false })]);
    const error = await resolveXeroCategoryLineTax(ANCHOR, "SALES_TAX_ON_EXPENSES").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XeroTaxCategoryUnavailableError);
    expect((error as XeroTaxCategoryUnavailableError).reason).toBe("unfit");
  });

  it("refuses when Xero's rates cannot be read, rather than trust the stored code", async () => {
    h.rows.mockResolvedValue([mapping("EXEMPT", "EXEMPTCODE")]);
    h.rates.mockRejectedValue(new Error("Xero is down"));
    expect(await reasonFor()).toBe("rates-unreadable");
  });
});

describe("loadXeroTaxCategoryMappings (#5209)", () => {
  it("marks each row by whether it was chosen in the organisation connected now", async () => {
    h.rows.mockResolvedValue([mapping("EXEMPT", "EXEMPTCODE"), mapping("ZERO_RATED", "ZEROCODE", "tenant-before")]);
    await expect(loadXeroTaxCategoryMappings()).resolves.toEqual({
      tenantId: TENANT,
      rows: [
        { category: "EXEMPT", taxType: "EXEMPTCODE", currentTenant: true },
        { category: "ZERO_RATED", taxType: "ZEROCODE", currentTenant: false },
      ],
    });
  });
});

// A synthetic sender, built the way a real one must be: resolve the line's tax, then write.
let writes = 0;
describeExemptLineContract("a synthetic Exempt sender", {
  arrange({ registered, exemptTaxType, exemptRateIsZero }) {
    writes = 0;
    h.schedule.mockResolvedValue(registered ? REGISTERED : UNREGISTERED);
    h.rows.mockResolvedValue(exemptTaxType === null ? [] : [mapping("EXEMPT", exemptTaxType)]);
    h.rates.mockResolvedValue([rate("EXEMPTCODE", { rateBasisPoints: exemptRateIsZero ? 0 : 1500 })]);
  },
  async renderLine() {
    const line = { description: "Opening credit used", unitAmount: -20, ...(await resolveXeroCategoryLineTax(ANCHOR, "EXEMPT")), accountCode: "2100" };
    writes += 1;
    return line;
  },
  providerWrites: () => writes,
});
