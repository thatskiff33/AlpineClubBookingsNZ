/**
 * #3642 (`INV-PAY-105`, `INV-SSOT-002`): the combined group invoice's lines,
 * built from exactly the children the settlement committed.
 *
 * The settlement's total is the sum of its CONFIRMED organiser-settled
 * children's worth — final price plus a change fee recorded on the child's
 * payment, billed on the change-fee line (#3750) — (`groupSettlementTotalCents`); PAID children were
 * settled already and are never on it. The invoice is built from the same
 * children and carries each child's promotion adjustment as its own line, the
 * way the per-booking invoice does, because a final price is the stay's total
 * plus that adjustment. The create worker compares both totals with the
 * settlement's before it asks Xero for anything, so an invoice whose total is
 * not the settlement's is never raised.
 *
 * #3828 (`INV-MONEY-040`): a child carrying several promo codes gets one
 * promotion line per code, exactly as a per-booking invoice does, through the
 * same planner; a split that cannot be trusted is that child's single
 * aggregate line, and every several-code child's split is handed back for the
 * operation to record.
 */
import type { LineItem } from "xero-node";
import type { XeroTaxRendering } from "@/lib/xero-tax-rendering";
import { prisma } from "./prisma";
import { committedGroupChildrenWhere } from "./xero-group-settlement-invoice-children";
import { getStayNights } from "./pricing";
import { buildPrimaryInvoiceLines } from "./xero-primary-invoice-lines";
import {
  getHutFeeItemCodeMap,
  getHutFeeSeasonType,
  getResolvedAccountMapping,
  type HutFeeItemCodeResolver,
  type ResolvedAccountMapping,
} from "./xero-mappings";
import {
  promoAdjustmentLineRecord,
  type PromoAdjustmentLineRecord,
} from "@/lib/xero-promo-adjustment-lines";
import { groupSettlementTotalCents } from "@/lib/group-settlement-invoice-binding";
import { invoiceLineItemsTotalCents } from "@/lib/xero-modification-line-items";
import { recordedChangeFeeCents } from "@/lib/booking-payment-state";
import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";


/** One child's share of the combined invoice, in build order (#4525, ALP-437). */
export interface GroupSettlementChildLines {
  bookingId: string;
  lodgeId: string;
  seasonType: string | null;
  /** The child's guest and promo lines: what bills its stay charge. */
  stayLines: LineItem[];
  /** The child's change-fee line, or none. */
  feeLines: LineItem[];
}

export interface GroupSettlementInvoiceLines {
  /** Every child's stay lines then fee lines, child after child: what is sent. */
  lineItems: LineItem[];
  /** The same lines, child by child, for the export manifest's per-child match. */
  byChild: GroupSettlementChildLines[];
  /** The hut-fee mapping and item-code map every child's lines were built with. */
  hutFeeMapping: ResolvedAccountMapping;
  hutFeeItemCodeMap: HutFeeItemCodeResolver;
  childCount: number;
  /** `groupSettlementTotalCents` over the children the lines were built from. */
  childrenCents: number;
  /** What the lines add up to. */
  lineCents: number;
  /**
   * #3828: what the CREATE operation records beside the invoice — how each
   * child carrying several codes was split into promotion lines (or why it fell
   * back to one aggregate line), present only when a child carries more than
   * one code. #4525 (ALP-437): `childBookingIds` names the children billed, in
   * line order, so the export manifest's replay matches the invoice against
   * the children it was raised for, not whoever is committed later. Local
   * only: Xero is sent `invoices` alone.
   */
  operationRecord: {
    childBookingIds: string[];
    promoLines?: Array<{ bookingId: string } & PromoAdjustmentLineRecord>;
  };
}

/** Build the combined invoice's lines from the settlement's committed children. */
export async function buildGroupSettlementInvoiceLines(
  organiserBookingId: string,
  /** The organiser's booking's tax treatment (#4632): one combined document, one anchor. */
  taxRendering: XeroTaxRendering,
): Promise<GroupSettlementInvoiceLines> {
  const children = await prisma.booking.findMany({
    where: committedGroupChildrenWhere(organiserBookingId),
    include: {
      guests: { include: { nights: true } },
      promoRedemptions: { include: { promoCode: true, allocations: true } },
      nightAdjustments: true,
      // #3750: a change fee recorded on a child's payment is part of its worth.
      payment: { select: { changeFeeCents: true } },
    },
  });

  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);

  // Built per child (each child has its own date range and season) through the
  // primary invoice's own composition (`INV-SSOT`): guest lines, its promotion
  // lines (#3828, one per code), then its recorded change fee (#3750, #3955
  // review F3), which is part of its worth. Aggregated into one invoice.
  const byChild: GroupSettlementChildLines[] = [];
  const promoLines: Array<{ bookingId: string } & PromoAdjustmentLineRecord> = [];
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
    const built = buildPrimaryInvoiceLines({
      guests,
      checkIn,
      checkOut,
      nights,
      hutFeeMapping,
      hutFeeItemCodeMap,
      seasonType,
      promo: {
        aggregateCents: child.promoAdjustmentCents ?? 0,
        redemptions: child.promoRedemptions,
        adjustmentRows: child.nightAdjustments,
        firstGuest: guests[0] ?? null,
      },
      changeFeeCents: recordedChangeFeeCents(child.payment),
      taxRendering,
    });
    byChild.push({ bookingId: child.id, lodgeId: child.lodgeId, seasonType, stayLines: built.stayLines, feeLines: built.feeLines });
    const promoLineRecord = promoAdjustmentLineRecord(built.promoLinePlan);
    if (promoLineRecord) promoLines.push({ bookingId: child.id, ...promoLineRecord });
  }
  const lineItems = byChild.flatMap((child) => [...child.stayLines, ...child.feeLines]);

  return {
    lineItems,
    byChild,
    hutFeeMapping,
    hutFeeItemCodeMap,
    childCount: children.length,
    childrenCents: groupSettlementTotalCents(
      children.map((child) => ({ finalPriceCents: child.finalPriceCents ?? 0, payment: child.payment }))
    ),
    lineCents: invoiceLineItemsTotalCents(lineItems),
    operationRecord: { childBookingIds: byChild.map((child) => child.bookingId), ...(promoLines.length > 0 ? { promoLines } : {}) },
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
  detail: { syncOperation?: XeroOperationClaim; childrenCents: number; lineCents: number }
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
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
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
  if (detail.syncOperation) {
    await completeXeroSyncOperation(detail.syncOperation, {
      status: "FAILED",
      responsePayload: {
        invoiceLinesDisagreeWithPrices: true,
        childrenCents: detail.childrenCents,
        lineCents: detail.lineCents,
      },
    });
  }
}
