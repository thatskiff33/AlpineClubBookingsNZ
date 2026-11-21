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
 * - not registered: the line names no tax type at all.
 */
export interface ExemptLineScenario {
  registered: boolean;
  /** The Exempt mapping for the connected organisation, or null when unmapped. */
  exemptTaxType: string | null;
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
      await harness.arrange({ registered: true, exemptTaxType: "EXEMPTCODE" });
      const line = await harness.renderLine();
      expect(line.taxType).toBe("EXEMPTCODE");
    });

    it("is refused before any provider write while a registered club has not mapped Exempt", async () => {
      await harness.arrange({ registered: true, exemptTaxType: null });
      await expect(harness.renderLine()).rejects.toBeInstanceOf(XeroTaxCategoryUnavailableError);
      expect(harness.providerWrites()).toBe(0);
    });

    it("names no tax type for a club that is not registered, mapped or not", async () => {
      for (const exemptTaxType of [null, "EXEMPTCODE"]) {
        await harness.arrange({ registered: false, exemptTaxType });
        const line = await harness.renderLine();
        expect("taxType" in line).toBe(false);
      }
    });
  });
}
