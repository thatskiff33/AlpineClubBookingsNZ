/**
 * THE GROUP SETTLEMENT'S FROZEN REFUND PLAN, READ (#1236, #3653, #3854).
 *
 * Pure: no database or provider import, so the booking-ledger census reads a
 * plan exactly as the organiser cancel, its recovery replay and the ledger
 * poster do (`INV-SSOT`). Moved here from `organiser-child-refund.ts`, which
 * imports the Prisma client.
 */

import type { BookingCancelledRefundMethod } from "@/lib/booking-modified-email-copy";

/**
 * The settlement's frozen plan, in the shape #3653 writes:
 * `{ perChildRefunds: { childId: cents } }`. The children sit one level down
 * ON PURPOSE: the pre-#3653 reader takes every top-level integer as a child's
 * share of ONE combined refund, so it reads this shape as an empty plan and
 * moves no money, rather than misreading it.
 */
export function readPerChildRefundPlan(value: unknown): Map<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const children = (value as Record<string, unknown>).perChildRefunds;
  if (!children || typeof children !== "object" || Array.isArray(children)) return null;
  const plan = new Map<string, number>();
  for (const [childId, cents] of Object.entries(children as Record<string, unknown>)) {
    if (typeof cents === "number" && Number.isInteger(cents) && cents > 0) plan.set(childId, cents);
  }
  return plan;
}

/**
 * The settlement's frozen plan in the shape a group cancel wrote BEFORE #3653:
 * `{childId: cents}`, each child's share of ONE combined Stripe refund. The one
 * reader of that shape (`INV-SSOT`), for the group cancel that finishes such a
 * plan and the audit that explains the mirrors it wrote. Defensive: only
 * non-negative integer cents survive, and a non-object (or a #3653 per-child
 * plan, whose one key holds an object) reads as empty - the plan is applied
 * verbatim on a re-drive, so a corrupt entry degrades to "no refund for that
 * child" rather than crashing the cleanup.
 */
export function deserializeRefundPlan(value: unknown): Map<string, number> {
  const plan = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return plan;
  }
  for (const [childId, cents] of Object.entries(value as Record<string, unknown>)) {
    if (typeof cents === "number" && Number.isInteger(cents) && cents >= 0) {
      plan.set(childId, cents);
    }
  }
  return plan;
}

/**
 * A child's refunded total once a `{childId: cents}` mirror plan's share is
 * counted, capped at what it paid (#3854, `INV-SSOT`): the one spelling the
 * organiser cancel's mirror, its recovery replay and the ledger's kept figure
 * share, so the three cannot disagree on what the plan handed back.
 */
export function mirrorPlanRefundedCents(
  payment: { amountCents: number; refundedAmountCents: number },
  plannedRefundCents: number,
): number {
  return Math.min(payment.amountCents, payment.refundedAmountCents + plannedRefundCents);
}

/**
 * Is the settlement's refund the `{childId: cents}` mirror plan (#1236) rather
 * than #3653's per-child card refunds? A plan already frozen in the mirror
 * shape, or any Internet Banking settlement (no card intent to refund per
 * child). The one test the organiser cancel decides by and the back-post
 * (#3854) re-reads history by (`INV-SSOT`).
 */
export function isMirrorRefundPlan(settlement: { refundPlan: unknown; stripePaymentIntentId: string | null }): boolean {
  return readPerChildRefundPlan(settlement.refundPlan) === null && (settlement.refundPlan != null || !settlement.stripePaymentIntentId);
}

/**
 * What a pre-#3653 group cancel's ONE combined Stripe refund still has to send,
 * in cents - the replay's own rule (`executeGroupSettlementRefundPlan`) and THE
 * ONE spelling of it (`INV-SSOT`; #3956 round 3): while the settlement is still
 * `SUCCEEDED` on a Stripe intent, the whole `{childId: cents}` plan is still to
 * send; once it reads REFUNDED or PARTIALLY_REFUNDED the refund went, and a
 * FAILED or PENDING settlement, one with no card intent, or an empty plan (a
 * #3653 per-child plan reads empty) sends nothing. The club-wide "Refunds owed"
 * line sums it (`legacyGroupSettlementRefundOwedCents`); the refund appeal
 * waits on it (`mirrorPlanRefundUnmade`).
 */
