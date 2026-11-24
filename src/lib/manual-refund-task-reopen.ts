import "server-only";

import { BookingEventType, BookingStatus, ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import {
  refundableCashForRefundAppeal,
  refundableCashNetOfOpenHandBacks,
} from "@/lib/edit-refund-hand-back";
import {
  isEditRefundHandBackTask,
  isNonCancellationHandBackTask,
  isRefundRequestHandBackTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { isDisputeLossHandBack, restoreReopenedHandBackDebt } from "@/lib/manual-refund-task-hand-back-journal";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import { resolveBookingDoorClock, type BookingJournalContext } from "@/lib/member-money/doors";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";
import { stripeDisputeLateWinReopenKey } from "@/lib/stripe-dispute-keys";
import { recordManualRefundTaskReopenAudit } from "@/lib/manual-refund-task-reopen-audit";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { editRefundHandBackReopenAfterCancelMessage } from "@/lib/manual-refund-task-copy";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  normaliseManualPaymentNote,
} from "@/lib/manual-subscription-payment";
import { prisma } from "@/lib/prisma";
import { GROUP_CANCEL_SETTLED_REFUND_EVENT_REASON } from "@/lib/cancel-card-refund-event-reason";
import { NOT_A_SETTLEMENT_MARKER_WHERE } from "@/lib/manual-settlement-reversal-event";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { setTransactionLockTimeout } from "@/lib/member-merge-booking-lock";

/**
 * #3498 (owner decision D2, epic #2797): put a DISMISSED money task back in the
 * queue.
 *
 * ## The failure this exists for
 *
 * Every closure of a `ManualRefundTask` was terminal, the queue only ever read
 * `status: "OPEN"`, and the unique `occurrenceKey` meant the occurrence could
 * never be raised again. So a wrong dismissal was silent, permanent and
 * invisible to every later reader: no banner, no queue row, no correction to the
 * booking's stored total. Measured on the live deployment on 17 September 2026,
 * an officer working a seven-item fan-out for one edit stopped one row short of
 * dismissing the row carrying a real $140.00 adjustment. #3498 removes the
 * fan-out that made that likely; this removes the part that made it
 * unrecoverable.
 *
 * ## DISMISSED ONLY, and COMPLETED stays terminal
 *
 * A dismissal is a DECISION - "reviewed, and this system moved no money for that
 * occurrence" - and a decision can be wrong. A completion is a MOVEMENT: the
 * money has gone, down one of three settlement routes.
 *
 * ONE of those routes has an anchor that enforces exactly-once against a REPLAY
 * OF THE SAME TASK: `MemberCredit.sourceBookingModificationId` is `@unique`, so a
 * second account-credit settlement of the same edit is refused by the database.
 * The Stripe refund's idempotency key is NOT a second instance of that and must
 * not be read as one - it is TASK-scoped
 * (`buildEditFinancialReviewRefundStripeKeyPrefix(taskId)`), deliberately, because
 * one edit can raise two review tasks and a modification-scoped prefix would make
 * Stripe answer the second with the first's refund
 * (`edit-financial-review-settlement.ts` argues it in full). Reopening a
 * COMPLETED task would reuse that task's own id, so the key would match and
 * Stripe would replay - which is not protection, it is a member told their money
 * came back twice when it left once.
 *
 * Either way the refusal would arrive AFTER an officer had priced it a second
 * time, in front of a screen that had invited them to. So reopening a completion
 * is refused here, by status, before anything is claimed.
 *
 * ## AND ONLY A PERSON'S DISMISSAL
 *
 * `completedByMemberId` is NULL on a machine-written closure, and one population
 * of those is real and dangerous: `automaticallyRefundedManualRefundTaskFilter`
 * finds rows the Stripe webhook dismissed BECAUSE IT HAD ALREADY REFUNDED the
 * capture. Those are a record of money that moved, wearing a DISMISSED status.
 * Putting one back in the hand-settle queue would invite a second refund of a
 * capture Stripe has already returned. So the rule is the narrow one owner
 * decision D2 actually asks for: an officer may undo an officer's decision.
 *
 * ## What it deliberately does NOT do
 *
 * It moves no money, writes no allocation, sends no email, touches no provider,
 * and does not re-price the booking. The closure's own `note` is left exactly as
 * the dismissing officer wrote it - it is their record of why, and overwriting
 * it with the reopen's reason would destroy the thing being questioned. The
 * reopen's reason goes in the audit entry, which is where "who undid what, and
 * why" belongs.
 *
 * ## IT TAKES `pg_advisory_xact_lock(1)`, AND THE CLOSURE PATH'S REASONS FOR NOT
 * TAKING ONE DO NOT TRANSFER
 *
 * `resolveManualRefundTask` holds no advisory key ACROSS ITS PROVIDER CALL, and
 * that is deliberate: holding the global key across a Stripe round trip is what
 * the bounded-exception rule in `docs/CONCURRENCY_AND_LOCKING.md` forbids (since
 * #3582 an edit review's closure takes `lock(1)` inside its transaction only,
 * released before the call; legacy kinds take none). Reopening makes NO PROVIDER
 * CALL at all, so that exception has nothing to apply to - and the two
 * transitions are not mirror images in the way that phrasing suggests.
 *
 * A closure moves `OPEN -> terminal`, which only RELAXES
 * `assertNoPendingEditFinancialReview`: an edit that read the fence and proceeded
 * was entitled to. A reopen moves `DISMISSED -> OPEN`, which TIGHTENS the same
 * fence RETROACTIVELY, against edits already in flight. Unlocked, this
 * interleaves: a member's date change takes `lock(1)`, reads the fence (this task
 * is DISMISSED, so it proceeds) and runs a long edit that issues a credit under
 * its own modification M2; mid-window an officer reopens this task; both commit.
 * The task is now OPEN on a booking whose edit has already settled, its context
 * still points at M1, and the `MemberCredit.sourceBookingModificationId` anchor
 * for M1 is free - so completing it credits the member a second time.
 *
 * Taking the global key first is what closes that: the reopen either lands before
 * the edit reads the fence (and the edit is then refused, correctly) or after the
 * edit has committed (and the officer is reopening against a booking whose state
 * they can see). One tier, taken first, composing with nothing - `INV-LOCK-002`'s
 * global -> lodge -> member order is satisfied trivially.
 *
 * The status-fenced `updateMany` stays, and still carries the two-officers case:
 * the lock serialises them, and the fence is what tells the loser the row moved
 * rather than writing over the winner.
 *
 * ## What reopening SETS IN MOTION, which is nothing sudden
 *
 * The row becomes OPEN, so it is back on the finance queue and back inside
 * `assertNoPendingEditFinancialReview` - a further money-affecting edit to that
 * booking is fenced again, which is correct: the club has said the money is an
 * open question once more. The member-facing review banner returns for the same
 * reason. Both follow from the status and neither is written here.
 */
export const REOPEN_NOTE_REQUIRED_MESSAGE =
  "Say why this is being put back on the queue — a note is required.";

export const REOPEN_ONLY_DISMISSED_MESSAGE =
  "Only a closure that was dismissed can be put back on the queue. This one was completed, which means the money has already moved — raise the correction against the booking instead.";

export const REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE =
  "This item was closed automatically because the payment had already been refunded, so it is a record rather than a decision and cannot be put back on the queue.";

export const REOPEN_ALREADY_OPEN_MESSAGE =
  "This item is already on the queue.";

/**
 * #3827 (`INV-PAY-117`): an edit refund hand-back promises cash back. Once it
 * is dismissed that cash is refundable again, and a later edit or cancellation
 * may already have promised or returned it, so putting the task back could
 * promise more than the club took.
 */
export const REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE =
  "This refund can no longer be put back on the queue: since it was dismissed, the money it would return has been refunded or promised back another way. Check the booking's payments before raising anything further.";

export const REOPEN_RACED_MESSAGE =
  "This item changed while you were putting it back — refresh and try again.";

/**
 * #4343: edit reviews are retired. Reopening one would put it back on the
 * queue and fence every later edit of that booking. Officer-dismissed and
 * machine-dismissed rows are both refused, before the status claim.
 */
export const REOPEN_EDIT_REVIEW_RETIRED_MESSAGE =
  "Officer edit reviews were retired; an edit review cannot be put back on the queue.";

/*
  THE BOUNDS ARE NOT HERE. A card has to SAY the window it is showing, and this
  module is `server-only`, so both bounds live in
  `manual-refund-task-reopen-bounds.ts` where the query and the card can each
  read them - and neither is a rule about what may be reopened, which is why
  they are not on this module at all. `reopenManualRefundTask` refuses on status
  and on who closed the row, never on age.
*/

/**
 * #5197: the late win's own refusals. The dispute it names must still read won, on the task's own payment, or the
 * reopen is not the app's to make; the alert then names the task for an officer instead.
 */
export const LATE_WIN_REOPEN_NOT_WON_MESSAGE =
  "The dispute no longer reads won on this task's card payment.";
export const LATE_WIN_REOPEN_NOT_DISPUTE_LOSS_MESSAGE =
  "It is not a disputed card payment's hand-back.";

/**
 * #5197: an edit refund hand-back on a cancelled booking whose dismissal recorded no booking status (dismissed before
 * #5197, or with no audit row) and no cancellation since: it may have been dismissed after the cancel for a lost dispute,
 * when the cancel counted it as going back, so neither "counted by the cancellation" nor a reopen is safe to assume.
 */
export const REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE =
  "It was dismissed before the app recorded the booking's status, so the app cannot tell whether the booking's cancellation counted it in its own refund. Check the booking's payments by hand before paying or reopening anything.";

/** #5197: how long a late win's reopen waits for a lock before it gives up and the alert names the task instead. */
export const LATE_WIN_REOPEN_LOCK_TIMEOUT_MS = 5_000;

/**
 * #3827 (`INV-PAY-117`): the after-cancel reopen refusal, its own class so a late win (#5197) can tell the alert that
 * the cancellation counted the money, rather than that an officer should reopen it.
 */
export class ReopenCountedByCancellationError extends ManualBookingPaymentError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ReopenCountedByCancellationError";
  }
}

