import { LineAmountTypes, type LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { buildInvoiceLineItems } from "../../xero-booking-invoice-lines";
import { buildXeroBookingInvoiceCorrelationKey } from "../../xero-booking-invoice-key";
import type { HutFeeItemCodeResolver, ResolvedAccountMapping } from "../../xero-mappings";
import { CHANGE_FEE_LINE_DESCRIPTION, changeFeeLineItem, invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import {
  planPromoAdjustmentLines,
  promoAdjustmentLineItems,
  type PromoLineAdjustmentRow,
  type PromoLineRedemption,
} from "../../xero-promo-adjustment-lines";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { bookingChargeIdentity } from "./booking-charges";
import { componentKey, componentsPostedBy, liveComponentSplit, type PostedRevenueLeg } from "./components";

/**
 * THE PRIMARY BOOKING INVOICE, PLANNED FROM THE JOURNAL (#4525, Ledger M13).
 * Pure: no database, clock, settings or provider. It builds the lines
 * `createXeroInvoiceForBooking` builds, by calling the same builders
 * (`INV-SSOT`), and says which journal components those lines bill in whole,
 * or why they do not. The sender keeps sending its own lines; the export
 * manifest records this answer beside the invoice it raised.
 *
 * The match, in cents through `invoiceLineItemsTotalCents`: guest and promo
 * lines equal the stay component's live gross, the change-fee line equals the
 * live change-fee components' gross, and the line total equals what is
 * covered. Anything else is a conflict and covers nothing. The Xero tax type
 * (`OUTPUT2`) and the journal's tax codes are separate namespaces: both are
 * frozen, neither is translated, and a difference is never a conflict.
 */

/** The arguments the sender already passes to the line builders, and the booking's posted charge legs. */
export interface PrimaryInvoicePlanInput {
  bookingId: string;
  guests: Parameters<typeof buildInvoiceLineItems>[0];
  checkIn: Date;
  checkOut: Date;
  nights: number;
  hutFeeMapping: ResolvedAccountMapping;
  hutFeeItemCodeMap: HutFeeItemCodeResolver;
  seasonType: string | null;
  promo: {
    aggregateCents: number;
    redemptions: ReadonlyArray<PromoLineRedemption> | null | undefined;
    adjustmentRows: ReadonlyArray<PromoLineAdjustmentRow> | null | undefined;
    firstGuest: Parameters<typeof promoAdjustmentLineItems>[1]["firstGuest"];
  };
  /** `recordedChangeFeeCents(payment)`: the fee line is billed when it is positive. */
  changeFeeCents: number;
  /** The booking's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
}

export interface PrimaryInvoiceCoverage {
  account: "BOOKING_REVENUE" | "FEE_REVENUE";
  chargeIdentity: string;
  coveredCents: number;
  taxCode: string | null;
}

interface PrimaryInvoiceRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type PrimaryInvoicePlan =
  | (PrimaryInvoiceRendering & { outcome: "COVERED"; lines: LineItem[]; coverage: PrimaryInvoiceCoverage[] })
  | (PrimaryInvoiceRendering & { outcome: "CONFLICT"; lines: LineItem[]; reason: MemberMoneyExportConflictReason; problem: string });

/** What a line array hashes to: the same bytes the sync operation stores (`sanitizeForJson`). */
export function primaryInvoicePayloadHash(lines: ReadonlyArray<LineItem>): string {
  return stableDigest(sanitizeForJson(lines));
}

/** Plan the primary invoice the sender builds: the same lines, then their coverage or conflict. */
export function planPrimaryBookingInvoice(input: PrimaryInvoicePlanInput): PrimaryInvoicePlan {
  const lines = buildInvoiceLineItems(
    input.guests,
    input.checkIn,
    input.checkOut,
    input.nights,
    input.hutFeeMapping.code ?? "200",
    input.hutFeeMapping.itemCode,
    input.hutFeeMapping.codeExplicitlyConfigured,
    input.hutFeeItemCodeMap,
    input.seasonType,
  );
  const promoPlan = planPromoAdjustmentLines({
    aggregateCents: input.promo.aggregateCents,
    redemptions: input.promo.redemptions,
    adjustmentRows: input.promo.adjustmentRows,
  });
  lines.push(...promoAdjustmentLineItems(promoPlan, {
    firstGuest: input.promo.firstGuest,
    itemCodeResolver: input.hutFeeItemCodeMap,
    seasonType: input.seasonType,
    hutFeeMapping: input.hutFeeMapping,
  }));
  const stayCents = invoiceLineItemsTotalCents(lines);
  const feeLines = input.changeFeeCents > 0 ? [changeFeeLineItem(input.changeFeeCents, input.hutFeeMapping)] : [];
  lines.push(...feeLines);
  return coverPrimaryInvoiceLines({
    bookingId: input.bookingId,
    lines,
    stayCents,
    feeCents: invoiceLineItemsTotalCents(feeLines),
    postedLegs: input.postedLegs,
    mapping: {
      source: "BUILT",
      hutFee: {
        accountCode: input.hutFeeMapping.code ?? "200",
        itemCode: input.hutFeeMapping.itemCode,
        codeExplicitlyConfigured: input.hutFeeMapping.codeExplicitlyConfigured,
      },
      itemCodeMap: {
        byKey: [...input.hutFeeItemCodeMap.byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        fullTypeId: input.hutFeeItemCodeMap.fullTypeId,
        nonMemberTypeId: input.hutFeeItemCodeMap.nonMemberTypeId,
        legacyItemCode: input.hutFeeItemCodeMap.legacyItemCode,
      },
      seasonType: input.seasonType,
      promoCodes: (input.promo.redemptions ?? []).map((redemption) => ({
        code: redemption.promoCode?.code ?? null,
        xeroItemCode: redemption.promoCode?.xeroItemCode ?? null,
        xeroAccountCode: redemption.promoCode?.xeroAccountCode ?? null,
      })),
    },
  });
}

/**
 * The replay's plan (#4525): an invoice already raised, its lines read back from
 * the sync operation's stored request. Nothing is rebuilt. The change-fee line is
 * the one `changeFeeLineItem` words; the rest is the stay. The mapping frozen is
 * what the stored lines carry, because the settings they were built from are gone.
 */
export function planReplayedPrimaryBookingInvoice(input: {
  bookingId: string;
  storedLines: LineItem[];
  postedLegs: readonly PostedRevenueLeg[];
}): PrimaryInvoicePlan {
  const isFee = (line: LineItem) => line.description === CHANGE_FEE_LINE_DESCRIPTION;
  return coverPrimaryInvoiceLines({
    bookingId: input.bookingId,
    lines: input.storedLines,
    stayCents: invoiceLineItemsTotalCents(input.storedLines.filter((line) => !isFee(line))),
    feeCents: invoiceLineItemsTotalCents(input.storedLines.filter(isFee)),
    postedLegs: input.postedLegs,
    mapping: {
      source: "STORED_REQUEST",
      lineCodes: input.storedLines.map((line) => ({
        accountCode: line.accountCode ?? null,
        itemCode: line.itemCode ?? null,
      })),
    },
  });
}

function coverPrimaryInvoiceLines(input: {
  bookingId: string;
  lines: LineItem[];
  stayCents: number;
  feeCents: number;
  postedLegs: readonly PostedRevenueLeg[];
  mapping: Record<string, unknown>;
}): PrimaryInvoicePlan {
  const { bookingId, lines, stayCents, feeCents, postedLegs } = input;
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (componentTaxCodes: PrimaryInvoiceCoverage[]): PrimaryInvoiceRendering => ({
    legacyKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      ...input.mapping,
      taxType: "OUTPUT2",
      lineAmountTypes: LineAmountTypes.Inclusive,
      componentTaxCodes: componentTaxCodes.map(({ account, chargeIdentity, taxCode }) => ({ account, chargeIdentity, taxCode })),
    },
    lineTotalCents,
  });
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): PrimaryInvoicePlan =>
    ({ outcome: "CONFLICT", lines, reason, problem, ...rendering([]) });

  const stayIdentity = bookingChargeIdentity(bookingId);
  const identities = componentsPostedBy({ lines: postedLegs }).sort((a, b) => {
    const left = componentKey(a.account, a.chargeIdentity);
    const right = componentKey(b.account, b.chargeIdentity);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const components: PrimaryInvoiceCoverage[] = [];
  for (const identity of identities) {
    const account = identity.account as PrimaryInvoiceCoverage["account"];
    const { chargeIdentity } = identity;
    const split = liveComponentSplit(postedLegs, account, chargeIdentity);
    if (!split) continue;
    if ("problem" in split) return conflict("COMPONENT_UNUSABLE", split.problem);
    if (split.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `component ${chargeIdentity} names another booking`);
    components.push({ account, chargeIdentity, coveredCents: split.grossCents, taxCode: split.taxCode });
  }
  const stay = components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity === stayIdentity);
  // A close-out (`refundCloseOutIdentity`) or any other booking-revenue component is never the stay charge.
  const otherStay = components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity !== stayIdentity && c.coveredCents !== 0);
  if (otherStay) return conflict("COMPONENT_UNUSABLE", `booking revenue ${otherStay.chargeIdentity} is not the stay charge`);
  const fees = components.filter((c) => c.account === "FEE_REVENUE");
  const liveFeeCents = fees.reduce((sum, c) => sum + c.coveredCents, 0);
  if (!stay) {
    if (lineTotalCents === 0 && liveFeeCents === 0) return { outcome: "COVERED", lines, coverage: [], ...rendering([]) };
    return conflict("COMPONENT_UNUSABLE", `the journal holds no stay charge ${stayIdentity}`);
  }
  if (stay.coveredCents !== stayCents) {
    return conflict("STAY_CENTS", "the stay lines do not bill the stay charge's live gross");
  }
  if (liveFeeCents !== feeCents) {
    return conflict("FEE_CENTS", "the change-fee line does not bill the fee components' live gross");
  }
  const coverage = [stay, ...fees].filter((c) => c.coveredCents !== 0);
  if (coverage.some((c) => c.coveredCents < 0)) return conflict("COMPONENT_UNUSABLE", "a component carries a negative gross");
  if (coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the components carry");
  }
  return { outcome: "COVERED", lines, coverage, ...rendering(coverage) };
}

/** The primary manifest an update stands on: the one recorded for the same booking's invoice. */
export interface PrimaryManifestForUpdate {
  id: string;
  outcome: "COVERED" | "CONFLICT";
  lineTotalCents: number;
  providerInvoiceId: string;
}

export type PrimaryInvoiceUpdatePlan =
  | (PrimaryInvoiceRendering & { outcome: "COVERED" })
  | (PrimaryInvoiceRendering & { outcome: "CONFLICT"; reason: "PRIMARY_UNMATCHED"; problem: string });

/**
 * THE UPDATE OF AN ISSUED PRIMARY INVOICE (#4525, ALP-436). Pure.
 * `updateXeroBookingInvoiceForBooking` rewrites descriptions and dates and
 * copies every amount from the invoice Xero holds, so an update bills nothing
 * of its own: it covers no component, and it matches when its total is the
 * total of the covered primary manifest for the same invoice. The database
 * holds the same rule (`member_money_require_export_coverage`). Null when no
 * primary manifest was recorded: there is nothing for an update to stand on.
 */
export function planPrimaryInvoiceUpdate(input: {
  legacyKey: string;
  providerInvoiceId: string;
  lines: LineItem[];
  /** What the update sends: the issued invoice's own, so the frozen value is the provider's. */
  lineAmountTypes: LineAmountTypes;
  /** The provider's gross invoice total, including discounts and tax, converted at its boundary. */
  providerTotalCents: number;
  primary: PrimaryManifestForUpdate | null;
}): PrimaryInvoiceUpdatePlan | null {
  const { lines, primary } = input;
  if (!primary) return null;
  const lineTotalCents = input.providerTotalCents;
  const rendering: PrimaryInvoiceRendering = {
    legacyKey: input.legacyKey,
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      source: "UPDATED_FROM_PROVIDER",
      primaryManifestId: primary.id,
      lineCodes: lines.map((line) => ({ accountCode: line.accountCode ?? null, itemCode: line.itemCode ?? null })),
      lineAmountTypes: input.lineAmountTypes,
    },
    lineTotalCents,
  };
  const unmatched = (problem: string): PrimaryInvoiceUpdatePlan =>
    ({ outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED", problem, ...rendering });
  if (primary.providerInvoiceId !== input.providerInvoiceId) return unmatched("the primary manifest names another invoice");
  if (primary.outcome !== "COVERED") return unmatched("the primary manifest records a conflict");
  if (primary.lineTotalCents !== lineTotalCents) return unmatched("the updated lines' total is not the primary invoice's");
  return { outcome: "COVERED", ...rendering };
}
