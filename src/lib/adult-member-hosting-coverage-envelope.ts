import { Prisma } from "@prisma/client";

import {
  ACTIVE_BOOKING_STATUSES,
  hostingCoverageSourceBookingFilter,
} from "@/lib/booking-status";

/**
 * The clauses EVERY adult-member coverage scope shares, in one place
 * (`INV-SSOT-002`).
 *
 * A host scope is one relationship clause wrapped in one envelope. The
 * relationship legitimately differs — `SAME_BOOKING_OWNER` asks for the same
 * `Booking.memberId`, `SAME_GROUP_TRIP` asks for the same `GroupBooking` — and
 * stays in its own module beside the reasoning that justifies it. The envelope
 * does NOT differ, and must not: the scopes are OR-ed per night by ONE
 * evaluator, so a scope with its own quietly different lodge, date or status
 * rules would be a second definition of what coverage even means.
 *
 * Written twice, that symmetry is hand-maintained — #2576 wrote it once, #3037
 * copied it, and each copy's docblock relied on somebody noticing when the other
 * moved. `INV-SSOT-002` rejects exactly that arrangement, so the five clauses
 * that must agree live here and each scope module supplies only its
 * relationship.
 *
 * ## The five, and why each is what it is
 *
 *  - `lodgeId` — the exact same lodge. An adult at Lodge A on Friday cannot cover
 *    Lodge B on Friday, so this is an equality and never a fan-out.
 *  - SELF-EXCLUSION — a booking never covers itself through a cross-booking
 *    scope; the same-booking scope is the rule for that.
 *  - a HALF-OPEN date overlap — `checkOut` is the morning nobody stays, so a
 *    source arriving on this booking's checkout day, or leaving on its arrival
 *    day, shares no night. Per-NIGHT matching still happens in the evaluator on
 *    the participants' own `BookingGuestNight` rows; this is a coarse bounding
 *    test, not the coverage rule.
 *  - `deletedAt: null` — a soft-deleted booking is not at the lodge.
 *  - THE STATUS SPLIT, which is the one asymmetry and the reason there are two
 *    functions rather than one flag. See `coverageDependentEnvelopeWhere`.
 */

/**
 * The booking being evaluated.
 *
 * `id` is nullable ON PURPOSE: the pre-persist create and join paths have no
 * booking id to exclude, and demanding one would force those callers to invent a
 * sentinel. A null id simply adds no exclusion clause, which is right — a row
 * that does not exist cannot match the query.
 */
export interface CoverageEnvelopeBooking {
  id: string | null;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
}

function lodgeSelfAndNightClauses(
  booking: CoverageEnvelopeBooking,
): Prisma.BookingWhereInput {
  return {
    lodgeId: booking.lodgeId,
    ...(booking.id === null ? {} : { id: { not: booking.id } }),
    checkIn: { lt: booking.checkOut },
    checkOut: { gt: booking.checkIn },
  };
}

/**
 * The envelope for a coverage SOURCE: a booking whose attendance may cover
 * another booking's non-member guest-nights.
 *
 * The status set is the eligible-source one, read off the canonical lifecycle
 * helper in `booking-status.ts` — genuinely confirmed active attendance only,
 * and `historical` opts into `COMPLETED` for historical-compliance reads alone.
 * Note what this is NOT: it is `Booking.status`. No container's status appears
 * here, and `INV-HOST-043` is why.
 *
 * Combine with a relationship clause by spreading, when the relationship is
 * scalar equality, or under `AND` when it is an `OR` — see
 * `coverageDependentEnvelopeWhere` for why the distinction is load-bearing.
 */
export function coverageEnvelopeWhere(
  booking: CoverageEnvelopeBooking,
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  return {
    ...hostingCoverageSourceBookingFilter(options),
    ...lodgeSelfAndNightClauses(booking),
  };
}

/**
 * The envelope for a coverage DEPENDENT: a booking whose own compliance may
 * depend on the evaluated booking's attendance, and which therefore has to be
 * re-evaluated when it changes.
 *
 * THE ONE DELIBERATE ASYMMETRY is the status set: the wider
 * `ACTIVE_BOOKING_STATUSES`, not the eligible-source set. A dependent is any
 * booking the rule would judge, and the rule judges a `PAYMENT_PENDING` or
 * `AWAITING_REVIEW` booking too — those cannot SUPPLY cover, but they certainly
 * NEED it. These statuses are not all capacity-holding, so this is a policy
 * cohort rather than a bed-hold claim.
 *
 * NO GUEST-COMPOSITION FILTER, on purpose, and the failure direction is why: the
 * SQL for "has a participant the rule treats as a non-member guest" is not
 * `memberId IS NULL` — it also covers a member-linked row whose Member is
 * inactive, cancelled or archived — so expressing it here would be a second copy
 * of `participantIsNonMemberGuest` written in Prisma filters. A drifted copy
 * MISSES a dependent, which means no reconciliation and no escalation for a
 * booking that really was stranded; a copy that is merely too wide costs one
 * idempotent reconciliation that writes nothing. The relationship, lodge and
 * night clauses are what make the set small.
 *
 * COMPOSE AN `OR` RELATIONSHIP UNDER `AND`, NEVER BY SPREADING IT. A flat spread
 * of two objects that each carry an `OR` key keeps only the last one, and both
 * losses are silent: dropping the relationship admits the whole lodge, and
 * dropping the status filter admits bookings the rule does not judge.
 */
export function coverageDependentEnvelopeWhere(
  booking: CoverageEnvelopeBooking,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
    ...lodgeSelfAndNightClauses(booking),
  };
}
