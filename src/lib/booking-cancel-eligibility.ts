import type { BookingStatus } from "@prisma/client";

/**
 * WHICH BOOKINGS MAY BE CANCELLED — the one home (#3497, `INV-SSOT-001`).
 *
 * Until #3497 this question was answered three times and no two answers agreed:
 * the cancel service admitted seven statuses, the booking page's Cancel button
 * six, and the cancel-preview route four — so a waitlisted member pressed
 * Cancel and the dialog dead-ended on a sentence naming statuses theirs was not.
 * The lists now live here, in a module that imports nothing at runtime, so a
 * route, a page and the service can all read them without dragging the
 * service's provider imports along, and so a test can pin every status's
 * answer at every door as one table.
 */

/**
 * Every status the cancel SERVICE (`cancelBooking`) accepts. Shared by its
 * outer validation guard and the tx1 single-flight re-check so the two can
 * never drift (#1160). Internal and officer callers — request decline, hold
 * release, review reject, account deletion — cancel from any of these.
 */
export const CANCELLABLE_BOOKING_STATUSES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "AWAITING_REVIEW",
] as const satisfies readonly BookingStatus[];

export type CancellableBookingStatus = (typeof CANCELLABLE_BOOKING_STATUSES)[number];

/**
 * The statuses a MEMBER-FACING door may cancel from: the service set minus
 * `AWAITING_REVIEW` (#3497, owner decision Option B, 19 Sep 2026).
 *
 * WHY THE ONE EXCLUSION. `cancelBooking` never touches `adminReviewStatus`, so
 * a member self-cancelling a booking under review would leave a `CANCELLED`
 * row still sitting as a `PENDING` item in the officers' Approvals queue — a
 * ghost the officer then has to clear by hand. Withdrawing a booking that is
 * with the club for review is the reviewing officer's Reject, which cancels
 * through the service AND closes the review. So the doors a member reaches —
 * the page's Cancel button (`canCancel`), the cancel-preview route, the cancel
 * route's opt-in guard, and the notes editor `canCancel` draws — read THIS set,
 * and every internal caller keeps the seven above.
 *
 * Derived, not restated: a status added to the service set is a member-door
 * status too unless it is named in the exclusion here.
 */
const MEMBER_CANCEL_EXCLUDED_STATUSES = ["AWAITING_REVIEW"] as const satisfies readonly CancellableBookingStatus[];

export const MEMBER_CANCELLABLE_BOOKING_STATUSES: readonly Exclude<
  CancellableBookingStatus,
  (typeof MEMBER_CANCEL_EXCLUDED_STATUSES)[number]
>[] = CANCELLABLE_BOOKING_STATUSES.filter(
  (
    status,
  ): status is Exclude<
    CancellableBookingStatus,
    (typeof MEMBER_CANCEL_EXCLUDED_STATUSES)[number]
  > => !(MEMBER_CANCEL_EXCLUDED_STATUSES as readonly string[]).includes(status),
);

export type MemberCancellableBookingStatus =
  (typeof MEMBER_CANCELLABLE_BOOKING_STATUSES)[number];

/** May the cancel service cancel a booking in this status? */
export function isCancellableBookingStatus(
  status: string,
): status is CancellableBookingStatus {
  return (CANCELLABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

/** May a member-facing door cancel a booking in this status? */
export function isMemberCancellableBookingStatus(
  status: string,
): status is MemberCancellableBookingStatus {
  return (MEMBER_CANCELLABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

/** "A, B, or C" — the prose shape the service's refusal has always used. */
function listInProse(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * The cancel SERVICE's refusal for a status outside `CANCELLABLE_BOOKING_STATUSES`,
 * derived from the set so the sentence can never name a different list from
 * the one the guard reads. Internal and officer callers see this one; it names
 * status codes because those callers are the officer screens and the tests.
 */
export function cancellableStatusRefusal(): string {
  return `Only ${listInProse(CANCELLABLE_BOOKING_STATUSES)} bookings can be cancelled`;
}

/**
 * The sentence a member-facing door answers with when it refuses, or `null`
 * when the booking may be cancelled from that door. One home for the wording
 * too, so the preview, the cancel route and the booking page can never
 * disagree about WHY. Plain English throughout: a member is never shown a
 * status code.
 */
export function memberCancelRefusal(status: string): string | null {
  if (isMemberCancellableBookingStatus(status)) return null;
  if (isCancellableBookingStatus(status)) {
    // In the service set but not the member set: with the club for review.
    return "This booking is with the club for review, so it cannot be cancelled from here. If you no longer want it, contact the club and the reviewing officer will withdraw it.";
  }
  return "This booking can no longer be cancelled from here.";
}
