import { bookingOwner } from "@/lib/booking-owner";
import {
  cancelCardShortfallPart,
  isEditRefundHandBackTask,
  isPartPaymentReviewTask,
  isRefundRequestHandBackTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import { isGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back-rules";
import { journalHandBackDismissal, NO_HAND_BACK_DISPUTES, type HandBackDisputeContext } from "@/lib/manual-refund-task-hand-back-journal";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { isGroupSettlementMirrorHandBackKind } from "@/lib/group-settlement-mirror-kinds";
import { readBankRefundVoidFollowUpContext } from "@/lib/bank-refund-void-follow-up-copy";

/**
 * What the finance settlement queue's loader sends to the browser, and the one
 * place either of its two lists is shaped.
 *
 * Lifted out of `GET /api/admin/payments/manual-refund-tasks` when #3033 pushed
 * that route past its 250-line budget. The seam is a real one rather than a
 * line-count dodge: this is the projection between a database row and an admin
 * screen — including the redaction below, which is the security-relevant half of
 * the whole route — and the route around it is now the handler it was supposed
 * to be: guard, permissions, two queries, respond.
 *
 * The input types are structural, naming only the fields the mappers read. That
 * keeps this module free of Prisma's generated payload types while still failing
 * to compile if the route narrows its `select`.
 */

/** The booking fields both lists read. */
type QueueBookingSummary = {
  checkIn: Date;
  checkOut: Date;
  member: { firstName: string; lastName: string } | null;
  /** #3369: the owner may be an Organisation; `bookingOwner()` reads both. */
  organisation: { name: string; email: string | null } | null;
};

/**
 * #3949: what `paidByOrganiserInternetBanking` reads of an OPEN row's booking,
 * selected by the route so the card can say a refund goes back to the group
 * organiser rather than to the joiner.
 */
export const OPEN_TASK_BOOKING_PAYMENT_SELECT = {
  organiserSettled: true,
  parentBookingId: true,
  payment: { select: { source: true } },
} as const;

/** An OPEN row the operator has to settle by hand. */
export type OpenManualRefundTaskRow = {
  /** #4516: match disputes to this task’s payment. */
  paymentId: string | null;
  id: string;
  bookingId: string;
  amountCents: number | null;
  raisedAmountCents: number | null;
  /**
   * Nullable in the schema: every row written before #3030 added the column has
   * none, and the card treats an absent kind as the hand-back it has always
   * been. Passed through as-is rather than defaulted here, so the one place that
   * decides what an absent kind MEANS stays the card.
   */
  kind: string | null;
  /** #3639: set on a late capture held for a treasurer's approval. */
  lateCaptureApprovalIntentId: string | null;
  /** #3643: set on a part-payment review, settled in Xero rather than here. */
  partPaymentReviewPaymentId: string | null;
  /** #3827 (`INV-PAY-117`): an edit refund hand-back's marker (with the kind). */
  occurrenceKey: string | null;
  /** #3643 (`INV-PAY-108`): the inbound sync's note that Xero reported the invoice paid. */
  partPaymentReviewXeroPaidAt: Date | null;
  partPaymentReviewXeroPaidCents: number | null;
  /** #4042/#4162: a group hand-back's or a re-confirmed bank refund's own context. */
  reviewContext: unknown;
  reason: string;
  createdAt: Date;
  booking: QueueBookingSummary & {
    /** #3949: `OPEN_TASK_BOOKING_PAYMENT_SELECT` - whether the group organiser paid for it. */
    organiserSettled: boolean;
    parentBookingId: string | null;
    payment: { source: string } | null;
    /**
     * #3033: who owns the booking, for the ownership half of the link grant.
     * Null since #3369 when the owner is an `Organisation`, which never signs
     * in — so the ownership half simply does not grant, which is what it did
     * for the invented school member too.
     */
    memberId: string | null;
    deletedAt: Date | null;
  };
};

/**
 * A DISMISSED row an officer closed and could put back (#3498, owner decision
 * D2).
 *
 * Officer-closed only, which is the same fence `reopenManualRefundTask` applies
 * and is applied in the query rather than on the card: a machine-written
 * dismissal is a record of a refund Stripe already made, and offering a
 * **Put back on the queue** button beside one would invite a second refund of
 * the same capture.
 */
export type DismissedManualRefundTaskRow = {
  id: string;
  bookingId: string;
  amountCents: number | null;
  kind: string | null;
  reason: string;
  note: string | null;
  completedAt: Date | null;
  booking: QueueBookingSummary & { deletedAt: Date | null };
};

/** A row the Stripe webhook already refunded and closed (#2750, #2760). */
export type AutoRefundedManualRefundTaskRow = {
  id: string;
  bookingId: string;
  amountCents: number | null;
  reason: string;
  note: string | null;
  completedAt: Date | null;
  booking: QueueBookingSummary & { deletedAt: Date | null };
};

export type OpenManualRefundTaskPayload = {
  id: string;
  bookingId: string;
  amountCents: number | null;
  raisedAmountCents: number | null;
  kind: string | null;
  /**
   * #3639: a late capture held for a treasurer: completing it refunds the card
   * through Stripe, so none of the hand-back wording fits it.
   */
  awaitingLateCaptureApproval: boolean;
  /**
   * #3643: a payment recorded against an invoice an officer cancelled as
   * unpaid, which the club settles in Xero. It has no amount and closes only by
   * dismissal, so none of the hand-back wording fits it either.
   */
  partPaymentReview: boolean;
  /**
   * #3827 (owner decision D-3813-6, `INV-PAY-117`): an edit lowered the price
   * of a booking paid by internet banking or by hand, and the club refunds the
   * difference by bank transfer. A hand-back like any other, but of a LIVE
   * booking, so the cancelled-booking sentence does not fit it.
   */
  editRefundHandBack: boolean;
  /**
   * #3827 (owner decision D-3813-7, `INV-PAY-118`): an approved refund appeal
   * on a booking not paid by card, which the club refunds by bank transfer.
   * The booking was cancelled before the appeal, but the money is the
   * appeal's, so neither the cancellation nor the edit sentence fits it.
   */
  refundRequestHandBack: boolean;
  /**
   * #3949 (`INV-PAY-137`): either of those two, or the joiner's own cancellation's
   * hand-back (`isGroupSettlementMirrorHandBackKind`), on a joiner's booking the
   * group organiser paid for by Internet Banking, so the money goes back to the
   * ORGANISER (`paidByOrganiserInternetBanking`), never to the joiner.
   */
  paidToGroupOrganiser: boolean;
  /**
   * #4042 (`INV-PAY-124`): an organiser cancelled a group paid by Internet
   * Banking, and the club repays the joiners' refunds to the organiser. The
   * cancel already booked those refunds, so the cash sentence does not fit it.
   */
  groupOrganiserHandBack: boolean;
  /**
   * #4516 (owner decisions, 14 and 15 Nov 2026): why the server refuses this journal hand-back's dismissal, in its
   * own words, or null. A part to check keeps Dismiss; a disputed card payment's hand-back keeps it once its dispute
   * is lost (`journalHandBackDismissal`, the server's rule).
   */
  journalHandBackDismissRefusal: string | null;
  /** That disputed card payment's hand-back, now dismissible because its dispute is lost: its dialog says so. */
  disputedHandBackLost: boolean;
  /**
   * #4516 (owner decision, 15 Nov 2026, comment 6893252570): its disputes lost for part of what is still owed: the
   * reduction the officer may make (the server's own rule), or null.
   */
  disputeReduction: { reducedByCents: number; stillOwedCents: number } | null;
  /** #4516 (owner decision, 18 Nov 2026): the server's refusal of Mark paid (a lost dispute it may take), or null. Set, the row offers no Mark paid. */
  markPaidRefusal: string | null;
  /**
   * #4097 (`INV-PAY-129`): a card cancellation whose card refund carried less
   * than the refund due. `cardShortfallHandBack`: the part the payment's
   * non-card charges hold, refunded by bank transfer. `cardShortfallCheck`: the
   * rest, which the payment's records show already refunded or nothing holds,
   * checked before paying. The booking was paid by card, so the cash sentence
   * fits neither.
   */
  cardShortfallHandBack: boolean;
  cardShortfallCheck: boolean;
  /**
   * #4162 (`INV-ADDPAY-042`): a bank refund back on the list because Xero
   * voided the credit note that recorded it. The card asks one question - has
   * the money gone to the member? - and completes only on one of its two
   * answers. Null on every other task.
   */
  bankRefundVoidFollowUp: { voidedCreditNoteNumber: string | null; voidedAt: string } | null;
  /**
   * #3643 (`INV-PAY-108`, ORCHESTRATOR DECISION 3): on a part-payment review, when the inbound
   * Xero sync learned the invoice was reported PAID and the invoice's cash then.
   * Nothing was credited or handed back for it; the treasurer decides. The
   * card prints it, because this - not the best-effort email - is the record.
   */
  partPaymentReviewXeroPaid: { reportedAt: string; cashCents: number } | null;
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  viewerOwnsBooking: boolean;
};

function memberName(booking: QueueBookingSummary): string {
  return `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`;
}

/**
 * One OPEN row, as the queue card receives it.
 *
 * THE STORED CONTEXT NEVER CROSSES THE WIRE. A group organiser's hand-back and
 * a re-confirmed bank refund keep their own context in the shared column; only
 * the void's two facts are read out of it, and nothing else is sent.
 *
 * NO REVIEW EVIDENCE SINCE #4344. The officer edit review is retired and the
 * route no longer lists one, so the redacted evidence, the removed-guest
 * warning and the unpriced nights the settle screen read went with that screen.
 *
 * @param viewerMemberId the signed-in admin's member id — `session.user.id`,
 *   which is what the booking page's own `isBookingOwner` compares against.
 */
/**
 * Every open task's payload, in the queue's order: each with its
 * booking's card disputes (#4516, keyed by booking, for the dismissal rule).
 */
export function toOpenManualRefundTaskPayloads(
  tasks: readonly OpenManualRefundTaskRow[],
  viewerMemberId: string | null | undefined,
  disputes: ReadonlyMap<string, HandBackDisputeContext>,
): OpenManualRefundTaskPayload[] {
  return tasks.map((task) => toOpenManualRefundTaskPayload(task, viewerMemberId, disputes.get(task.bookingId) ?? NO_HAND_BACK_DISPUTES));
}

export function toOpenManualRefundTaskPayload(
  task: OpenManualRefundTaskRow,
  viewerMemberId: string | null | undefined,
  /** #4516: the card disputes on the task's booking and the tasks on their payments (`readOpenTaskDisputes`), for the dismissal rule. */
  disputes: HandBackDisputeContext = NO_HAND_BACK_DISPUTES,
): OpenManualRefundTaskPayload {
  const dismissal = journalHandBackDismissal({ ...task, status: "OPEN" }, disputes);
  // #4042: a group organiser's hand-back keeps its joiners' shares there, not review evidence.
  const groupHandBack = isGroupOrganiserHandBackTask(task);
  // #4162: a re-confirmed bank refund keeps its void's facts there.
  const followUp = isBankRefundVoidFollowUpTask(task) ? readBankRefundVoidFollowUpContext(task.reviewContext) : null;

  return {
    id: task.id,
    bookingId: task.bookingId,
    amountCents: task.amountCents,
    raisedAmountCents: task.raisedAmountCents,
    kind: task.kind,
    awaitingLateCaptureApproval: task.lateCaptureApprovalIntentId !== null,
    partPaymentReview: isPartPaymentReviewTask(task),
    editRefundHandBack: isEditRefundHandBackTask(task),
    refundRequestHandBack: isRefundRequestHandBackTask(task),
    paidToGroupOrganiser:
      isGroupSettlementMirrorHandBackKind(task) && paidByOrganiserInternetBanking(task.booking),
    groupOrganiserHandBack: groupHandBack,
    // Waiting on an open dispute with a loss already taken: that sentence says both what to wait for and why not to pay.
    journalHandBackDismissRefusal: dismissal.refusal && dismissal.markPaidRefusal && dismissal.unappliedLostCents > 0 && !dismissal.reduction ? dismissal.markPaidRefusal : dismissal.refusal,
    markPaidRefusal: dismissal.markPaidRefusal,
    disputedHandBackLost: dismissal.disputeLost,
    disputeReduction: dismissal.reduction && task.amountCents !== null
      ? { reducedByCents: dismissal.reduction.cents, stillOwedCents: task.amountCents - dismissal.reduction.cents } : null,
    cardShortfallHandBack: cancelCardShortfallPart(task) === "bank",
    cardShortfallCheck: cancelCardShortfallPart(task) === "check",
    bankRefundVoidFollowUp: followUp
      ? { voidedCreditNoteNumber: followUp.voidedCreditNoteNumber, voidedAt: followUp.voidedAt }
      : null,
    partPaymentReviewXeroPaid:
      isPartPaymentReviewTask(task) &&
      task.partPaymentReviewXeroPaidAt &&
      task.partPaymentReviewXeroPaidCents !== null
        ? {
            reportedAt: task.partPaymentReviewXeroPaidAt.toISOString(),
            cashCents: task.partPaymentReviewXeroPaidCents,
          }
        : null,
    reason: task.reason,
    createdAt: task.createdAt.toISOString(),
    memberName: memberName(task.booking),
    checkIn: task.booking.checkIn.toISOString(),
    checkOut: task.booking.checkOut.toISOString(),
    /*
      #3033. The route's `viewerCanViewBookings` answers "may this admin open
      ANYBODY's booking". That is not the only way somebody reaches
      `/bookings/{id}`: the page admits the booking's own member
      (`isBookingOwner`, compared against `session.user.id`, which is the member
      id), so a finance-only admin whose own booking is sitting in this queue was
      being shown an identifier for a page they can open.

      Answered per row, because ownership is. Deleted bookings are excluded
      because that page 404s for a non-admin even when they own it, and offering
      a link into a 404 is the dead end the identifier exists to avoid. Both
      halves default false, so a row that establishes neither still gets the
      identifier — including one whose viewer id is absent entirely.
    */
    viewerOwnsBooking:
      viewerMemberId != null &&
      task.booking.deletedAt === null &&
      bookingOwner(task.booking).memberId === viewerMemberId,
  };
}

/**
 * One dismissed row as the reopen card receives it.
 *
 * EXPORTED so the card imports it instead of respelling it (`INV-SSOT`,
 * #3498 fix round). The two spellings had already drifted: `bookingDeleted` is
 * written unconditionally here and was optional on the card, so a field lost in
 * transit read as "not deleted" on a card whose whole job is judging whether a
 * closure was right.
 */
export type DismissedManualRefundTaskPayload = {
  id: string;
  bookingId: string;
  amountCents: number | null;
  kind: string | null;
  reason: string;
  note: string | null;
  dismissedAt: string | null;
  bookingDeleted: boolean;
  memberName: string;
  checkIn: string;
  checkOut: string;
};

export function toDismissedManualRefundTaskPayload(
  task: DismissedManualRefundTaskRow,
): DismissedManualRefundTaskPayload {
  return {
    id: task.id,
    bookingId: task.bookingId,
    amountCents: task.amountCents,
    kind: task.kind,
    reason: task.reason,
    note: task.note,
    dismissedAt: task.completedAt ? task.completedAt.toISOString() : null,
    bookingDeleted: task.booking.deletedAt !== null,
    memberName: memberName(task.booking),
    checkIn: task.booking.checkIn.toISOString(),
    checkOut: task.booking.checkOut.toISOString(),
  };
}

/** One already-refunded row, as the read-only record card receives it. */
export function toAutoRefundedManualRefundTaskPayload(
  task: AutoRefundedManualRefundTaskRow,
) {
  return {
    id: task.id,
    bookingId: task.bookingId,
    amountCents: task.amountCents,
    reason: task.reason,
    note: task.note,
    // `completedAt` is nullable in the schema but never null on a row this
    // filter matched — the writer sets it in the same statement as the status,
    // on both the close arm and the #2760 create. Answered as null rather than
    // coerced, so the surface renders a row whose date it cannot state instead
    // of inventing one.
    refundedAt: task.completedAt ? task.completedAt.toISOString() : null,
    // #2760: which group the card puts this row in. A boolean, not the date: the
    // card needs "is this booking still there?" and nothing more.
    bookingDeleted: task.booking.deletedAt !== null,
    memberName: memberName(task.booking),
    checkIn: task.booking.checkIn.toISOString(),
    checkOut: task.booking.checkOut.toISOString(),
  };
}
