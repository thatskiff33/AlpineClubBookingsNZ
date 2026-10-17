/**
 * #4210 (`INV-PAY-136`): A CARD REFUND A "PAID ANOTHER WAY" CLOSE ALREADY
 * SETTLED IS NOT OWED AGAIN WHEN STRIPE FAILS IT LATER.
 *
 * A card refund row's runner asks Stripe for refund X and the answer is lost;
 * the treasurer closes the row "Paid another way" and pays the member by bank
 * for what the row still owed - X's share included, because the close never
 * counted X as made. If Stripe then fails X, the member has had that money
 * once, by the close. The failed-later writer (`card-refund-failed-later.ts`)
 * asks this module, under the Payment row lock it holds, before it raises
 * anything; a close takes that lock before it writes its record
 * (`lockPaymentForRefundedTotal`), so the record read here is all or nothing.
 *
 * WHICH CLOSE. The row that sent X (`madeBy`, by its runner's metadata), closed
 * "Paid another way" (its record, `closeKeysOf`), with X made by Stripe by the
 * close (`operationWindowTakes`). A refund naming no booking of this payment -
 * made in the Stripe dashboard, which no row sent - is weighed against the row
 * whose slice it fills, only on the paid-twice reading
 * (`cardRefundsSentAfterPaidAnotherWay`). Another door's refund for this
 * booking that no row sent is never settled.
 *
 * DID THAT CLOSE PAY X BACK (round 3, money F1/F2). Decided from what the close
 * counted, kept on its record (`readPaidAnotherWayCounted`), never from today's
 * matching, which another refund failing can move:
 *
 * - **Kept**: X was not among the refunds it counted as made, and X fits one of
 *   the slices it found unsent (`refundFitsSlice`: that charge, exactly that
 *   amount, not marked as another refund's). A refund of another amount - an
 *   edit's own refund carrying the same metadata - is owed as before.
 * - **Not kept** (a close recorded before round 3): only a refund the app
 *   recorded after the close and that fills that row's slice - on the
 *   paid-twice list - is settled. One that fits a slice the row planned, but
 *   the close may have counted, is uncertain: raised dead for an officer to
 *   check, never settled and never re-sent.
 * - A refund larger than what the close owed is uncertain too.
 *
 * WHAT IS LEFT FOR AN OFFICER. A full close paid back X's share: nothing is
 * raised. A part close (`paidAnotherWayUnpaidCents`) may have given up X's
 * share: up to what it gave up, less what earlier part-close checks against it
 * already list (money F3), is raised dead - attempts spent, never sent - for
 * an officer to check (`PaidAnotherWayCheck`). A close whose paid-twice row
 * was marked Resolved (`readPaidTwiceResolution`) most likely had the member
 * return the extra: the whole of X is raised dead. A resolution speaks only
 * for refunds its paid-twice row listed.
 */
import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import { readPaidAnotherWayCounted, type PaidAnotherWayCounted } from "@/lib/card-refund-paid-another-way-counted";
import { readPaidTwiceResolution } from "@/lib/card-refund-paid-twice-resolution";
import type { PaidAnotherWayFailedLaterOutcome } from "@/lib/card-refund-failed-later-paid-another-way-note";
import { CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, closeKeysOf, paidAnotherWayUnpaidCents } from "@/lib/manual-refund-task-settlement-rules";
import {
  cardRefundPlannedSlices,
  cardRefundsSentAfterPaidAnotherWay,
  operationWindowTakes,
  paidAnotherWayCheckOf,
  recordedAfterClose,
  refundFitsSlice,
  type CardRefundOwedPaymentRow,
  type PaidAnotherWayCheckReason,
  type RecordedCardRefundRow,
} from "@/lib/open-card-refund-owed";

/** The close that settled a failed refund, and what it leaves for an officer. */
export type SettlingPaidAnotherWayClose = {
  outcome: PaidAnotherWayFailedLaterOutcome;
  /** The close's record (`ManualRefundTask`) and the row it closed. */
  recordId: string;
  operationId: string;
  paidBackCents: number;
  owedCents: number;
  /** What is raised dead for an officer to check; 0 when settled. */
  checkCents: number;
  /** The refund was counted under "Card refunds paid back twice". */
  onPaidTwiceList: boolean;
  /** The app recorded the refund after the close (else it counted it toward another row before it). */
  recordedAfterClose: boolean;
  /** The note its paid-twice row was marked Resolved with, if it was. */
  resolutionNote: string | null;
};

