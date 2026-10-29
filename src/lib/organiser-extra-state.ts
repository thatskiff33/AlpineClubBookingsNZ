/** Organiser bank-transfer extras: durable invoice asks, cash and reservations. */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { asRecord } from "@/lib/xero-json";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { organiserExtraRefundBasisCents, readOrganiserExtraAdjustmentPayload, XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, type OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

export const ORGANISER_SHARE_RECEIPT_REASON = "organiser-combined-invoice-share";
export const ORGANISER_EXTRA_RECEIPT_REASON = "organiser-extra-invoice-cash";
/** F4: the code on a queued extra invoice a waiver retired whole before it was raised. */
export const ORGANISER_EXTRA_WAIVED_UNRAISED_CODE = "ORGANISER_EXTRA_WAIVED_BEFORE_RAISED";
/**
 * S1 (b): whether a waiver retired this change's queued extra invoice whole
 * before it was raised. Asked under the change's supplementary-anchor lock by
 * the enqueue and by the create just before its Xero call, so no later row -
 * an edit's after-commit re-enqueue or an officer's retry - raises it.
 */
export async function organiserExtraWaivedBeforeRaised(db: Pick<Prisma.TransactionClient, "xeroSyncOperation">, bookingModificationId: string): Promise<boolean> {
  const row = await db.xeroSyncOperation.findFirst({
    where: { localModel: "BookingModification", localId: bookingModificationId, queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE, status: "SKIPPED", lastErrorCode: ORGANISER_EXTRA_WAIVED_UNRAISED_CODE },
    select: { id: true },
  });
  return row !== null;
}
/** S1 (c): the one row a change's extra is read from - a linked or authorised row first, then oldest. */
function extraInvoiceRowRank(row: { status: string; xeroObjectId: string | null }): number {
  return row.xeroObjectId !== null || row.status === "SUCCEEDED" || row.status === "PARTIAL" ? 0 : 1;
}
export type OrganiserExtraInvoice = {
  modificationId: string;
  invoiceId: string | null;
  priceCents: number;
  feeCents: number;
  cashCents: number;
  waivedCents: number;
  refundedCents: number;
  releasedPriceCents: number;
};
export type OrganiserExtraState = { bookingId: string; invoices: OrganiserExtraInvoice[] };
export type OrganiserExtraReduction = OrganiserExtraState & { scopeId: string; offsetCents: number; reductionCents: number };
export type OrganiserExtraDb = Pick<Prisma.TransactionClient, "bookingModification" | "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation">;

export function organiserExtraUnpaidCents(invoice: OrganiserExtraInvoice): number {
  return Math.max(0, invoice.priceCents + invoice.feeCents - invoice.cashCents - invoice.waivedCents);
}
/** N4: cash settles the fee first; an uncollected fee cannot reduce paid share refunds. */
export function effectiveOrganiserPaidChangeFeeCents(recordedFeeCents: number, state: OrganiserExtraState): number {
  return Math.max(0, recordedFeeCents - state.invoices.reduce((sum, invoice) => sum + Math.max(0, invoice.feeCents - invoice.cashCents), 0));
}
export function organiserExtraPaidPriceCents(invoice: OrganiserExtraInvoice): number {
  return Math.max(0, Math.min(invoice.priceCents, invoice.cashCents - invoice.feeCents) - invoice.releasedPriceCents);
}
/** The paid price of one change's extra that every plan's refunds - policy or raced cash - have released. */
function organiserExtraReleasedPriceCents(plans: readonly (OrganiserExtraAdjustmentPayload | null)[], modificationId: string): number {
  return plans.reduce((sum, plan) => sum + (plan?.modificationId === modificationId && plan.purpose === "refund" ? organiserExtraRefundBasisCents(plan) : 0), 0);
}

/** All reads are local, after the caller's existing global money lock. */
export async function readOrganiserExtraState(db: OrganiserExtraDb, bookingId: string): Promise<OrganiserExtraState> {
  const modifications = await db.bookingModification.findMany({
    where: { bookingId, OR: [{ priceDiffCents: { gt: 0 } }, { changeFeeCents: { gt: 0 } }] },
    select: { id: true, priceDiffCents: true, changeFeeCents: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (modifications.length === 0) return { bookingId, invoices: [] };
  const ids = modifications.map((m) => m.id);
  const [links, issuedOrQueued, receipts, adjustments] = await Promise.all([
    db.xeroObjectLink.findMany({ where: { localModel: "BookingModification", localId: { in: ids }, role: "SUPPLEMENTARY_INVOICE", active: true }, select: { localId: true, xeroObjectId: true, metadata: true } }),
    db.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: { in: ids }, queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        OR: [{ status: { notIn: ["SKIPPED", "RESOLVED"] } }, { status: "SKIPPED", lastErrorCode: ORGANISER_EXTRA_WAIVED_UNRAISED_CODE }] },
      select: { id: true, localId: true, requestPayload: true, status: true, xeroObjectId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.paymentTransaction.findMany({ where: { payment: { bookingId }, reason: ORGANISER_EXTRA_RECEIPT_REASON, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } }, orderBy: [...LEDGER_ROWS_OLDEST_FIRST], select: { xeroInvoiceId: true, amountCents: true } }),
    db.xeroSyncOperation.findMany({ where: { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, localId: bookingId }, select: { requestPayload: true } }),
  ]);
  const invoices: OrganiserExtraInvoice[] = [];
  for (const modification of modifications) {
    if (modification.priceDiffCents + modification.changeFeeCents <= 0) continue;
    const link = links.find((l) => l.localId === modification.id);
    const queued = issuedOrQueued.filter((op) => op.localId === modification.id).sort((a, b) => extraInvoiceRowRank(a) - extraInvoiceRowRank(b))[0];
    if (!link && !queued) continue;
    const metadata = asRecord(link?.metadata);
    const payload = asRecord(queued?.requestPayload);
    const priceCents = typeof metadata?.priceDiffCents === "number" ? metadata.priceDiffCents : typeof payload?.priceDiffCents === "number" ? payload.priceDiffCents : modification.priceDiffCents;
    const feeCents = typeof metadata?.changeFeeCents === "number" ? metadata.changeFeeCents : typeof payload?.changeFeeCents === "number" ? payload.changeFeeCents : modification.changeFeeCents;
    const plans = adjustments.map((a) => readOrganiserExtraAdjustmentPayload(a.requestPayload)).filter((a) => a?.modificationId === modification.id);
    // F4: never raised because a waiver covered it whole - owed nothing, its fee never paid.
    const waivedUnraisedCents = !link && queued?.status === "SKIPPED" ? priceCents + feeCents : 0;
    invoices.push({ modificationId: modification.id, invoiceId: link?.xeroObjectId ?? null, priceCents, feeCents,
      cashCents: receipts.filter((r) => r.xeroInvoiceId === link?.xeroObjectId).reduce((s, r) => s + r.amountCents, 0),
      waivedCents: waivedUnraisedCents + plans.reduce((s, p) => s + (p?.purpose === "waive" ? p.amountCents : 0), 0),
      releasedPriceCents: organiserExtraReleasedPriceCents(plans, modification.id),
      refundedCents: plans.reduce((s, p) => s + (p?.purpose === "refund" ? p.amountCents : 0), 0),
    });
  }
  return { bookingId, invoices };
}

export async function readOrganiserExtraReduction(db: OrganiserExtraDb, bookingId: string, reductionCents: number): Promise<OrganiserExtraReduction> {
  const state = await readOrganiserExtraState(db, bookingId);
  return { ...state, scopeId: randomUUID(), reductionCents,
    offsetCents: Math.min(reductionCents, state.invoices.reduce((sum, invoice) => sum + organiserExtraUnpaidCents(invoice), 0)),
  };
}
