import { BookingStatus, Prisma } from "@prisma/client";

export const CAPACITY_HOLDING_BOOKING_STATUSES = [
  BookingStatus.PAID,
  // COMPLETED means the stay has started or remains operationally active.
  // It must keep consuming lodge capacity until checkout.
  BookingStatus.COMPLETED,
  // CONFIRMED holds capacity for pay-on-account bookings (school groups,
  // issue #709): the booking is confirmed at approval and the lodge is
  // reserved while the emailed Xero invoice is outstanding. It flips to PAID
  // when the invoice is reconciled. School quote acceptances also land here
  // (issue #1254), so an accepted-but-unpaid school booking holds its beds.
  BookingStatus.CONFIRMED,
  // AWAITING_REVIEW must hold the bed: otherwise another member could book
  // the same dates while an admin is deciding, and approval would overbook.
  // The quote lifecycle (issue #1254) also reuses this status for the "sent
  // quote" hold — a sent quote reserves the beds/guest-nights while the
  // requester decides, so it must consume capacity.
  BookingStatus.AWAITING_REVIEW,
  // NOTE: PENDING does NOT hold capacity *by status alone* (issue #737). Members
  // pay up front and land on PAID; split-booking non-member children (#738) and
  // "only-if-my-guests-come" holds are provisional and stay bumpable — the
  // bump-on-no-capacity safety in cron-confirm-pending.ts and the
  // most-recent-first bumping still target those PENDING bookings.
  //
  // EXCEPTION (issue #1254, refines #737): a PENDING booking that is the
  // *converted* booking of a BookingRequest (an accepted-but-unpaid quote, or a
  // directly-approved request) DOES hold capacity until it is paid, expires, or
  // is cancelled. That extension is relation-based (originBookingRequest is
  // set), not status-based, so it lives in `capacityHoldingBookingFilter()`
  // below rather than in this status set. Generic PENDING remains non-holding.
] as const;

export const PAYMENT_OWED_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export const IMMEDIATE_PAYMENT_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
] as const;

// test seam
export const MEMBER_MODIFIABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  // While awaiting review, the member may amend guests (e.g. add an adult
  // to clear the no-adult flag); this is what releases the booking to
  // PAYMENT_PENDING without an admin decision.
  BookingStatus.AWAITING_REVIEW,
] as const;

export const OPERATIONAL_STAY_BOOKING_STATUSES = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
] as const;

export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.AWAITING_REVIEW,
] as const;

// The status set the admin bookings list shows for its `?upcoming=N` view — see
// `buildBookingWhere` in admin-bookings-service.ts, which applies exactly these
// statuses when no explicit `status` filter is supplied. Deliberately EXCLUDES
// AWAITING_REVIEW (a booking still under admin review is not yet a confirmed
// upcoming check-in). The admin dashboard's "Bookings" officer card reuses this
// constant for its headline count so the card number matches the list it deep
// links to (`/admin/bookings?upcoming=7`) instead of over-counting via the wider
// ACTIVE_BOOKING_STATUSES.
export const UPCOMING_CHECK_IN_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.PENDING,
] as const;

