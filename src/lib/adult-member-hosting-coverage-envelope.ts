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
 *
 * ## And one deliberate SUBTRACTION, which is a third function rather than a flag
 *
 * A dependent fan-out that runs after the change it is reacting to cannot use the
 * night comparison at all, because the booking it compares against already holds
 * the NEW dates — see `coverageDependentEnvelopeAcrossNightsWhere`, which keeps
 * the lodge equality and the self-exclusion and drops only the two date
 * comparisons. It is a named function and not a boolean because the reason it
 * exists is three paragraphs long and belongs at the definition; a `{ nights:
 * false }` option at forty call sites would be a silent hole waiting for somebody
 * to pass it by mistake.
 *
 * ## And one deliberate WIDENING, which is a fourth function for the same reason
 *
 * A fan-out whose answer can REFUSE the actor's change needs the same
 * post-mutation correction without the subtraction's cost, because an extra row
 * there is not one idempotent re-read — it is a booking the member is told they
 * may not move. `coverageDependentEnvelopeOverStayUnionWhere` takes the window the
 * booking VACATED as well as the one it now holds and matches either, so the set
 * is exactly "could have been relying on this booking before or after the change"
 * and nothing wider. #3232 is why it exists; its own docblock carries the
 * reasoning and the reason it is not a variant of the subtraction above.
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

/**
 * The two clauses that are about the ROW rather than the dates: the exact lodge,
 * and never this booking itself.
 *
 * Split out from the night comparison because `coverageDependentEnvelopeAcrossNightsWhere`
 * needs these two and not those — one definition of "same lodge, not me" rather
 * than a second hand-written copy (`INV-SSOT-001`).
 */
function lodgeAndSelfClauses(
  booking: CoverageEnvelopeBooking,
): Prisma.BookingWhereInput {
  return {
    lodgeId: booking.lodgeId,
    ...(booking.id === null ? {} : { id: { not: booking.id } }),
  };
}

/**
 * The half-open overlap test on its own, so the single-window form and the
 * old-or-new form below cannot spell it two ways (`INV-SSOT-001`).
 *
 * Returned as a nestable object rather than spread into the caller, because the
 * union form needs TWO of them under one `OR` and a flat spread would keep only
 * the second — the same silent-collision hazard `coverageDependentEnvelopeWhere`
 * warns about for an `OR` relationship.
 */
function nightOverlapClause(range: {
  checkIn: Date;
  checkOut: Date;
}): Prisma.BookingWhereInput {
  return {
    checkIn: { lt: range.checkOut },
    checkOut: { gt: range.checkIn },
  };
}

