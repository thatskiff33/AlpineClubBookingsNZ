/**
 * #3502: THE CHANGE FEE A PRIMARY BOOKING INVOICE MUST BILL.
 *
 * A primary invoice is built from the booking's guest and promotion lines,
 * which sum to `finalPriceCents`. A change fee never joins that price
 * (`INV-PAY-047`: it is its own term, `Payment.changeFeeCents`), and on an
 * ordinary booking it is billed on the edit's supplementary invoice instead.
 *
 * A supplementary invoice needs a primary one to supplement, so an edit made
 * BEFORE the primary invoice was raised bills its fee nowhere in Xero, while
 * the card ask that collected it has already been captured. The primary
 * invoice raised later then records more Stripe cash than its lines total, and
 * a card booking's applied-credit allocation (`settleCardAppliedCreditAllocation`)
 * is refused for exceeding what is due - which fails every replay. #3502 made
 * that reachable for a credit-paid ($0) booking; a card-plus-credit booking
 * edited before its invoice was raised is the same class.
 *
 * So the primary invoice bills the fee the payment carries LESS any fee a
 * supplementary invoice already bills or is queued to bill, so a fee is never
 * billed twice. Today no supplementary invoice can exist without a primary
 * (it skips when there is none), so that subtraction is a guard against a
 * future writer rather than a figure expected to be non-zero.
 */
import type { LineItem } from "xero-node";
import { prisma } from "@/lib/prisma";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES } from "@/lib/xero-supplementary-invoice-statuses";
import { changeFeeLineItem } from "@/lib/xero-modification-line-items";
import type { ResolvedAccountMapping } from "@/lib/xero-mappings";

/** The fee left for the primary invoice, in integer cents; never negative. */
export function primaryInvoiceChangeFeeCents(params: {
  paymentChangeFeeCents: number;
  supplementaryInvoicedFeeCents: number;
}): number {
  return Math.max(0, params.paymentChangeFeeCents - params.supplementaryInvoicedFeeCents);
}

/**
 * Reads the booking's fee-bearing modifications and which of them a
 * supplementary invoice bills (an active link) or will bill (an outstanding
 * operation), then answers `primaryInvoiceChangeFeeCents`. No read at all when
 * the payment carries no fee, which is every booking edited after its invoice.
 */
export async function loadPrimaryInvoiceChangeFeeCents(
  bookingId: string,
  paymentChangeFeeCents: number,
): Promise<number> {
  if (paymentChangeFeeCents <= 0) return 0;
  const modifications = await prisma.bookingModification.findMany({
    where: { bookingId, changeFeeCents: { gt: 0 } },
    select: { id: true, changeFeeCents: true },
  });
  if (modifications.length === 0) return paymentChangeFeeCents;
  const ids = modifications.map((modification) => modification.id);
  const [links, operations] = await Promise.all([
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "BookingModification",
        localId: { in: ids },
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        active: true,
      },
      select: { localId: true },
    }),
    prisma.xeroSyncOperation.findMany({
      where: {
        localModel: "BookingModification",
        localId: { in: ids },
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        status: { in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES] },
      },
      select: { localId: true },
    }),
  ]);
  const supplementary = new Set([...links, ...operations].map((row) => row.localId));
  return primaryInvoiceChangeFeeCents({
    paymentChangeFeeCents,
    supplementaryInvoicedFeeCents: modifications
      .filter((modification) => supplementary.has(modification.id))
      .reduce((sum, modification) => sum + modification.changeFeeCents, 0),
  });
}

/**
 * The primary invoice's change-fee line: none, or the one shared fee line for
 * `loadPrimaryInvoiceChangeFeeCents`, coded to the hut-fee income mapping.
 */
export async function primaryInvoiceChangeFeeLines(
  bookingId: string,
  paymentChangeFeeCents: number,
  incomeMapping: ResolvedAccountMapping,
): Promise<LineItem[]> {
  const feeCents = await loadPrimaryInvoiceChangeFeeCents(bookingId, paymentChangeFeeCents);
  return feeCents > 0 ? [changeFeeLineItem(feeCents, 1, incomeMapping)] : [];
}
