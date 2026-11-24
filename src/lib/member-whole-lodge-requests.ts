/**
 * "My requests" — the member-facing view of their own whole-lodge booking
 * requests (#2263, D3).
 *
 * This module is the ONE place a `BookingRequest` row is reduced to something a
 * member may see, and it exists as a separate module (rather than a mapper
 * buried in the page) so the reduction is testable in isolation and cannot drift
 * per-surface.
 *
 * Two rules it enforces, both privacy rules rather than presentation ones:
 *
 *  1. STRICT ALLOWLIST. The DTO names every field it carries. It never spreads a
 *     request row, so a column added to `BookingRequest` tomorrow cannot arrive
 *     on a member's screen by accident. `declineReason`, `responseMessage`,
 *     conflict data, hold state, admin identities, prices and internal ids are
 *     all absent by construction.
 *
 *  2. VALUE-LEVEL STATUS MAPPING. The member sees exactly one of four words. The
 *     raw pipeline statuses — `PRICED`, `QUOTED`, `QUOTE_SENT`,
 *     `QUERY_PENDING`, `MODIFICATION_REQUESTED` — are an ADMIN-ACTIVITY ORACLE:
 *     "an officer has started pricing your dates" is information about what the
 *     club is doing behind the queue, and on a whole-lodge request it edges
 *     toward information about the calendar. The mapping is exhaustive over the
 *     enum (the `never` check below fails the build if a status is added and not
 *     classified), so a new status cannot default into visibility.
 */
import { BookingRequestStatus } from "@prisma/client";
import { formatDateOnly } from "@/lib/date-only";

/**
 * The non-terminal statuses that count against the open-request cap and that a
 * member may withdraw from (owner decision D3, #2263). Deliberately the same
 * list for both, so the cap can never count a row the member has no way to
 * clear.
 *
 * `NEW` is absent because a member request never enters there (it is created
 * already `VERIFIED` — the requester is signed in, so there is nothing to
 * verify); the quote-lifecycle states are present only because the shared
 * pipeline can technically reach them, and the service-layer rejections in
 * booking-request-quotes.ts keep a member-origin row out of all of them.
 *
 * It lives in THIS module, not in booking-request.ts, for one reason: the
 * withdraw affordance (`canWithdraw` below) must be derived from the very list
 * the service's WHERE clause uses, and this module is dependency-free (no
 * prisma, no email) so both the DTO and the service can read it. Deriving the
 * button from a *restatement* of the rule is what let `NEW`/`ACCEPTED` render a
 * Withdraw button the API then answered with a 409.
 */
export const MEMBER_WHOLE_LODGE_OPEN_STATUSES = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

const MEMBER_WHOLE_LODGE_OPEN_STATUS_SET = new Set<BookingRequestStatus>(
  MEMBER_WHOLE_LODGE_OPEN_STATUSES,
);

/**
 * Exactly the rows the withdraw service will accept: the same status list its
 * guarded claim names. Not "status reads as pending" — `NEW` and `ACCEPTED` both
 * map to the word "pending" for the member and are NOT withdrawable.
 */
export function isMemberWholeLodgeRequestOpen(
  status: BookingRequestStatus,
): boolean {
  return MEMBER_WHOLE_LODGE_OPEN_STATUS_SET.has(status);
}

/**
 * How many of their own requests a member is shown, newest first. Bounded
 * history: declined and withdrawn rows purge on the 90-day retention clock
 * anyway (owner decision OD-B), and the list is a sidebar to My bookings, not
 * an archive.
 */
export const MY_WHOLE_LODGE_REQUEST_LIMIT = 20;

/** The four words a member may see. Nothing else is ever rendered. */
export const MY_WHOLE_LODGE_REQUEST_STATUSES = ["pending", "approved", "declined", "withdrawn"] as const;

export type MyWholeLodgeRequestStatus = (typeof MY_WHOLE_LODGE_REQUEST_STATUSES)[number];

