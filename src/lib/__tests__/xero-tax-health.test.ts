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
  openMismatches: vi.fn(),
  mappings: vi.fn(),
}));
const openingCreditsRow = vi.hoisted(() => vi.fn());
const accountMappingRows = vi.hoisted(() => vi.fn());
// #4988: the health check asks whether the Opening Credits account is mapped,
// and reads every stored account mapping to see whether another shares its account.
vi.mock("@/lib/prisma", () => ({
  prisma: { xeroAccountMapping: { findUnique: openingCreditsRow, findMany: accountMappingRows } },
}));
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
vi.mock("@/lib/xero-tax-override-safeguard", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-tax-override-safeguard")),
  countOpenXeroTaxOverrideMismatches: mocks.openMismatches,
}));
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
    mocks.openMismatches.mockResolvedValue(0);
    mocks.mappings.mockResolvedValue({ tenantId: "tenant-connected", rows: [] });
    openingCreditsRow.mockReset();
    openingCreditsRow.mockResolvedValue(null);
    accountMappingRows.mockReset();
    accountMappingRows.mockResolvedValue([]);
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

  it("reports the GST-override pause while any flagged invoice is uncleared, even when Xero cannot be read (#5208)", async () => {
    mocks.openMismatches.mockResolvedValue(2);
    expect((await readXeroTaxHealth()).problems).toEqual([
      "Xero changed the GST on 2 invoices after the app sent it. Until someone in finance checks them and resumes, "
        + "new invoices go to Xero without the club's own GST figures and Xero works the GST out itself.",
    ]);
    mocks.openMismatches.mockResolvedValue(1);
    mocks.rates.mockResolvedValue(null);
    mocks.organisation.mockResolvedValue({ paysTax: null });
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: false, problems: [expect.stringMatching(/^Xero changed the GST on 1 invoice after/)] });
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
      "Opening Credits is mapped and the club is, or is scheduled to be, GST-registered, but the Exempt tax category has no usable Xero tax rate, so spent opening credits wait, or will wait, in the Xero queue. On a card booking, the booking's Xero invoice operation fails instead; retry it from the Xero Operations list once Exempt is mapped. A Full Admin maps Exempt to a 0% rate on the Xero setup screen, or unmaps the Opening Credits account under Account Mappings.";
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

  describe("Opening Credits stored on the Xero account another mapping uses (#4988, #5391)", () => {
    // The mapping screen's own rule and remedy (`xero-opening-credits-mapping-save.test.ts` pins the refusal),
    // with the health line's ending: here nothing was refused, the mappings are saved.
    const SHARED_ACCOUNT_PROBLEM =
      "Opening Credits cannot use the same Xero account as Hut Fee Refunds. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. The saved account mappings share that account now; change one of them under Account Mappings.";
    const shared = [
      { key: "hutFeesIncome", code: "201" },
      { key: "hutFeeRefunds", code: "2100" },
      { key: "openingCredits", code: "2100" },
    ];

    beforeEach(() => {
      accountMappingRows.mockResolvedValue(shared);
    });

    it("MUTATION: is a health problem once the stored mappings share the Opening Credits account, naming the other role", async () => {
      expect((await readXeroTaxHealth()).problems).toEqual([SHARED_ACCOUNT_PROBLEM]);
      expect(accountMappingRows).toHaveBeenCalledWith({ select: { key: true, code: true } });
    });

    it("never says a save was refused: the mappings it reports are stored", async () => {
      const [problem] = (await readXeroTaxHealth()).problems;
      expect(problem).not.toMatch(/No account mapping was saved/);
    });

    it("counts a role that only has its application default, compared without case or spaces", async () => {
      // No stored row for Hut Fees Income or Hut Fee Refunds: both sit on their default account, 200.
      accountMappingRows.mockResolvedValue([{ key: "openingCredits", code: " 200 " }]);
      expect((await readXeroTaxHealth()).problems).toEqual([
        expect.stringMatching(/^Opening Credits cannot use the same Xero account as .*Hut Fee Refunds.*\. Choose an account/),
      ]);
    });

    it("is reported for a club that is not GST-registered too, as the save is refused for one", async () => {
      mocks.schedule.mockResolvedValue([unregistered]);
      mocks.organisation.mockResolvedValue({ paysTax: false });
      expect((await readXeroTaxHealth()).problems).toEqual([SHARED_ACCOUNT_PROBLEM]);
    });

    it("is reported after the Exempt line when both apply", async () => {
      openingCreditsRow.mockResolvedValue({ code: "2100" });
      expect((await readXeroTaxHealth()).problems).toEqual([
        expect.stringMatching(/^Opening Credits is mapped and the club is, or is scheduled to be, GST-registered/),
        SHARED_ACCOUNT_PROBLEM,
      ]);
    });

    it("is clean while Opening Credits has an account to itself, or none", async () => {
      accountMappingRows.mockResolvedValue([
        { key: "hutFeesIncome", code: "201" },
        { key: "hutFeeRefunds", code: "202" },
        { key: "openingCredits", code: "2100" },
      ]);
      await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
      accountMappingRows.mockResolvedValue([
        { key: "hutFeeRefunds", code: "2100" },
        { key: "openingCredits", code: null },
      ]);
      await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
    });

    it("MUTATION: says nothing while Xero is not connected, and does not read the account mappings", async () => {
      mocks.mappings.mockResolvedValue({ tenantId: null, rows: [] });
      expect((await readXeroTaxHealth()).problems).toEqual([]);
      expect(accountMappingRows).not.toHaveBeenCalled();
    });
  });

  it("does not judge mappings while Xero is not connected (#5209)", async () => {
    mocks.mappings.mockResolvedValue({ tenantId: null, rows: [{ category: "EXEMPT", taxType: "GONE", currentTenant: false }] });
    await expect(readXeroTaxHealth()).resolves.toEqual({ checked: true, problems: [] });
  });
});
