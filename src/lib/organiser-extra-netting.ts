/** N1–N4: reserve unpaid waivers before policy refunds, in the money claim. */
import type { Prisma } from "@prisma/client";
import { readOrganiserExtraAdjustmentPayload, XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, type OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";
import { ORGANISER_EXTRA_WAIVED_UNRAISED_CODE, organiserExtraPaidPriceCents, organiserExtraUnpaidCents, readOrganiserExtraState, type OrganiserExtraInvoice, type OrganiserExtraReduction, type OrganiserExtraState } from "@/lib/organiser-extra-state";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

export function planOrganiserExtraNetting(state: OrganiserExtraState, input: { reductionCents: number; refundAmountCents: number; refundBasisCents: number; cancel?: boolean }) {
  let left = input.cancel ? Number.MAX_SAFE_INTEGER : input.reductionCents;
  const waivers = state.invoices.flatMap((invoice) => {
    const amountCents = Math.min(left, organiserExtraUnpaidCents(invoice));
    left -= amountCents;
    return amountCents > 0 ? [{ invoice, amountCents }] : [];
  });
  let refundLeft = input.refundAmountCents;
  let basisLeft = input.refundBasisCents;
  const refunds = state.invoices.flatMap((invoice) => {
    const basisCents = Math.min(basisLeft, organiserExtraPaidPriceCents(invoice));
    basisLeft -= basisCents;
    // The policy (including its fixed fee) has already run ONCE. Distribute its
    // result, never run a policy fee once per invoice. Remainder goes to share.
    const amountCents = input.refundBasisCents > 0 ? Math.min(refundLeft, Math.floor(input.refundAmountCents * basisCents / input.refundBasisCents)) : 0;
    refundLeft -= amountCents;
    return basisCents > 0 ? [{ invoice, amountCents, basisCents }] : [];
  });
  return { waivers, refunds, combinedRefundCents: refundLeft };
}

async function reserveAdjustment(tx: Prisma.TransactionClient, payload: OrganiserExtraAdjustmentPayload, createdByMemberId?: string): Promise<void> {
  const key = `organiser-extra:${payload.bookingId}:${payload.scopeId}:${payload.purpose}:${payload.modificationId ?? payload.invoiceId}`;
  const existing = await tx.xeroSyncOperation.findFirst({ where: { correlationKey: key }, select: { id: true } });
  if (existing) return;
  const { startXeroSyncOperation } = await import("@/lib/xero-sync");
  await startXeroSyncOperation({ direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Booking", localId: payload.bookingId,
    status: payload.purpose === "refund" ? payload.amountCents === 0 ? "SUCCEEDED" : "WAITING_PAYMENT" : "PENDING", correlationKey: key, idempotencyKey: key,
    requestPayload: payload, createdByMemberId, store: tx });
}

/**
 * The queued invoice rows a waiver may still retire: never attempted. Not
 * RUNNING, whose create is under way, and not FAILED, whose invoice may exist
 * in Xero after a timeout, a stale-RUNNING reset or an email throw; those keep
 * the reserved-waiver path, which voids or credits whatever was raised.
 */
const SKIPPABLE_QUEUED_INVOICE_STATUSES = ["PENDING", "WAITING_PAYMENT"];

/**
 * F4: an extra invoice still queued (never raised in Xero) that this waiver
 * covers in full is not raised at all, so the organiser is never emailed for
 * a debt already waived. Its operation is SKIPPED, status-guarded so a create
 * attempted, under way, or one that reached Xero, keeps it; then the waiver is
 * reserved as usual and voids or credits the invoice once it exists. True when
 * no live operation is left, and the waiver needs no document; the state then
 * reads the invoice as waived whole, so its unpaid fee is never kept.
 */
async function skipQueuedInvoiceWaivedInFull(tx: Prisma.TransactionClient, invoice: OrganiserExtraInvoice, amountCents: number): Promise<boolean> {
  if (invoice.invoiceId !== null || invoice.cashCents > 0 || amountCents < invoice.priceCents + invoice.feeCents) return false;
  const queued = { localModel: "BookingModification", localId: invoice.modificationId, queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE };
  await tx.xeroSyncOperation.updateMany({
    where: { ...queued, status: { in: SKIPPABLE_QUEUED_INVOICE_STATUSES }, startedAt: null, xeroObjectId: null },
    data: { status: "SKIPPED", lastErrorCode: ORGANISER_EXTRA_WAIVED_UNRAISED_CODE, lastErrorMessage: "Not raised: a cancellation or reduction waived the whole extra before it reached Xero." },
  });
  return (await tx.xeroSyncOperation.count({ where: { ...queued, status: { notIn: ["SKIPPED", "RESOLVED"] } } })) === 0;
}

/** Whether a netting scope has reserved its invoice debts: the scope's one replay test. */
export async function hasOrganiserExtraReservation(tx: Pick<Prisma.TransactionClient, "xeroSyncOperation">, bookingId: string, scopeId: string): Promise<boolean> {
  const row = await tx.xeroSyncOperation.findFirst({ where: { localId: bookingId, queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, requestPayload: { path: ["scopeId"], equals: scopeId } }, select: { id: true } });
  return row !== null;
}

/** A raced-cash refund row (`organiser-extra-raced-cash.ts`), reserved like any other: under the caller's money claim. */
export async function reserveOrganiserExtraRacedRefund(tx: Prisma.TransactionClient, payload: OrganiserExtraAdjustmentPayload): Promise<void> {
  await reserveAdjustment(tx, payload);
}

export async function reserveOrganiserExtraNetting(tx: Prisma.TransactionClient, input: {
  state: OrganiserExtraState; scopeId: string; reductionCents: number; refundAmountCents: number;
  refundBasisCents: number; refundPercentage: number; cancel?: boolean; createdByMemberId?: string;
  /** N1: the tier's fixed fee (card), frozen with the plan's basis so cash racing its waivers is tiered with the plan. */
  fixedFeeCents?: number;
}): Promise<void> {
  if (input.state.invoices.length === 0) return;
  if (await hasOrganiserExtraReservation(tx, input.state.bookingId, input.scopeId)) return;
  const plan = planOrganiserExtraNetting(input.state, input);
  const base = { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId: input.state.bookingId, scopeId: input.scopeId, refundPercentage: input.refundPercentage,
    planBasisCents: Math.max(0, input.refundBasisCents), fixedFeeCents: input.fixedFeeCents ?? 0, ...(input.cancel ? { planCancels: true } : {}) } as const;
  for (const [purpose, shares] of [["waive", plan.waivers], ["refund", plan.refunds]] as const) {
    for (const share of shares) {
      const { invoice, amountCents } = share;
      if (purpose === "waive" && (await skipQueuedInvoiceWaivedInFull(tx, invoice, amountCents))) continue;
      await reserveAdjustment(tx, { ...base, purpose, ...("basisCents" in share ? { priceBasisCents: share.basisCents } : {}), modificationId: invoice.modificationId, invoiceId: invoice.invoiceId, amountCents, cashAtPlanCents: invoice.cashCents }, input.createdByMemberId);
    }
  }
  if (plan.combinedRefundCents > 0) {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: input.state.bookingId }, include: { payment: true } });
    const { resolveOrganiserBilling } = await import("@/lib/organiser-billing");
    const billing = await resolveOrganiserBilling(tx, booking);
    if (!billing) throw new Error("Organiser refund has no combined invoice");
    await reserveAdjustment(tx, { ...base, purpose: "refund", modificationId: null, invoiceId: billing.combinedInvoiceId, amountCents: plan.combinedRefundCents, cashAtPlanCents: 0 }, input.createdByMemberId);
  }
}