/**
 * The booking states whose attendance may COVER another booking's non-member
 * guest-night under the `SAME_BOOKING_OWNER` host scope (#2576 §3).
 *
 * Declared HERE, beside the rest of the lifecycle sets, because the owner's
 * decision is explicit that this rule reads "the repository's canonical
 * lifecycle helpers rather than adding a second independent status list". The
 * hosting evaluator is pure and the same-owner loader is a query builder;
 * neither is the place a club's idea of "genuinely confirmed active attendance"
 * should be spelled out for the second time.
 *
 * CONFIRMED and PAID, and nothing else. Both are the club's own statement that
 * the stay is happening: PAID is settled, and CONFIRMED is the pay-on-account /
 * accepted-quote hold that reserves the beds while an emailed invoice is
 * outstanding. Every other state is excluded for a reason the owner listed by
 * name:
 *
 *  - `DRAFT`, `PENDING` — a draft, an unconfirmed request, or a provisional
 *    "only if my guests come" hold. A speculative booking must not allow another
 *    booking to confirm.
 *  - `PAYMENT_PENDING` — named in the exclusion list in as many words.
 *  - `AWAITING_REVIEW` — a booking (or a sent quote) waiting on an officer or an
 *    exception decision is not yet attendance anybody has agreed to.
 *  - `WAITLISTED`, `WAITLIST_OFFERED` — a queue position and an unaccepted offer
 *    are not stays.
 *  - `BUMPED`, `CANCELLED` — gone.
 *  - `COMPLETED` — see the historical set below.
 *
 * A soft-deleted (archived) booking is excluded by `deletedAt`, which is a
 * column rather than a status; `hostingCoverageSourceBookingFilter` applies it,
 * so use that filter rather than this set alone in a query.
 *
 * NOT the same question as `capacityHoldingBookingFilter`. That set answers
 * "does this booking consume a bed", which AWAITING_REVIEW and a converted
 * PENDING quote both do — holding a bed is not the same as the club having
 * accepted that these people are coming.
 */
export const HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

/**
 * The same set plus `COMPLETED`, for evaluating HISTORICAL compliance only
 * (#2576 §3: "historical completed attendance may be considered only where
 * evaluating historical compliance; it must not be used as current or future
 * coverage").
 *
 * Deliberately a separate constant rather than a flag on the set above, so a
 * caller has to name which question it is asking. Nothing on a booking write
 * path may use this one — a completed stay cannot cover a future night, and
 * `COMPLETED` is reached the moment a stay starts, so treating it as current
 * coverage would let a stay that has begun and ended keep clearing a rule.
 */
export const HISTORICAL_HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES = [
  ...HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES,
  BookingStatus.COMPLETED,
] as const;

/** Per-booking form of the set above. `historical` opts into COMPLETED. */
export function isHostingCoverageSourceBookingStatus(
  status: string,
  options: { historical?: boolean } = {},
): boolean {
  const set = options.historical
    ? HISTORICAL_HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES
    : HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES;
  return (set as readonly string[]).includes(status);
}

/**
 * The `where` fragment for "this booking's attendance may supply same-owner
 * coverage" (#2576 §3) — the status set above AND not soft-deleted.
 *
 * Use this rather than a bare `status: { in: [...] }`: an archived booking is
 * excluded by `deletedAt`, not by its status, and the owner's exclusion list
 * names archived bookings explicitly.
 */
export function hostingCoverageSourceBookingFilter(
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  return {
    status: {
      in: [
        ...(options.historical
          ? HISTORICAL_HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES
          : HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES),
      ],
    },
    deletedAt: null,
  };
}

// A member's existing "real stay" for the cross-lodge duplicate-stay guard
// (ADR-004, #1587): everything that is not cancelled/bumped and not a waitlist
// placeholder. This includes PAYMENT_PENDING (a real pending stay awaiting
// payment) and COMPLETED (for completeness, though it cannot overlap a future
// offer's dates); it excludes WAITLISTED / WAITLIST_OFFERED, which are not
// stays. Shared by the pre-flight guard (waitlist-cross-lodge.ts) and the
// in-transaction guard (createConfirmedBooking) so both count identically.
export const DUPLICATE_STAY_BOOKING_STATUSES = [
  ...ACTIVE_BOOKING_STATUSES,
  BookingStatus.COMPLETED,
] as const;

export function isPaymentOwedBookingStatus(status: string) {
  return (PAYMENT_OWED_BOOKING_STATUSES as readonly string[]).includes(status);
}

// test seam
export function isCapacityHoldingBookingStatus(status: string) {
  return (CAPACITY_HOLDING_BOOKING_STATUSES as readonly string[]).includes(status);
}

