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
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
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

import { readXeroTaxHealth } from "@/lib/xero-tax-health";

const rate = (overrides: Partial<XeroTaxRateOption>): XeroTaxRateOption => ({
  taxType: "OUTPUT2",
  name: "15% GST on Income",
  rateBasisPoints: 1500,
  active: true,
  revenue: true,
  ...overrides,
});
const period = (overrides: Partial<ClubTaxPeriod> = {}): ClubTaxPeriod => ({ ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides });
const unregistered = period({ gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null });

describe("xeroTaxCodeProblem", () => {
  const rates = [
    rate({}),
    rate({ taxType: "OUTPUT3", name: "Old GST", active: false }),
    rate({ taxType: "INPUT2", name: "GST on Expenses", revenue: false }),
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
});
