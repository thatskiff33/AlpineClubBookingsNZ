/**
 * A fee recorded for a booking that has no payment row yet, and the history
 * marker an ordinary edit used to write when it added a late-notice fee to
 * the amount owed.
 *
 * `recordFeeOnNewPayment` is the finished-stay correction's writer (#3750).
 * A stay that never reached its pay step has no row, and the retention is
 * recorded on one carrying only the fee until the pay step fills the rest.
 * An ordinary edit of a booking that has not been paid records no late-notice
 * fee (owner decision, 10 Nov 2026) and does not open a row.
 *
 * `CHANGE_FEE_ADDED_TO_AMOUNT_OWED_PATH` and
 * `changeFeeAddedToAmountOwedHistory` remain for rows already written under
 * #4661. A new ordinary edit passes 0, so it writes no marker. Paying a
 * booking that already has the marker still posts that `CHANGE_FEE` line
 * (`loadFeesAddedToAmountOwed`).
 */
import type { PrismaTransactionClient } from "@/lib/db-transaction";

/**
 * Records a fee owed by a booking that has no payment row yet, on a new row
 * carrying only the fee until its pay step fills in the rest (#3750). An
 * upsert, so a row a pay step opened without the edit's locks takes the fee
 * rather than failing the edit.
 */
export async function recordFeeOnNewPayment(
  tx: PrismaTransactionClient,
  input: { bookingId: string; changeFeeCents: number },
): Promise<void> {
  await tx.payment.upsert({
    where: { bookingId: input.bookingId },
    create: { bookingId: input.bookingId, amountCents: 0, changeFeeCents: input.changeFeeCents },
    update: { changeFeeCents: { increment: input.changeFeeCents } },
  });
}

/** The `newData` path of an ordinary edit's marker; a finished-stay correction keeps its own (#3750). */
export const CHANGE_FEE_ADDED_TO_AMOUNT_OWED_PATH = ["changeFeeAddedToAmountOwed"] as const;

/** The `newData` field an edit writes when it added its fee to the amount owed, or none. */
export function changeFeeAddedToAmountOwedHistory(
  feeAddedCents: number,
): { changeFeeAddedToAmountOwed?: true } {
  return feeAddedCents > 0 ? { changeFeeAddedToAmountOwed: true } : {};
}
