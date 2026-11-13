/**
 * #4125: A CAPACITY-RACE REFUND SHORT OF THE CHARGE IS THE OFFICERS' TO FOLLOW UP.
 *
 * A payment that completes after the final capacity claim failed is cancelled
 * and refunded by card for what the payment ledger shows refundable
 * (`plannedRefundCents`, `payment-reconciliation.ts`). Mirror-vs-ledger drift
 * can make that less than the charge, or nothing at all. The rest is neither
 * refunded nor retained, and the member's booking page says the club will be in
 * touch about it (`booking-narrative-cancelled-post-payment.ts`). This is what
 * backs that sentence: the officers are told, once ever per booking, how much
 * was not refunded automatically and that it is theirs to check and settle.
 *
 * Once ever through the one rule (`sendAdminAlertOnceEver`): a send that
 * reached an admin keeps its claim, so a redelivered webhook never repeats it.
 * A send that threw gives the claim back, but nothing re-runs this - the
 * capacity race happens once - so that loss is logged, and the booking page
 * still says the club will be in touch.
 *
 * #4154 (`INV-PAY-135`): the rest is also recorded, as #4097's card refund
 * shortfall part to CHECK (a `CANCELLED_BOOKING_HAND_BACK` keyed
 * `capacityRaceShortfallOccurrenceKey(booking, intent)`), raised in the
 * capacity void's own claim so it commits with the cancel. Only that part: the
 * rest is drift in the card charge's own records, which may already have gone
 * back by another route, so the treasurer checks before paying - never a
 * bank-transfer part sized from other charges, which this refund was never
 * for. Marked paid back, it records the hand refund only on the race's own
 * charge (`cardShortfallSettlement`), as #4097's does otherwise (its
 * `BANK_REFUND` line and Xero note, and a REFUNDED event the member's page
 * counts). Where that charge holds too little, the owner's guarded
 * recalculation corrects it first (`capacity-race-refunded-total-correction.ts`),
 * or the app refuses, naming why, and says to dismiss it and raise the Xero
 * note by hand. Dismissed, the page
 * says the club checked it and closed it. One per booking in practice, as the
 * alert is: a booking is cancelled once.
 */
import type { Prisma } from "@prisma/client";

import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { raiseCardShortfallPart } from "@/lib/cancel-card-refund-shortfall";
import { capacityRaceShortfallOccurrenceKey } from "@/lib/capacity-race-shortfall-task-key";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { alertPaymentRecoveryOfficers, NOBODY_ALERTED } from "@/lib/payment-recovery-alert";
import { formatCents } from "@/lib/utils";
import type { BookingJournalContext } from "@/lib/member-money/doors";

/** The once-ever alert's key: one per booking, whatever the intent. */
export function capacityRaceRefundShortfallAlertKey(bookingId: string): string {
  return `capacity-race-refund-shortfall:${bookingId}`;
}

type ShortfallFigures = { chargedCents: number; plannedRefundCents: number };

/** What was refunded automatically and what was not, as the alert and the task both say it. */
function refundedSentence({ chargedCents, plannedRefundCents }: ShortfallFigures, format: ClubFormat): string {
  const money = (cents: number) => formatCents(cents, format);
  return plannedRefundCents > 0
    ? `The payment's records showed only ${money(plannedRefundCents)} of the ${money(chargedCents)} charge refundable, so that is being refunded to the card automatically and the remaining ${money(chargedCents - plannedRefundCents)} is not.`
    : `The payment's records showed nothing of the ${money(chargedCents)} charge refundable by card, so none of it was refunded automatically.`;
}

/**
 * The alert's text, naming what was refunded automatically and what is left,
 * and (#4154) the task that records it - or, where none could be raised (the
 * booking already holds one, which the settle logs), only what to do.
 */
