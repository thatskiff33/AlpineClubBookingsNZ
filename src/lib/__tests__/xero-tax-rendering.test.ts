import { describe, expect, it } from "vitest";
import { LineAmountTypes } from "xero-node";
import { CLUB_TAX_SETTINGS_DEFAULTS, clubTaxTreatmentOn, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";
import {
  BASELINE_XERO_TAX_RENDERING,
  DEFAULT_XERO_OUTPUT_TAX_TYPE,
  xeroDocumentCarriesTax,
  xeroLineTax,
  xeroTaxRenderingOf,
} from "@/lib/xero-tax-rendering";

/**
 * The one Xero tax renderer (#4632): the baseline renders exactly what every
 * document carried before, a custom code renders that code, and an unregistered
 * club renders `NoTax` with no line tax type at all.
 */
const on = (schedule: ClubTaxSchedule, date: string) => clubTaxTreatmentOn(schedule, requireCalendarDate(date));
const schedule: ClubTaxSchedule = [
  CLUB_TAX_SETTINGS_DEFAULTS,
  { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "TAX005", effectiveFrom: requireCalendarDate("2027-04-01") },
  { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2028-04-01") },
];

describe("xeroTaxRenderingOf (#4632)", () => {
  it("renders the baseline period as the frozen baseline rendering, OUTPUT2 inclusive", () => {
    expect(xeroTaxRenderingOf(on(schedule, "2026-07-01"))).toEqual(BASELINE_XERO_TAX_RENDERING);
    expect(BASELINE_XERO_TAX_RENDERING).toEqual({ lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT2" });
    expect(DEFAULT_XERO_OUTPUT_TAX_TYPE).toBe("OUTPUT2");
    expect(Object.isFrozen(BASELINE_XERO_TAX_RENDERING)).toBe(true);
  });

  it("renders a registered period's own Xero code", () => {
    expect(xeroTaxRenderingOf(on(schedule, "2027-04-01"))).toEqual({ lineAmountTypes: LineAmountTypes.Inclusive, taxType: "TAX005" });
  });

  it("renders an unregistered period as NoTax with no tax type", () => {
    const rendering = xeroTaxRenderingOf(on(schedule, "2028-04-01"));
    expect(rendering).toEqual({ lineAmountTypes: LineAmountTypes.NoTax });
    expect("taxType" in rendering).toBe(false);
  });
});

describe("xeroLineTax (#4632)", () => {
  it("keeps a baseline line byte-identical to the pre-#4632 literal", () => {
    const before = { description: "Lodge", unitAmount: 50, taxType: "OUTPUT2", accountCode: "200" };
    const after = { description: "Lodge", unitAmount: 50, ...xeroLineTax(BASELINE_XERO_TAX_RENDERING), accountCode: "200" };
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("adds no taxType key at all for an unregistered club", () => {
    const line = { unitAmount: 50, ...xeroLineTax({ lineAmountTypes: LineAmountTypes.NoTax }) };
    expect(Object.keys(line)).toEqual(["unitAmount"]);
  });
});

describe("xeroDocumentCarriesTax (#4632)", () => {
  const custom = { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "TAX005" };
  const noTax = { lineAmountTypes: LineAmountTypes.NoTax };

  it("accepts a document raised under the same treatment", () => {
    expect(xeroDocumentCarriesTax({ lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [{ taxType: "OUTPUT2" }] }, BASELINE_XERO_TAX_RENDERING)).toBe(true);
    expect(xeroDocumentCarriesTax({ lineAmountTypes: LineAmountTypes.NoTax, lineItems: [{ taxType: "NONE" }, {}] }, noTax)).toBe(true);
  });

  it("refuses a document raised under another treatment", () => {
    const baseline = { lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [{ taxType: "OUTPUT2" }] };
    expect(xeroDocumentCarriesTax(baseline, custom)).toBe(false);
    expect(xeroDocumentCarriesTax(baseline, noTax)).toBe(false);
    expect(xeroDocumentCarriesTax({ lineAmountTypes: LineAmountTypes.Exclusive, lineItems: [{ taxType: "OUTPUT2" }] }, BASELINE_XERO_TAX_RENDERING)).toBe(false);
    expect(xeroDocumentCarriesTax({ lineAmountTypes: LineAmountTypes.NoTax, lineItems: [{ taxType: "OUTPUT2" }] }, noTax)).toBe(false);
  });
});
