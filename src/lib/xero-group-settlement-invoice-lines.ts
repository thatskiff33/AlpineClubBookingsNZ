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
import { soleBookingPromoRedemption } from "@/lib/booking-promo-redemptions";
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
import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";

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
      promoRedemptions: { include: { promoCode: true } },
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
      // #3826: one promo line per code is epic #3813 C3; until then a child
      // carrying several codes is refused rather than invoiced under the first.
      const promo = soleBookingPromoRedemption(child)?.promoCode ?? null;
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

/**
 * #3642: a bound settlement whose joiners' stored prices cannot be turned into
 * an invoice at its total. Under `lock(1)` the settlement FAILS (only while it
 * is still bound, with no invoice, at the same total), releasing the binding so
 * the organiser can pay by card; the operators are alerted once; the CREATE row
 * FAILS with a flag the organiser's page reads.
 */
export async function releaseUninvoiceableGroupSettlement(
  settlementId: string,
  amountCents: number,
  detail: { syncOperationId?: string; childrenCents: number; lineCents: number }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.groupBookingSettlement.updateMany({
      where: {
        id: settlementId,
        source: "INTERNET_BANKING",
        status: "PENDING",
        xeroInvoiceId: null,
        amountCents,
      },
      data: { status: "FAILED" },
    });
  });
  const format = await clubFormatValues();
  await alertGroupSettlementInvoice(
    {
      kind: "lines_disagree_with_prices",
      settlementId,
      invoiceId: null,
      errorMessage: `The group's combined invoice could not be raised: its joiners' bookings total ${formatCents(detail.childrenCents, format)}, but their stored night prices add up to ${formatCents(detail.lineCents, format)}. No invoice was sent and the settlement was released so the organiser can pay by card. Correct the booking prices, then the organiser can settle again.`,
    },
    format
  );
  if (detail.syncOperationId) {
    await completeXeroSyncOperation(detail.syncOperationId, {
      status: "FAILED",
      responsePayload: {
        invoiceLinesDisagreeWithPrices: true,
        childrenCents: detail.childrenCents,
        lineCents: detail.lineCents,
      },
    });
  }
}