/** #4210: the check a raised row stands for (`PaidAnotherWayCheck`), by outcome. */
export const CHECK_REASON_OF: Record<Exclude<PaidAnotherWayFailedLaterOutcome, "settled-paid-another-way">, PaidAnotherWayCheckReason> = {
  "raised-check-part-close": "part-close",
  "raised-check-resolved": "resolved",
  "raised-check-uncertain": "uncertain",
};

/**
 * Whether the close paid this refund back: `covered`, `uncertain` (an officer
 * checks), or null - it did not, and the refund is owed as before. See the
 * module comment.
 */
function closePaidItBack(
  row: PaymentRecoveryOperation,
  counted: PaidAnotherWayCounted | null,
  recorded: RecordedCardRefundRow,
  onPaidTwiceList: boolean,
): "covered" | "uncertain" | null {
  if (counted) {
    if (counted.refundIds.includes(recorded.stripeRefundId)) return null;
    return counted.unsentSlices.some((slice) => refundFitsSlice(slice, recorded)) ? "covered" : null;
  }
  if (onPaidTwiceList) return "covered";
  return cardRefundPlannedSlices(row).some((slice) => refundFitsSlice(slice, recorded)) ? "uncertain" : null;
}

/**
 * The "Paid another way" close that settled this failed refund, or null.
 * `beforeFailure` is the payment as it stood before Stripe failed the refund
 * (`cardRefundPaymentBeforeFailure`); `madeBy` the row that sent it; `filledBy`
 * the row whose slice it fills there; `rows` every card refund row on the
 * payment, the checks already raised against a close among them.
 */
export async function findPaidAnotherWayCloseThatSettled(
  tx: Prisma.TransactionClient,
  {
    rows,
    beforeFailure,
    madeBy,
    filledBy,
    refund,
    bookingId,
  }: {
    rows: ReadonlyArray<PaymentRecoveryOperation>;
    beforeFailure: CardRefundOwedPaymentRow;
    madeBy: string | null;
    filledBy: string | null;
    refund: { id: string; amount: number; metadata?: Record<string, string> | null };
    bookingId: string;
  },
): Promise<SettlingPaidAnotherWayClose | null> {
  const recorded = beforeFailure.refunds.find((each) => each.stripeRefundId === refund.id);
  const closed = (id: string | null) =>
    rows.find((row) => row.id === id && row.status === PaymentRecoveryOperationStatus.SUCCEEDED && row.succeededAt !== null);
  // The row that sent it decides; by the slice it fills only a refund no door of this booking made.
  const row = madeBy !== null ? closed(madeBy) : refund.metadata?.bookingId !== bookingId ? closed(filledBy) : undefined;
  if (!recorded || !row || !operationWindowTakes(row, recorded)) return null;
  const onPaidTwiceList = cardRefundsSentAfterPaidAnotherWay(beforeFailure, new Set([row.id])).get(row.id)?.has(refund.id) === true;
  if (madeBy === null && !onPaidTwiceList) return null;
  const record = await tx.manualRefundTask.findFirst({
    where: { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, occurrenceKey: { in: closeKeysOf(row.id) } },
    select: { id: true, amountCents: true, raisedAmountCents: true, reviewContext: true },
  });
  if (!record) return null;
  const owedCents = record.raisedAmountCents ?? record.amountCents ?? 0;
  const paidItBack = closePaidItBack(row, readPaidAnotherWayCounted(record.reviewContext), recorded, onPaidTwiceList);
  if (paidItBack === null) return null;
  const resolution = onPaidTwiceList ? readPaidTwiceResolution(record.reviewContext) : null;
  let outcome: PaidAnotherWayFailedLaterOutcome;
  let checkCents: number;
  if (paidItBack === "uncertain" || refund.amount > owedCents) {
    [outcome, checkCents] = ["raised-check-uncertain", refund.amount];
  } else if (resolution) {
    [outcome, checkCents] = ["raised-check-resolved", refund.amount];
  } else {
    // Money F3: what the close gave up, less what part-close checks against it already list.
    const listedCents = rows
      .filter((each) => {
        const check = paidAnotherWayCheckOf(each);
        return check?.closedOperationId === row.id && check.reason === "part-close";
      })
      .reduce((sum, each) => sum + each.amountCents, 0);
    checkCents = Math.min(refund.amount, Math.max(0, paidAnotherWayUnpaidCents(record) - listedCents));
    outcome = checkCents === 0 ? "settled-paid-another-way" : "raised-check-part-close";
  }
  return {
    outcome,
    recordId: record.id,
    operationId: row.id,
    paidBackCents: record.amountCents ?? 0,
    owedCents,
    checkCents,
    onPaidTwiceList,
    recordedAfterClose: recordedAfterClose(row, recorded),
    resolutionNote: resolution?.note ?? null,
  };
}
