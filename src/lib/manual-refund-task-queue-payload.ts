import {
  parseEditFinancialReviewContext,
  toEditFinancialReviewEvidence,
  type EditFinancialReviewEvidence,
} from "@/lib/edit-financial-review-context";
import type { UnpricedNightsSummary } from "@/lib/stored-night-price-repair";

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
  member: { firstName: string; lastName: string };
};

/** An OPEN row the operator has to settle by hand. */
export type OpenManualRefundTaskRow = {
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
  reviewContext: unknown;
  reason: string;
  createdAt: Date;
  booking: QueueBookingSummary & {
    /** #3033: who owns the booking, for the ownership half of the link grant. */
    memberId: string;
    deletedAt: Date | null;
  };
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
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  viewerOwnsBooking: boolean;
  reviewEvidence: EditFinancialReviewEvidence | null;
  reviewEvidenceUnreadable: boolean;
  /**
   * #3191: the nights on this review's guest whose stored price is blank, and
   * the two totals the officer's figures have to reconcile against. NULL when
   * there is nothing this screen can repair, which is most rows.
   *
   * READ LIVE by the route rather than taken from the stored context, and the
   * difference matters: the context records the evidence as it stood BEFORE the
   * edit, while a blank is something the edit left behind. Showing the first as
   * if it were the second would ask an officer to price nights that are no
   * longer there.
   */
  unpricedNights: UnpricedNightsSummary | null;
};

function memberName(booking: QueueBookingSummary): string {
  return `${booking.member.firstName} ${booking.member.lastName}`;
}

/**
 * One OPEN row, as the queue card receives it.
 *
 * THE STORED CONTEXT IS PARSED HERE AND THE RAW COLUMN NEVER CROSSES THE WIRE.
 *
 * Two things fall out of that and both are deliberate. The parser returns NULL
 * rather than throwing on a row it cannot read (#3030), so an unreadable blob
 * costs the card its captured evidence and nothing else — the task, its amount
 * and the booking are still shown. And parsing on the server is what lets
 * `toEditFinancialReviewEvidence` do the redaction: the guest's member id and
 * the guest-strand id have no field in the shape the browser receives, so no
 * amount of forgetting can put them there.
 *
 * @param viewerMemberId the signed-in admin's member id — `session.user.id`,
 *   which is what the booking page's own `isBookingOwner` compares against.
 * @param unpricedNights #3191: this row's blank night prices, already read and
 *   projected by the route. Passed in rather than looked up here because it is a
 *   live database read and this module is a pure projection — and because the
 *   route reads them for the whole page in one query.
 */
export function toOpenManualRefundTaskPayload(
  task: OpenManualRefundTaskRow,
  viewerMemberId: string | null | undefined,
  unpricedNights: UnpricedNightsSummary | null,
): OpenManualRefundTaskPayload {
  const reviewContext = parseEditFinancialReviewContext(task.reviewContext);

  return {
    id: task.id,
    bookingId: task.bookingId,
    amountCents: task.amountCents,
    raisedAmountCents: task.raisedAmountCents,
    kind: task.kind,
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
      task.booking.memberId === viewerMemberId,
    reviewEvidence: reviewContext
      ? toEditFinancialReviewEvidence(reviewContext)
      : null,
    /*
      The row HAS captured evidence this release cannot read, as distinct from
      never having had any. The card says so in a line of its own: an admin
      pricing a refund needs to know that the one record of what the edit
      destroyed is unreadable, rather than silently see a task with no evidence
      section and assume none was ever taken.
    */
    reviewEvidenceUnreadable: task.reviewContext !== null && !reviewContext,
    unpricedNights,
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
