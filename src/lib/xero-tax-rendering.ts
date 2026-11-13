import { LineAmountTypes } from "xero-node";
import type { ClubTaxTreatment } from "@/lib/club-tax-settings";

/**
 * THE ONE XERO TAX RENDERER (#4632). The only module under `src/` that names a
 * Xero tax type or a `LineAmountTypes` value; `xero-tax-rendering-census.test.ts`
 * holds every other module to that. Every invoice and credit note the app sends
 * takes its line-amount basis and its revenue lines' tax type from here, under
 * the club's tax treatment (`club-tax-settings.ts`), so Xero and the member-money
 * journal can never answer "how is this club taxed?" differently.
 *
 * Pure and small on purpose: the anchor that picks a treatment is resolved
 * elsewhere (`xero-tax-anchors.ts`), outside any transaction, and a later
 * manifest renderer (Ledger M13) can call this one rather than add another.
 *
 * Gross amounts never change: prices are GST-inclusive cents everywhere, so a
 * registered club's lines are `Inclusive` under its output code, and an
 * unregistered club's are `NoTax` with no line tax type at all. Only Xero's
 * split of the same gross differs.
 */

/**
 * New Zealand's GST-on-income code: the baseline treatment's Xero tax type, and
 * the column default of `ClubTaxSettings.xeroTaxType`. A club whose Xero uses
 * another code records it on its tax period; nothing else may name this one.
 */
export const DEFAULT_XERO_OUTPUT_TAX_TYPE = "OUTPUT2";

/** How a Xero document carries a treatment: its line-amount basis, and the tax type its revenue lines name. */
export interface XeroTaxRendering {
  readonly lineAmountTypes: LineAmountTypes;
  /** Absent when the club is not registered: the line then names no tax type. */
  readonly taxType?: string;
}

export function xeroTaxRenderingOf(treatment: ClubTaxTreatment): XeroTaxRendering {
  if (!treatment.registered) return { lineAmountTypes: LineAmountTypes.NoTax };
  return { lineAmountTypes: LineAmountTypes.Inclusive, taxType: treatment.xeroTaxType };
}

/**
 * The tax field a revenue line spreads in, at the place its literal `taxType`
 * used to sit, so a document rendered under the baseline is byte-identical to
 * one rendered before #4632. Empty when the club is not registered.
 */
export function xeroLineTax(rendering: XeroTaxRendering): { taxType?: string } {
  return rendering.taxType === undefined ? {} : { taxType: rendering.taxType };
}

/**
 * Whether an existing Xero document already carries this treatment: its
 * line-amount basis, and the tax type on each revenue line. The subscription
 * adoption matcher's tax test (#4632), so a document raised under another
 * treatment is never adopted as this one.
 */
export function xeroDocumentCarriesTax(
  document: { lineAmountTypes?: LineAmountTypes | string | null; lineItems?: ReadonlyArray<{ taxType?: string | null }> | null },
  rendering: XeroTaxRendering,
): boolean {
  if (document.lineAmountTypes !== rendering.lineAmountTypes) return false;
  return (document.lineItems ?? []).every((line) =>
    rendering.taxType === undefined ? !line.taxType || line.taxType === "NONE" : line.taxType === rendering.taxType);
}
