import "server-only";

import { ManualRefundTaskStatus, Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog } from "@/lib/audit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  normaliseManualPaymentNote,
} from "@/lib/manual-subscription-payment";
import { prisma } from "@/lib/prisma";

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
 * money has gone, down one of three settlement routes, against an anchor that
 * enforces exactly-once. `MemberCredit.sourceBookingModificationId` is `@unique`
 * and the Stripe refund idempotency key is derived from the same
 * `bookingModificationId`, so a second settlement against the same anchor is
 * refused by the database rather than by this module - but it would be refused
 * AFTER an officer had priced it a second time, in front of a screen that had
 * invited them to. Reopening a completion is therefore refused here, by status,
 * before anything is claimed.
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
 * It takes NO ADVISORY LOCK, matching the closure path it mirrors
 * (`manual-refund-task-resolution.ts`, and `docs/CONCURRENCY_AND_LOCKING.md`
 * records that as deliberate). The status-fenced `updateMany` is the whole
 * single-flight guarantee: two officers pressing at once means one claim lands
 * and the other is told the row moved.
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

export const REOPEN_RACED_MESSAGE =
  "This item changed while you were putting it back — refresh and try again.";

/** How far back the finance queue offers a dismissal for reopening. */
export const REOPENABLE_DISMISSAL_WINDOW_DAYS = 30;

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

  return prisma.$transaction(async (tx) => {
    const task = await tx.manualRefundTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        bookingId: true,
        kind: true,
        status: true,
        amountCents: true,
        raisedAmountCents: true,
        note: true,
        completedAt: true,
        completedByMemberId: true,
        booking: { select: { memberId: true, organisation: { select: { name: true, email: true } } } },
      },
    });
    if (!task) {
      throw new ManualBookingPaymentError("Refund task not found.", 404);
    }
    if (task.status === ManualRefundTaskStatus.OPEN) {
      throw new ManualBookingPaymentError(REOPEN_ALREADY_OPEN_MESSAGE, 409);
    }
    if (task.status !== ManualRefundTaskStatus.DISMISSED) {
      throw new ManualBookingPaymentError(REOPEN_ONLY_DISMISSED_MESSAGE, 409);
    }
    if (task.completedByMemberId === null) {
      throw new ManualBookingPaymentError(
        REOPEN_ONLY_OFFICER_DISMISSAL_MESSAGE,
        409,
      );
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

    await createAuditLog(
      {
        action: "booking-payment.manual-refund-task.reopen",
        memberId: actingMemberId,
        actorMemberId: actingMemberId,
        subjectMemberId: bookingOwner(task.booking).memberId,
        targetId: task.bookingId,
        entityType: "ManualRefundTask",
        entityId: task.id,
        category: "payment",
        // The same severity as the closure it undoes: it moves no money itself,
        // and it puts a money question back in front of the club.
        severity: "important",
        outcome: "success",
        summary: "Dismissed booking money task put back on the queue",
        details: trimmedNote,
        metadata: {
          taskId: task.id,
          bookingId: task.bookingId,
          kind: task.kind,
          amountCents: task.amountCents,
          raisedAmountCents: task.raisedAmountCents,
          // WHOSE decision was undone, and when they took it. Cleared from the
          // row by the claim above, so this entry is the only place either
          // survives - which is the whole reason they are recorded here.
          dismissedByMemberId: task.completedByMemberId,
          dismissedAt: task.completedAt?.toISOString() ?? null,
          dismissalNote: task.note,
        },
      },
      tx,
    );

    return {
      taskId: task.id,
      bookingId: task.bookingId,
      kind: task.kind,
      status: ManualRefundTaskStatus.OPEN,
    };
  });
}

export { MANUAL_PAYMENT_NOTE_MAX };
export type ReopenedManualRefundTask = Prisma.PromiseReturnType<
  typeof reopenManualRefundTask
>;