export async function settleOrganiserExtraReduction(tx: Prisma.TransactionClient, input: {
  reduction: OrganiserExtraReduction; refundAmountCents: number; refundBasisCents: number; refundPercentage: number; fixedFeeCents?: number; createdByMemberId?: string;
}): Promise<void> {
  await reserveOrganiserExtraNetting(tx, { ...input, state: input.reduction, scopeId: input.reduction.scopeId, reductionCents: input.reduction.reductionCents });
}

export async function reserveOrganiserExtraCancellation(tx: Prisma.TransactionClient, input: {
  bookingId: string; scopeId: string; refundAmountCents: number; refundBasisCents: number; refundPercentage: number; fixedFeeCents?: number; createdByMemberId?: string;
}): Promise<void> {
  await reserveOrganiserExtraNetting(tx, { ...input, state: await readOrganiserExtraState(tx, input.bookingId), reductionCents: 0, cancel: true });
}

/** Called by the hand-back writer inside the same money claim. */
export async function bindOrganiserExtraRefundToHandBack(tx: Prisma.TransactionClient, input: { bookingId: string; handBackTaskId: string; scopeId?: string }): Promise<boolean> {
  const rows = await tx.xeroSyncOperation.findMany({ where: { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, localId: input.bookingId, status: "WAITING_PAYMENT" }, select: { id: true, requestPayload: true } });
  let bound = false;
  for (const row of rows) {
    const payload = readOrganiserExtraAdjustmentPayload(row.requestPayload);
    if (!payload || payload.purpose !== "refund" || payload.handBackTaskId || (input.scopeId && payload.scopeId !== input.scopeId)) continue;
    await tx.xeroSyncOperation.update({ where: { id: row.id }, data: { requestPayload: { ...payload, handBackTaskId: input.handBackTaskId } } });
    bound = true;
  }
  return bound;
}

export async function releaseOrganiserExtraRefundNotes(tx: Prisma.TransactionClient, taskId: string): Promise<boolean> {
  const rows = await tx.xeroSyncOperation.findMany({ where: { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, status: "WAITING_PAYMENT", requestPayload: { path: ["handBackTaskId"], equals: taskId } }, select: { id: true } });
  if (rows.length === 0) return false;
  await tx.xeroSyncOperation.updateMany({ where: { id: { in: rows.map((row) => row.id) }, status: "WAITING_PAYMENT" }, data: { status: "PENDING" } });
  return true;
}
