import "server-only";

import { ManualRefundTaskStatus, PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import {
  CAPACITY_RACE_XERO_SENTENCE,
  capacityRaceChargeForHandBack,
  capacityRaceNothingToAllocateMessage,
  noteMayCover,
  type CapacityRaceStripeRefunded,
  type CapacityRaceXero,
} from "@/lib/capacity-race-refunded-total-correction";
import type { ClubFormat } from "@/lib/club-format";
import { capacityRaceShortfallIntentId } from "@/lib/capacity-race-shortfall-task-key";
import { cancelCardShortfallOccurrenceKey, cancelCardShortfallPart } from "@/lib/manual-refund-task-settlement-rules";
import { isPaymentRecoveryOperationExhausted, isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { bookingCancelCardRefundRecoveryWhere, CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX, isBookingCancelCardRefundRecoveryKey } from "@/lib/payment-recovery-keys";
import { CARD_REFUND_STILL_OWED_RECOVERY_PREFIX } from "@/lib/card-refund-still-owed-keys";
import { cardRefundStillOwedOrigin } from "@/lib/card-refund-still-owed-origin";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { isStripeTransaction, lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";

/**
 * #4097 (`INV-PAY-129`, coordinator decisions on PR #4122): HOW A CANCEL'S CARD
 * REFUND SHORTFALL IS MARKED PAID BACK.
 *
 * - **Its money settles on the payment's non-card charges first**
 *   (`preferTransactionIds`), as a "Paid another way" close places it on the
 *   charges its card refund was for - the bank part was sized from exactly
 *   their headroom, so its allocation can succeed.
 * - **Never while the card part is still being refunded.** Under the `Payment`
 *   row lock (`lockPaymentForRefundedTotal`, which every refunded-total writer
 *   takes first), a completion is refused while the cancel's card refund
 *   recovery (`booking_cancel_refund_recovery_<bookingId>`, or a capacity
 *   race's per intent, #4154) is not SUCCEEDED:
 *   the card's slices and this hand-back must never be read off one ledger
 *   while one of them is still moving. Nor (#4104) while a card refund on the
 *   payment that Stripe failed later is owed again by a row of its own. The refusal names the next step by the
 *   row's state - running, failed and waiting to retry, or stopped (close it
 *   as Paid another way) - on the recovery module's own rules. A capacity
 *   race's (#4154 review M10) never says to mark this after that close, which
 *   its correction would refuse: stopped, it says to dismiss with a note.
 * - **A part to check waits for its bank-transfer sibling**, which was sized on
 *   the same non-card charges: completed first, the check part would use that
 *   money and leave the bank part told to dismiss. Once the bank part is
 *   closed, a check part settles only on whatever headroom is left.
 * - **A refusal names the dismiss route** where the payment's records hold
 *   nothing for it (`cardShortfallSettlementRefusal`).
 *
 * Asked by `chooseEditReviewSettlementRoute` before the status claim, inside the
 * completion's transaction, so a refusal leaves the task OPEN.
 */
/** The card refund recovery is running, or queued to run. */
export const CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE =
  "The card part of this cancellation's refund is still being refunded; mark this once it settles.";

/** The card refund failed and its runner will try again. */
export const CARD_SHORTFALL_CARD_AWAITING_RETRY_MESSAGE =
  "The card part of this cancellation's refund failed and is waiting to retry: wait for its retry to go through, then mark this. If its retries run out, close it as Paid another way on the Stuck States page first.";

/** The card refund's retries are spent (`deadCardRefundOperationWhere`'s rule). */
export const CARD_SHORTFALL_CARD_STOPPED_MESSAGE =
  "The card part of this cancellation's refund has stopped retrying: close it as Paid another way on the Stuck States page (once the member has had that money back another way), then mark this.";

/** A part to check, while its sibling bank-transfer part is still open. */
export const CARD_SHORTFALL_BANK_PART_FIRST_MESSAGE =
  "Mark the bank-transfer part of this cancellation's refund first: it is settled on the money this part would otherwise use. Then mark this, if the check shows it is really owed.";

/** #4154 review (M3): an officer marks first and pays after, so a refusal says what to do with money still owed. */
export const CARD_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE =
  "The payment's records show nothing left to refund for this - it may already have gone back. Check Stripe and the bank: if the member has been refunded, dismiss this task with a note saying how. If it really is owed, the app cannot record it here: refund it by bank transfer, dismiss this task with a note saying when and how much, and raise its refund credit note in Xero by hand if the booking has a Xero invoice.";

/**
 * #4154 review (M10): a capacity race's card refund that failed. Never "close
 * it as Paid another way, then mark this": that close is another refund task
 * on the booking, which the race's correction refuses (`other-task`), so the
 * part can then only be dismissed - the owner's way out where the correction
 * cannot run.
 */
export const CAPACITY_RACE_CARD_AWAITING_RETRY_MESSAGE =
  "The card refund for this booking failed and is waiting to retry: wait for its retry to go through, then mark this. If its retries run out, the app will say what to do then.";

export function capacityRaceCardStoppedMessage(xero: CapacityRaceXero): string {
  return `The card refund for this booking has stopped retrying, so the app cannot record this part as paid back. Check Stripe and the bank. Close the card refund as Paid another way on the Stuck States page once the member has had that money back another way. If this part is really owed too, refund it by bank transfer and dismiss this task with a note saying when and how much. ${CAPACITY_RACE_XERO_SENTENCE[xero]}`;
}

/**
 * The payment's captured charges the card refund cannot carry, newest first:
 * every captured charge that is not a Stripe one (`isStripeTransaction`, the
 * rule the card refund plan itself uses - its complement, so the two cannot
 * disagree about a charge). What a bank-transfer part is sized on and settles on.
 */
export async function nonCardCapturedCharges(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<Array<{ id: string; headroomCents: number }>> {
  const rows = await db.paymentTransaction.findMany({
    where: { paymentId, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
    orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
    select: { id: true, source: true, stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
  });
  return nonCardChargeHeadroom(rows ?? []);
}

/** The pure step of `nonCardCapturedCharges`, for rows already captured: #4119's cancel preview reads its in-memory ledger through it. */
export function nonCardChargeHeadroom(
  capturedRows: ReadonlyArray<Parameters<typeof isStripeTransaction>[0] & { id: string; amountCents: number; refundedAmountCents: number }>,
): Array<{ id: string; headroomCents: number }> {
  return capturedRows
    .filter((row) => !isStripeTransaction(row))
    .map((row) => ({ id: row.id, headroomCents: Math.max(0, row.amountCents - row.refundedAmountCents) }));
}

/** The refusals a card refund still moving gets: a member cancel's, or (review M10) a capacity race's, which never says to mark this after a Paid another way close. */
type CardRefundRefusals = { stillRefunding: string; awaitingRetry: string; stopped: string };
const CANCEL_CARD_REFUND_REFUSALS: CardRefundRefusals = {
  stillRefunding: CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE,
  awaitingRetry: CARD_SHORTFALL_CARD_AWAITING_RETRY_MESSAGE,
  stopped: CARD_SHORTFALL_CARD_STOPPED_MESSAGE,
};

/** Why the card refund recovery is not settled, as the refusal says it - or null when it is (or there is none). */
function cardRefundRefusal(
  cardRefund: { status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null; lastError: string | null } | null,
  says: CardRefundRefusals,
): string | null {
  if (!cardRefund || cardRefund.status === PaymentRecoveryOperationStatus.SUCCEEDED) return null;
  if (isPaymentRecoveryOperationExhausted(cardRefund)) return says.stopped;
  // A raw-string READ: the enum member stays in the recovery module (INV-PAY-056's census).
  if (cardRefund.status === "FAILED" || (cardRefund.status === PaymentRecoveryOperationStatus.PENDING && cardRefund.lastError)) {
    return isPaymentRecoveryOperationInFlight(cardRefund) ? says.awaitingRetry : says.stopped;
  }
  return says.stillRefunding;
}

/** Null for any other task; for a shortfall, its settlement's preferred charges, or the refusal. */
export async function cardShortfallSettlement(
  task: { id: string; kind: string | null; occurrenceKey: string | null; bookingId: string; paymentId: string | null; booking: { memberId: string | null } },
  store: Prisma.TransactionClient,
  /**
   * What this completion settles, and who: a capacity race's correction (#4154) needs both. For a capacity race,
   * too, what Stripe says its charge refunded (read before the transaction) and whether the booking has a Xero
   * invoice its note would credit (#4154 review M1, M4); a race without them refuses as Stripe unread.
   */
  completion: { amountCents: number; actingMemberId: string | null; format: ClubFormat; capacityRace?: { stripe: CapacityRaceStripeRefunded | null; invoiced: boolean } },
): Promise<{ preferTransactionIds: string[]; onlyTransactionIds?: string[]; nothingToAllocateMessage?: string } | null> {
  const part = cancelCardShortfallPart(task);
  if (part === null || task.paymentId === null) return null;
  await lockPaymentForRefundedTotal(store, task.paymentId);
  const raceIntentId = capacityRaceShortfallIntentId(task);
  const race = { stripe: completion.capacityRace?.stripe ?? null, invoiced: completion.capacityRace?.invoiced ?? true };
  // Round 4 (F2): a race's refusals read the payment's Xero notes first (`noteMayCover`), the stopped one included.
  const raceXero: CapacityRaceXero | null =
    raceIntentId === null ? null : (await noteMayCover(store, task.paymentId)).mayCover ? "noted" : race.invoiced ? "invoiced" : "no-invoice";
  // #4104 review (MM3): the cancel's own recovery row, and any card refund on
  // this payment Stripe failed later and that is owed again by a row of its own
  // (`card_refund_failed_later_<refund>`) - card money still moving either way.
  // #4154: the cancel's own rows are #4147's one rule - a member cancel's row, or a capacity race's per intent.
  // #4516 review M4: and a rest of either still owed after a part "Paid another way" close (`card_refund_still_owed_<record>`),
  // asked of the row it was first owed on.
  const cardRefunds = await store.paymentRecoveryOperation.findMany({
    where: {
      OR: [
        bookingCancelCardRefundRecoveryWhere(task.bookingId),
        { paymentId: task.paymentId, idempotencyKey: { startsWith: CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } },
        { paymentId: task.paymentId, idempotencyKey: { startsWith: CARD_REFUND_STILL_OWED_RECOVERY_PREFIX } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { idempotencyKey: true, status: true, attempts: true, nextRetryAt: true, lastError: true },
  });
  const isOwnOrFailedLater = (key: string) =>
    key.startsWith(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX) || isBookingCancelCardRefundRecoveryKey(task.bookingId, key);
  const ownOrFailedLater: typeof cardRefunds = [];
  for (const row of cardRefunds ?? []) {
    const origin = await cardRefundStillOwedOrigin(store, row.idempotencyKey);
    if (isOwnOrFailedLater(origin?.idempotencyKey ?? row.idempotencyKey)) ownOrFailedLater.push(row);
  }
  const says: CardRefundRefusals =
    raceIntentId === null
      ? CANCEL_CARD_REFUND_REFUSALS
      : { ...CANCEL_CARD_REFUND_REFUSALS, awaitingRetry: CAPACITY_RACE_CARD_AWAITING_RETRY_MESSAGE, stopped: capacityRaceCardStoppedMessage(raceXero ?? "invoiced") };
  const refusal = ownOrFailedLater.map((row) => cardRefundRefusal(row, says)).find((message) => message !== null);
  if (refusal) throw new ManualBookingPaymentError(refusal, 409);
  // #4154 (`INV-PAY-135`, PR #4159 review F2/F4): a capacity race's settles on
  // the race's own card charge and nowhere else - never a non-card charge, nor
  // a charge captured later on the same payment. Short there, the allocation
  // refuses (`onlyTransactionIds`) with the race's own way out.
  // Where that charge holds too little, the owner's guarded recalculation (#4154) corrects it first, or names what blocked it.
  if (raceIntentId !== null) {
    const { chargeId, xero } = await capacityRaceChargeForHandBack(store, {
      task: { id: task.id, bookingId: task.bookingId, paymentId: task.paymentId, booking: task.booking },
      raceIntentId,
      amountCents: completion.amountCents,
      stripe: race.stripe,
      invoiced: race.invoiced,
      actingMemberId: completion.actingMemberId,
      format: completion.format,
    });
    // Round 3 (1): the allocator's backstop refusal says what the correction found about Xero notes, too.
    return { preferTransactionIds: [chargeId], onlyTransactionIds: [chargeId], nothingToAllocateMessage: capacityRaceNothingToAllocateMessage(xero) };
  }
  // A part to check settles only on what the bank-transfer part leaves (coordinator, PR #4122).
  // #4872: the completion passes the superseded-capture hold-back into the allocation, so after
  // these preferred non-card charges the newest-first fall-through does not take a live superseded capture.
  if (part === "check") {
    const bank = await store.manualRefundTask.findUnique({
      where: { occurrenceKey: cancelCardShortfallOccurrenceKey(task.bookingId, "bank") },
      select: { status: true },
    });
    if (bank?.status === ManualRefundTaskStatus.OPEN) throw new ManualBookingPaymentError(CARD_SHORTFALL_BANK_PART_FIRST_MESSAGE, 409);
  }
  return { preferTransactionIds: (await nonCardCapturedCharges(store, task.paymentId)).map((row) => row.id) };
}