export function legacyGroupSettlementRefundUnsentCents(settlement: {
  status: string;
  stripePaymentIntentId: string | null;
  refundPlan: unknown;
}): number {
  if (settlement.status !== "SUCCEEDED" || !settlement.stripePaymentIntentId) return 0;
  let unsentCents = 0;
  for (const cents of deserializeRefundPlan(settlement.refundPlan).values()) unsentCents += cents;
  return unsentCents;
}

/**
 * #4851 (`INV-PAY-153`): the note a Stuck States bank close leaves in
 * `lastError` on a pre-#3653 group's ONE refund row
 * (`group_settlement_refund_recovery_*`) when the plan went back by bank
 * transfer, not to the card. Unlike the charge-backed `PAID_ANOTHER_WAY_MARKER`
 * it is read: it is the only record that the plan's refund lines are bank
 * refunds, so the ledger poster, its census and its back-post agree
 * (`legacyGroupRefundPaidByBank`).
 */
export const LEGACY_GROUP_REFUND_PAID_BY_BANK_NOTE =
  "Closed by the treasurer: the old whole-group card refund was paid by bank transfer (#4851)";

/** Did a Stuck States bank close settle this pre-#3653 group refund row? The one reader of the note. */
export function legacyGroupRefundPaidByBank(operation: { status: string; lastError: string | null }): boolean {
  return operation.status === "SUCCEEDED" && operation.lastError === LEGACY_GROUP_REFUND_PAID_BY_BANK_NOTE;
}

/**
 * #3956 review F1: is a pre-#3653 plan's ONE combined refund still to be made?
 * It is when it has anything left to send (`legacyGroupSettlementRefundUnsentCents`).
 */
export function mirrorPlanRefundUnmade(settlement: { status: string; refundPlan: unknown; stripePaymentIntentId: string | null }): boolean {
  return legacyGroupSettlementRefundUnsentCents(settlement) > 0;
}

/**
 * What a card organiser's settlement since #3653 has already handed back, or
 * still owes, on one child — the figure a cancellation of the child tiers from.
 * The ONE formula (`INV-SSOT`; #3854 F1): the larger of the child's stored
 * mirror and the refund rows recorded against its payment (the mirror alone can
 * be zeroed by a reconcile; the rows survive), plus every child-refund debt
 * not yet closed. `organiserChildCommittedRefundCents` reads the evidence from
 * the database; the booking-ledger census and back-post read it from the rows
 * they already hold.
 */
export type OrganiserChildRefundEvidence = {
  /** Σ the child payment's `PaymentRefund` rows that count (`isRecordedRefundStatus`). */
  recordedRefundCents: number;
  /** Σ the child's `organiser_child_refund_` debts on the settlement's intent not yet SUCCEEDED. */
  childOwedCents: number;
};

export function organiserChildCommittedRefundFrom(refundedAmountCents: number, evidence: OrganiserChildRefundEvidence): number {
  return Math.max(refundedAmountCents, evidence.recordedRefundCents) + evidence.childOwedCents;
}

/**
 * #3973: what a joiner's "Booking Cancelled" email says about the refund when
 * the organiser cancels the group. The joiner paid nothing, so no sentence may
 * name "your original payment method". Reads the organiser cancel's own
 * answers and never re-derives money: `refundForChild` is a refund made (a card
 * settlement's Stripe refund, or an Internet Banking plan the club repays by
 * hand); `owedForChild` a #3653 per-child refund Stripe has not made yet; and a
 * card plan frozen before #3653 whose combined refund failed this run leaves
 * the child's planned share owed (`refundForChild` cleared, the plan kept).
 * With none of these the policy refunded nothing, or nothing was paid.
 * `refundCents` is `{{refundAmount}}`, what it was before #3973 (the refund
 * made); `sentenceCents` the amount the refund line names.
 */
export function organiserCancelJoinerEmailRefund(input: {
  refundForChild: number;
  owedForChild: number;
  plannedRefundCents: number;
  cardSettlement: boolean;
}): { refundCents: number; sentenceCents: number; refundMethod: BookingCancelledRefundMethod } {
  const made = input.refundForChild;
  if (made > 0) return { refundCents: made, sentenceCents: made, refundMethod: input.cardSettlement ? "organiser_card" : "organiser_by_hand" };
  const owed = input.owedForChild > 0 ? input.owedForChild : input.cardSettlement ? input.plannedRefundCents : 0;
  return { refundCents: 0, sentenceCents: owed, refundMethod: owed > 0 ? "organiser_card_pending" : "card" };
}
