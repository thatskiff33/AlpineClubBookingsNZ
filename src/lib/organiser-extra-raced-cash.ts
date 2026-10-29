/**
 * #4299 (`INV-PAY-148`): cash the organiser paid on an extra invoice while a
 * cancellation's or reduction's waiver of it was queued. It is refunded as if
 * it had arrived before the oldest plan, whatever order the waivers run in and
 * whenever the cash is imported.
 */
import { prisma } from "@/lib/prisma";
import { calculateRefundAmount } from "@/lib/policies/cancellation";
import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { bindOrganiserExtraRefundToHandBack, hasOrganiserExtraReservation, reserveOrganiserExtraRacedRefund } from "@/lib/organiser-extra-netting";
import {
  organiserExtraRefundBasisCents, readOrganiserExtraAdjustmentPayload,
  XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, type OrganiserExtraAdjustmentPayload,
} from "@/lib/organiser-extra-adjustment-payload";

/** One extra invoice's figures: its change's price and fee, and the cash Xero shows paid on it. */
type OrganiserExtraRacedInvoice = { modificationId: string; invoiceId: string; priceCents: number; feeCents: number; cashCents: number };
/** What one plan is owed for cash that raced its waiver of this invoice. */
type OrganiserExtraRacedReservation = {
  planScopeId: string;
  /** Idempotency: the plan, the change and the plan's whole raced price on it, so a replay finds its row. */
  scopeId: string;
  basisCents: number;
  refundCents: number;
  refundPercentage: number;
};

/**
 * The oldest plan's waiver is set against what would still be unpaid had the
 * cash arrived first; whatever the cash covered beyond that is the plan's
 * raced price. A reduction's raced price is all its covered waiver: with the
 * cash first, that much more of the reduction is refunded. A cancellation's
 * is capped at the paid price the older waivers left: the cancel refunds the
 * paid price, never the fee the cash paid first. (A plan's own policy refund
 * never meets a later cancel's waiver: a cancel waives only what is unpaid,
 * and a reduction refunds from the extra only once nothing is.)
 */
function organiserExtraRacedPriceByPlan(invoice: OrganiserExtraRacedInvoice, rows: readonly OrganiserExtraAdjustmentPayload[]): Map<string, number> {
  let unpaidCents = Math.max(0, invoice.priceCents + invoice.feeCents - invoice.cashCents);
  let paidPriceLeftCents = Math.max(0, Math.min(invoice.priceCents, invoice.cashCents - invoice.feeCents));
  const racedByPlan = new Map<string, number>();
  for (const waiver of rows.filter((row) => row.purpose === "waive" && row.modificationId === invoice.modificationId)) {
    const offsetCents = Math.min(waiver.amountCents, unpaidCents);
    unpaidCents -= offsetCents;
    const coveredCents = waiver.amountCents - offsetCents;
    const racedCents = waiver.planCancels ? Math.min(coveredCents, paidPriceLeftCents) : coveredCents;
    paidPriceLeftCents = Math.max(0, paidPriceLeftCents - racedCents);
    racedByPlan.set(waiver.scopeId, (racedByPlan.get(waiver.scopeId) ?? 0) + racedCents);
  }
  return racedByPlan;
}

/** The plan's own tier over a basis: the cancel's computation and rounding, its fixed fee charged once. */
function planRefundCents(plan: Pick<OrganiserExtraAdjustmentPayload, "refundPercentage" | "fixedFeeCents">, basisCents: number): number {
  const { refundPercentage } = plan;
  const tier = { daysBeforeStay: 0, refundPercentage, creditRefundPercentage: refundPercentage, fixedFeeCents: plan.fixedFeeCents ?? 0, creditFixedFeeCents: 0 };
  return calculateRefundAmount(basisCents, 0, [tier], "card").refundAmountCents;
}

/**
 * The raced-cash refunds still to reserve, oldest plan first. `rows` is every
 * adjustment row of the booking, oldest first. A plan's refund is its tier over
 * its own basis plus ALL its raced price, on every invoice, less its own refund
 * and what is already reserved - so its fixed fee is charged once. A plan is
 * reserved by whichever of the invoice's waivers runs, so none is lost when the
 * plan's own waiver found nothing due.
 */
