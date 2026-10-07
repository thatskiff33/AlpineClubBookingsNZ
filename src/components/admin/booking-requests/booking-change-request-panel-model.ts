/**
 * The locked-period change-request panel's data model: the row the admin list
 * route returns, and one card's un-submitted decision. Split out of
 * `booking-change-requests-panel.tsx` (#3750) so the panel file holds the
 * decision flow and its rendering.
 */
import type { FinishedStaySettlementMethod } from "@/components/admin/booking-requests/booking-change-request-finished-stay";

export interface BookingChangeRequestData {
  id: string;
  bookingId: string;
  requestedByMemberId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  /** The optimistic token the decision is checked against (#3750). */
  version?: number;
  /**
   * #3750: the booking's stay has finished, so approving APPLIES the request
   * (owner decision, 6 Oct 2026) rather than acknowledging it. Answered by the
   * list route from the same rule the decision route uses.
   */
  executesOnApproval?: boolean;
  requestedChanges: {
    requested?: {
      summary?: string | null;
      /** #3750 (owner D1): shown with a link to any member among them. */
      addGuests?: Array<{ firstName: string; lastName: string; memberId?: string | null }>;
    };
    payment?: {
      id?: string;
      amountCents?: number;
      refundedAmountCents?: number;
      status?: string;
      xeroInvoiceId?: string | null;
      xeroInvoiceNumber?: string | null;
    } | null;
  };
  reason: string | null;
  /**
   * MEMBER-VISIBLE (#2562). Rendered to the member verbatim on their booking page
   * under "Change Requests", so the field below is labelled for that audience
   * before a decision is submitted.
   */
  adminNotes: string | null;
  /** The officer's PRIVATE note (#2562) — admin surfaces only, never the member. */
  internalNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  reviewedBy: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  linkedModification: {
    id: string;
    createdAt: string;
    modificationType: string;
    priceDiffCents: number;
    changeFeeCents: number;
  } | null;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
    // #3369: NULLABLE — a school booking has no member, and an officer can
    // raise a locked-period change request on one. Declared non-null here, a
    // hand-written copy of an API shape that was right, it satisfied the
    // compiler while the render threw inside the `.map()`.
    member: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
    organisation: { name: string; email: string | null } | null;
    payment: {
      id: string;
      amountCents: number;
      refundedAmountCents: number;
      status: string;
      xeroInvoiceId: string | null;
      xeroInvoiceNumber: string | null;
    } | null;
  };
}

export function statusBadgeClass(status: BookingChangeRequestData["status"]) {
  if (status === "REQUESTED") return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

/**
 * One request's un-submitted decision, as the officer has typed it so far.
 *
 * A DRAFT PER REQUEST, keyed by request id, and that is the whole design (#2562
 * review). The three fields used to share one state slot with a `reviewingId`
 * marker naming their owner, and every field's onChange moved the marker — so a
 * keystroke in the internal note or the modification id on one row claimed
 * ownership of the OTHER row's half-written member-facing explanation: the second
 * card displayed it, its decision buttons unlocked on it, and submitting posted
 * one member a sentence written about somebody else's request. On this table
 * `adminNotes` is read verbatim by the member on their own booking page, so that
 * was a privacy failure, not a cosmetic one. Keyed state makes the row-isolation
 * invariant structural: there is no shared slot left for a draft to leak through,
 * whichever field is typed in and in whatever order.
 */
export interface DecisionDraft {
  /** The MEMBER-FACING decision explanation (`adminNotes`). */
  adminNotes: string;
  /** The officer's PRIVATE note. Never shown to the member. */
  internalNotes: string;
  linkedModificationId: string;
  /**
   * #3750: where a reduction goes when an executed approval lowers the price
   * and the club's policy offers a choice. "card" is back the way it was paid.
   */
  settlementMethod: FinishedStaySettlementMethod;
}

export const EMPTY_DECISION_DRAFT: DecisionDraft = {
  adminNotes: "",
  internalNotes: "",
  linkedModificationId: "",
  settlementMethod: "",
};