/** Who is reopening: an officer, with their reason, or the app for a lost dispute Stripe now reports won (#5197). */
type ReopenBy =
  | { by: "officer"; actingMemberId: string; note: string }
  | { by: "late-win"; disputeId: string };

const REOPEN_TASK_SELECT = Prisma.validator<Prisma.ManualRefundTaskSelect>()({
  id: true,
  bookingId: true,
  paymentId: true,
  kind: true,
  // #3827: an edit refund hand-back's marker and the cash behind it.
  occurrenceKey: true,
  // #5197: what `isDisputeLossHandBack` reads.
  partPaymentReviewPaymentId: true,
  reason: true,
  payment: { select: { id: true, bookingId: true, status: true, amountCents: true, refundedAmountCents: true } },
  status: true,
  amountCents: true,
  raisedAmountCents: true,
  note: true,
  completedAt: true,
  completedByMemberId: true,
  // #3827: whether a cancellation has since counted this task out.
  // #3949: and whether the group organiser paid for it, whom its money goes back to.
  booking: { select: { memberId: true, status: true, organiserSettled: true, parentBookingId: true, payment: { select: { source: true } }, organisation: { select: { name: true, email: true } } } },
});

type ReopenTask = Prisma.ManualRefundTaskGetPayload<{ select: typeof REOPEN_TASK_SELECT }>;