function lodgeSelfAndNightClauses(
  booking: CoverageEnvelopeBooking,
): Prisma.BookingWhereInput {
  return {
    ...lodgeAndSelfClauses(booking),
    ...nightOverlapClause(booking),
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
 * The dependent COHORT: which rows the rule judges at all.
 *
 * Both clauses, in one place, for the reason this module exists — it is the home
 * of the clauses every coverage read shares, and it had already factored out the
 * lodge/self and night ones while leaving this pair inline at four sites. Widening
 * the cohort with four copies means the refusal path keeps the old one, and the
 * failure is silent: a booking the rule would judge is simply not in the set.
 *
 * Returned fresh each call rather than as a shared const, so no caller can mutate
 * the array another caller is about to hand to Prisma.
 */
function dependentCohortClauses(): Prisma.BookingWhereInput {
  return {
    // A soft-deleted booking is not at the lodge.
    deletedAt: null,
    // The WIDER set, not the eligible-source one: the rule judges a
    // `PAYMENT_PENDING` or `AWAITING_REVIEW` booking too — those cannot SUPPLY
    // cover, but they certainly NEED it. Not all capacity-holding, so this is a
    // policy cohort rather than a bed-hold claim.
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
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
    ...dependentCohortClauses(),
    ...lodgeSelfAndNightClauses(booking),
  };
}

/**
 * The dependent envelope WITHOUT the night-overlap clause, for a fan-out that runs
 * AFTER the change it is reacting to (#3039).
 *
 * WHY THE NIGHT CLAUSE HAS TO GO HERE, and it is a defect that was measured rather
 * than a precaution. Every dependent read runs post-mutation — the writer updates
 * the booking and then calls the hosting seam — so `booking.checkIn` and
 * `booking.checkOut` are the NEW dates. A dependent that was relying on this
 * booking over the OLD dates therefore fails the overlap test and is not in the
 * set at all: no queue item, no re-evaluation, no incident, no owner notice and
 * nothing in the officer queue, for a booking whose cover the change had just
 * taken away. Concretely: booking A carries the trip's only qualifying adult on
 * nights 10-11, booking B on ANOTHER account is compliant only through
 * `SAME_GROUP_TRIP`, and A moves to nights 20-21. `checkOut > 20` is false for B,
 * so B stays marked compliant indefinitely, because nothing re-evaluates it until
 * B itself is touched and its owner has no reason to touch it.
 *
 * THE ALTERNATIVE WAS TO PLAN OVER THE UNION OF THE OLD AND NEW WINDOWS, and it
 * was rejected. Only one writer in the tree holds the old dates
 * (`booking-date-modification-service.ts`), so the union form would have to be
 * threaded through the ~40 booking writers that reach the seam, and any writer
 * that forgot would silently reintroduce exactly this hole. Dropping the clause
 * fixes it once, for every writer, without any of them knowing.
 *
 * OVER-WIDE IS THE SAFE DIRECTION HERE, which is what makes the trade acceptable.
 * The extra rows are bookings in the same party at the same lodge that do not
 * overlap the changed stay; each one costs one idempotent re-evaluation that
 * re-reads committed facts and writes nothing unless the answer really changed.
 * The set is still bounded by the relationship clause the caller composes — for
 * `SAME_GROUP_TRIP` that is one trip, capped again by
 * `GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT`.
 *
 * THE LODGE CLAUSE AND THE SELF-EXCLUSION STAY. Dropping the lodge equality would
 * falsify the whole "group cover is same-lodge by construction" argument that lets
 * the mode gate read one lodge's policy for the trip; dropping the self-exclusion
 * would make a booking its own dependent. Only the two date comparisons go.
 *
 * NOT USED BY THE SAME-OWNER DIRECTION, AND #3232 CHANGED WHY RATHER THAN
 * CHANGING THE ANSWER. This paragraph used to say the same-owner direction must
 * keep its night clause because `inspectSameOwnerDependents` decides whether a
 * member's edit is REFUSED, and that "its own post-mutation date exposure is
 * #2576's and is not this change's to alter". The second half was wrong as a
 * statement about the product — the exposure was a live defect that silently
 * stranded a member's own second booking, and #3232 fixed it — while the first
 * half is still exactly right, and is the reason the fix is a THIRD shape rather
 * than this function.
 *
 * The distinction is what an extra row COSTS on each side. Here it costs one
 * idempotent re-evaluation that writes nothing, so being generous is free and the
 * clause can simply go. On the same-owner side an extra row is a booking the
 * member is told they cannot move, so a set that is merely "not narrowed by the
 * new nights" is not good enough — it has to be RIGHT. It is, because the
 * information this function does not have is available there: only a date move
 * makes the old and new stay differ, and the one writer that performs one
 * (`booking-date-modification-service.ts`) holds `oldCheckIn`/`oldCheckOut` in the
 * same function that calls the hosting seam. So the same-owner direction matches
 * the union of the vacated and the current window through
 * `coverageDependentEnvelopeOverStayUnionWhere`, which is exact, and this function
 * stays what it is for the fan-out that cannot refuse.
 */
export function coverageDependentEnvelopeAcrossNightsWhere(
  booking: CoverageEnvelopeBooking,
): Prisma.BookingWhereInput {
  return {
    ...dependentCohortClauses(),
    ...lodgeAndSelfClauses(booking),
  };
}

/**
 * The dependent envelope over the window this booking VACATED as well as the one
 * it now holds, for a post-mutation fan-out whose answer can refuse the actor
 * (#3232, `INV-HOST-049`).
 *
 * WHAT WAS BROKEN, and it is the same root cause as
 * `coverageDependentEnvelopeAcrossNightsWhere`'s with the opposite remedy. Every
 * dependent read runs after the write, so a single-window overlap test compares
 * against the NEW dates. A booking that was relying on this one over the OLD dates
 * fails that test and is not in the set at all — no evaluation, no incident, no
 * notice, nothing in the officer queue — so it stays recorded as compliant while
 * being uncovered, indefinitely, because nothing looks at it again until its owner
 * touches it and its owner has no reason to. Concretely: booking A carries the only
 * qualifying adult on nights 10-11, booking B is the same owner's at the same lodge
 * on the same nights and is compliant only through A, and A moves to nights 20-21.
 * `B.checkOut(12) > A.checkIn(20)` is false, so B is invisible.
 *
 * WHY NOT SIMPLY DROP THE CLAUSE, which is what the group direction does. Because
 * the answer this set feeds can REFUSE a member's edit, and the two directions pay
 * opposite prices for an extra row. Dropping the clause here would put every other
 * active booking the member holds at this lodge into a set whose members can block
 * the edit — including a booking that is genuinely uncovered for a reason this
 * change had nothing to do with, on nights this change never touched. The
 * "materially newly uncovered" test in `inspectSameOwnerDependents` catches most of
 * those, but it cannot catch one that carries no recorded snapshot and no open
 * incident yet, and a false refusal is the failure mode this whole issue exists to
 * avoid rather than to relocate.
 *
 * SO THE SET IS THE UNION, WHICH IS EXACT. A booking's compliance can only have
 * been changed by this one if it shared a night with where this booking WAS or with
 * where it now IS. Matching either window is precisely that statement, and it is
 * not a heuristic narrowing of a wider sweep: a booking overlapping neither window
 * cannot have been relying on this booking before the change and cannot be relying
 * on it after, so re-reading it would answer a question nobody asked.
 *
 * `AN OR, UNDER AND, NEVER SPREAD`. The two overlap tests both set `checkIn` and
 * `checkOut`, so a flat spread would keep only one of them and the loss would be
 * silent — the same hazard `coverageDependentEnvelopeWhere` documents for an `OR`
 * relationship clause. They therefore compose under `AND`, which also leaves the
 * caller free to spread its own relationship clause on top.
 *
 * `vacated` IS NULLABLE AND NULL IS THE COMMON CASE. Roughly forty writers reach
 * the hosting seam and only a date move makes the old and new stay differ; for all
 * the others the vacated window IS the current one, so `null` collapses this to one
 * overlap test and the behaviour is byte-identical to
 * `coverageDependentEnvelopeWhere`. Passing the same range twice would also be
 * correct and is deliberately not required, because a writer forced to restate a
 * window it did not change is a writer that will eventually restate it wrongly.
 *
 * WHAT MAKES A WRITER SUPPLY IT AT ALL is not this function's docblock — it is
 * that `hostingCoverageActorOptions` takes the vacated range as a REQUIRED field,
 * so the compiler enumerates every actor-driven site and a new date writer cannot
 * inherit the hole by omission.
 */
export function coverageDependentEnvelopeOverStayUnionWhere(
  booking: CoverageEnvelopeBooking,
  vacated: { checkIn: Date; checkOut: Date } | null,
): Prisma.BookingWhereInput {
  const current = nightOverlapClause(booking);
  if (
    vacated === null ||
    (vacated.checkIn.getTime() === booking.checkIn.getTime() &&
      vacated.checkOut.getTime() === booking.checkOut.getTime())
  ) {
    return {
      ...dependentCohortClauses(),
      ...lodgeAndSelfClauses(booking),
      ...current,
    };
  }
  return {
    ...dependentCohortClauses(),
    ...lodgeAndSelfClauses(booking),
    AND: [{ OR: [current, nightOverlapClause(vacated)] }],
  };
}
