import type { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";

/**
 * #3213 (epic #2797): WHICH FINANCE-QUEUE ITEMS CAN BE SETTLED AT ALL, and the
 * sentence an officer gets when one cannot.
 *
 * Two layers have to agree about this and they cannot share a module otherwise:
 * `manual-refund-task-resolution.ts` is `server-only`, so the settle screen
 * cannot import the rule from where it is enforced, and a copy written beside
 * the screen would drift from the one the server throws. That is the same split
 * `manual-refund-task-copy.ts` records for the zero refusal - and the reason
 * this is a module of its own rather than another section of that one is that a
 * RULE is not COPY: the screen consults this to decide whether a control exists
 * at all, which is a question about behaviour rather than about words.
 *
 * `INV-SSOT`. Before this, "a withheld share cannot be completed" would have
 * been decided twice - once by the door and once by the card - and the failure
 * mode of that arrangement is not a visible disagreement but a silent one: a
 * card that keeps offering a control the server has started refusing.
 *
 * THE RULE ITSELF HAS ONE HOME AND IT IS NOT THIS FILE. `INV-PAY-051`
 * (`docs/invariants/payment-and-settlement.md`) states why `COMPLETED` is
 * refused on this kind, which is the part a reader needs to understand rather
 * than to call.
 */

/**
 * #3643 (`INV-PAY-107`): IS THIS TASK A PART-PAYMENT REVIEW? The one spelling of
 * that question for every server reader - the resolution door, the audit, the
 * queue payload and the repair loader - so a new door
 * asks it here rather than inventing a sixth test of the marker. A review is a
 * `CANCELLED_BOOKING_HAND_BACK` like any other hand-back, so its kind cannot
 * say it; only the marker can. The browser reads the payload's boolean, which
 * this computes.
 */
export function isPartPaymentReviewTask<
  T extends { partPaymentReviewPaymentId: string | null },
>(task: T): task is T & { partPaymentReviewPaymentId: string } {
  // Present-or-absent, not `!== null`: a row read without the column selected
  // carries undefined, which is no review.
  return Boolean(task.partPaymentReviewPaymentId);
}

/**
 * May a task of this kind be closed as money that moved?
 *
 * FALSE FOR EXACTLY ONE KIND. `UNCOLLECTED_EDIT_REVIEW_SHARE` is a notice that
 * the club may not have ASKED for money, so there is nothing for a settlement to
 * record - and a `COMPLETED` close whose `settlementDirection` is null reads as
 * `REFUND_TO_MEMBER` on every kind older than `EDIT_FINANCIAL_REVIEW`, so
 * completing one would assert a refund the club never made and reach the refund
 * allocation path with an amount that is not a refund at all.
 *
 * TAKES A LOOSE STRING, because the browser's copy of a task's kind is one: a
 * cached client bundle reading a newer row must degrade rather than throw. An
 * unrecognised kind - including a row written before the column existed, which
 * carries null - answers TRUE, so this can only ever CLOSE a door, never open
 * one the server would refuse.
 */
export function manualRefundTaskKindAllowsSettlement(
  kind: ManualRefundTaskKind | string | null | undefined,
  /**
   * #3643: the task is a part-payment review (`partPaymentReviewPaymentId`
   * set). Its kind is the ordinary hand-back one, so the kind alone cannot say
   * it records money the club settles in Xero rather than here; a review is
   * closed by DISMISSED only, and the database refuses a COMPLETED one
   * (`ManualRefundTask_part_payment_review_shape`). `INV-PAY-107`.
   * REQUIRED, never defaulted: a caller that forgot it would be told a review
   * may be settled (`isPartPaymentReviewTask` answers it).
   */
  partPaymentReview: boolean,
): boolean {
  return kind !== "UNCOLLECTED_EDIT_REVIEW_SHARE" && !partPaymentReview;
}

/**
 * The refusal the completion door raises, or null when this close is allowed.
 *
 * ONE CALL RATHER THAN A PREDICATE PLUS A STRING, because the door has to ask
 * both questions together and a caller that asked only one would either refuse
 * a dismissal or complete a withheld share. Answering `null` for every
 * dismissal is part of the rule, not a caller's business: DISMISSED is how one
 * of these items IS closed.
 *
 * IT NAMES THE WAY OUT, which is what the owner's 31 Aug 2026 decision on the
 * zero refusal asks of every refusal on this screen. Here the way out is the
 * whole job: check Xero, bill only what is missing, then close the item.
 */
export function manualRefundTaskSettlementRefusal(
  kind: ManualRefundTaskKind | string | null | undefined,
  resolution: "completed" | "dismissed",
  /** #3643: required, as on `manualRefundTaskKindAllowsSettlement`. */
  partPaymentReview: boolean,
): string | null {
  if (resolution !== "completed") return null;
  if (manualRefundTaskKindAllowsSettlement(kind, partPaymentReview)) return null;
  if (partPaymentReview) {
    return "This item records a payment the club settles in Xero, so it cannot be closed as an amount settled here - nothing about it moves money. Settle the payment in Xero (refund it or apply it), clear what the invoice still owes, then close this item with a note saying what you did.";
  }
  return "This item records money the club may not have asked for, so it cannot be closed as an amount settled here - nothing about it moves money. Check the booking's Xero invoices, bill any shortfall by hand, then close it with a note saying what you found and what you billed.";
}

/** The `ManualRefundTask` fields `openCancellationHandBackOwedCents` reads. */
export type CancellationHandBackTaskRow = {
  status: ManualRefundTaskStatus | string;
  kind: ManualRefundTaskKind | string | null;
  amountCents: number | null;
  partPaymentReviewPaymentId: string | null;
};

const OPEN_TASK_STATUS = "OPEN" satisfies ManualRefundTaskStatus;
const HAND_BACK_KIND = "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind;

/**
 * Owner decision on #3372 (3 Oct 2026, refining the review on PR #3811): THE
 * REFUND A CANCELLED BOOKING STILL OWES BY HAND. It reads a cancelled
 * booking's OPEN hand-back tasks; the caller (`getNetCollectedPaymentParts`)
 * hands it only a cancelled booking's tasks, and only a booking that is not
 * soft-deleted reaches it (the Net Collected scope).
 *
 * A cancellation of a payment settled by hand raises a
 * `CANCELLED_BOOKING_HAND_BACK` task for the refund its policy gives back
 * (`booking-cancel.ts`), and only COMPLETING the task writes
 * `refundedAmountCents` (`manual-refund-task-resolution.ts`). The owner's rule
 * is that the refund owed is treated as gone straight away, so a "Net
 * Collected" figure counts only what the policy keeps: this is the amount to
 * take off before the task is completed.
 *
 * - OPEN tasks only: a COMPLETED one is already on `refundedAmountCents`, and a
 *   DISMISSED one moved nothing.
 * - A part-payment review shares the kind but carries no amount and records
 *   money settled in Xero (`isPartPaymentReviewTask`), so it owes nothing here.
 * - A task with no kind (`kind` null) is read as a hand-back: the column was
 *   added on 19 Aug 2026 with no backfill, and on a cancelled booking the only
 *   task raised before then was the cancellation's hand-back (the late-capture
 *   kinds are raised on DELETED bookings, which the scope leaves out).
 * - Every OPEN task of the hand-back kind counts, whatever raised it. A booking
 *   edit's or an appeal's hand-back on a CANCELLED booking is counted on
 *   purpose: it is money the club owes back, so it is not money kept.
 */
export function openCancellationHandBackOwedCents(
  tasks: ReadonlyArray<CancellationHandBackTaskRow>,
): number {
  return tasks
    .filter(
      (task) =>
        task.status === OPEN_TASK_STATUS &&
        (task.kind === HAND_BACK_KIND || task.kind === null) &&
        !isPartPaymentReviewTask(task),
    )
    .reduce((sum, task) => sum + Math.max(0, task.amountCents ?? 0), 0);
}
