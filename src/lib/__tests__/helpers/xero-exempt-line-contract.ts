import { describe, expect, it } from "vitest";
import { XeroTaxCategoryUnavailableError } from "@/lib/xero-tax-categories";

/**
 * THE EXEMPT LINE'S CONTRACT (#5209), for every sender of a line in the Exempt
 * tax category — first #4988's spent opening credit coded to the Opening
 * Credits liability account. A sender's own test calls this with a harness that
 * arranges the club's treatment and Exempt mapping, renders (or sends) its
 * line, and counts its provider writes:
 *
 * - mapped: the line carries the mapped Xero code;
 * - registered and unmapped: `XeroTaxCategoryUnavailableError`, and nothing is
 *   written to Xero — never a fallback code;
 * - registered and mapped to a rate Xero now charges tax at (someone edited the
 *   club's "Exempt" rate in Xero): the same refusal, reason `unfit`;
 * - not registered: the line names no tax type at all.
 */
export interface ExemptLineScenario {
  registered: boolean;
  /** The Exempt mapping for the connected organisation, or null when unmapped. */
  exemptTaxType: string | null;
  /**
   * Whether the connected organisation's rate for `exemptTaxType` is 0%, as an
   * Exempt rate must be. The harness serves that rate, active, at 0% when true
   * and at a non-zero percentage when false.
   */
  exemptRateIsZero: boolean;
}

export interface ExemptLineHarness {
  arrange(scenario: ExemptLineScenario): void | Promise<void>;
  /** Renders the line, sending it where the sender sends; resolves to the line Xero would receive. */
  renderLine(): Promise<{ taxType?: string }>;
  /** How many writes reached the Xero provider since the last `arrange`. */
  providerWrites(): number;
}

export function describeExemptLineContract(name: string, harness: ExemptLineHarness): void {
  describe(`${name}: the Exempt line contract (#5209)`, () => {
    it("carries the Exempt category's mapped Xero code", async () => {
      await harness.arrange({ registered: true, exemptTaxType: "EXEMPTCODE", exemptRateIsZero: true });
      const line = await harness.renderLine();
      expect(line.taxType).toBe("EXEMPTCODE");
    });

    it("is refused before any provider write while a registered club has not mapped Exempt", async () => {
      await harness.arrange({ registered: true, exemptTaxType: null, exemptRateIsZero: true });
      await expect(harness.renderLine()).rejects.toBeInstanceOf(XeroTaxCategoryUnavailableError);
      expect(harness.providerWrites()).toBe(0);
    });

    it("is refused before any provider write when the mapped rate is no longer 0% in Xero", async () => {
      await harness.arrange({ registered: true, exemptTaxType: "EXEMPTCODE", exemptRateIsZero: false });
      const error = await harness.renderLine().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(XeroTaxCategoryUnavailableError);
      expect((error as XeroTaxCategoryUnavailableError).reason).toBe("unfit");
      expect(harness.providerWrites()).toBe(0);
    });

    it("names no tax type for a club that is not registered, mapped or not", async () => {
      for (const exemptTaxType of [null, "EXEMPTCODE"]) {
        await harness.arrange({ registered: false, exemptTaxType, exemptRateIsZero: true });
        const line = await harness.renderLine();
        expect("taxType" in line).toBe(false);
      }
    });
  });
}