/**
 * Put one DISMISSED task back on the queue, audited, as the officer doing it.
 *
 * The window above bounds the CARD, not this function: a bound written into the
 * money rule would make whether a mistake can be corrected depend on the clock,
 * and there is no failure that stops being worth correcting on day thirty-one.
 * What stops an arbitrarily old row being reopened is that nothing offers it.
 */
export async function reopenManualRefundTask({
  taskId,
  actingMemberId,
  note,
}: {
  taskId: string;
  actingMemberId: string;
  /**
   * Why. REQUIRED, exactly as a dismissal's note is and for the same reason:
   * this undoes a decision somebody recorded, and the only record of why it was
   * undone is this sentence.
   */
  note: string | null;
}) {
  const trimmedNote = normaliseManualPaymentNote(note);
  if (!trimmedNote) {
    throw new ManualBookingPaymentError(REOPEN_NOTE_REQUIRED_MESSAGE, 400);
  }
  // `INV-LOCK-004`: a dispute-loss hand-back's restored debt (#5197) posts on the journal read before the transaction.
  const { journal } = await resolveBookingDoorClock();
  return prisma.$transaction(async (tx) => {
    const task = await reopenInTransaction(tx, journal, taskId, { by: "officer", actingMemberId, note: trimmedNote });
    if (task === "already-open") throw new ManualBookingPaymentError(REOPEN_ALREADY_OPEN_MESSAGE, 409);
    return {
      taskId: task.id,
      bookingId: task.bookingId,
      kind: task.kind,
      status: ManualRefundTaskStatus.OPEN,
    };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}

/**
 * #5197: a dispute-loss hand-back dismissed while its card dispute read lost, put back
 * on the queue by the app once Stripe reports that dispute won (a "late win"): the club holds the money again and
 * owes the member. The officer's own rules and order apply, with no officer: origin `STRIPE`, no actor (as the inbound
 * Xero sync reopens a part-payment review, `part-payment-review-cover.ts`), the dispute named in the audit entry, and
 * its debt posted again. Every lock wait is bounded (`LATE_WIN_REOPEN_LOCK_TIMEOUT_MS`), so a busy officer holding the
 * booking makes the webhook give up rather than stall; the caller reports that, as it reports every refusal
 * (`ManualBookingPaymentError`), never retrying here. A task already open (reopened by an officer, or by an earlier
 * delivery) answers `already-open` and writes nothing. The `AlertCooldown` marker for (dispute, task) commits with
 * the claim, so a redelivery names the task as reopened even though the allocation no longer counts it.
 */
export async function reopenHandBackAfterLateWin({ taskId, disputeId }: { taskId: string; disputeId: string }): Promise<"reopened" | "already-open"> {
  const { journal } = await resolveBookingDoorClock();
  return prisma.$transaction(async (tx) => {
    await setTransactionLockTimeout(tx, LATE_WIN_REOPEN_LOCK_TIMEOUT_MS);
    const task = await reopenInTransaction(tx, journal, taskId, { by: "late-win", disputeId });
    if (task === "already-open") return "already-open";
    const key = stripeDisputeLateWinReopenKey(disputeId, task.id);
    await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: new Date() }, update: {} });
    return "reopened";
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}

/**
 * The reopen both doors share, in one transaction. Order (`INV-LOCK-002`): `lock(1)` first (the module docblock),
 * the task read, then for an appeal's hand-back its Payment row, as before. A dispute-loss hand-back (#5197) instead
 * takes its booking row straight after the read, re-reads the task under it, then its Payment row and the booking's
 * disputes: exactly the order its Dismiss and Reduce took (`lock(1)`, booking row, Payment row), and the restored
 * debt reads its debtor under that booking row.
 */
async function reopenInTransaction(
  tx: Prisma.TransactionClient,
  journal: BookingJournalContext,
  taskId: string,
  reopenBy: ReopenBy,
): Promise<ReopenTask | "already-open"> {
  /*
    `INV-LOCK-001`/`INV-LOCK-002`: the global settlement cohort, taken FIRST and
    before the read, because `DISMISSED -> OPEN` re-arms the pending-review fence
    against money-affecting edits already in flight. The module docblock works
    the interleaving through. No provider call happens inside this transaction,
    so the bounded-exception rule that keeps the CLOSURE path lock-free has
    nothing to apply to here.
  */
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  let task = await tx.manualRefundTask.findUnique({ where: { id: taskId }, select: REOPEN_TASK_SELECT });
  if (!task) {
    throw new ManualBookingPaymentError("Refund task not found.", 404);
  }
  const disputeLoss = isDisputeLossHandBack(task);
  if (disputeLoss) {
    // #5197: the booking row before anything else row-level; the task re-read under it is the one decided on.
    await lockBookingRowForOwnerRead(tx, task.bookingId);
    task = await tx.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: REOPEN_TASK_SELECT });
  }
  if (task.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) {
    throw new ManualBookingPaymentError(REOPEN_EDIT_REVIEW_RETIRED_MESSAGE, 409);
  }
  if (task.status === ManualRefundTaskStatus.OPEN) return "already-open";
  if (task.status !== ManualRefundTaskStatus.DISMISSED) {
    throw new ManualBookingPaymentError(REOPEN_ONLY_DISMISSED_MESSAGE, 409);
  }
  if (task.completedByMemberId === null) {
    throw new ManualBookingPaymentError(
      REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE,
      409,
    );
  }
  if (reopenBy.by === "late-win" && !disputeLoss) {
    throw new ManualBookingPaymentError(LATE_WIN_REOPEN_NOT_DISPUTE_LOSS_MESSAGE, 409);
  }
  // #5197: the Payment row (the dismissal's order), then the disputes re-read under every lock above.
  if (disputeLoss && task.paymentId !== null) await lockPaymentForRefundedTotal(tx, task.paymentId);
  if (reopenBy.by === "late-win") await assertLateWinDisputeWon(tx, task, reopenBy.disputeId);

  // #3827 (`INV-PAY-117`): a cancellation since the dismissal sized its refund
  // without this task, so reopening it would promise the same money twice.
  // #5197: except a dismissal made after the cancellation, which only a lost
  // dispute allows (#4516, owner decision 18 Nov 2026): the cancel counted the
  // task as going back, so putting it back restores what the cancel assumed.
  // An older dismissal with no recorded status cannot be told either way: refused, for a person to check.
  if (isEditRefundHandBackTask(task) && task.booking.status === BookingStatus.CANCELLED) {
    const dismissal = await dismissalAgainstCancellation(tx, task);
    if (dismissal === "status-unrecorded") throw new ManualBookingPaymentError(REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE, 409);
    if (dismissal === "counted") throw new ReopenCountedByCancellationError(editRefundHandBackReopenAfterCancelMessage(task.booking)); // #3949
  }
  // #3827 (`INV-PAY-117`): never promise back more cash than was taken - for
  // an edit's refund and (D-3813-7) an approved appeal's alike, an appeal's
  // measured by the appeal's own ceiling (`INV-PAY-118`: every open
  // hand-back, the late-cash credit and, #4124, the card refunds still owed).
  // Read under lock(1), which every edit, acceptance, paid cancel and
  // approval holds - and, for an appeal's task, the Payment row too (#4124
  // review F2; `lock(1)` then the Payment row, `INV-LOCK-002`), which the
  // refunded-total writers, a cancellation hand-back's completion and the
  // failed-later card refund debt hold without `lock(1)`.
  if (isNonCancellationHandBackTask(task) && isRefundRequestHandBackTask(task) && task.payment) {
    await lockPaymentForRefundedTotal(tx, task.payment.id);
  }
  if (
    isNonCancellationHandBackTask(task) &&
    (task.amountCents ?? 0) >
      (isRefundRequestHandBackTask(task)
        ? await refundableCashForRefundAppeal(tx, task.payment)
        : await refundableCashNetOfOpenHandBacks(tx, task.payment))
  ) {
    throw new ManualBookingPaymentError(REOPEN_EDIT_REFUND_EXCEEDS_CASH_MESSAGE, 409);
  }

  /*
    The same status-fenced conditional update the closure uses, in the other
    direction. `updateMany` rather than `update` precisely so the fence can
    live in the `where`: a row somebody else has already reopened, or
    completed, matches nothing and is answered as the race it is rather than
    being written over.

    `completedAt` and `completedByMemberId` are cleared because they describe a
    closure this row no longer has, and a reader filtering "who closed this"
    would otherwise be handed the officer whose decision has just been undone.
    `note` is NOT cleared - see the module docblock.

    `amountCents` and `settlementDirection` are not touched either. A dismissal
    writes neither, so there is nothing of a closure's on those columns to
    undo; a task raised with a proposed amount keeps it, which is the state it
    was in before it was dismissed.
  */
  const claimed = await tx.manualRefundTask.updateMany({
    where: { id: task.id, status: ManualRefundTaskStatus.DISMISSED },
    data: {
      status: ManualRefundTaskStatus.OPEN,
      completedAt: null,
      completedByMemberId: null,
    },
  });
  if (claimed.count === 0) {
    throw new ManualBookingPaymentError(REOPEN_RACED_MESSAGE, 409);
  }
  // #5197: with the claim, so a lost claim posts nothing; a journal refusal rolls the reopen back.
  await restoreReopenedHandBackDebt(tx, journal, {
    task,
    origin: reopenBy.by === "officer" ? "OFFICER" : "STRIPE",
    actorMemberId: reopenBy.by === "officer" ? reopenBy.actingMemberId : null,
  });

  await recordManualRefundTaskReopenAudit({
    task,
    subjectMemberId: bookingOwner(task.booking).memberId,
    actingMemberId: reopenBy.by === "officer" ? reopenBy.actingMemberId : null,
    ...(reopenBy.by === "officer"
      ? { summary: "Dismissed booking money task put back on the queue", details: reopenBy.note }
      : {
          summary: "Disputed card payment's hand-back put back on the queue: Stripe reports the lost dispute won",
          details: `Stripe dispute ${reopenBy.disputeId} was recorded lost, and this hand-back was dismissed because the cardholder had the money back. Stripe now reports the dispute won, so the club holds the money again and owes the member.`,
          extraMetadata: { lateWinDisputeId: reopenBy.disputeId },
        }),
    store: tx,
  });
  return task;
}

