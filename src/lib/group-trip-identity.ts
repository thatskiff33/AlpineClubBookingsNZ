import { Prisma } from "@prisma/client";

import {
  ACTIVE_BOOKING_STATUSES,
  hostingCoverageSourceBookingFilter,
} from "@/lib/booking-status";

/**
 * The one answer to "which Group Trip does this booking or join belong to?"
 * (#3037, epic #2943).
 *
 * Deliberately I/O-free — one `select` fragment, one resolver, one comparison and
 * two Prisma `where` builders. The reads themselves belong to the modules that
 * already own them (`adult-member-hosting-review.ts` turns a persisted booking
 * into evaluator input; `adult-member-hosting-proposed.ts` does the same for a
 * party that has no rows yet), and keeping this module read-free is what lets
 * BOTH of them, plus the reconciliation writers of #3039 and the kiosk payloads
 * of #3040, share one definition without an import cycle.
 *
 * ## Three rules this module exists to state once
 *
 * **1. GROUP IDENTITY IS `GroupBooking.organiserBookingId` AND
 * `GroupBookingJoin.bookingId`, AND NOTHING ELSE.** Emphatically NOT
 * `Booking.parentBookingId`. That column is the #738 split-booking relationship —
 * one party the database stores as a member row plus a linked non-member child —
 * and it is neither necessary nor sufficient for Group Trip membership: two
 * bookings in one Group Trip have no `parentBookingId` link at all, and a split
 * pair that is in no Group Trip has one. Reading grouping off it would produce a
 * sibling set that is wrong in both directions, which is why the owner's contract
 * names the two authoritative columns and forbids that one. Nothing in this file
 * mentions `parentBookingId`, and `group-trip-identity.test.ts` asserts that no
 * source file resolves group identity from it.
 *
 * **2. THE CONTAINER'S STATUS GOVERNS JOINING, NOT COVER.** `GroupBooking.status`
 * (`OPEN` / `CLOSED` / `CANCELLED`) decides whether NEW bookings may join the
 * group. It says nothing about whether the adults on the bookings that already
 * joined are still travelling — a `CLOSED` group is the normal state of a trip
 * whose party is settled, and an organiser cancelling the container does not
 * cancel the joiners' own bookings. So `GroupBooking.status` is absent from both
 * builders below, on purpose: filtering on it would silently strip cover from
 * live, compliant bookings whose party has not changed at all. Whether a given
 * booking is really happening is decided where it always was — on
 * `Booking.status`, through `hostingCoverageSourceBookingFilter`.
 *
 * **3. THE PAID-UP-ADULT LOCKOUT IS A DIFFERENT RULE AND STAYS PER-BOOKING.**
 * `PAID_UP_ADULT_MEMBER_REQUIRED` (#2543) asks whether THIS booking's own party
 * contains a paid-up adult member. It is party-level, it is not per-night, and it
 * is not a cover-source question, so nothing here widens it across a Group Trip.
 * This module supplies group identity to the hosting rule only.
 */

/** Which end of the Group Trip relationship a booking sits on. */
export type GroupTripRole = "ORGANISER" | "JOINER";

/**
 * A booking's Group Trip membership: the container it belongs to, and how.
 *
 * `groupBookingId` is the whole identity — two bookings are in the same Group
 * Trip exactly when this id matches. `role` carries no policy weight at all in
 * the hosting rule (an organiser's adults and a joiner's adults are equally
 * admissible), and exists because #3040 needs to know which booking is the
 * organiser's in order to keep organiser identity OUT of the ordinary
 * staying-guest tier.
 */
export interface GroupTripIdentity {
  groupBookingId: string;
  role: GroupTripRole;
}

/**
 * The Booking `select` fragment that carries canonical Group Trip identity.
 *
 * Spread into a narrow select rather than re-typed at each call site, because
 * Prisma does NOT typecheck `select` keys through the hand-written
 * `Pick<PrismaClient, ...>` interfaces the hosting paths use: a column or relation
 * name that drifts from the schema is a runtime validation failure on a booking
 * write path with a green typecheck. One constant means one place to be right,
 * and the census test reads the schema to prove it still is.
 *
 * `joinCode` IS NEVER SELECTED HERE, and must never be added. It is the group's
 * join credential; the epic's privacy contract keeps it out of every payload and
 * every tier, and identity resolution has no use for it.
 */
export const GROUP_TRIP_IDENTITY_SELECT = {
  groupBookingAsOrganiser: { select: { id: true } },
  groupBookingJoin: { select: { groupBookingId: true } },
} as const;

/**
 * What `GROUP_TRIP_IDENTITY_SELECT` produces, as a structural type.
 *
 * Both relations are optional as well as nullable so a caller holding a WIDER
 * row — or a test double written before #3037 — still satisfies it and resolves
 * to "no Group Trip", which is the safe direction: a booking wrongly read as
 * ungrouped supplies and consumes no cross-booking cover, so the rule falls back
 * to exactly its pre-#3037 answer.
 */
