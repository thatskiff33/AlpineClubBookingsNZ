/**
 * HOW A HUT-FEE LINE IS CODED IN XERO - the item-code and account-code
 * precedence, in one place (#3530 stage 2b, `INV-SSOT`).
 *
 * Extracted verbatim from `buildInvoiceLineItems` (#1930 E4), which still
 * applies it to the original invoice's guest lines; the itemised lines on a
 * supplementary invoice and on a modification credit note (#3530) apply the
 * same two rules, so the account a night's money lands in cannot depend on
 * which document carried it.
 *
 * Pure: no database, no provider. The resolver and the mappings are loaded by
 * the caller (`getHutFeeItemCodeMap`, `getResolvedAccountMapping`).
 */
import type { LineItem } from "xero-node";
import { DEFAULT_HUT_FEE_ACCOUNT_CODE } from "@/lib/xero-account-mapping-keys";
import {
  isHutFeeResolverConfigured,
  resolveHutFeeItemCode,
  type HutFeeItemCodeResolver,
  type ResolvedAccountMapping,
} from "@/lib/xero-mappings";
import { xeroLineTax, type XeroTaxRendering } from "@/lib/xero-tax-rendering";

/**
 * The item code for one guest's hut-fee line. When the per-guest resolver is
 * configured (keyed rows or the legacy flat `hutFeeItem`) AND a season type is
 * known, the resolver's answer is FINAL - a miss with keyed rows present yields
 * NO item code (an account-coded line), never the single `hutFeesIncome` item
 * code. That single item code applies only when the resolver is absent or
 * unconfigured, or the season type is unknown.
 */
export function resolveHutFeeLineItemCode(
  guest: { ageTier: string; isMember: boolean; rateMembershipTypeId?: string | null },
  context: {
    itemCodeResolver?: HutFeeItemCodeResolver | null;
    seasonType?: string | null;
    /** The single `hutFeesIncome` item code, the fallback named above. */
    itemCode?: string | null;
  },
): string | null {
  const resolverActive = Boolean(
    context.itemCodeResolver &&
      context.seasonType &&
      isHutFeeResolverConfigured(context.itemCodeResolver),
  );
  return resolverActive
    ? resolveHutFeeItemCode(context.itemCodeResolver!, guest, context.seasonType)
    : (context.itemCode ?? null);
}

type RefundLineMapping = { itemCode?: string | null; code?: string | null; codeExplicitlyConfigured: boolean };

export function hutFeeRefundLineCodes(mapping: RefundLineMapping): Pick<LineItem, "itemCode" | "accountCode"> {
  return applyHutFeeLineCodes({}, {
    itemCode: mapping.itemCode,
    accountCode: mapping.code ?? DEFAULT_HUT_FEE_ACCOUNT_CODE,
    accountCodeExplicitlyConfigured: mapping.codeExplicitlyConfigured,
  });
}

/**
 * One hut-fee refund line under the caller's tax rendering (#4632), with the
 * `hutFeeRefunds` item and account (`INV-PAY-151`). The refund credit note and the failed-card-refund reversal
 * invoice both use it, so the reversal copies the note it undoes.
 */
export function hutFeeRefundLine(
  description: string,
  amountCents: number,
  mapping: RefundLineMapping,
  taxRendering: XeroTaxRendering,
): LineItem {
  return hutFeeRefundLineCodedAs(description, amountCents, hutFeeRefundLineCodes(mapping), taxRendering);
}

/**
 * A hut-fee refund line coded with item and account codes the caller already
 * holds rather than today's mapping: the failed-card-refund reversal copies
 * the coding of the card note it undoes, so a mapping changed since (#5235,
 * revenue to expense) cannot split the note and its reversal across two
 * accounts. A code absent from `codes` stays absent from the line.
 */
export function hutFeeRefundLineCodedAs(
  description: string,
  amountCents: number,
  codes: Pick<LineItem, "itemCode" | "accountCode">,
  taxRendering: XeroTaxRendering,
): LineItem {
  return {
    description,
    quantity: 1,
    unitAmount: amountCents / 100,
    ...xeroLineTax(taxRendering),
    ...(codes.itemCode ? { itemCode: codes.itemCode } : {}),
    ...(codes.accountCode ? { accountCode: codes.accountCode } : {}),
  };
}

/** Xero uses the item's account unless the line overrides it. */
export function applyHutFeeLineCodes(
  lineItem: LineItem,
  codes: {
    itemCode: string | null | undefined;
    accountCode: string;
    accountCodeExplicitlyConfigured: boolean;
  },
): LineItem {
  if (codes.itemCode) {
    lineItem.itemCode = codes.itemCode;
  }
  if (!codes.itemCode || codes.accountCode !== DEFAULT_HUT_FEE_ACCOUNT_CODE || codes.accountCodeExplicitlyConfigured) {
    lineItem.accountCode = codes.accountCode;
  }
  return lineItem;
}

/**
 * The codes for a promotion line: the promo's own Xero item and account when
 * it has them, else the first guest's hut-fee item code. Unlike a guest line,
 * the promo fallback DOES fall through to the single `hutFeesIncome` item code
 * on a per-guest miss - preserved from the original invoice (#1930, E4).
 */
export function resolvePromoLineCodes(context: {
  promo: { xeroItemCode?: string | null; xeroAccountCode?: string | null } | null;
  firstGuest: { ageTier: string; isMember: boolean; rateMembershipTypeId?: string | null } | null;
  itemCodeResolver?: HutFeeItemCodeResolver | null;
  seasonType?: string | null;
  hutFeeMapping: ResolvedAccountMapping;
}): { itemCode: string | null; accountCode: string; accountCodeExplicitlyConfigured: boolean } {
  const { promo, firstGuest, itemCodeResolver, seasonType, hutFeeMapping } = context;
  const fallbackItemCode =
    seasonType && firstGuest && itemCodeResolver && isHutFeeResolverConfigured(itemCodeResolver)
      ? (resolveHutFeeItemCode(itemCodeResolver, firstGuest, seasonType) ?? hutFeeMapping.itemCode)
      : hutFeeMapping.itemCode;
  return {
    itemCode: promo?.xeroItemCode ?? fallbackItemCode ?? null,
    accountCode: promo?.xeroAccountCode ?? hutFeeMapping.code ?? DEFAULT_HUT_FEE_ACCOUNT_CODE,
    accountCodeExplicitlyConfigured:
      promo?.xeroAccountCode != null || hutFeeMapping.codeExplicitlyConfigured,
  };
}
