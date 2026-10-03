import type { ManualRefundTaskKind } from "@prisma/client";

import {
  getRemainingRefundableCentsNetOf,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";

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
 * #3827 (owner decision D-3813-6, `INV-PAY-114`): THE OCCURRENCE-KEY PREFIX of
 * an edit refund hand-back — the task an internet-banking (or cash) price
 * reduction raises so the treasurer sends the money back. One per
 * `BookingModification`, so the key is the duplicate fence and, with the kind,
 * the marker. The one spelling, read by the writer and by every reader below.
 */
export const EDIT_REFUND_HAND_BACK_KEY_PREFIX = "edit-refund-hand-back:";

/** The one occurrence key of one edit's refund hand-back (`INV-PAY-114`). */
export function editRefundHandBackOccurrenceKey(bookingModificationId: string): string {
  return `${EDIT_REFUND_HAND_BACK_KEY_PREFIX}${bookingModificationId}`;
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-114`): THE OCCURRENCE-KEY PREFIX of
 * a refund-request hand-back - the task an approved refund request (appeal)
 * raises for the part of its amount no card refund can carry, so the treasurer
 * sends it by bank transfer. One per `RefundRequest`: the key is the duplicate
 * fence and, with the kind, the marker.
 */
export const REFUND_REQUEST_HAND_BACK_KEY_PREFIX = "refund-request-hand-back:";

/** The one occurrence key of one refund request's hand-back (`INV-PAY-114`). */
export function refundRequestHandBackOccurrenceKey(refundRequestId: string): string {
  return `${REFUND_REQUEST_HAND_BACK_KEY_PREFIX}${refundRequestId}`;
}

/**
 * #3827 (`INV-PAY-114`): the key prefixes of every hand-back that is NOT a
 * cancellation's - money promised back by bank transfer on a decision other
 * than a cancel (an edit's reduction, an approved refund request). The one
 * list the predicate and both query fragments below are built from.
 */
const NON_CANCELLATION_HAND_BACK_KEY_PREFIXES = [
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
] as const;

function hasKeyPrefix(occurrenceKey: string | null, prefix: string): boolean {
  return occurrenceKey?.startsWith(prefix) ?? false;
}

/**
 * #3827 (`INV-PAY-114`): IS THIS TASK AN EDIT REFUND HAND-BACK? It is a
 * `CANCELLED_BOOKING_HAND_BACK` — reused rather than a new label for the reason
 * #3639 and #3643 give: the previous app version cannot read a label it does
 * not know, and lists this kind as money to pay back by hand, which is what it
 * is — marked by its occurrence key, which no cancellation writer sets. So the
 * kind cannot say it; this can. Every server reader that treats a hand-back as
 * a CANCELLATION's (its Xero note, the repair tool's late-cash evidence, the
 * organisation hand-back's duplicate check) asks it here.
 */
export function isEditRefundHandBackTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    task.kind === "CANCELLED_BOOKING_HAND_BACK" &&
    hasKeyPrefix(task.occurrenceKey, EDIT_REFUND_HAND_BACK_KEY_PREFIX)
  );
}

/** #3827 (D-3813-7): is this task an approved refund request's hand-back? */
export function isRefundRequestHandBackTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    task.kind === "CANCELLED_BOOKING_HAND_BACK" &&
    hasKeyPrefix(task.occurrenceKey, REFUND_REQUEST_HAND_BACK_KEY_PREFIX)
  );
}

/**
 * #3827 (`INV-PAY-114`): IS THIS HAND-BACK SOMETHING OTHER THAN A
 * CANCELLATION'S - an edit's refund or an approved refund request's? Both are
 * money promised back by bank transfer whose `refundedAmountCents` moves only
 * when the treasurer marks the task paid back, both take `lock(1)` to close,
 * both are netted from refundable cash while open, and neither owes Xero a
 * second note on completion (the edit or the approval queued it). Every server
 * reader that asks "is this a CANCELLATION's hand-back?" asks this.
 */
export function isNonCancellationHandBackTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return isEditRefundHandBackTask(task) || isRefundRequestHandBackTask(task);
}

/**
 * #3827 (`INV-PAY-114`): AN EDIT REFUND HAND-BACK ON A CANCELLED BOOKING IS
 * SETTLED BY PAYING IT, NEVER BY CHANGING ITS STATE THE OTHER WAY. A paid
 * cancellation sizes its refund and the club's kept figure from the cash net of
 * the edit refunds still OPEN (`refundableCashNetOfOpenHandBacks`): an open
 * one is money the cancellation counted as going back, a dismissed one money it
 * counted as never owed. Dismissing the first, or reopening the second, after
 * the cancel would leave the cancellation's kept figure and ledger lines saying
 * the opposite of what happened - and let a refund appeal re-promise the same
 * money. So both are refused once the booking is cancelled; completing an open
 * one is untouched. One sentence each, for the doors that throw them.
 *
 * NOT a refund-request hand-back (D-3813-7). An appeal exists only on a
 * cancelled booking, so its task is always raised AFTER the cancel, which
 * never counted it; dismissing one (with its required note) releases the cash
 * for a later appeal, and reopening one is capped at the net cash like any.
 */
export const EDIT_REFUND_HAND_BACK_DISMISS_AFTER_CANCEL_MESSAGE =
  "This booking has been cancelled since this edit refund was raised, and the cancellation's refund was worked out on the basis that this money goes back to the member. Send it and mark it paid back. If the club has decided not to pay it, that changes the cancellation's own figures, so take it to the treasurer to correct the cancelled booking rather than dismissing the task here.";

export const EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE =
  "This booking has been cancelled since this edit refund was dismissed, and the cancellation's refund was worked out without it. Putting it back on the queue would promise the member money the cancellation already accounted for. If more is owed, raise it against the cancelled booking, for example as a refund appeal.";

/**
 * #3827 (`INV-PAY-114`): the same question as a query fragment, for the server
 * readers that select a CANCELLATION's hand-backs by kind and must not count an
 * edit's or an approved refund request's. Spread into a `ManualRefundTask`
 * where clause beside the kind.
 */
export const NOT_NON_CANCELLATION_HAND_BACK_WHERE = {
  OR: [
    { occurrenceKey: null },
    {
      AND: NON_CANCELLATION_HAND_BACK_KEY_PREFIXES.map((prefix) => ({
        NOT: { occurrenceKey: { startsWith: prefix } },
      })),
    },
  ],
};

/**
 * #3827 (`INV-PAY-114`): the POSITIVE form - the non-cancellation hand-backs
 * themselves, for a reader that sizes money already promised back by hand
 * (`openNonCancellationHandBackCents`). The kind and the key prefixes together,
 * as `isNonCancellationHandBackTask` asks them.
 */
export const NON_CANCELLATION_HAND_BACK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind,
  OR: NON_CANCELLATION_HAND_BACK_KEY_PREFIXES.map((prefix) => ({
    occurrenceKey: { startsWith: prefix },
  })),
} as const;

/**
 * #3827 (`INV-PAY-114`): the OPEN non-cancellation hand-backs on a payment, as a
 * relation fragment for a read that loads the payment anyway (the booking
 * page, the refund-appeal queue). Paired with `sumOpenNonCancellationHandBackCents`
 * and `getRemainingRefundableCentsNetOf`, it gives a screen the same ceiling
 * the server's `refundableCashNetOfOpenHandBacks` enforces.
 */
export const OPEN_NON_CANCELLATION_HAND_BACKS_SELECT = {
  where: { status: "OPEN", ...NON_CANCELLATION_HAND_BACK_WHERE },
  select: { amountCents: true },
} as const;

/** The money those rows promise back, in cents. Unpriced rows count as zero. */
export function sumOpenNonCancellationHandBackCents(
  tasks: readonly { amountCents: number | null }[] | null | undefined,
): number {
  return (tasks ?? []).reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
}

/**
 * The refund ceiling a screen shows from a payment loaded with that fragment:
 * the remaining refundable cash less those rows (`INV-PAY-114`).
 */
export function refundCeilingNetOfOpenHandBacks(
  payment:
    | (BookingPaymentState & { manualRefundTasks?: readonly { amountCents: number | null }[] })
    | null
    | undefined,
): number {
  return getRemainingRefundableCentsNetOf(
    payment,
    sumOpenNonCancellationHandBackCents(payment?.manualRefundTasks),
  );
}

/**
 * #3827 (`INV-PAY-114`): the snapshot discriminator on the REFUNDED booking
 * event an edit refund hand-back's completion writes. The booking is LIVE when
 * that money goes back, so the event is the settlement of an EDIT, never of a
 * cancellation - and the booking narrative takes the first REFUNDED event as a
 * later cancellation's settlement sentence. It excludes these the way it
 * excludes the #2008 duplicate-capture and #3340 supersede refunds. The
 * event's `reason` stays `manual_refund_completed`, so nothing that reads the
 * reason sees a new value.
 */
export const EDIT_REFUND_HAND_BACK_COMPLETED_EVENT_KIND = "edit_refund_hand_back_completed" as const;

/** The snapshot an edit refund hand-back's completion event carries. */
export function editRefundHandBackCompletedSnapshot(manualRefundTaskId: string): {
  kind: typeof EDIT_REFUND_HAND_BACK_COMPLETED_EVENT_KIND;
  manualRefundTaskId: string;
} {
  return { kind: EDIT_REFUND_HAND_BACK_COMPLETED_EVENT_KIND, manualRefundTaskId };
}

/**
 * #3827 (D-3813-7): the same discriminator for a refund-request hand-back's
 * completion. The booking is already cancelled, but this money is the
 * appeal's, decided after the cancel, so it is not the cancellation's
 * settlement either - a Stripe appeal refund writes no booking event at all.
 */
export const REFUND_REQUEST_HAND_BACK_COMPLETED_EVENT_KIND = "refund_request_hand_back_completed" as const;

/** The snapshot a non-cancellation hand-back's completion event carries. */
export function nonCancellationHandBackCompletedSnapshot(task: {
  id: string;
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): {
  kind: typeof EDIT_REFUND_HAND_BACK_COMPLETED_EVENT_KIND | typeof REFUND_REQUEST_HAND_BACK_COMPLETED_EVENT_KIND;
  manualRefundTaskId: string;
} {
  return isRefundRequestHandBackTask(task)
    ? { kind: REFUND_REQUEST_HAND_BACK_COMPLETED_EVENT_KIND, manualRefundTaskId: task.id }
    : editRefundHandBackCompletedSnapshot(task.id);
}

/** Is this booking event a non-cancellation hand-back's completion? */
export function isNonCancellationHandBackCompletedEvent(event: { type: string; snapshot: unknown }): boolean {
  if (event.type !== "REFUNDED" || typeof event.snapshot !== "object" || event.snapshot === null) {
    return false;
  }
  const kind = (event.snapshot as { kind?: unknown }).kind;
  return (
    kind === EDIT_REFUND_HAND_BACK_COMPLETED_EVENT_KIND ||
    kind === REFUND_REQUEST_HAND_BACK_COMPLETED_EVENT_KIND
  );
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