export interface GroupTripIdentityRow {
  groupBookingAsOrganiser?: { id: string } | null;
  groupBookingJoin?: { groupBookingId: string } | null;
}

/**
 * The Group Trip a loaded booking belongs to, or `null` for a booking in none.
 *
 * A booking cannot be both ends of the relationship: `GroupBooking` has a UNIQUE
 * `organiserBookingId` and `GroupBookingJoin` a UNIQUE `bookingId`, and the
 * organiser's booking is never also a join row. Should both ever be present the
 * ORGANISER link wins — it is the stronger of the two, being the row that defines
 * the container — and the answer is still one deterministic group rather than a
 * throw, because the hosting rule must not become unevaluatable for a data shape
 * the database is meant to prevent.
 */
export function groupTripIdentityOf(
  row: GroupTripIdentityRow,
): GroupTripIdentity | null {
  const organised = row.groupBookingAsOrganiser;
  if (organised) {
    return { groupBookingId: organised.id, role: "ORGANISER" };
  }
  const join = row.groupBookingJoin;
  if (join) {
    return { groupBookingId: join.groupBookingId, role: "JOINER" };
  }
  return null;
}

/**
 * Group Trip identity for a join whose Booking does not exist yet — the
 * PRE-PERSIST case the contract calls out by name.
 *
 * Both join paths need it, and neither can go through `groupTripIdentityOf`:
 *
 *  - a MEMBER join is created inside the booking transaction, so at the moment
 *    the hosting rule has to be answered (before the write, because the answer
 *    decides whether the member must supply a justification and whether the
 *    booking may be confirmed at all) there is no `Booking` row and no
 *    `GroupBookingJoin.bookingId`;
 *  - a NON-MEMBER join has a `GroupBookingJoin` row from the verify handshake,
 *    holding the contact and guest snapshot with `bookingId` still NULL until the
 *    joiner confirms their email.
 *
 * In both cases the joiner is joining a Group Trip whose id is already known and
 * already authoritative — it came from the join code they redeemed — so identity
 * is available strictly earlier than the booking is. Taking it from the container
 * rather than from the not-yet-written booking is what makes a pre-persist
 * evaluation possible at all, and it is exactly as canonical as the persisted
 * answer: the row this join becomes will carry the same `groupBookingId`.
 *
 * `role` is `JOINER` unconditionally, because an ORGANISER's booking has no
 * pre-persist group identity to resolve: the `GroupBooking` is created with the
 * organiser's booking in one transaction, so before that transaction there is no
 * container, and after it there are no siblings yet either.
 */
export function groupTripIdentityForJoin(join: {
  groupBookingId: string;
}): GroupTripIdentity {
  return { groupBookingId: join.groupBookingId, role: "JOINER" };
}

/** Whether two bookings are in the same Group Trip. `null` is never equal. */
export function sameGroupTrip(
  left: GroupTripIdentity | null,
  right: GroupTripIdentity | null,
): boolean {
  if (left === null || right === null) return false;
  return left.groupBookingId === right.groupBookingId;
}

/**
 * The membership clause on its own: bookings that ARE this Group Trip.
 *
 * The organiser's booking plus every booking a join row points at, expressed
 * through the two canonical relations and nothing else. Exported so a caller that
 * needs group membership WITHOUT the lodge/date/status envelope below — a
 * reconciliation fan-out, a kiosk linkage read — composes this rather than
 * writing the relation filter a third time.
 *
 * `is:` is written explicitly on both to-one relations. Prisma infers it, but the
 * inferred form reads like a scalar-equality filter and the two mean different
 * things on a nullable relation, so the explicit spelling is the one that stays
 * correct when somebody edits it.
 */
export function groupTripMembershipWhere(
  identity: GroupTripIdentity,
): Prisma.BookingWhereInput {
  return {
    OR: [
      { groupBookingAsOrganiser: { is: { id: identity.groupBookingId } } },
      { groupBookingJoin: { is: { groupBookingId: identity.groupBookingId } } },
    ],
  };
}

/**
 * The booking being evaluated, as the two builders below need it.
 *
 * `id` is nullable ON PURPOSE: the pre-persist create path has no booking id to
 * exclude, and a builder that demanded one would force that caller to invent a
 * sentinel. A null id simply adds no exclusion clause, which is right — a row
 * that does not exist cannot match the query.
 */
export interface GroupTripCoverageBooking {
  id: string | null;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
}

