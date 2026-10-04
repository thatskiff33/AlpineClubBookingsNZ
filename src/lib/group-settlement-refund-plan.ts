/**
 * THE GROUP SETTLEMENT'S FROZEN REFUND PLAN, READ (#1236, #3653, #3854).
 *
 * Pure: no database or provider import, so the booking-ledger census reads a
 * plan exactly as the organiser cancel, its recovery replay and the ledger
 * poster do (`INV-SSOT`). Moved here from `organiser-child-refund.ts`, which
 * imports the Prisma client.
 */

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
