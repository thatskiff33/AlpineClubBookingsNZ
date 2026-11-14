/**
 * #4851: what a read of the organiser's PaymentIntent means for one dead group
 * refund. Pure. The bank close and Try the card again both decide from this,
 * and the executor's own lookup stays the send path (`INV-PAY-114`).
 */
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { reopenedRetryAt } from "@/lib/organiser-child-refund-executor";

export interface GroupIntentRefund {
  amount: number;
  status?: string | null;
  created: number;
  metadata?: { organiserChildRefundKey?: string | null } | null;
}

function childKey(refund: GroupIntentRefund): string | null {
  const key = refund.metadata?.organiserChildRefundKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function live(refunds: readonly GroupIntentRefund[]): GroupIntentRefund[] {
  return refunds.filter((refund) => !isRefusedRefundStatus(refund.status));
}

/**
 * A per-joiner row. `keyed` is a live refund carrying this row's key: record
 * it, pay nobody again. `unkeyed-same-amount` is a live refund of this row's
 * amount with no joiner key: it cannot be told apart from this refund.
 * Another joiner's key is ignored. Anything else is the bank payment.
 */
export function classifyOrganiserChildIntentRefunds(
  refunds: readonly GroupIntentRefund[],
  key: string,
  amountCents: number,
): "keyed" | "unkeyed-same-amount" | "none" {
  const rows = live(refunds);
  if (rows.some((refund) => childKey(refund) === key)) return "keyed";
  if (rows.some((refund) => childKey(refund) === null && refund.amount === amountCents)) return "unkeyed-same-amount";
  return "none";
}

/**
 * A pre-#3653 whole-group row. `match` is the one live refund of the frozen
 * plan's total carrying no joiner key. Any other live refund is `other`.
 */
export function classifyLegacyGroupIntentRefunds(
  refunds: readonly GroupIntentRefund[],
  planTotalCents: number,
): "match" | "other" | "none" {
  const rows = live(refunds);
  if (rows.length === 0) return "none";
  const match = rows.filter((refund) => childKey(refund) === null && refund.amount === planTotalCents);
  return match.length === 1 && rows.length === 1 ? "match" : "other";
}

/**
 * When a re-arm of a per-joiner row may next be tried. A refused refund of
 * this key still inside Stripe's replay window waits until `reopenedRetryAt`;
 * otherwise the row is due now. A live refund is not this function's answer.
 */
export function organiserChildRearmAt(refunds: readonly GroupIntentRefund[], key: string, now: Date): Date {
  let latest = now;
  for (const refund of refunds) {
    if (childKey(refund) !== key || !isRefusedRefundStatus(refund.status)) continue;
    const at = reopenedRetryAt({ created: refund.created }, now);
    if (at.getTime() > latest.getTime()) latest = at;
  }
  return latest;
}