export type MyWholeLodgeRequestItem = {
  id: string;
  /** YYYY-MM-DD (NZ date-only lodge nights). */
  checkIn: string;
  checkOut: string;
  /**
   * The party size on the request row. That is the approximate number the member
   * submitted right up until an officer approves it — the approval writes the
   * headcount it actually priced and booked back onto the row (which may be the
   * officer's override), so on an approved request this is the BOOKED number,
   * not the original guess.
   */
  headcount: number;
  status: MyWholeLodgeRequestStatus;
  /** ISO timestamp of submission, for ordering and the "sent on" line. */
  createdAt: string;
  /**
   * The approved booking, when there is one — the member's link through to the
   * real thing. Null on every other status.
   */
  bookingId: string | null;
  /** Whether the withdraw affordance is offered for this row. */
  canWithdraw: boolean;
};

/**
 * Map an internal status onto the member-visible one. Exhaustive: the `never`
 * assignment at the end is a compile-time proof that every enum member is
 * classified.
 */
export function toMyWholeLodgeRequestStatus(
  status: BookingRequestStatus
): MyWholeLodgeRequestStatus {
  switch (status) {
    // Still with the booking officer. Every intermediate pipeline state
    // collapses to the same word: a member learns that a decision has not been
    // made, and nothing about how far along it is.
    case BookingRequestStatus.NEW:
    case BookingRequestStatus.VERIFIED:
    case BookingRequestStatus.PRICED:
    case BookingRequestStatus.QUOTED:
    case BookingRequestStatus.QUOTE_SENT:
    case BookingRequestStatus.QUERY_PENDING:
    case BookingRequestStatus.MODIFICATION_REQUESTED:
    // ACCEPTED is the quote-lifecycle state a requester reaches by accepting a
    // quote. A member whole-lodge request can never get there — the quote ops
    // are refused for it at the service layer — but it is classified anyway,
    // and as "pending": acceptance is not the club's decision, and the officer
    // still has to approve. Mapping it to "approved" would tell a member their
    // whole-lodge stay was confirmed when no booking exists.
    case BookingRequestStatus.ACCEPTED:
      return "pending";
    // APPROVED is the moment before the booking row commits; CONVERTED is after.
    // Both read as "approved" — the member is not shown the seam.
    case BookingRequestStatus.APPROVED:
    case BookingRequestStatus.CONVERTED:
      return "approved";
    case BookingRequestStatus.DECLINED:
      return "declined";
    // The member's own withdrawal.
    case BookingRequestStatus.CANCELLED:
      return "withdrawn";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Reduce a request row to the member DTO. The input type is deliberately a
 * narrow structural shape, not `BookingRequest`: a caller cannot satisfy it by
 * handing over the whole row and hoping the mapper is careful.
 */
export function toMyWholeLodgeRequestItem(request: {
  id: string;
  status: BookingRequestStatus;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
  convertedBookingId: string | null;
  heldBookingId: string | null;
  guestCount: number;
}): MyWholeLodgeRequestItem {
  const status = toMyWholeLodgeRequestStatus(request.status);
  return {
    id: request.id,
    checkIn: toDateOnly(request.checkIn),
    checkOut: toDateOnly(request.checkOut),
    headcount: request.guestCount,
    status,
    createdAt: request.createdAt.toISOString(),
    // Only an actually-converted request has a booking to open. An APPROVED row
    // whose conversion has not committed reads as approved with no link yet.
    bookingId: status === "approved" ? request.convertedBookingId : null,
    // DERIVED from the very list the service's guarded claim names, plus the
    // `heldBookingId: null` half of that claim. Offering a button the API
    // answers with a 409 is worse than offering none, so this is not allowed to
    // be a restatement of the rule.
    canWithdraw:
      isMemberWholeLodgeRequestOpen(request.status) &&
      request.heldBookingId === null,
  };
}

function toDateOnly(value: Date): string {
  return formatDateOnly(value);
}