/** #5197: a late win's reopen names its dispute, which must read won on the task's own payment. */
async function assertLateWinDisputeWon(tx: Prisma.TransactionClient, task: ReopenTask, disputeId: string): Promise<void> {
  const disputes = (await readDisputesByBookingId(tx, [task.bookingId])).get(task.bookingId) ?? [];
  const won = disputes.some((dispute) => dispute.stripeDisputeId === disputeId && dispute.paymentId !== null
    && dispute.paymentId === task.paymentId && dispute.status === "WON");
  if (!won) throw new ManualBookingPaymentError(LATE_WIN_REOPEN_NOT_WON_MESSAGE, 409);
}

/**
 * #5197: the booking events that ARE a cancellation: a CANCELLED event that is not a settlement marker (#2262, stored
 * as CANCELLED but never cancelling), or the REFUNDED event an organiser's group cancel writes in place of one (#3653).
 */
const CANCELLATION_EVENT_WHERE = [
  { type: BookingEventType.CANCELLED, ...NOT_A_SETTLEMENT_MARKER_WHERE },
  { type: BookingEventType.REFUNDED, reason: GROUP_CANCEL_SETTLED_REFUND_EVENT_REASON },
] satisfies Prisma.BookingEventWhereInput[];

/**
 * #5197: whether this edit hand-back was dismissed AFTER its booking's latest cancellation. The after-cancel
 * dismissal refusal (`INV-PAY-117`) lets only a lost dispute through (#4516, owner decision 18 Nov 2026), and then the
 * cancellation counted the task as going back (`after-cancel`). Two records, both required, each failing towards a
 * refusal:
 * - a cancellation event after the dismissal (`CANCELLATION_EVENT_WHERE`): a cancellation since sized its refund
 *   without the task (`counted`). Any other REFUNDED event (another hand-back marked paid, a card refund row's close,
 *   a duplicate capture's refund) is not one, so it falls through to the next record;
 * - the dismissal's own audit row, written in its transaction, says the booking read CANCELLED under its locks
 *   (`bookingStatusAtClosure`). Another recorded status means the cancel came later (`counted`); none (a dismissal
 *   recorded before #5197, or no audit row) cannot be told either way (`status-unrecorded`), so it is never reopened and
 *   never reported as counted by the cancellation.
 */
async function dismissalAgainstCancellation(
  tx: Prisma.TransactionClient,
  task: ReopenTask,
): Promise<"after-cancel" | "counted" | "status-unrecorded"> {
  if (task.completedAt === null) return "counted";
  const laterCancellation = await tx.bookingEvent.findFirst({
    where: { bookingId: task.bookingId, occurredAt: { gt: task.completedAt }, OR: CANCELLATION_EVENT_WHERE },
    select: { id: true },
  });
  if (laterCancellation !== null) return "counted";
  const dismissal = await tx.auditLog.findFirst({
    where: { entityType: "ManualRefundTask", entityId: task.id, action: "booking-payment.manual-refund-task.dismiss" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const status = (dismissal?.metadata as { bookingStatusAtClosure?: unknown } | null | undefined)?.bookingStatusAtClosure;
  if (status === undefined || status === null) return "status-unrecorded";
  return status === BookingStatus.CANCELLED ? "after-cancel" : "counted";
}

export { MANUAL_PAYMENT_NOTE_MAX };
