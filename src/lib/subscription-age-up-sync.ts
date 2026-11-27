/**
 * The membership sync's view of age-up top-up invoices (#5190 PR 3). A top-up
 * is a coverage-less charge, so the per-member sync, which follows a member's
 * coverage to their season invoice, never reads it. The sweep's changed
 * invoices are mapped to their top-up here instead:
 *  - paid, unpaid or overdue: `xeroInvoiceStatus` follows the invoice, which
 *    is what lets an issued, unpaid top-up hold back a member's booking
 *    (`ISSUED_UNPAID_AGE_UP_TOP_UP`) and a paid one release it;
 *  - voided or deleted: the charge and the adjustment are VOIDED, and the
 *    billing run never raises that top-up again (it names it instead).
 * Every write is status-guarded on a PENDING adjustment, so a voided top-up is
 * never revived and a repeat sweep writes nothing.
 */
import { Invoice } from "xero-node";
import type { CalendarDate } from "@/lib/club-time";
import { prisma } from "@/lib/prisma";
import { determineSubscriptionStatus } from "@/lib/xero-subscription-invoice-status";

const LIVE_CHARGE_STATUSES = ["QUEUED", "PROCESSING", "INVOICE_CREATED", "EMAIL_FAILED", "EMAILED", "CONFLICT"] as const;

/** Map each changed invoice that is a top-up's to the adjustment; returns how many moved. */
export async function syncAgeUpTopUpInvoices(
  invoices: readonly Invoice[],
  /** The club's today: the day an unpaid invoice is judged overdue against. */
  today: CalendarDate,
): Promise<number> {
  const byId = new Map(
    invoices.filter((invoice) => invoice.invoiceID).map((invoice) => [invoice.invoiceID!, invoice]),
  );
  if (byId.size === 0) return 0;
  const topUps = await prisma.memberSubscriptionAgeUpAdjustment.findMany({
    where: { kind: "TOP_UP", status: "PENDING", charge: { xeroInvoiceId: { in: [...byId.keys()] } } },
    select: { id: true, chargeId: true, xeroInvoiceStatus: true, charge: { select: { xeroInvoiceId: true } } },
  });
  let moved = 0;
  for (const topUp of topUps) {
    const invoice = topUp.charge?.xeroInvoiceId ? byId.get(topUp.charge.xeroInvoiceId) : undefined;
    if (!invoice || !topUp.chargeId) continue;
    if (invoice.status === Invoice.StatusEnum.VOIDED || invoice.status === Invoice.StatusEnum.DELETED) {
      const chargeId = topUp.chargeId;
      const voided = await prisma.$transaction(async (tx) => {
        const adjustment = await tx.memberSubscriptionAgeUpAdjustment.updateMany({
          where: { id: topUp.id, status: "PENDING" },
          data: { status: "VOIDED" },
        });
        if (adjustment.count === 0) return 0;
        await tx.membershipSubscriptionCharge.updateMany({
          where: { id: chargeId, status: { in: [...LIVE_CHARGE_STATUSES] } },
          data: { status: "VOIDED" },
        });
        return 1;
      });
      moved += voided;
      continue;
    }
    const { status } = determineSubscriptionStatus(invoice, today);
    if (status === topUp.xeroInvoiceStatus) continue;
    const updated = await prisma.memberSubscriptionAgeUpAdjustment.updateMany({
      where: { id: topUp.id, status: "PENDING", xeroInvoiceStatus: topUp.xeroInvoiceStatus },
      data: { xeroInvoiceStatus: status },
    });
    moved += updated.count;
  }
  return moved;
}

/**
 * The invoices left once top-ups are taken out, for the per-member sync's
 * contact-scoped discovery: a top-up is never a member's season invoice.
 */
export async function withoutAgeUpTopUpInvoices(invoices: Invoice[]): Promise<Invoice[]> {
  const ids = invoices.map((invoice) => invoice.invoiceID).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return invoices;
  const topUps = await prisma.membershipSubscriptionCharge.findMany({
    where: { xeroInvoiceId: { in: ids }, ageUpAdjustment: { isNot: null } },
    select: { xeroInvoiceId: true },
  });
  if (topUps.length === 0) return invoices;
  const excluded = new Set(topUps.map((charge) => charge.xeroInvoiceId));
  return invoices.filter((invoice) => !excluded.has(invoice.invoiceID ?? null));
}
