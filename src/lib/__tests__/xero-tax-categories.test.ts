/**
 * The club's tax categories (#5209): which Xero rate each mapped category may
 * name, what an Exempt line needs first, and which account mappings share the
 * Opening Credits code. The frozen clock's club today is 2026-07-01.
 */
import { XeroTaxCategory } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxPeriod, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";
import {
  MAPPED_XERO_TAX_CATEGORIES,
  XERO_TAX_CATEGORIES,
  usableXeroTaxCategoryRates,
  xeroTaxCategoryRateFault,
  xeroTaxCategoryRateProblem,
} from "@/lib/xero-tax-categories";
import {
  exemptPrerequisiteProblem,
  openingCreditsAccountConflicts,
  registeredNowOrLater,
} from "@/lib/xero-tax-category-prerequisites";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

const rate = (overrides: Partial<XeroTaxRateOption>): XeroTaxRateOption => ({
  taxType: "OUTPUT2",
  name: "15% GST on Income",
  rateBasisPoints: 1500,
  active: true,
  revenue: true,
  expenses: false,
  ...overrides,
});
const RATES = [
  rate({}),
  rate({ taxType: "INPUT2", name: "15% GST on Expenses", revenue: false, expenses: true }),
  rate({ taxType: "EXEMPTOUTPUT", name: "Exempt Income", rateBasisPoints: 0 }),
  rate({ taxType: "ZERORATED", name: "Zero Rated", rateBasisPoints: 0, expenses: true }),
  rate({ taxType: "OLDNONE", name: "Old No GST", rateBasisPoints: 0, active: false }),
];
const today = requireCalendarDate("2026-07-01");
const period = (overrides: Partial<ClubTaxPeriod>): ClubTaxPeriod => ({ ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides });
const unregistered = (from: string) =>
  period({ gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate(from) });

describe("the category registry (#5209)", () => {
  it("has the owner's four categories, and income is never a mapped one", () => {
    expect(XERO_TAX_CATEGORIES.map((category) => category.label)).toEqual([
      "Sales tax on income",
      "Sales tax on expenses",
      "Exempt",
      "Zero rated",
    ]);
    expect(MAPPED_XERO_TAX_CATEGORIES).toEqual(["SALES_TAX_ON_EXPENSES", "EXEMPT", "ZERO_RATED"]);
    // The stored enum is exactly the mapped categories: income cannot be stored, and no stored value lacks a row.
    expect([...MAPPED_XERO_TAX_CATEGORIES].sort()).toEqual(Object.values(XeroTaxCategory).sort());
  });

  it("says on the screen which categories no document uses yet", () => {
    const withoutSender = XERO_TAX_CATEGORIES.filter((category) => "noSenderYet" in category).map((category) => category.key);
    expect(withoutSender).toEqual(["SALES_TAX_ON_EXPENSES", "ZERO_RATED"]);
  });
});

describe("xeroTaxCategoryRateProblem (#5209)", () => {
  it.each([
    ["SALES_TAX_ON_EXPENSES", "INPUT2"],
    ["EXEMPT", "EXEMPTOUTPUT"],
    ["EXEMPT", "ZERORATED"],
    ["ZERO_RATED", "ZERORATED"],
  ] as const)("accepts %s mapped to %s", (category, taxType) => {
    expect(xeroTaxCategoryRateProblem(RATES, category, taxType)).toBeNull();
  });

  it.each([
    ["EXEMPT", "GONE", "removed", /Exempt: Xero has no tax rate with the code GONE/],
    ["ZERO_RATED", "OLDNONE", "inactive", /Zero rated: .* is not active/],
    ["EXEMPT", "OUTPUT2", "unfit", /Exempt: .* is not 0%/],
    ["ZERO_RATED", "INPUT2", "unfit", /Zero rated: .* is not 0%/],
    ["SALES_TAX_ON_EXPENSES", "OUTPUT2", "unfit", /Sales tax on expenses: .* cannot be used on expenses/],
  ] as const)("refuses %s mapped to %s (%s)", (category, taxType, reason, message) => {
    expect(xeroTaxCategoryRateProblem(RATES, category, taxType)).toMatch(message);
    expect(xeroTaxCategoryRateFault(RATES, category, taxType)?.reason).toBe(reason);
  });

  it("offers each picker exactly the rates the rule accepts", () => {
    expect(usableXeroTaxCategoryRates(RATES, "SALES_TAX_ON_EXPENSES").map((option) => option.taxType)).toEqual(["INPUT2", "ZERORATED"]);
    expect(usableXeroTaxCategoryRates(RATES, "EXEMPT").map((option) => option.taxType)).toEqual(["EXEMPTOUTPUT", "ZERORATED"]);
  });
});

