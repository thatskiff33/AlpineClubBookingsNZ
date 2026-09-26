/**
 * #3642 (`INV-PAY-105`, `INV-SSOT-002`): the combined group invoice's lines,
 * built from exactly the children the settlement committed.
 *
 * The settlement's total is the sum of its CONFIRMED organiser-settled
 * children's final prices (`groupSettlementTotalCents`) — PAID children were
 * settled already and are never on it. The invoice is built from the same
 * children and carries each child's promotion adjustment as its own line, the
 * way the per-booking invoice does, because a final price is the stay's total
 * plus that adjustment. The create worker compares both totals with the
 * settlement's before it asks Xero for anything, so an invoice whose total is
 * not the settlement's is never raised.
 */
import type { LineItem } from "xero-node";
import { BookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { getStayNights } from "./pricing";
import { buildInvoiceLineItems } from "./xero-booking-invoices";
import {
  getHutFeeItemCodeMap,
  getHutFeeSeasonType,
  getResolvedAccountMapping,
} from "./xero-mappings";
import { applyHutFeeLineCodes, resolvePromoLineCodes } from "./xero-hut-fee-line-codes";
import { groupSettlementTotalCents } from "@/lib/group-settlement-invoice-binding";
import { providerAmountToCents } from "@/lib/money-provider-amount";

/** A built invoice's total in cents, line by line as Xero will add it. */
export function invoiceLineItemsTotalCents(lineItems: ReadonlyArray<LineItem>): number {
  return lineItems.reduce(
    (sum, line) =>
      sum + (providerAmountToCents(line.unitAmount) ?? 0) * (line.quantity ?? 1),
    0
  );
}

export interface GroupSettlementInvoiceLines {
  lineItems: LineItem[];
  childCount: number;
  /** `groupSettlementTotalCents` over the children the lines were built from. */
  childrenCents: number;
  /** What the lines add up to. */
  lineCents: number;
}

/** Build the combined invoice's lines from the settlement's committed children. */
export async function buildGroupSettlementInvoiceLines(
  organiserBookingId: string
): Promise<GroupSettlementInvoiceLines> {
  const children = await prisma.booking.findMany({
    where: {
      parentBookingId: organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: BookingStatus.CONFIRMED,
    },
    include: {
      guests: { include: { nights: true } },
      promoRedemption: { include: { promoCode: true } },
    },
  });

  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";

  // Built per child (each child has its own date range and season), then
  // aggregated across the whole group into one invoice.
  const lineItems: LineItem[] = [];
  for (const child of children) {
    const checkIn = new Date(child.checkIn);
    const checkOut = new Date(child.checkOut);
    const nights = getStayNights(checkIn, checkOut).length;
    // Scoped to the CHILD booking's own lodge: lodges may run different season
    // windows, so an unscoped read can take another lodge's item code.
    const seasonType = await getHutFeeSeasonType(checkIn, child.lodgeId);
    const guests = (child.guests ?? []).map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      rateMembershipTypeId: g.rateMembershipTypeId,
      priceCents: g.priceCents,
      nights: (g.nights ?? []).map((n) => ({
        stayDate: n.stayDate,
        priceCents: n.priceCents,
      })),
    }));
    lineItems.push(
      ...buildInvoiceLineItems(
        guests,
        checkIn,
        checkOut,
        nights,
        incomeCode,
        hutFeeMapping.itemCode,
        hutFeeMapping.codeExplicitlyConfigured,
        hutFeeItemCodeMap,
        seasonType
      )
    );
    const promoAdjustmentCents = child.promoAdjustmentCents ?? 0;
    if (promoAdjustmentCents !== 0) {
      const promo = child.promoRedemption?.promoCode ?? null;
      lineItems.push(
        applyHutFeeLineCodes(
          {
            description: promo ? `Promo adjustment - ${promo.code}` : "Promo adjustment",
            quantity: 1,
            unitAmount: promoAdjustmentCents / 100,
            taxType: "OUTPUT2",
          },
          resolvePromoLineCodes({
            promo,
            firstGuest: guests[0] ?? null,
            itemCodeResolver: hutFeeItemCodeMap,
            seasonType,
            hutFeeMapping,
          })
        )
      );
    }
  }

  return {
    lineItems,
    childCount: children.length,
    childrenCents: groupSettlementTotalCents(
      children.map((child) => ({ finalPriceCents: child.finalPriceCents ?? 0 }))
    ),
    lineCents: invoiceLineItemsTotalCents(lineItems),
  };
}
