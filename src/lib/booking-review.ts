import { AdminReviewStatus, BookingStatus, type Prisma } from "@prisma/client";
import { isCapacityHoldingBookingStatus } from "@/lib/booking-status";

export const ADULT_SUPERVISION_REVIEW_REASON =
  "This booking does not include an adult guest, so it should be reviewed by an admin.";

/**
 * The adult-member hosting sentence (#2364). Its own field, not appended to
 * `adminReviewReason` — see `Booking.adultMemberHostingReview` in the schema for
 * why the two hazards do not share storage.
 */
export const ADULT_MEMBER_HOSTING_REVIEW_REASON =
  "This booking has non-member guests on nights when no adult member is staying, so it should be reviewed by an admin.";

/**
 * Every reason a booking is currently in admin review, as CODES (#2364).
 *
 * The issue asks for simultaneous minors and hosting hazards to be reported as
 * structured codes "without overloading the legacy single review string", and
 * this is where that happens: a booking can carry both at once, and each hazard
 * keeps its own prose and its own state. Deliberately DERIVED at read time from
 * the two states rather than stored as a third column — a stored copy is one
 * more thing that can disagree with the columns it summarises, and every writer
 * of either hazard would have to remember to maintain it.
 *
 * Order is fixed (supervision first) so responses and snapshots are stable.
 */
export const BOOKING_REVIEW_REASON_CODES = [
  "ADULT_SUPERVISION",
  "ADULT_MEMBER_HOSTING_REQUIRED",
] as const;

export type BookingReviewReasonCode =
  (typeof BOOKING_REVIEW_REASON_CODES)[number];

export function bookingReviewReasonCodes(booking: {
  requiresAdminReview: boolean;
  adminReviewStatus: AdminReviewStatus | string | null;
  adultMemberHostingReviewStatus: AdminReviewStatus | string | null;
}): BookingReviewReasonCode[] {
  const codes: BookingReviewReasonCode[] = [];
  if (booking.requiresAdminReview === true) codes.push("ADULT_SUPERVISION");
  if (booking.adultMemberHostingReviewStatus !== null) {
    codes.push("ADULT_MEMBER_HOSTING_REQUIRED");
  }
  return codes;
}

/** The human sentence for each code, in the same fixed order. */
export function bookingReviewReasonSentences(
  codes: readonly BookingReviewReasonCode[],
): string[] {
  return codes.map((code) =>
    code === "ADULT_SUPERVISION"
      ? ADULT_SUPERVISION_REVIEW_REASON
      : ADULT_MEMBER_HOSTING_REVIEW_REASON,
  );
}

// The adult-supervision rule lives in its client-safe home (#3770); re-exported
// here so every server caller keeps importing it from the review module.
export { requiresAdultSupervisionReview } from "@/lib/adult-supervision";

type ReviewGate = {
  requiresAdminReview: boolean;
  adminReviewStatus: AdminReviewStatus | string | null;
  adminReviewReason: string | null;
};

/**
 * F27 / #1372 + #1422. A booking left with only under-18 guests (no adult) is
 * flagged for admin review and KEPT in its PAID status — never parked to
 * AWAITING_REVIEW, so the captured-money invariant (#1100) holds. While that
 * admin review is still PENDING the booking must be BLOCKED from lodge check-in
 * (a child-safety gate): an admin has to clear the review before the party can
 * arrive.
 *
 * This predicate is the single source of truth for "is this booking blocked
 * from check-in by a pending admin review". #1422 broadened it to key on ANY
 * pending admin review (`requiresAdminReview === true && adminReviewStatus ===
 * PENDING`) rather than the specific adult-supervision reason. This blocks any
 * PAID/COMPLETED booking with a pending admin review; today the only such
 * reason is adult-supervision, but the broadened scope is intentional (owner
 * decision) so a future review type inherits the check-in gate automatically.
 *
 * Safe because every lodge query pre-filters `status IN
 * OPERATIONAL_STAY_BOOKING_STATUSES = [PAID, COMPLETED]`; AWAITING_REVIEW
 * (pre-payment) parked bookings are not in that set, so nothing new is
 * over-blocked.
 *
 * #2364 note: a pending ADULT-MEMBER HOSTING review deliberately does NOT
 * appear here, so it does not turn a party away at the door. The two are not
 * the same kind of hazard — the minors gate exists because a lodge full of
 * unaccompanied under-18s is a child-safety problem, whereas hosting is a club
 * membership rule the club chose to make reviewable and, by D-R4, always
 * administratively overridable. Refusing arrival for it would also punish the
 * wrong people: the fix is an adult member joining the booking, which nobody at
 * the door can do. The hosting hazard therefore surfaces to admins as a review,
 * and #2365 owns whatever consequence the club decides it should carry.
 */
export function isCheckinBlockedByPendingReview(booking: ReviewGate): boolean {
  return (
    booking.requiresAdminReview === true &&
    booking.adminReviewStatus === AdminReviewStatus.PENDING
  );
}

/**
 * Prisma `where` fragment (AND-able) that admits bookings requiring no review
 * or carrying explicit APPROVED review state (#1372 / #1422 / #2586). Spread it into any
 * lodge-scoped `booking` filter — never hand-roll the condition — so every
 * check-in enforcement surface (arrive/depart, roster generate/confirm) applies
 * the block identically. REJECTED and malformed unresolved legacy states remain
 * ineligible rather than becoming operational during a follow-up transition.
 *
 * NOTE (#1422): the guest LIST (check-in roster the kiosk shows staff) no
 * longer spreads this filter — it INCLUDES blocked bookings and flags them via
 * `isCheckinBlockedByPendingReview` so staff can see who is blocked. The
 * mutation/enforcement paths below keep excluding them (defense in depth).
 */
export function checkinNotBlockedByPendingReviewFilter(): Prisma.BookingWhereInput {
  return {
    OR: [
      // Most bookings never require review. Once review is required, only an
      // explicit approval is operationally admissible; PENDING, REJECTED and
      // malformed legacy null states all remain blocked. The explicit OR also
      // avoids nullable `not` semantics silently admitting a null status.
      { requiresAdminReview: false },
      { adminReviewStatus: AdminReviewStatus.APPROVED },
    ],
  };
}

/**
 * Should an admin alert fire because an edit NEWLY dropped a capacity-holding
 * (paid) booking into the minors-only blocked state (#1372)? True only when:
 *   1. the booking now sits in the blocked state (pending minors-only review),
 *   2. it was NOT already in a pending review before the edit (no repeat
 *      alerts just because the guest list shuffled), and
 *   3. it kept a live capacity-holding status (PAID/CONFIRMED/COMPLETED) rather
 *      than being parked to AWAITING_REVIEW — a parked pre-payment booking has
 *      no captured money and is already surfaced to the member, so the email is
 *      the nudge for the paid booking that stays PAID.
 */
export function minorsReviewAlertShouldFire({
  previous,
  updated,
}: {
  previous: {
    requiresAdminReview: boolean;
    adminReviewStatus: AdminReviewStatus | string | null;
  };
  updated: ReviewGate & { status: string };
}): boolean {
  if (!isCheckinBlockedByPendingReview(updated)) return false;

  const wasAlreadyPendingReview =
    previous.requiresAdminReview === true &&
    previous.adminReviewStatus === AdminReviewStatus.PENDING;
  if (wasAlreadyPendingReview) return false;

  return (
    updated.status !== BookingStatus.AWAITING_REVIEW &&
    isCapacityHoldingBookingStatus(updated.status)
  );
}