/**
 * Bookings whose attendance may cover `booking`'s non-member guest-nights under
 * `SAME_GROUP_TRIP`.
 *
 * The same four-clause shape as `sameBookingOwnerCoverageSourceWhere` (#2576),
 * with the relationship clause swapped and NOTHING else loosened — that symmetry
 * is deliberate, because the two scopes are OR-ed per night by one evaluator and
 * a scope with its own quietly different lodge, date or status rules would be a
 * second definition of coverage:
 *
 *  - the Group Trip — canonical membership, above (§1).
 *  - `lodgeId` — the exact same lodge. An adult at Lodge A on Friday cannot cover
 *    Lodge B on Friday, so this is an equality and never a fan-out.
 *  - the eligible-source filter — genuinely confirmed active attendance only, read
 *    off the canonical lifecycle helper in `booking-status.ts`. Note what this is
 *    NOT: it is `Booking.status`, not `GroupBooking.status` (§2).
 *  - a half-open date OVERLAP — `checkOut` is the morning nobody stays, so a
 *    source arriving on this booking's checkout day, or leaving on its arrival
 *    day, shares no night and is excluded. Per-NIGHT matching still happens in the
 *    evaluator on the participants' own `BookingGuestNight` rows; this clause only
 *    keeps the read bounded and is a coarse envelope test, not the coverage rule.
 *
 * WHY THIS IS BOUNDED. `GroupBookingJoin` is indexed on `groupBookingId` and
 * `GroupBooking.organiserBookingId` is unique, so the relation clause resolves to
 * one trip's bookings — the size of a travelling party, and capped further by the
 * group's own `maxJoiners` where the organiser set one. It is emphatically not the
 * lodge-wide sweep #2575 rejected: no clause here can match a booking that is not
 * in this Group Trip.
 *
 * WHAT IT DOES NOT DECIDE. Membership is not hosting. WHO may host is settled
 * afterwards by the shared evaluator's own `participantQualifiesAsHost`, and a
 * sibling booking supplies nothing unless a qualifying adult member is actually
 * recorded as attending the relevant lodge-night. There is deliberately no second
 * definition of a qualifying adult member here.
 */
export function groupTripCoverageSourceWhere(
  booking: GroupTripCoverageBooking,
  identity: GroupTripIdentity,
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  // Composed with `AND` rather than spread flat, unlike its same-owner sibling.
  // The membership clause is an `OR`, and `hostingCoverageSourceBookingFilter` is
  // a helper this module does not own: were it ever to grow an `OR` of its own, a
  // flat spread would silently drop one of the two — dropping the status filter
  // would admit cancelled bookings as cover, and dropping the membership filter
  // would admit the whole lodge. `AND` cannot lose a clause that way.
  return {
    AND: [
      hostingCoverageSourceBookingFilter(options),
      groupTripMembershipWhere(identity),
      {
        lodgeId: booking.lodgeId,
        ...(booking.id === null ? {} : { id: { not: booking.id } }),
        checkIn: { lt: booking.checkOut },
        checkOut: { gt: booking.checkIn },
      },
    ],
  };
}

/**
 * Bookings whose own compliance may DEPEND on `booking`'s attendance — the set
 * #3039 has to re-evaluate when this booking's rows change.
 *
 * The mirror of the source builder, with the one deliberate difference its
 * same-owner sibling also carries: the status set is the wider
 * `ACTIVE_BOOKING_STATUSES`, not the eligible-source set. A dependent is any
 * booking the rule would judge, and the rule judges a `PAYMENT_PENDING` or
 * `AWAITING_REVIEW` booking too — those cannot SUPPLY cover, but they certainly
 * NEED it. These statuses are not all capacity-holding, so this is a policy cohort
 * rather than a bed-hold claim.
 *
 * NO GUEST-COMPOSITION FILTER, on purpose, for the reason the same-owner builder
 * records: the SQL for "has a participant the rule treats as a non-member guest"
 * is not `memberId IS NULL` — it also covers a member-linked row whose Member is
 * inactive, cancelled or archived — so expressing it here would be a second copy
 * of `participantIsNonMemberGuest` written in Prisma filters, and the failure
 * direction is the bad one. A drifted copy MISSES a dependent, which means no
 * reconciliation and no escalation for a booking that really was stranded; a copy
 * that is merely too wide costs one idempotent reconciliation that writes nothing.
 * The group, lodge and night clauses are what make the set small, and they are all
 * here.
 *
 * AND STILL NO `GroupBooking.status` (§2). Closing or cancelling the container
 * changes no booking's cover, so it must not change who is re-evaluated either —
 * a dependent dropped because its container closed is a dependent nobody
 * reconciles.
 */
export function groupTripCoverageDependentWhere(
  booking: GroupTripCoverageBooking,
  identity: GroupTripIdentity,
): Prisma.BookingWhereInput {
  return {
    ...groupTripMembershipWhere(identity),
    lodgeId: booking.lodgeId,
    deletedAt: null,
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
    ...(booking.id === null ? {} : { id: { not: booking.id } }),
    checkIn: { lt: booking.checkOut },
    checkOut: { gt: booking.checkIn },
  };
}
