import { LineAmountTypes } from "xero-node";
import type { ClubTaxTreatment } from "@/lib/club-tax-settings";
import { XeroTaxCategoryUnavailableError, type XeroTaxCategoryKey } from "@/lib/xero-tax-categories";

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

/**
 * The baseline treatment's rendering: what every document carried before #4632.
 * Only for a builder that prices lines without sending them (a reconciliation
 * total, a rounding audit) and so needs no anchor; a document the app SENDS
 * always resolves its anchor's rendering (`xero-tax-anchors.ts`). Equal to
 * `xeroTaxRenderingOf` of the baseline period, which `xero-tax-rendering.test.ts` holds.
 */
export const BASELINE_XERO_TAX_RENDERING: XeroTaxRendering = Object.freeze({
  lineAmountTypes: LineAmountTypes.Inclusive,
  taxType: DEFAULT_XERO_OUTPUT_TAX_TYPE,
});

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
 * The tax field a line in one of the club's tax categories spreads in (#5209;
 * `xero-tax-categories.ts`). An unregistered club's documents are `NoTax`, so
 * no category names a tax type there and none needs mapping. Sales tax on
 * income is the treatment's own code, exactly `xeroLineTax`. Any other category
 * takes the tax type the club mapped for its connected Xero organisation, which
 * the caller has already checked against Xero; unmapped, the line is refused
 * before any provider write, never sent under a guessed code.
 */
export function xeroCategoryLineTax(
  rendering: XeroTaxRendering,
  category: XeroTaxCategoryKey,
  mappedTaxType: string | null,
): { taxType?: string } {
  if (rendering.lineAmountTypes === LineAmountTypes.NoTax) return {};
  if (category === "SALES_TAX_ON_INCOME") return xeroLineTax(rendering);
  if (mappedTaxType === null) throw new XeroTaxCategoryUnavailableError(category, "unmapped");
  return { taxType: mappedTaxType };
}

/**
 * Whether an existing Xero document already carries this treatment: its
 * line-amount basis, and the tax type on each revenue line. The subscription
 * adoption matcher's tax test (#4632), so a document raised under another
 * treatment is never adopted as this one.
 *
 * Why the literal "NONE" stays (#5375 item 8, asked when the Exempt category
 * arrived in #5209): it is not a stand-in for the Exempt category's mapped
 * code, so a club that maps Exempt to another code changes nothing here. The
 * literal is read only when the treatment names no tax type (the club is not
 * registered), and the document must then be `NoTax` as well. Under that
 * treatment no mapping is read to render a line: `xeroCategoryLineTax` gives
 * a `NoTax` rendering's line no tax type, and `resolveXeroCategoryLineTax`
 * returns before it loads the mappings, so no document the app renders for
 * such a club carries a mapped code on any line. A line of such a document is taken
 * as untaxed when it names no tax type or names "NONE". A registered club's
 * document is matched line by line on the treatment's own code instead.
 */
export function xeroDocumentCarriesTax(
  document: { lineAmountTypes?: LineAmountTypes | string | null; lineItems?: ReadonlyArray<{ taxType?: string | null }> | null },
  rendering: XeroTaxRendering,
): boolean {
  if (document.lineAmountTypes !== rendering.lineAmountTypes) return false;
  return (document.lineItems ?? []).every((line) =>
    rendering.taxType === undefined ? !line.taxType || line.taxType === "NONE" : line.taxType === rendering.taxType);
}
