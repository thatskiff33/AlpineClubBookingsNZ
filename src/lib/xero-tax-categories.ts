import type { XeroTaxCategory } from "@prisma/client";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

/**
 * THE CLUB'S TAX CATEGORIES (#5209; `INV-CONFIG-008`). Four club-side answers
 * to "what tax does this line carry?", each mapped to a rate the club's OWN
 * Xero organisation provides, so no Xero tax code is written into the code
 * (`INV-CONFIG-001`). Pure and client-safe, with no database, Xero client or
 * schedule import, so the admin card filters its pickers by the same rule the
 * writer refuses by. What must be mapped before an Exempt line can be set up is
 * `xero-tax-category-prerequisites.ts`.
 *
 * SALES TAX ON INCOME IS THE DATED SCHEDULE, not a mapping (`INV-SSOT`): its
 * Xero code is each period's `xeroTaxType` on `ClubTaxSettings`, chosen on the
 * "GST / tax treatment" card. The other three are undated and scoped to the
 * Xero organisation they were chosen in (`XeroTaxCategoryMapping`), and only
 * matter while a registered period applies: an unregistered club's documents
 * carry no tax at all (`xeroCategoryLineTax`).
 */

/** The category stored as a mapping: every category but sales tax on income. */
export type MappedXeroTaxCategory = XeroTaxCategory;

export type XeroTaxCategoryKey = "SALES_TAX_ON_INCOME" | MappedXeroTaxCategory;

export interface XeroTaxCategoryDefinition {
  readonly key: XeroTaxCategoryKey;
  readonly label: string;
  readonly description: string;
  /** Said on the screen when no document uses the category yet. */
  readonly noSenderYet?: string;
}

const NO_SENDER_YET =
  "No document the app sends uses this category yet. It is mapped now so a later one can, without another settings change.";

export const XERO_TAX_CATEGORIES = [
  {
    key: "SALES_TAX_ON_INCOME",
    label: "Sales tax on income",
    description:
      "Bookings, subscriptions, fees and their credit notes. Set by the club's GST / tax treatment, which can change on a date.",
  },
  {
    key: "SALES_TAX_ON_EXPENSES",
    label: "Sales tax on expenses",
    description: "Tax the club pays on what it buys.",
    noSenderYet: NO_SENDER_YET,
  },
  {
    key: "EXEMPT",
    label: "Exempt",
    description: "Lines that carry no GST, such as a spent opening credit coded to the Opening Credits liability account.",
  },
  {
    key: "ZERO_RATED",
    label: "Zero rated",
    description: "Supplies taxed at 0%.",
    noSenderYet: NO_SENDER_YET,
  },
] as const satisfies readonly XeroTaxCategoryDefinition[];

/** The three categories a Full Admin maps, in screen order. */
export const MAPPED_XERO_TAX_CATEGORIES: readonly MappedXeroTaxCategory[] = XERO_TAX_CATEGORIES
  .map((definition) => definition.key)
  .filter((key): key is MappedXeroTaxCategory => key !== "SALES_TAX_ON_INCOME");

export function xeroTaxCategoryLabel(category: XeroTaxCategoryKey): string {
  return XERO_TAX_CATEGORIES.find((definition) => definition.key === category)!.label;
}

/** Why a rate fails a category: gone from Xero, not active, or the wrong kind of rate for it. */
export type XeroTaxCategoryRateFaultReason = "removed" | "inactive" | "unfit";

export interface XeroTaxCategoryRateFault {
  reason: XeroTaxCategoryRateFaultReason;
  /** The plain-English problem the card, the writer and the health check show. */
  message: string;
}

/**
 * THE ONE TEST OF WHETHER XERO'S RATE CAN CARRY A CATEGORY (`INV-SSOT`), or null
 * when it can. The rate must exist and be active; Exempt and Zero rated must be
 * 0%; Sales tax on expenses must be usable on expenses. The writer, the picker,
 * the health check and the send-time resolver (`resolveXeroCategoryLineTax`)
 * all judge by this.
 */
export function xeroTaxCategoryRateFault(
  rates: readonly XeroTaxRateOption[],
  category: MappedXeroTaxCategory,
  taxType: string,
): XeroTaxCategoryRateFault | null {
  const rate = rates.find((candidate) => candidate.taxType === taxType);
  const label = xeroTaxCategoryLabel(category);
  if (!rate) return { reason: "removed", message: `${label}: Xero has no tax rate with the code ${taxType}.` };
  if (!rate.active) {
    return { reason: "inactive", message: `${label}: Xero's tax rate ${taxType} (${rate.name}) is not active.` };
  }
  if ((category === "EXEMPT" || category === "ZERO_RATED") && rate.rateBasisPoints !== 0) {
    return { reason: "unfit", message: `${label}: Xero's tax rate ${taxType} (${rate.name}) is not 0%.` };
  }
  if (category === "SALES_TAX_ON_EXPENSES" && !rate.expenses) {
    return { reason: "unfit", message: `${label}: Xero's tax rate ${taxType} (${rate.name}) cannot be used on expenses.` };
  }
  return null;
}

/** `xeroTaxCategoryRateFault`'s message alone, or null when the rate can carry the category. */
export function xeroTaxCategoryRateProblem(
  rates: readonly XeroTaxRateOption[],
  category: MappedXeroTaxCategory,
  taxType: string,
): string | null {
  return xeroTaxCategoryRateFault(rates, category, taxType)?.message ?? null;
}

/** The rates a category's picker offers: exactly those `xeroTaxCategoryRateProblem` accepts. */
export function usableXeroTaxCategoryRates(
  rates: readonly XeroTaxRateOption[],
  category: MappedXeroTaxCategory,
): XeroTaxRateOption[] {
  return rates.filter((rate) => xeroTaxCategoryRateProblem(rates, category, rate.taxType) === null);
}

export type XeroTaxCategoryUnavailableReason =
  | "unmapped"
  | XeroTaxCategoryRateFaultReason
  | "wrong-tenant"
  | "rates-unreadable";

const UNAVAILABLE_REASON: Record<XeroTaxCategoryUnavailableReason, string> = {
  unmapped: "is not mapped to a Xero tax rate",
  removed: "is mapped to a tax rate the club's Xero organisation no longer has",
  inactive: "is mapped to a tax rate that is not active in Xero",
  unfit: "is mapped to a Xero tax rate that cannot carry it (Exempt and Zero rated need a 0% rate; expenses need a rate usable on expenses)",
  "wrong-tenant": "was mapped in a different Xero organisation from the one connected now",
  "rates-unreadable": "cannot be checked because Xero's tax rates could not be read",
};

/**
 * A registered club's line in a category Xero cannot carry. Thrown before any
 * provider write and never answered with a fallback code: the document waits
 * until a Full Admin maps the category on the Xero setup screen.
 */
export class XeroTaxCategoryUnavailableError extends Error {
  constructor(readonly category: MappedXeroTaxCategory, readonly reason: XeroTaxCategoryUnavailableReason) {
    super(`The ${xeroTaxCategoryLabel(category)} tax category ${UNAVAILABLE_REASON[reason]}; map it on the Xero setup screen.`);
    this.name = "XeroTaxCategoryUnavailableError";
  }
}