describe("exemptPrerequisiteProblem (#5209, for #4988's Opening Credits account)", () => {
  const registered: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS];
  const notRegistered: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS, unregistered("2026-01-01")];
  const scheduledRegistration: ClubTaxSchedule = [
    ...notRegistered,
    period({ effectiveFrom: requireCalendarDate("2026-10-01") }),
  ];

  it("asks for an Exempt mapping while the club is registered today", () => {
    expect(exemptPrerequisiteProblem({ schedule: registered, today, exemptTaxType: null, rates: RATES })).toMatch(/map the Exempt/);
    expect(exemptPrerequisiteProblem({ schedule: registered, today, exemptTaxType: "EXEMPTOUTPUT", rates: RATES })).toBeNull();
  });

  it("asks for it when a registration is only scheduled, so it cannot start without one", () => {
    expect(registeredNowOrLater(scheduledRegistration, today)).toBe(true);
    expect(exemptPrerequisiteProblem({ schedule: scheduledRegistration, today, exemptTaxType: null, rates: RATES })).toMatch(/map the Exempt/);
  });

  it("needs nothing for a club that is not registered and has no registration scheduled", () => {
    expect(registeredNowOrLater(notRegistered, today)).toBe(false);
    expect(exemptPrerequisiteProblem({ schedule: notRegistered, today, exemptTaxType: null, rates: null })).toBeNull();
  });

  it("refuses a mapped rate Xero no longer carries, and one it cannot check", () => {
    expect(exemptPrerequisiteProblem({ schedule: registered, today, exemptTaxType: "GONE", rates: RATES })).toMatch(/no tax rate/);
    expect(exemptPrerequisiteProblem({ schedule: registered, today, exemptTaxType: "EXEMPTOUTPUT", rates: null })).toMatch(/could not be read/);
  });
});

describe("openingCreditsAccountConflicts (#5209, for #4988)", () => {
  it("reports a key whose application default is the code", () => {
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "200", mappings: [] })).toContain("hutFeesIncome");
  });

  it("reports a key whose explicit code is the code, and not one moved off it", () => {
    const mappings = [
      { key: "hutFeesIncome", code: "2100" },
      { key: "hutFeeRefunds", code: "2100" },
    ];
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "2100", mappings })).toEqual(["hutFeesIncome", "hutFeeRefunds"]);
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "200", mappings })).not.toContain("hutFeesIncome");
  });

  it("compares case- and whitespace-insensitively, and a blank row falls back to the default", () => {
    const mappings = [{ key: "hutFeesIncome", code: " oc-1 " }, { key: "hutFeeRefunds", code: "  " }];
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "OC-1", mappings })).toEqual(["hutFeesIncome"]);
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "200", mappings })).toEqual(["hutFeeRefunds"]);
  });

  it("MUTATION (#5375 item 2): never reports the Opening Credits key as a conflict with itself", () => {
    // #4988 made `openingCredits` an account-mapping key, so its own row always matches its own code.
    const mappings = [{ key: "openingCredits", code: "2100" }, { key: "hutFeeRefunds", code: "202" }];
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "2100", mappings })).toEqual([]);
    // A real conflict beside it is still reported, alone.
    expect(
      openingCreditsAccountConflicts({ openingCreditsCode: "2100", mappings: [...mappings, { key: "stripeFees", code: "2100" }] }),
    ).toEqual(["stripeFees"]);
  });

  it("reports nothing when no key shares the code, or there is no code", () => {
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "2999", mappings: [] })).toEqual([]);
    expect(openingCreditsAccountConflicts({ openingCreditsCode: "  ", mappings: [] })).toEqual([]);
  });
});
