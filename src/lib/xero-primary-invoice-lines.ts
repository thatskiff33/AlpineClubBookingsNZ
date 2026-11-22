/**
 * The primary booking invoice's lines, composed in ONE place (#4525 review, `INV-SSOT`).
 *
 * `createXeroInvoiceForBooking` sends these lines and the member-money planner
 * plans the export manifest from them, so the two can never disagree about which
 * lines the invoice carries or in what order: guest lines, then the promo
 * adjustment lines, then the change-fee line when the recorded fee is positive.
 */

import type { LineItem } from "xero-node";
import { buildInvoiceLineItems } from "./xero-booking-invoice-lines";
import type { HutFeeItemCodeResolver, ResolvedAccountMapping } from "./xero-mappings";
import { changeFeeLineItem } from "./xero-modification-line-items";
import {
  planPromoAdjustmentLines,
  promoAdjustmentLineItems,
  type PromoAdjustmentLinePlan,
  type PromoLineAdjustmentRow,
  type PromoLineRedemption,
} from "./xero-promo-adjustment-lines";
import type { XeroTaxRendering } from "./xero-tax-rendering";

/** What the sender reads from the booking and its settings to build the primary invoice. */
export interface PrimaryInvoiceLineInput {
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
  /**
   * The booking's tax treatment (#4632), resolved from its tax anchor
   * (`xero-tax-anchors.ts`) before the lines are built; every line carries it.
   */
  taxRendering: XeroTaxRendering;
}

export interface PrimaryInvoiceLines {
  /** Every line, in the order sent: stay lines first, then the fee line. */
  lines: LineItem[];
  /** The guest and promo lines: what bills the stay charge. */
  stayLines: LineItem[];
  /** The change-fee line, or none. */
  feeLines: LineItem[];
  /** The promo split, for the sender's own operation record. */
  promoLinePlan: PromoAdjustmentLinePlan;
}

/** Build the primary booking invoice's lines. Pure apart from the builders it calls. */
export function buildPrimaryInvoiceLines(input: PrimaryInvoiceLineInput): PrimaryInvoiceLines {
  // Guest lines, with per-guest item codes (#1930, E4). The resolver is always
  // passed: on a legacy-only install it resolves the flat hutFeeItem.
  const stayLines = buildInvoiceLineItems(
    input.guests,
    input.checkIn,
    input.checkOut,
    input.nights,
    input.hutFeeMapping.code ?? "200",
    input.hutFeeMapping.itemCode,
    input.hutFeeMapping.codeExplicitlyConfigured,
    input.hutFeeItemCodeMap,
    input.seasonType,
    input.taxRendering,
  );
  // Signed promo adjustment lines, one per code (#3828, `INV-MONEY-040`).
  const promoLinePlan = planPromoAdjustmentLines({
    aggregateCents: input.promo.aggregateCents,
    redemptions: input.promo.redemptions,
    adjustmentRows: input.promo.adjustmentRows,
  });
  stayLines.push(
    ...promoAdjustmentLineItems(promoLinePlan, {
      firstGuest: input.promo.firstGuest,
      itemCodeResolver: input.hutFeeItemCodeMap,
      seasonType: input.seasonType,
      hutFeeMapping: input.hutFeeMapping,
    }, input.taxRendering),
  );
  // #3750: the recorded change fee is billed here in full, when there is one.
  const feeLines = input.changeFeeCents > 0 ? [changeFeeLineItem(input.changeFeeCents, input.hutFeeMapping, input.taxRendering)] : [];
  return { lines: [...stayLines, ...feeLines], stayLines, feeLines, promoLinePlan };
}
