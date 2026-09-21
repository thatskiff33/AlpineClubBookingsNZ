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
import {
  isHutFeeResolverConfigured,
  resolveHutFeeItemCode,
  type HutFeeItemCodeResolver,
  type ResolvedAccountMapping,
} from "@/lib/xero-mappings";

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

/**
 * Stamp the codes onto a line. If an item code is set, Xero fills the account
 * from the Item's own configuration; the account code is sent as well when
 * there is no item code, when the account is not the "200" default, or when
 * the admin explicitly configured the account to override the Item's default.
 */
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
  if (!codes.itemCode || codes.accountCode !== "200" || codes.accountCodeExplicitlyConfigured) {
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
    accountCode: promo?.xeroAccountCode ?? hutFeeMapping.code ?? "200",
    accountCodeExplicitlyConfigured:
      promo?.xeroAccountCode != null || hutFeeMapping.codeExplicitlyConfigured,
  };
}