// test seam
export function isOperationalStayBookingStatus(status: string) {
  return (OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(status);
}

/**
 * Per-booking analogue of `capacityHoldingBookingFilter()` (the DB-query form
 * below): does THIS booking consume lodge capacity? (issue #1254). A booking
 * holds when its status is capacity-holding, OR it is PENDING and is the
 * converted booking of a BookingRequest (accepted-but-unpaid quote / approved
 * request), OR it is PAYMENT_PENDING and carries an admin capacity hold
 * (#1764). Pass `isRequestConverted` = whether the booking has an
 * `originBookingRequest`, and `hasAdminCapacityHold` = whether
 * `adminCapacityHoldAt` is set. Generic PENDING stays non-holding (#737
 * preserved).
 *
 * Use this wherever a display or decision needs a per-row holding answer (e.g.
 * the bed board's Held vs Provisional tag) instead of the pure status check —
 * `isCapacityHoldingBookingStatus` alone would mislabel a held quote booking
 * or an admin-held payment-pending booking.
 */
export function bookingHoldsCapacity(booking: {
  status: string;
  isRequestConverted?: boolean;
  hasAdminCapacityHold?: boolean;
}): boolean {
  if (isCapacityHoldingBookingStatus(booking.status)) return true;
  if (
    booking.status === BookingStatus.PENDING &&
    Boolean(booking.isRequestConverted)
  ) {
    return true;
  }
  // Admin capacity hold (#1764) is status-scoped to PAYMENT_PENDING (the v1
  // scope): a stale flag on a cancelled/expired booking can never hold, and a
  // booking that later reaches a naturally-holding status is already counted
  // by the status check above — OR semantics, counted exactly once.
  return (
    booking.status === BookingStatus.PAYMENT_PENDING &&
    Boolean(booking.hasAdminCapacityHold)
  );
}

/**
 * Does THIS booking carry a persisted capacity override (#1771)? When true, a
 * payment-time / settlement capacity re-check must NOT cancel/refund, 409, or
 * bump the booking — it was deliberately admitted above the lodge ceiling by an
 * admin. Set at every over-capacity admission site (create/modify/force-confirm/
 * capacity-hold); read at every re-check site.
 */
export function bookingHasCapacityOverride(booking: {
  capacityOverriddenAt: Date | null;
}): boolean {
  return booking.capacityOverriddenAt != null;
}

/**
 * Prisma update-data fragment that releases an admin capacity hold (#1764).
 * Spread into every terminal status flip (the cancel paths and cancel-like
 * cron transitions) so no cancelled/expired booking keeps a stale hold record.
 * Capacity correctness never depends on this — the filter's admin-hold
 * disjunct is scoped to PAYMENT_PENDING, so a booking that left that status
 * stopped holding the moment it transitioned — but the shared release keeps
 * rows honest and the audit story simple ("cancel releases the hold").
 */
export const RELEASE_ADMIN_CAPACITY_HOLD_UPDATE = {
  adminCapacityHoldAt: null,
  adminCapacityHoldByMemberId: null,
} as const;

/**
 * Prisma update-data fragment that releases an exclusive whole-lodge hold
 * (ADR-001, issue #177). Spread alongside `RELEASE_ADMIN_CAPACITY_HOLD_UPDATE` by
 * the cancel paths and cancel-like cron transitions that can be releasing a hold,
 * so no cancelled/bumped/expired booking keeps a stale `wholeLodgeHold` record.
 *
 * NOT "every terminal status flip", which is what this said until #3209 and what
 * made it look usable as a census key for one. Measured then: SEVEN files spread
 * it and TWELVE flip a booking to a terminal status, so ten cancelling writers
 * spread neither fragment — correctly, because a booking that never held the
 * lodge has no hold to release. A guard that needs to find terminal flips must
 * read the status write itself; `adult-member-hosting-call-sites.test.ts` does,
 * and keeps this constant only as a cross-check on that reader.
 *
 * Capacity correctness never depends on this. Enforcement is status-scoped:
 * `getLodgeHeldNights` and every masking index intersect the hold flag with
 * `capacityHoldingBookingFilter()`, so a booking that left a capacity-holding
 * status stopped blocking new admissions the moment it transitioned — a stale
 * `wholeLodgeHold = true` on a cancelled row blocks nothing. The release exists
 * to keep rows honest and, crucially, so a cancelled-then-reinstated booking
 * does not silently RE-ARM its old hold with a stale actor/audit trail (#177):
 * reinstatement must start from no hold, and the officer re-sets it deliberately
 * through the audited exclusive-hold route.
 *
 * Mirrors the capacity-hold sibling: pure field clearing. Where the transition
 * runs with an audit context (the `booking-cancel.ts` cancellation audit funnel)
 * a `booking.exclusiveHold.released` entry is recorded when a hold was actually
 * released; the bulk/fragment cron and group-cancel transitions have no
 * per-booking audit context, so — exactly as the capacity-hold release does
 * there — the field clearing is best-effort audit-wise and stands on its own.
 */
export const RELEASE_WHOLE_LODGE_HOLD_UPDATE = {
  wholeLodgeHold: false,
  wholeLodgeHoldAt: null,
  wholeLodgeHoldByMemberId: null,
} as const;

/**
 * The single source of truth for "which bookings consume lodge capacity" as a
 * Prisma `where` fragment. Use this — never a bare `status: { in: [...] }` — in
 * every occupancy/availability query so the rule stays consistent everywhere.
 *
 * Capacity is held by:
 *   1. Any booking in a capacity-holding status (PAID/COMPLETED/CONFIRMED/
 *      AWAITING_REVIEW),
 *   2. PENDING bookings that were converted from a BookingRequest — i.e. an
 *      accepted-but-unpaid quote or a directly-approved request (issue #1254,
 *      refining #737). These reserve the bed until payment, expiry, or cancel,
 *      and
 *   3. PAYMENT_PENDING bookings carrying an admin capacity hold (issue #1764):
 *      an admin reserved the beds while the member sorts out payment. The
 *      disjunct is deliberately status-scoped — a cancelled/expired booking
 *      with a stale hold flag can never hold, and a booking that pays (moving
 *      to a status in clause 1) is counted once via that clause, keeping the
 *      claim path idempotent with an existing admin hold.
 *
 * Generic PENDING bookings (split-booking non-member children #738, member
 * "only-if-my-guests-come" holds) have no `originBookingRequest`, so they stay
 * non-holding and bumpable — #737 is preserved. PAYMENT_PENDING without an
 * admin hold stays non-holding exactly as before (#737).
 *
 * The result is a self-contained `AND`-able fragment (its top level is `OR`);
 * spread it into a larger `where` alongside date/exclusion clauses.
 */
export function capacityHoldingBookingFilter(): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] } },
      {
        status: BookingStatus.PENDING,
        originBookingRequest: { isNot: null },
      },
      {
        status: BookingStatus.PAYMENT_PENDING,
        adminCapacityHoldAt: { not: null },
      },
    ],
  };
}

/**
 * Lifecycle order of a booking, for sorting the admin list's status column by
 * lifecycle rather than alphabetically (Decision-menu D9a / #1215). Unknown or
 * future enum values rank LAST so adding a BookingStatus never throws and never
 * scatters rows unpredictably.
 */
const BOOKING_STATUS_LIFECYCLE_ORDER: readonly BookingStatus[] = [
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.CANCELLED,
  BookingStatus.BUMPED,
];

const bookingStatusRankByValue = new Map<string, number>(
  BOOKING_STATUS_LIFECYCLE_ORDER.map((status, index) => [status, index])
);

/** Lifecycle rank for sorting; unknown/future statuses rank last. */
export function bookingStatusLifecycleRank(status: string): number {
  return bookingStatusRankByValue.get(status) ?? BOOKING_STATUS_LIFECYCLE_ORDER.length;
}