export function capacityRaceRefundShortfallMessage(figures: ShortfallFigures, format: ClubFormat, taskRaised = false): string {
  const remainder = formatCents(figures.chargedCents - figures.plannedRefundCents, format);
  const lead = "The dates filled up while this card payment was going through, so the booking was cancelled.";
  const todo = taskRaised
    ? `It is under Money to settle on the payments board, as a task to check: the records may be wrong, and it may already have gone back. Check Stripe and the bank first. If the member has had it, dismiss the task with a note saying how. If it really is owed, mark the task paid back first, once the card refund has gone through: the app first checks it can record it, only on that card charge, correcting the charge's records first where it safely can. Pay the ${remainder} by bank transfer straight after it accepts; if it refuses, follow what it says. Accepted, it queues the Xero refund credit note itself, but a booking with no Xero invoice to credit gets no note.`
    : `Check the payment and refund the member the ${remainder} by hand if it has not already gone back.`;
  return `${lead} ${refundedSentence(figures, format)} ${todo} The member's booking page says the club will be in touch about it.`;
}

/**
 * #4154: the task's reason - what went back automatically, and the two ways to
 * close it. Its longest (every figure at $9,999,999.99) fits
 * `MANUAL_REFUND_TASK_REASON_MAX` with room to spare; the booking is the
 * task's own column, so it is not repeated here.
 */
export function capacityRaceShortfallTaskReason(figures: ShortfallFigures, format: ClubFormat): string {
  return `Cancelled because the dates filled up while this card payment was going through. ${refundedSentence(figures, format)} Check Stripe and the bank before paying: dismiss this with a note if it was refunded. If it is owed, mark this paid back first, once the card refund has gone through, then pay it by bank transfer straight after the app accepts (#4154).`;
}

/**
 * #4154 (`INV-PAY-135`): record the part of a capacity-race charge no card
 * refund covers as ONE hand-back task to check, inside the capacity void's
 * claim. Nothing when the plan covers the charge. Never throws on a key the
 * booking already holds (`raiseCardShortfallPart`'s `keep`): the webhook must
 * not wedge with the charge taken. True when the booking's task stands OPEN
 * for this remainder.
 */
export async function raiseCapacityRaceRefundShortfallTask(
  tx: Prisma.TransactionClient,
  input: ShortfallFigures & { bookingId: string; paymentId: string; paymentIntentId: string; format: ClubFormat; journal?: BookingJournalContext | null },
): Promise<boolean> {
  const cents = input.chargedCents - input.plannedRefundCents;
  if (cents <= 0) return false;
  const reason = capacityRaceShortfallTaskReason(input, input.format);
  if (reason.length > MANUAL_REFUND_TASK_REASON_MAX) logger.warn({ bookingId: input.bookingId, length: reason.length }, "Capacity-race shortfall task reason is over its limit; it is cut to fit (#4154)");
  const raised = await raiseCardShortfallPart(
    tx,
    {
      bookingId: input.bookingId, paymentId: input.paymentId, part: "check", cents, format: input.format,
      reason: reason.slice(0, MANUAL_REFUND_TASK_REASON_MAX),
      occurrenceKey: capacityRaceShortfallOccurrenceKey(input.bookingId, input.paymentIntentId),
      journal: input.journal,
    },
    "keep",
  );
  return raised !== null;
}

/**
 * Tell the officers, once ever, about the part of a capacity-race charge no
 * card refund covers. Nothing when the plan covers the charge. Never throws.
 */
export async function alertCapacityRaceRefundShortfall(
  input: { bookingId: string; paymentIntentId: string; chargedCents: number; plannedRefundCents: number; taskRaised?: boolean },
  format: ClubFormat,
): Promise<boolean> {
  const remainderCents = input.chargedCents - input.plannedRefundCents;
  if (remainderCents <= 0) return false;
  const context = { bookingId: input.bookingId, paymentIntentId: input.paymentIntentId, chargedCents: input.chargedCents, plannedRefundCents: input.plannedRefundCents };
  logger.error(context, "Capacity-race refund plan covers less than the captured amount; refunding what the payment ledger shows refundable");
  return sendAdminAlertOnceEver({
    key: capacityRaceRefundShortfallAlertKey(input.bookingId),
    label: "capacity-race refund shortfall alert",
    context,
    send: async () =>
      (await alertPaymentRecoveryOfficers(
        {
          bookingId: input.bookingId,
          amountCents: remainderCents,
          paymentIntentId: input.paymentIntentId,
          errorMessage: capacityRaceRefundShortfallMessage(input, format, input.taskRaised),
        },
        format,
      )) ?? NOBODY_ALERTED,
  });
}
