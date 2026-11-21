/**
 * Whether Xero can carry the club's tax treatment (#4632): the one test a
 * period's code must pass (`xeroTaxCodeProblem`), the picker's list of usable
 * rates, and the health check's three cases against the period in force today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxPeriod } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";
import { usableXeroTaxRates, xeroTaxCodeProblem, type XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  rates: vi.fn(),
  organisation: vi.fn(),
  mappings: vi.fn(),
}));
const openingCreditsRow = vi.hoisted(() => vi.fn());
// #4988: the health check asks whether the Opening Credits account is mapped.
vi.mock("@/lib/prisma", () => ({ prisma: { xeroAccountMapping: { findUnique: openingCreditsRow } } }));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: mocks.schedule,
}));
vi.mock("@/lib/xero-tax-rates", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-tax-rates")),
  readXeroTaxRatesOrNull: mocks.rates,
}));
vi.mock("@/lib/xero-organisation", () => ({ getXeroConnectedOrganisation: mocks.organisation }));
vi.mock("@/lib/xero-tax-category-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-tax-category-mappings")),
  loadXeroTaxCategoryMappings: mocks.mappings,
}));

import { readXeroTaxHealth } from "@/lib/xero-tax-health";

const rate = (overrides: Partial<XeroTaxRateOption>): XeroTaxRateOption => ({
  taxType: "OUTPUT2",
  name: "15% GST on Income",
  rateBasisPoints: 1500,
  active: true,
  revenue: true,
  expenses: false,
  ...overrides,
});
const period = (overrides: Partial<ClubTaxPeriod> = {}): ClubTaxPeriod => ({ ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides });
const unregistered = period({ gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null });

describe("xeroTaxCodeProblem", () => {
  const rates = [
    rate({}),
    rate({ taxType: "OUTPUT3", name: "Old GST", active: false }),
    rate({ taxType: "INPUT2", name: "GST on Expenses", revenue: false, expenses: true }),
    rate({ taxType: "TAX005", name: "12.5% GST", rateBasisPoints: 1250 }),
  ];

  it("accepts an active revenue code at the period's own rate", () => {
    expect(xeroTaxCodeProblem(rates, period())).toBeNull();
    expect(xeroTaxCodeProblem(rates, period({ taxRateBasisPoints: 1250, xeroTaxType: "TAX005" }))).toBeNull();
  });

  it("has nothing to check for a club that is not registered", () => {
    expect(xeroTaxCodeProblem([], unregistered)).toBeNull();
  });

  it.each([
    ["missing", period({ xeroTaxType: "NOPE" }), /no tax rate with the code NOPE/],
    ["inactive", period({ xeroTaxType: "OUTPUT3" }), /not active/],
    ["not on revenue", period({ xeroTaxType: "INPUT2" }), /cannot be used on revenue/],
    ["at another rate", period({ xeroTaxType: "TAX005" }), /is 12\.5%, not 15%/],
  ])("refuses a code that is %s", (_label, candidate, message) => {
    expect(xeroTaxCodeProblem(rates, candidate)).toMatch(message);
  });

  it("offers only active revenue rates at the chosen rate", () => {
    expect(usableXeroTaxRates(rates, 1500).map((option) => option.taxType)).toEqual(["OUTPUT2"]);
    expect(usableXeroTaxRates(rates, 1250).map((option) => option.taxType)).toEqual(["TAX005"]);
  });
});

describe("readXeroTaxHealth", () => {
  beforeEach(() => {
    mocks.schedule.mockResolvedValue([period()]);
    mocks.rates.mockResolvedValue([rate({})]);
    mocks.organisation.mockResolvedValue({ paysTax: true });
    mocks.mappings.mockResolvedValue({ tenantId: "tenant-connected", rows: [] });
    openingCreditsRow.mockReset();
    openingCreditsRow.mockResolvedValue(null);
  });

  it("is clean when Xero agrees with the period in force today", async () => {
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
  });

  it("flags a code in force that Xero no longer carries", async () => {
    mocks.rates.mockResolvedValue([rate({ active: false })]);
    expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/not active/)]);
  });

  it("flags a rate that differs", async () => {
    mocks.rates.mockResolvedValue([rate({ rateBasisPoints: 1250 })]);
    expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/12\.5%, not 15%/)]);
  });

  it("flags an organisation whose PaysTax disagrees with the registered flag, either way", async () => {
    mocks.organisation.mockResolvedValue({ paysTax: false });
    expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/does not pay tax/)]);
    mocks.schedule.mockResolvedValue([unregistered]);
    mocks.organisation.mockResolvedValue({ paysTax: true });
    expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/not GST-registered.*pays tax/)]);
  });

  it("judges the period in force today, not the baseline or a scheduled one", async () => {
    // The frozen clock's club today is 2026-07-01.
    mocks.schedule.mockResolvedValue([
      period(),
      { ...unregistered, effectiveFrom: requireCalendarDate("2026-06-01") },
      period({ effectiveFrom: requireCalendarDate("2026-08-01"), xeroTaxType: "GONE" }),
    ]);
    mocks.organisation.mockResolvedValue({ paysTax: false });
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
  });

  it("says it did not check when Xero could not be read at all", async () => {
    mocks.rates.mockResolvedValue(null);
    mocks.organisation.mockResolvedValue({ paysTax: null });
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: false, problems: [] });
  });

  it("flags a mapped tax category whose rate was removed in Xero, or that no longer fits it (#5209)", async () => {
    mocks.rates.mockResolvedValue([rate({}), rate({ taxType: "NOWTAXED", name: "Now taxed", rateBasisPoints: 1500 })]);
    mocks.mappings.mockResolvedValue({
      tenantId: "tenant-connected",
      rows: [
        { category: "EXEMPT", taxType: "GONE", currentTenant: true },
        { category: "ZERO_RATED", taxType: "NOWTAXED", currentTenant: true },
      ],
    });
    expect((await readXeroTaxHealth()).problems).toEqual([
      expect.stringMatching(/^Exempt: Xero has no tax rate with the code GONE/),
      expect.stringMatching(/^Zero rated: .* is not 0%/),
    ]);
  });

  it("flags a mapping chosen in another Xero organisation, even when Xero's rates cannot be read (#5209)", async () => {
    mocks.rates.mockResolvedValue(null);
    mocks.mappings.mockResolvedValue({
      tenantId: "tenant-connected",
      rows: [{ category: "EXEMPT", taxType: "EXEMPTOUTPUT", currentTenant: false }],
    });
    expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/^Exempt: mapped in a different Xero organisation/)]);
  });

  describe("Opening Credits mapped while Exempt has no usable rate (#4988, #5375 item 3)", () => {
    const OPENING_CREDITS_PROBLEM =
      "Opening Credits is mapped and the club is, or is scheduled to be, GST-registered, but the Exempt tax category has no usable Xero tax rate. Spent opening credits wait in the Xero queue until a Full Admin maps Exempt on the Xero setup screen.";
    const exemptRate = rate({ taxType: "EXEMPTOUTPUT", name: "Exempt", rateBasisPoints: 0 });

    beforeEach(() => {
      openingCreditsRow.mockResolvedValue({ code: "2100" });
      mocks.rates.mockResolvedValue([rate({}), exemptRate]);
    });

    it("MUTATION: is a health problem for a registered club that has not mapped Exempt", async () => {
      expect((await readXeroTaxHealth()).problems).toEqual([OPENING_CREDITS_PROBLEM]);
      expect(openingCreditsRow).toHaveBeenCalledWith({ where: { key: "openingCredits" }, select: { code: true } });
    });

    it("is a health problem for a club that is only scheduled to register", async () => {
      // The frozen clock's club today is 2026-07-01: unregistered today, registered from 1 August.
      mocks.schedule.mockResolvedValue([
        period(),
        { ...unregistered, effectiveFrom: requireCalendarDate("2026-06-01") },
        period({ effectiveFrom: requireCalendarDate("2026-08-01") }),
      ]);
      mocks.organisation.mockResolvedValue({ paysTax: false });
      expect((await readXeroTaxHealth()).problems).toEqual([OPENING_CREDITS_PROBLEM]);
    });

    it("is reported beside the category's own fault when the mapped rate stopped being usable", async () => {
      mocks.rates.mockResolvedValue([rate({}), { ...exemptRate, rateBasisPoints: 1500 }]);
      mocks.mappings.mockResolvedValue({
        tenantId: "tenant-connected",
        rows: [{ category: "EXEMPT", taxType: "EXEMPTOUTPUT", currentTenant: true }],
      });
      expect((await readXeroTaxHealth()).problems).toEqual([expect.stringMatching(/^Exempt: .* is not 0%/), OPENING_CREDITS_PROBLEM]);
    });

    it("is clean once Exempt is mapped to a usable rate", async () => {
      mocks.mappings.mockResolvedValue({
        tenantId: "tenant-connected",
        rows: [{ category: "EXEMPT", taxType: "EXEMPTOUTPUT", currentTenant: true }],
      });
      await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
    });

    it("is not a problem while Opening Credits is unmapped, or the club is not registered now or later", async () => {
      openingCreditsRow.mockResolvedValue({ code: "  " });
      await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
      openingCreditsRow.mockResolvedValue({ code: "2100" });
      mocks.schedule.mockResolvedValue([unregistered]);
      mocks.organisation.mockResolvedValue({ paysTax: false });
      await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
    });

    it("says nothing about a mapped rate it could not check, and nothing while Xero is not connected", async () => {
      mocks.rates.mockResolvedValue(null);
      mocks.mappings.mockResolvedValue({
        tenantId: "tenant-connected",
        rows: [{ category: "EXEMPT", taxType: "EXEMPTOUTPUT", currentTenant: true }],
      });
      expect((await readXeroTaxHealth()).problems).toEqual([]);
      mocks.mappings.mockResolvedValue({ tenantId: null, rows: [] });
      expect((await readXeroTaxHealth()).problems).toEqual([]);
    });
  });

  it("does not judge mappings while Xero is not connected (#5209)", async () => {
    mocks.mappings.mockResolvedValue({ tenantId: null, rows: [{ category: "EXEMPT", taxType: "GONE", currentTenant: false }] });
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
  });
});