function planOrganiserExtraRacedCash(invoice: OrganiserExtraRacedInvoice, rows: readonly OrganiserExtraAdjustmentPayload[]): OrganiserExtraRacedReservation[] {
  const reservations: OrganiserExtraRacedReservation[] = [];
  for (const [planScopeId, racedCents] of organiserExtraRacedPriceByPlan(invoice, rows)) {
    const raced = rows.filter((row) => row.purpose === "refund" && row.racedPlanScopeId === planScopeId);
    const recordedHereCents = raced.filter((row) => row.modificationId === invoice.modificationId).reduce((sum, row) => sum + organiserExtraRefundBasisCents(row), 0);
    if (racedCents <= recordedHereCents) continue;
    const plan = rows.find((row) => row.purpose === "waive" && row.scopeId === planScopeId)!;
    const planRacedCents = raced.reduce((sum, row) => sum + organiserExtraRefundBasisCents(row), 0) + racedCents - recordedHereCents;
    const planBasisCents = plan.planBasisCents ?? 0;
    const refundCents = Math.max(0, planRefundCents(plan, planBasisCents + planRacedCents) - planRefundCents(plan, planBasisCents) - raced.reduce((sum, row) => sum + row.amountCents, 0));
    reservations.push({ planScopeId, scopeId: `racing-cash:${planScopeId}:${invoice.modificationId}:${racedCents}`, basisCents: racedCents - recordedHereCents, refundCents, refundPercentage: plan.refundPercentage });
  }
  return reservations;
}

/**
 * Reserve, under the global money lock, every plan's refund for cash that
 * raced its waiver of this invoice. Each is recorded even when it refunds
 * nothing yet (a 0 row), so the plan's next raced cash counts its price.
 */
export async function reserveOrganiserExtraRacedCash(bookingId: string, invoice: Omit<OrganiserExtraRacedInvoice, "priceCents" | "feeCents">): Promise<void> {
  const modification = await prisma.bookingModification.findUniqueOrThrow({ where: { id: invoice.modificationId }, select: { priceDiffCents: true, changeFeeCents: true } });
  const figures = { ...invoice, priceCents: modification.priceDiffCents, feeCents: modification.changeFeeCents };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const rows = (await tx.xeroSyncOperation.findMany({
      where: { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, localId: bookingId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { requestPayload: true },
    })).map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)).filter((row): row is OrganiserExtraAdjustmentPayload => row !== null);
    for (const reservation of planOrganiserExtraRacedCash(figures, rows)) {
      if (await hasOrganiserExtraReservation(tx, bookingId, reservation.scopeId)) continue;
      const refund: OrganiserExtraAdjustmentPayload = {
        queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId, scopeId: reservation.scopeId, racedPlanScopeId: reservation.planScopeId,
        modificationId: invoice.modificationId, invoiceId: invoice.invoiceId, purpose: "refund", amountCents: reservation.refundCents,
        priceBasisCents: reservation.basisCents, cashAtPlanCents: invoice.cashCents, refundPercentage: reservation.refundPercentage,
      };
      if (reservation.refundCents <= 0) {
        // Nothing to hand back yet: record the price, so the plan's next raced cash counts it.
        await reserveOrganiserExtraRacedRefund(tx, refund);
        continue;
      }
      const occurrenceKey = editRefundHandBackOccurrenceKey(`organiser-extra-${reservation.scopeId}`);
      if (await tx.manualRefundTask.findUnique({ where: { occurrenceKey }, select: { id: true } })) continue;
      const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId }, select: { id: true } });
      const task = await tx.manualRefundTask.create({
        data: {
          bookingId, paymentId: payment.id, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey,
          amountCents: reservation.refundCents, raisedAmountCents: reservation.refundCents,
          reason: "Refund the group organiser by bank transfer: the organiser paid an extra invoice while its cancellation or reduction was being processed, and that payment is refunded at the cancellation policy's percentage.",
        },
        select: { id: true },
      });
      await reserveOrganiserExtraRacedRefund(tx, refund);
      await bindOrganiserExtraRefundToHandBack(tx, { bookingId, handBackTaskId: task.id, scopeId: reservation.scopeId });
    }
  });
}
