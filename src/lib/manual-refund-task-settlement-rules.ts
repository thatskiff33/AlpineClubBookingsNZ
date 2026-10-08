import type { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";

import {
  getRemainingRefundableCentsNetOf,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import { sumInternetBankingLateCashCreditCents } from "@/lib/internet-banking-late-cash-credit";

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
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): THE OCCURRENCE-KEY PREFIX of
 * an edit refund hand-back — the task an internet-banking (or cash) price
 * reduction raises so the treasurer sends the money back. One per
 * `BookingModification`, so the key is the duplicate fence and, with the kind,
 * the marker. The one spelling, read by the writer and by every reader below.
 */
export const EDIT_REFUND_HAND_BACK_KEY_PREFIX = "edit-refund-hand-back:";

/** The one occurrence key of one edit's refund hand-back (`INV-PAY-117`). */
export function editRefundHandBackOccurrenceKey(bookingModificationId: string): string {
  return `${EDIT_REFUND_HAND_BACK_KEY_PREFIX}${bookingModificationId}`;
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-118`): THE OCCURRENCE-KEY PREFIX of
 * a refund-request hand-back - the task an approved refund request (appeal)
 * raises for the part of its amount no card refund can carry, so the treasurer
 * sends it by bank transfer. One per `RefundRequest`: the key is the duplicate
 * fence and, with the kind, the marker.
 */
export const REFUND_REQUEST_HAND_BACK_KEY_PREFIX = "refund-request-hand-back:";

/** The one occurrence key of one refund request's hand-back (`INV-PAY-118`). */
export function refundRequestHandBackOccurrenceKey(refundRequestId: string): string {
  return `${REFUND_REQUEST_HAND_BACK_KEY_PREFIX}${refundRequestId}`;
}

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"; #3924 round 4, M2,
 * `INV-PAY-120`): THE OCCURRENCE-KEY PREFIX of the record a "Paid another way"
 * close writes - a card refund Stripe gave up on, which the treasurer paid back
 * by bank transfer instead (`closeCardRefundPaidAnotherWay`). One per
 * `PaymentRecoveryOperation`, so the key is the duplicate fence and, with the
 * kind, the marker. The row is born COMPLETED and never OPEN: it records money
 * already sent, so the booking ledger's hand-back line has a completed task to
 * stand on and the Xero cash evidence can tell it from a card refund.
 */
export const CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX = "card-refund-paid-another-way:";

/** The one occurrence key of one card refund operation's paid-another-way close. */
export function cardRefundPaidAnotherWayOccurrenceKey(paymentRecoveryOperationId: string): string {
  return `${CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX}${paymentRecoveryOperationId}`;
}

/**
 * #3827 (`INV-PAY-117`): the key prefixes of every hand-back that is NOT a
 * cancellation's - money promised back by bank transfer on a decision other
 * than a cancel (an edit's reduction, an approved refund request). The one
 * list the predicate and both query fragments below are built from.
 *
 * #3924 round 4 (M2): also a card refund's paid-another-way close. It is not a
 * cancellation's hand-back in the sense these readers ask - no cancellation
 * raised it, it is never OPEN, and its Xero note (a cancellation's card refund
 * only) is queued by the close itself, not by a hand-back's completion - so
 * the readers that select a cancellation's hand-backs by kind leave it out
 * (the booking repair tool's late-cash evidence, the organisation hand-back's
 * duplicate check), and the readers census polices any new one.
 */
const NON_CANCELLATION_HAND_BACK_KEY_PREFIXES = [
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
  CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX,
] as const;

function hasKeyPrefix(occurrenceKey: string | null, prefix: string): boolean {
  return occurrenceKey?.startsWith(prefix) ?? false;
}

/**
 * #3924 round 4 (M2): IS THIS TASK A CARD REFUND'S PAID-ANOTHER-WAY CLOSE? The
 * kind and the key prefix together, as the other non-cancellation hand-backs
 * are asked. Never `lastError`'s wording: this row is the persisted evidence.
 */
export function isCardRefundPaidAnotherWayTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    task.kind === "CANCELLED_BOOKING_HAND_BACK" &&
    hasKeyPrefix(task.occurrenceKey, CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX)
  );
}

/** The operation a paid-another-way record closed, read off its key; null for any other task. */
export function paymentRecoveryOperationIdOfPaidAnotherWay(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): string | null {
  if (!isCardRefundPaidAnotherWayTask(task) || task.occurrenceKey === null) return null;
  const id = task.occurrenceKey.slice(CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** The same question as a `ManualRefundTask` where fragment: every paid-another-way record. */
export const CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind,
  status: "COMPLETED" satisfies ManualRefundTaskStatus,
  occurrenceKey: { startsWith: CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX },
} as const;

/**
 * #3827 (`INV-PAY-117`): IS THIS TASK AN EDIT REFUND HAND-BACK? It is a
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
 * #3827 (D-3813-8, `INV-PAY-118`): the refund request a refund-request
 * hand-back was raised for, read off its occurrence key - or null for any
 * other task. Its completion queues THAT request's own Xero refund credit
 * note, keyed by the request.
 */
export function refundRequestIdOfHandBack(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): string | null {
  if (!isRefundRequestHandBackTask(task) || task.occurrenceKey === null) return null;
  const id = task.occurrenceKey.slice(REFUND_REQUEST_HAND_BACK_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * #3827 (`INV-PAY-117`): IS THIS HAND-BACK SOMETHING OTHER THAN A
 * CANCELLATION'S - an edit's refund or an approved refund request's? Both are
 * money promised back by bank transfer whose `refundedAmountCents` moves only
 * when the treasurer marks the task paid back, both take `lock(1)` to close,
 * and both are netted from refundable cash while open. On completion an
 * edit's owes Xero nothing (the edit queued its note); a refund request's
 * queues that request's own refund note (D-3813-8,
 * `refundRequestIdOfHandBack`). Every server
 * reader that asks "is this a CANCELLATION's hand-back?" asks this.
 */
export function isNonCancellationHandBackTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return isEditRefundHandBackTask(task) || isRefundRequestHandBackTask(task) || isCardRefundPaidAnotherWayTask(task);
}

/**
 * #3827 (`INV-PAY-117`): AN EDIT REFUND HAND-BACK ON A CANCELLED BOOKING IS
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
 * #3827 (`INV-PAY-117`): the same question as a query fragment, for the server
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
 * #3827 (`INV-PAY-117`): the POSITIVE form - the non-cancellation hand-backs
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
 * #3827 (`INV-PAY-117`): the OPEN non-cancellation hand-backs on a payment, as a
 * relation fragment for a read that loads the payment anyway (the cancel
 * preview). Paired with `sumOpenNonCancellationHandBackCents`
 * and `getRemainingRefundableCentsNetOf`, it gives a reader the same figure the
 * server's `refundableCashNetOfOpenHandBacks` enforces.
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
 * #3827 (`INV-PAY-118`): WHAT A REFUND APPEAL MAY STILL PROMISE. An appeal is
 * sized from the payment's refundable cash, which two other hand-backs leave
 * overstated, so its ceiling subtracts both - and only an appeal's does:
 *
 * - EVERY open hand-back on the payment, of any kind. The edit and earlier
 *   appeals' (as `INV-PAY-117`), and also a CANCELLATION's own - the hand-back
 *   an organisation's late bank transfer raises (#3369), whose money moves
 *   `refundedAmountCents` only when it is paid back. An edit or a cancel sizes
 *   its refund EXCLUDING the cancellation's task, by design: that task is the
 *   cancellation's own refund. An appeal comes after it and must not repeat it.
 * - the member credit already minted from the payment's late cash
 *   (`internet-banking-late-cash-credit.ts`), which never moves
 *   `refundedAmountCents` at all.
 *
 * The relation fragment below is the first half for a read that loads the
 * payment anyway; the booking's `creditsFromCancellation` is the second.
 * `refundableCashForRefundAppeal` is the server's figure; this is the screen's.
 */
export const OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT = {
  where: { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind },
  select: { amountCents: true },
} as const;

/** A screen's refund-appeal ceiling (`INV-PAY-118`), from those two reads. */
export function refundAppealCeiling(
  payment:
    | (BookingPaymentState & { manualRefundTasks?: readonly { amountCents: number | null }[] })
    | null
    | undefined,
  creditsFromCancellation:
    | readonly { amountCents: number; description: string | null; type?: string | null }[]
    | null
    | undefined,
): number {
  return getRemainingRefundableCentsNetOf(
    payment,
    sumOpenNonCancellationHandBackCents(payment?.manualRefundTasks) +
      sumInternetBankingLateCashCreditCents(creditsFromCancellation),
  );
}

/**
 * #3827 (`INV-PAY-117`): the snapshot discriminator on the REFUNDED booking
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

/** The `ManualRefundTask` fields `openHandBackOwedCents` reads. */
export type HandBackTaskRow = {
  status: ManualRefundTaskStatus | string;
  kind: ManualRefundTaskKind | string | null;
  amountCents: number | null;
  partPaymentReviewPaymentId: string | null;
};

const OPEN_TASK_STATUS = "OPEN" satisfies ManualRefundTaskStatus;
const HAND_BACK_KIND = "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind;
const LATE_CAPTURE_KIND = "DELETED_BOOKING_LATE_CAPTURE" satisfies ManualRefundTaskKind;

/**
 * THE REFUND STILL OWED BY HAND: money the club has promised back and not yet
 * paid. Owner decisions on #3372: 3 Oct 2026 for a cancelled booking ("subtract
 * the refund owed"), 7 Oct 2026 for a live one ("subtract it immediately":
 * money promised back isn't the club's). Read through `openTaskOwedCents`,
 * which also answers the late captures below, by `getNetCollectedCashParts`
 * (off a payment's Net Collected straight away) and by the "Refunds owed"
 * figure (`readRefundsAndCreditsOwed`, club-wide until each task is paid).
 *
 * Every task that promises money back by hand is a `CANCELLED_BOOKING_HAND_BACK`:
 * a cancellation's (`booking-cancel.ts`), an edit's refund (`INV-PAY-117`)
 * and an approved refund request's (`INV-PAY-118`), which reuse the kind and
 * are told apart only by their occurrence key
 * (`isNonCancellationHandBackTask`). All of them count, on any booking, so
 * this reads kind and status only, never a key prefix. Only COMPLETING a task
 * writes `refundedAmountCents` (`manual-refund-task-resolution.ts`), so an
 * open one is not yet off the payment and nothing is taken off twice.
 *
 * - OPEN tasks only: a COMPLETED one is already on `refundedAmountCents`, and a
 *   DISMISSED one moved nothing.
 * - A part-payment review shares the kind but carries no amount and records
 *   money settled in Xero (`isPartPaymentReviewTask`), so it owes nothing here.
 * - A task with no kind (`kind` null) counts too. The column was added on
 *   19 Aug 2026 with no backfill. On a booking that is not deleted such a row
 *   is a cancellation's hand-back; on a DELETED booking it is a #2700 late
 *   capture (`isLateCaptureAwaitingDecisionTask`), which `openTaskOwedCents`
 *   takes out before asking this, so no row counts twice.
 * - Not an `EDIT_FINANCIAL_REVIEW`: its amount is a figure an officer has still
 *   to price and confirm, and "nothing is due" is a legitimate close
 *   (DISMISSED), so it is not yet money promised back.
 */
export function openHandBackOwedCents(
  tasks: ReadonlyArray<HandBackTaskRow>,
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

/**
 * #3372 (owner, 7 Oct 2026: "count as owed"): IS THIS A LATE CARD CHARGE
 * AWAITING THE TREASURER'S REFUND-OR-KEEP DECISION? The one home for that
 * question. Such a charge counts in "Refunds owed" until the treasurer keeps
 * it (dismisses the task) or refunds it (completes it).
 *
 * - An OPEN `DELETED_BOOKING_LATE_CAPTURE`: a capture held for a treasurer on a
 *   cancelled booking (#3639, `lateCaptureApprovalIntentId` set,
 *   `INV-PAY-106`), or a change payment captured on a deleted booking (#2700,
 *   `INV-ADDPAY-036`). Both kinds of row ask the same question.
 * - An OPEN task with no kind on a DELETED booking: a #2700 row raised before
 *   the kind column existed. The only task raised on a deleted booking is a
 *   late capture.
 *
 * The capture is recorded on the payment before the task is raised, so its
 * money is inside `amountCents` and Net Collected takes it off while it waits
 * (`getNetCollectedCashParts`); once kept it counts as collected.
 */
export function isLateCaptureAwaitingDecisionTask(
  task: Pick<HandBackTaskRow, "status" | "kind">,
  booking: { deletedAt: Date | null },
): boolean {
  if (task.status !== OPEN_TASK_STATUS) return false;
  if (task.kind === LATE_CAPTURE_KIND) return true;
  return task.kind === null && booking.deletedAt !== null;
}

/**
 * What a booking's open tasks owe back, in two parts that never overlap: late
 * charges awaiting the treasurer (`isLateCaptureAwaitingDecisionTask`) and
 * refunds still owed by hand (`openHandBackOwedCents`, over the rest). Net
 * Collected and "Refunds owed" both read it, so a task is never counted in one
 * part by one figure and the other part by the other.
 */
export function openTaskOwedCents(
  tasks: ReadonlyArray<HandBackTaskRow>,
  booking: { deletedAt: Date | null },
): { handBackCents: number; lateCaptureCents: number } {
  const lateCaptures = tasks.filter((task) => isLateCaptureAwaitingDecisionTask(task, booking));
  return {
    handBackCents: openHandBackOwedCents(
      tasks.filter((task) => !isLateCaptureAwaitingDecisionTask(task, booking)),
    ),
    lateCaptureCents: lateCaptures.reduce(
      (sum, task) => sum + Math.max(0, task.amountCents ?? 0),
      0,
    ),
  };
}
