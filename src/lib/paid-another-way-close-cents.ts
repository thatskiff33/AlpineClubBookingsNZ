import { paidAnotherWayUnpaidCents } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4516 (round-4 review 2, `INV-SSOT`): WHAT ONE "PAID ANOTHER WAY" CLOSE RECORD
 * SAYS OF THE ROW IT CLOSED, for every reader that tells it: paid back - a
 * record with no figure paid back the whole of what the row owed (the close
 * always writes one; a figureless record has no `raisedAmountCents` either, by
 * `ManualRefundTask_raised_amount_requires_amount`) - and left unpaid
 * (`paidAnotherWayUnpaidCents`). Neither is below nothing, and together they
 * are never more than the row owed (`owedCents`).
 */
export function paidAnotherWayCloseCents(
  close: { amountCents: number | null; raisedAmountCents: number | null },
  owedCents: number,
): { paidBackCents: number; unpaidCents: number } {
  const owed = Math.max(0, owedCents);
  const paidBackCents = Math.min(Math.max(0, close.amountCents ?? owed), owed);
  const unpaidCents = paidAnotherWayUnpaidCents({ amountCents: paidBackCents, raisedAmountCents: close.raisedAmountCents });
  return { paidBackCents, unpaidCents: Math.min(unpaidCents, owed - paidBackCents) };
}
